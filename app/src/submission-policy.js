// submission-policy.js — 成功受理冷却与队列位置（第 35.4、36.2、36.3 章）。
// 冷却取本项目 Attempt（acceptedAt，兼容 submittedAt）与浏览器平台记录的最新时间；
// 刷新 / 切项目不清除；未返回有效 video_id 的提交不算成功。
// 冷却不拒收新镜：入队照常，实际 POST 在 Transport 中等待冷却与请求间隔的截止时间。

import { idb } from './storage.js';
import { MODEL_PROFILES } from './models.js';

function cooldownKey(platformId) {
  return `submission-cooldown:${platformId || 'default'}`;
}

export async function recordAccepted(platformId, acceptedAt) {
  await idb.set('state', cooldownKey(platformId), { acceptedAt, platformId });
}

async function lastAcceptedFromStore(platformId) {
  const rec = await idb.get('state', cooldownKey(platformId));
  return rec && Number(rec.acceptedAt) ? Number(rec.acceptedAt) : 0;
}

// remaining = max(0, ceil((acceptedAt + cooldown*1000 − now)/1000))，按实际时钟计算。
export async function cooldownRemainingSeconds(project) {
  const profile = MODEL_PROFILES[0];
  const cd = (profile.submission && profile.submission.cooldownSeconds) || 0;
  if (!cd) return 0;
  let last = await lastAcceptedFromStore(profile.platformId);
  for (const j of project?.jobs || []) {
    for (const a of j.attempts || []) {
      const t = Number(a.acceptedAt) || Number(a.submittedAt) || 0; // 旧已知任务兼容 submittedAt，不回写
      if (a.videoId && t > last) last = t;
    }
  }
  if (!last) return 0;
  const remaining = Math.ceil((last + cd * 1000 - Date.now()) / 1000);
  return Math.max(0, remaining);
}

// 队列位置：未完成任务顺序（正在处理第 1 位，其后 pending 依次），已就绪 / 批准 / 终止任务不计入。
export function pendingSubmission(project, currentUid = null) {
  const active = ['pending', 'submitting', 'queued', 'generating', 'download', 'checking', 'deferred', 'unknown'];
  let position = 0;
  let mine = null;
  for (const j of project?.jobs || []) {
    if (!active.includes(j.state)) continue;
    position += 1;
    if ((currentUid && j.uid === currentUid) || (!currentUid && j.state === 'pending')) {
      mine = mine || position;
    }
  }
  return { position: mine || null, activeCount: position };
}

// 预计等待秒数：取成功冷却截止、提交预算 notBefore 的最大值（前序实际完成时间未知，需另行说明）。
export async function earliestSubmitWaitSeconds(pacingNotBeforeMs) {
  const cd = await cooldownRemainingSeconds(null);
  const now = Date.now();
  const fromPacing = pacingNotBeforeMs ? Math.ceil((pacingNotBeforeMs - now) / 1000) : 0;
  return Math.max(0, cd, Math.max(0, fromPacing));
}
