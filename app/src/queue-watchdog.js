// queue-watchdog.js — 页面内队列自检与旧任务迁移（第 37 章）。
// 页面初始化完成后立即自检；正常每 30 秒一次；页面重新显示 / 可见性恢复 / online 时额外唤醒。
// 自检做纯状态判断与安全恢复：不代提交专家草稿、不解除暂停、不重发未知 POST。

import { idb } from './storage.js';

const CHECK_INTERVAL_MS = 30000;
const START_MIN_GAP_MS = 10000;

// 旧小白 / Pavo 任务的自动意图迁移（第 37.1 章）。必须同时满足：
// autoSubmit 未定义 + pending + 小白版或 Pavo 创作 + 有匹配镜号的 input_approved 事件
// + 无已发出尝试或 video_id。显式 false、专家、未知 POST 不迁移；幂等。
export function migrateLegacyAutoSubmit(project) {
  const migrated = [];
  for (const j of project.jobs) {
    if (j.autoSubmit !== undefined) continue;
    if (j.state !== 'pending') continue;
    if (!['easy', 'pavo'].includes(j.experience)) continue;
    const hasApproval = (project.events || []).some(e => e.kind === 'input_approved' && e.jobId === j.id);
    if (!hasApproval) continue;
    const hasAttempt = (j.attempts || []).length > 0;
    if (hasAttempt) continue;
    j.autoSubmit = true;
    migrated.push(j.id);
  }
  if (migrated.length) {
    project.events.push({ at: new Date().toISOString(), kind: 'queue_migrated', message: `迁移自动提交意图：${migrated.join('、')}`, jobId: null });
  }
  return migrated;
}

export class QueueWatchdog {
  constructor({ project, runner, persist, logEvent, hasKey, hasDirPermission, getState }) {
    this.project = project; this.runner = runner; this.persist = persist;
    this.logEvent = logEvent || (() => {});
    this.hasKey = hasKey || (() => false);
    this.hasDirPermission = hasDirPermission || (() => true);
    this.getState = getState || (() => 'online');
    this.timer = null;
    this.checking = false;
    this.lastStartAttempt = 0;
    this.lastCheck = null; // { at, reason, message }
    this.stopped = false;
  }

  setProject(p) { this.project = p; }

  start() {
    if (this.stopped) return;
    this.check('启动自检');
    this.timer = setInterval(() => this.check('定时自检'), CHECK_INTERVAL_MS);
    window.addEventListener('pageshow', () => this.check('页面恢复'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.check('页面可见'); });
    window.addEventListener('online', () => this.check('网络恢复'));
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); }

  async check(reason) {
    if (this.checking || this.stopped) return;
    this.checking = true;
    try {
      const project = this.project;
      // 1. 旧任务迁移（幂等）
      const migrated = migrateLegacyAutoSubmit(project);
      if (migrated.length) { await this.persist(true); this.logEvent('watchdog', `自检迁移 ${migrated.length} 镜自动意图`); }
      // 2. 下载中的任务：定时唤醒 Runner 处理退避到期 / 本地恢复（Runner._loop 自会挑选）
      const autoPending = project.jobs.filter(j => j.state === 'pending' && j.autoSubmit === true);
      const recoverable = project.jobs.filter(j => ['download', 'queued', 'generating', 'deferred'].includes(j.state));
      const needStart = autoPending.length > 0 || recoverable.length > 0;
      // 3. 条件判断
      if (!needStart) { this.lastCheck = { at: Date.now(), reason, message: '没有需要自动接续的任务' }; return; }
      if (project.queueControl?.paused) { this.lastCheck = { at: Date.now(), reason, message: '已暂停：新提交保持暂停，当前任务继续' }; return; }
      const online = navigator.onLine;
      if (!online) { this.lastCheck = { at: Date.now(), reason, message: '网络离线：恢复后继续' }; return; }
      const dirOk = this.hasDirPermission();
      const keyOk = this.hasKey();
      if (!keyOk && autoPending.length) { this.lastCheck = { at: Date.now(), reason, message: '等待密钥启用后接续' }; return; }
      if (!dirOk && recoverable.some(j => j.state === 'download')) { this.lastCheck = { at: Date.now(), reason, message: '输出目录待重新授权：原任务保留' }; return; }
      // 4. 唤醒 Runner（仅自动意图范围）
      const now = Date.now();
      if (this.runner.running) { this.lastCheck = { at: now, reason, message: '队列运行中：自检仅刷新显示' }; return; }
      if (now - this.lastStartAttempt < START_MIN_GAP_MS) { this.lastCheck = { at: now, reason, message: '启动尝试间隔保护中' }; return; }
      this.lastStartAttempt = now;
      this.lastCheck = { at: now, reason, message: `正在自动接续（${autoPending.length ? '提交 ' + autoPending.length + ' 镜' : '恢复原任务'}）` };
      const uids = autoPending.map(j => j.uid);
      await this.runner.start({ onlyUids: uids.length ? uids : null });
    } finally {
      this.checking = false;
      await idb.set('state', 'watchdog-last-check', { at: new Date().toISOString(), reason, message: this.lastCheck?.message || '' }).catch(() => {});
    }
  }
}
