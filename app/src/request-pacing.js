// request-pacing.js — 独立操作间隔与渐进限流（第 39 章）。
// 提交、状态查询、模型检查、下载各自持有独立预算与锁：GET 不覆盖 POST 的局部截止时间。
// 算法：受罚 I=min(M, I+Δ)；成功 I=max(B, I−Δ)；到期时刻取 notBefore / Retry-After 的最大值。
// 惩罚识别：429、529，或 403/503 带限流 / 过载代码或有效 Retry-After；认证、参数、普通网络错误不算。

import { idb } from './storage.js';

export const BASE_INTERVALS = {
  submit: 61000,   // 默认 61 秒，严格大于 60；高级设置可调高
  poll: 10000,     // 后续状态查询
  models: 5000,    // 连接检查 / 模型列表
  download: 5000,  // 普通下载轮失败后的重试
};
export const STEPS = { submit: 10000, poll: 5000, models: 5000, download: 5000 };
export const CAPS = { submit: 181000, poll: 60000, models: 60000, download: 60000 };

const keyFor = (platform, op) => `request-pacing-v2:${platform}:${op}`;

function clampI(op, i) {
  return Math.min(CAPS[op], Math.max(BASE_INTERVALS[op], i));
}

export async function loadBudget(platform, op) {
  const rec = await idb.get('state', keyFor(platform, op));
  if (rec && typeof rec === 'object') {
    return {
      intervalMs: clampI(op, Number(rec.intervalMs) || BASE_INTERVALS[op]),
      notBefore: Number(rec.notBefore) || 0,
      lastSentAt: Number(rec.lastSentAt) || 0,
      reason: rec.reason || '',
      penaltyAt: Number(rec.penaltyAt) || 0,
    };
  }
  return { intervalMs: BASE_INTERVALS[op], notBefore: 0, lastSentAt: 0, reason: '', penaltyAt: 0 };
}

async function saveBudget(platform, op, rec) {
  await idb.set('state', keyFor(platform, op), {
    intervalMs: clampI(op, rec.intervalMs), notBefore: rec.notBefore || 0,
    lastSentAt: rec.lastSentAt || 0, reason: rec.reason || '', penaltyAt: rec.penaltyAt || 0,
    updatedAt: new Date().toISOString(),
  });
}

// 计算最早允许发送时刻（毫秒时间戳）。extraNotBefore：成功冷却截止、退避截止等外部约束。
export async function reserveSlot(platform, op, { extraNotBefore = 0, submitGapMs = 0 } = {}) {
  const rec = await loadBudget(platform, op);
  const now = Date.now();
  const baseFromLast = op === 'submit' && submitGapMs
    ? rec.lastSentAt + submitGapMs
    : rec.lastSentAt + rec.intervalMs;
  const notBefore = Math.max(rec.notBefore || 0, baseFromLast, extraNotBefore || 0);
  return { waitMs: Math.max(0, notBefore - now), notBefore, budget: rec };
}

// 真正发出前记录（本地持久化发送槽位；失败也占槽）。
export async function commitSend(platform, op) {
  const rec = await loadBudget(platform, op);
  rec.lastSentAt = Date.now();
  await saveBudget(platform, op, rec);
  return rec;
}

export function isPenalty(status, bodyText) {
  if (status === 429 || status === 529) return true;
  if (status === 403 || status === 503) {
    const t = String(bodyText || '').toLowerCase();
    return /rate.?limit|video_queue_full|overloaded/.test(t);
  }
  return false;
}

// 解析 Retry-After：秒数（含小数）或 HTTP 日期；非法忽略。返回绝对截止时间戳或 0。
export function parseRetryAfter(headerValue, now = Date.now()) {
  if (!headerValue) return 0;
  const v = String(headerValue).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return now + Math.round(parseFloat(v) * 1000);
  const d = Date.parse(v);
  if (!Number.isNaN(d) && d > now) return d;
  return 0;
}

export async function reportOutcome(platform, op, { success = false, penalty = false, retryAfterMs = 0 } = {}) {
  const rec = await loadBudget(platform, op);
  if (penalty) {
    rec.intervalMs = clampI(op, rec.intervalMs + STEPS[op]);
    rec.penaltyAt = Date.now();
    rec.reason = 'penalty';
  } else if (success) {
    rec.intervalMs = clampI(op, Math.max(BASE_INTERVALS[op], rec.intervalMs - STEPS[op]));
    rec.reason = '';
  }
  const ra = retryAfterMs > 0 ? Date.now() + retryAfterMs : 0;
  rec.notBefore = Math.max(rec.notBefore || 0, ra);
  await saveBudget(platform, op, rec);
  return rec;
}

// 首次查询估算：最近 10 次可靠同模型完成观察的中位数 × 0.6，取整限 10–30 秒（第 39.1 章）。
export function estimateFirstPollSeconds(observations) {
  const valid = (observations || [])
    .map(o => ({ a: Date.parse(o.acceptedAt), c: Date.parse(o.remoteCompletedAt) }))
    .filter(o => Number.isFinite(o.a) && Number.isFinite(o.c) && o.c > o.a)
    .map(o => (o.c - o.a) / 1000)
    .slice(-10);
  if (!valid.length) return 20;
  valid.sort((x, y) => x - y);
  const mid = valid.length % 2 ? valid[(valid.length - 1) / 2] : (valid[valid.length / 2 - 1] + valid[valid.length / 2]) / 2;
  return Math.max(10, Math.min(30, Math.round(mid * 0.6)));
}
