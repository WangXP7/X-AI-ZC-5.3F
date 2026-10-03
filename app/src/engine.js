// engine.js — 生成引擎（第 12、36—39 章）。
// 铁律：未知 POST 不自动重发；查询失败沿原 video_id；用户未启动/无自动意图不创建。
// 1.2.x 关键行为：提交/查询/模型/下载独立节奏（request-pacing）；成功冷却不拒收新镜；
// 原片持久化后释放远端槽位、后台技术校验；下载多通道自动恢复与回执；每请求固定凭据。

import { uuid, nowIso, redact, sha256Hex, buildRequestPrompt, STATE_LABELS,
         DOWNLOAD_MAX_BYTES, durationQA } from './core.js';
import { blobStore, saveProject, writeFile, fileExists, idb } from './storage.js';
import { inspectVideoBlob } from './media.js';
import { MODEL_PROFILES, profileForJob } from './models.js';
import * as pacing from './request-pacing.js';
import { recordAccepted, cooldownRemainingSeconds } from './submission-policy.js';
import { AutomaticMediaRelay } from './media-relay.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DOWNLOAD_BACKOFFS = [15, 30, 60, 120, 240, 300]; // 秒，封顶 300（第 36.8 章）
const LINK_REFRESH_MIN_GAP = 5 * 60 * 1000;            // 失效链接刷新最短间隔

export function lastAttempt(job) { return job.attempts?.at(-1) || null; }

// ---------- Transport：按操作独立节奏的认证请求 + 媒体多通道下载 ----------
export class Transport {
  constructor({ getSettings, onAuthWait } = {}) {
    this.getSettings = getSettings || (() => ({}));
    this.onAuthWait = onAuthWait || (() => {});
    this.relay = new AutomaticMediaRelay();
    this._pin = null; // 当次请求固定凭据（第 41.5 章）
  }

  _profile(job) { return profileForJob(job || {}); }

  // 认证请求。op ∈ submit | poll | models，各自独立预算。
  async api(method, path, { op = 'poll', jsonBody = null, timeoutMs = 180000, job = null, extraNotBefore = 0 } = {}) {
    const settings = this.getSettings();
    const key = this._pin ?? settings.key;
    if (!key) {
      const e = new Error('未启用密钥：等待启用后继续。');
      e.name = 'MissingCredential';
      throw e;
    }
    const profile = this._profile(job);
    const platform = profile.platformId || 'default';
    const submitGapMs = Math.max(61000, (settings.submitGapSeconds || 61) * 1000);
    const slot = await pacing.reserveSlot(platform, op, {
      extraNotBefore: op === 'submit' ? Math.max(extraNotBefore, await this._cooldownDeadline(job)) : extraNotBefore,
      submitGapMs,
    });
    if (slot.waitMs > 0) this.onAuthWait(Math.ceil(slot.waitMs / 1000), op);
    await sleep(slot.waitMs);
    await pacing.commitSend(platform, op);
    // 发送前最后一次检查并固定当次凭据（等待期间可能被停用）
    const keyNow = this.getSettings().key;
    if (!keyNow) { const e = new Error('密钥已在等待期间停用。'); e.name = 'MissingCredential'; throw e; }
    this._pin = keyNow;

    const url = settings.origin + path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Authorization': `Bearer ${this._pin}`, ...(jsonBody ? { 'Content-Type': 'application/json' } : {}) },
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
        redirect: 'error',
        credentials: 'omit',
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = null; }
      const retryAfterMs = pacing.parseRetryAfter(res.headers.get('Retry-After'));
      await pacing.reportOutcome(platform, op, {
        success: res.ok,
        penalty: pacing.isPenalty(res.status, text),
        retryAfterMs,
      });
      return { ok: res.ok, status: res.status, json: parsed, text, retryAfterMs };
    } catch (e) {
      await pacing.reportOutcome(platform, op, { success: false, penalty: false });
      return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : 'network', message: String(e.message || e) };
    } finally {
      clearTimeout(timer);
      this._pin = null;
    }
  }

  async _cooldownDeadline(job) {
    const remaining = await cooldownRemainingSeconds(this._projectRef?.());
    return remaining > 0 ? Date.now() + remaining * 1000 : 0;
  }
  bindProject(getter) { this._projectRef = getter; }

  // 媒体下载：本机中继（Pages/本地）→ 直连；通道诊断 + 单轮自动回退（第 36.7、38.5、40 章）。
  async media(url, { onProgress = () => {}, diag = null, timeoutMs = 180000 } = {}) {
    const channels = [];
    const origin = location.origin;
    const relayUsable = this.relay.eligible(origin, url);
    if (relayUsable) channels.push(['local', () => this._viaRelay(url, onProgress, timeoutMs)]);
    channels.push(['direct', () => this._viaDirect(url, onProgress, timeoutMs)]);
    const results = [];
    for (const [name, fn] of channels) {
      try {
        const blob = await fn();
        results.push({ channel: name, ok: true, bytes: blob.size });
        if (diag) diag.channels = results;
        return blob;
      } catch (e) {
        results.push({ channel: name, ok: false, code: e.name === 'AbortError' ? 'timeout' : 'fetch_unreadable', message: String(e.message || e).slice(0, 160) });
      }
    }
    if (diag) diag.channels = results;
    const e = new Error('所有下载通道失败');
    e.code = relayUsable ? 'media_channel_unavailable' : 'fetch_unreadable';
    e.channels = results;
    throw e;
  }

  async _viaDirect(url, onProgress, timeoutMs) {
    if (!/^https:\/\//.test(url) || url.includes('@')) throw new Error('非受信媒体地址');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.upstreamStatus = res.status; throw e; }
      return await this._readStream(res, onProgress);
    } finally { clearTimeout(timer); }
  }

  async _viaRelay(url, onProgress, timeoutMs) {
    const endpoint = await this.relay.endpoint();
    if (!endpoint) throw new Error('本机下载服务未连接');
    const token = await this.relay.token();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-XAI-Media-Token': token },
        body: JSON.stringify({ url }),
        signal: ctrl.signal,
      });
      if (res.status === 403) { const e = new Error('本机会话失效'); e.code = 'media_session_required'; throw e; }
      if (!res.ok) { const e = new Error(`本机通道 HTTP ${res.status}`); e.upstreamStatus = res.status; throw e; }
      return await this._readStream(res, onProgress);
    } finally { clearTimeout(timer); }
  }

  async _readStream(res, onProgress) {
    const type = (res.headers.get('Content-Type') || '').toLowerCase();
    if (type.includes('text/html') || type.includes('application/json')) throw new Error('响应不是视频');
    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body.getReader();
    const chunks = []; let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.byteLength;
      onProgress(received, total);
    }
    if (total && received !== total) { const e = new Error(`长度不符 ${received}/${total}`); e.code = 'incomplete_download'; throw e; }
    if (!received) { const e = new Error('空响应'); e.code = 'empty_download'; throw e; }
    return new Blob(chunks, { type: type || 'application/octet-stream' });
  }
}

// ---------- Runner ----------
export class Runner {
  constructor({ project, persist, transport, logEvent, onJobUpdate, onQueueState, hooks = {} }) {
    this.project = project; this.persist = persist; this.transport = transport;
    this.logEvent = logEvent || (() => {});
    this.onJobUpdate = onJobUpdate || (() => {});
    this.onQueueState = onQueueState || (() => {});
    this.hooks = hooks;             // { readAssetBlob, toast }
    this.transport.bindProject?.(() => this.project);
    this.running = false;
    this.pausedNew = false;
    this.stopFlag = false;
    this.localChecks = new Set();   // uid 去重的后台校验（第 37.4 章）
    this.assembling = false;
    this._watchdogWanted = false;   // watchdog 唤醒标记（带 onlyUids）
  }

  setProject(p) { this.project = p; }

  async start({ onlyUids = null } = {}) {
    if (this.running) { if (onlyUids) this._watchdogWanted = onlyUids; return; }
    if (navigator.locks) {
      const ok = await navigator.locks.request('x-ai-production-runner', { ifAvailable: true }, async (lock) => {
        if (!lock) { this.onQueueState('另一个页面正在运行队列'); return; }
        await this._loop(onlyUids);
      });
      return ok;
    }
    await this._loop(onlyUids);
  }

  stop() { this.stopFlag = true; }
  _job(id) { return this.project.jobs.find(j => j.id === id); }

  // 挑选下一个可提交的 pending：数组顺序即队列顺序；onlyUids 限定自动意图范围。
  _nextPending(onlyUids) {
    const inflightStates = ['submitting', 'queued', 'generating', 'download', 'checking', 'deferred', 'unknown'];
    for (const j of this.project.jobs) {
      if (inflightStates.includes(j.state)) return null; // 前序占用远端槽位，等待
      if (j.state === 'pending') {
        if (onlyUids && !onlyUids.includes(j.uid)) return null; // 自动流程不代提交无关草稿
        return j;
      }
    }
    return null;
  }

  async _loop(onlyUids = null) {
    this.running = true; this.stopFlag = false;
    this.onQueueState('队列运行中');
    try {
      for (;;) {
        if (this.stopFlag) break;
        const jobs = this.project.jobs;
        // 已下载 → 后台校验在别处运行；这里继续找下一个可提交
        const active = jobs.find(j => ['queued', 'generating', 'download', 'deferred'].includes(j.state));
        if (active) { await this._step(active); continue; }
        if (jobs.some(j => j.state === 'submitting' || j.state === 'unknown')) {
          this.onQueueState('存在待核实的提交，已暂停整队');
          break;
        }
        if (this.pausedNew) { this.onQueueState('已暂停新提交（当前任务已处理完成）'); break; }
        // 检查中的后台校验不阻塞下一独立镜；只要求没有其他远端在途
        const next = this._nextPending(onlyUids);
        if (!next) { this.onQueueState('队列空闲：没有待提交的任务'); break; }
        await this._submit(next);
        await this.persist();
      }
    } catch (e) {
      if (e?.name === 'MissingCredential') {
        this.onQueueState('等待密钥启用后继续（自检会接续）');
        this.hooks.onMissingCredential?.();
      } else {
        this.onQueueState(`队列停止：${e.message || e}`);
      }
    } finally {
      this.running = false;
      this.onQueueState(this.stopFlag ? '队列已停止' : '队列空闲');
      if (this._watchdogWanted) { const u = this._watchdogWanted; this._watchdogWanted = null; setTimeout(() => this.start({ onlyUids: u }), 1000); }
    }
  }

  async _step(job) {
    this.onJobUpdate(job);
    switch (job.state) {
      case 'queued': case 'generating': return this._poll(job);
      case 'download': return this._downloadOrRecover(job);
      case 'deferred': return this._deferredWait(job);
      default: return;
    }
  }

  // ---------- 提交（第 36.4、39.2 章） ----------
  async _submit(job) {
    const profile = profileForJob(job);
    // 1. 素材回读与哈希核对
    const attempt = this._newAttempt(job);
    const images = []; const audios = []; const imageNames = [];
    try {
      for (const id of job.assetIds) {
        const asset = this.project.assets.find(a => a.id === id);
        if (!asset) throw new Error(`素材记录缺失：${id}`);
        const blob = await this.hooks.readAssetBlob(asset);
        const sha = await sha256Hex(await blob.arrayBuffer());
        if (asset.sha256 && sha !== asset.sha256) throw new Error(`素材 ${asset.name} 内容与记录哈希不一致，请重新导入`);
        attempt.inputHashes[asset.name] = sha;
        if (asset.kind === 'image') { images.push(blob); imageNames.push(asset.name); }
        else audios.push(blob);
      }
    } catch (e) {
      job.state = 'blocked'; job.error = `素材回读失败：${e.message}`; this.logEvent('submit-blocked', job.error, job.id);
      return;
    }
    if (job.continuityFrom && job.mode === 'reference') {
      const prev = this.project.jobs.find(j => j.id === job.continuityFrom);
      if (!prev?.current?.lastFrameKey) { job.state = 'blocked'; job.error = `前镜 ${job.continuityFrom} 技术校验尚未通过或缺少末帧`; return; }
      const frameBlob = await blobStore.get(prev.current.lastFrameKey);
      if (!frameBlob) { job.state = 'blocked'; job.error = `前镜 ${job.continuityFrom} 末帧数据缺失`; return; }
      images.push(frameBlob); imageNames.push(`${job.continuityFrom}-末帧.png`);
      attempt.continuityInput = { fromJob: prev.id, frameSha256: prev.current.lastFrameSha256, videoSha256: prev.current.sha256 };
    }

    // 2. 请求构造
    const requestPrompt = buildRequestPrompt(job, imageNames);
    const payload = { model: profile.apiModel, seconds: String(job.seconds), mode: job.mode, size: profile.resolution, aspect_ratio: job.aspect, n: 1 };
    if (job.seed !== null && job.seed !== undefined) payload.seed = job.seed;
    if (job.mode === 'reference') {
      payload.images = await Promise.all(images.map(b => toDataUri(b)));
      if (audios.length) payload.audios = await Promise.all(audios.map(b => toDataUri(b)));
    }
    if (job.mode === 'keyframe') {
      if (job.firstFrame) payload.first_frame = await toDataUri(await blobStore.get(job.firstFrame));
      if (job.lastFrame) payload.last_frame = await toDataUri(await blobStore.get(job.lastFrame));
    }
    payload.prompt = requestPrompt;
    attempt.request = redactRequest(payload);
    attempt.requestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ model: payload.model, seconds: payload.seconds, prompt: payload.prompt })));

    // 3. 发送检查点：preparedAt（pending）→ submittedAt（submitting）→ sentAt（发出）
    job.preparedAt = nowIso();
    await this.persist(true);
    job.state = 'submitting'; job.error = null;
    attempt.submittedAt = nowIso();
    job.attempts.push(attempt);
    await this.persist(true);
    this.logEvent('submit', `第 ${attempt.number} 次尝试提交（${job.mode}，等待提交间隔与冷却）`, job.id);

    try {
      const res = await this.transport.api('POST', '/v1/videos', { op: 'submit', jsonBody: payload, job });
      attempt.response = { status: res.status, body: res.json ? redact(res.json) : (res.text || '').slice(0, 2000) };
      attempt.sentAt = attempt.sentAt || nowIso();
      if (res.ok && res.json) {
        const vid = findVideoId(res.json);
        if (vid) {
          attempt.videoId = vid; attempt.resolved = true; attempt.acceptedAt = nowIso();
          job.state = 'queued'; job.progress = 0; job.error = null;
          await recordAccepted(profile.platformId, Date.now());
          this.logEvent('queued', `已受理：video_id=${vid}`, job.id);
        } else {
          job.state = 'unknown'; job.error = '服务返回未包含 video_id：请人工核实后再继续，不要盲目重发。';
        }
      } else if (pacing.isPenalty(res.status, res.text) && !res.json?.video_id) {
        // 明确限流拒绝创建：按安全退避重试同一尝试（未创建）
        attempt.rejectedBeforeCreation = true; attempt.resolved = true;
        const retryAfterMs = res.retryAfterMs || 0;
        await pacing.reportOutcome(profile.platformId, 'submit', { penalty: true, retryAfterMs });
        job.state = 'deferred';
        const waitS = Math.max(15, Math.ceil(retryAfterMs / 1000) || Math.round((await pacing.loadBudget(profile.platformId, 'submit')).intervalMs / 1000));
        attempt.notBefore = Date.now() + waitS * 1000;
        job.error = `平台限流，${waitS} 秒后自动重试提交`;
        this.logEvent('deferred', `限流退避 ${waitS}s`, job.id);
      } else if ([400, 401, 403, 422].includes(res.status)) {
        attempt.rejectedBeforeCreation = true; attempt.resolved = true; attempt.terminalConfirmed = true;
        job.state = 'failed'; job.error = `创建被拒绝（HTTP ${res.status}）：${(res.json?.error?.message || res.text || '').slice(0, 200)}`;
        if (res.status === 401 || res.status === 403) { this.pausedNew = true; this.hooks.onAuthRejected?.(); }
      } else {
        job.state = 'unknown';
        job.error = `提交结果未知（${res.error === 'timeout' ? '超时' : res.status ? 'HTTP ' + res.status : '网络错误'}）。可能已创建收费任务，请核实后再继续。`;
        this.logEvent('unknown', job.error, job.id);
      }
    } catch (e) {
      if (e?.name === 'MissingCredential') { job.state = 'pending'; job.attempts.pop(); throw e; }
      job.state = 'unknown'; job.error = `提交异常：${e.message}。可能已创建，请核实。`;
    }
    this.onJobUpdate(job);
  }

  _newAttempt(job) {
    return {
      number: job.attempts.length + 1, createdAt: nowIso(), reason: job.revisionReason || '首次生成',
      snapshot: { prompt: job.prompt, dialogue: job.dialogue, seconds: job.seconds, aspect: job.aspect, mode: job.mode, seed: job.seed, assetIds: [...job.assetIds], firstFrame: job.firstFrame, lastFrame: job.lastFrame, continuityFrom: job.continuityFrom },
      inputHashes: {}, videoId: null, taskId: null, response: null, submitError: null,
      pollResponse: null, polledAt: null, url: null, pollCount: 0, firstPollAt: null, remoteCompletedAt: null,
      deferrals: 0, pollErrors: 0,
      resolved: false, terminalConfirmed: false, rejectedBeforeCreation: false, uncreatedEvidence: null,
      rawBlobKey: null, rawPath: null, rawSha256: null, downloadCompleteAt: null, remoteReleasedAt: null,
      blobKey: null, path: null, sha256: null, bytes: 0, downloadedAt: null, qa: null,
      frameDirectory: null, frameKeys: [], lastFrameKey: null, lastFramePath: null, lastFrameSha256: null,
      continuityInput: null, downloadSequence: 0, downloadHistory: [], downloadFailures: 0,
      downloadRetryAt: 0, downloadErrors: [], downloadUrlHistory: [], downloadDiagnostic: null,
      lastLinkRefreshAt: 0,
    };
  }

  // ---------- 查询（第 39.1 章：首查估算 20s，后续 10s；沿原 video_id 与原模型） ----------
  async _poll(job) {
    const attempt = lastAttempt(job);
    if (!attempt?.videoId) { job.state = 'unknown'; job.error = '缺少 video_id，无法查询'; return; }
    const profile = profileForJob(job);
    const model = attempt.request?.model || profile.apiModel;
    // 首次查询等待：acceptedAt + 估算秒；后续按 poll 预算
    if (attempt.pollCount === 0 && attempt.acceptedAt) {
      const est = pacing.estimateFirstPollSeconds(this._completedObservations());
      const due = Date.parse(attempt.acceptedAt) + est * 1000;
      const wait = due - Date.now();
      if (wait > 0) { this.onQueueState(`首次状态查询约 ${Math.ceil(wait / 1000)} 秒后`); await sleep(Math.min(wait, 5000)); return; }
    }
    const res = await this.transport.api('GET', `/agnesapi?video_id=${encodeURIComponent(attempt.videoId)}&model_name=${model}`, { op: 'poll', job });
    attempt.polledAt = nowIso();
    if (res.ok && res.json) {
      attempt.pollResponse = redact(res.json);
      attempt.pollCount = (attempt.pollCount || 0) + 1;
      const st = String(res.json.status || res.json.state || '').toLowerCase();
      const url = res.json.url || res.json.video_url || res.json.output?.url || res.json.data?.[0]?.url || null;
      if (['completed', 'success', 'succeeded', 'done'].includes(st)) {
        attempt.remoteCompletedAt = attempt.remoteCompletedAt || nowIso();
        if (typeof url === 'string' && url.startsWith('https://') && !url.includes('@')) {
          attempt.url = url;
          job.state = 'download'; job.error = null; job.downloadRecovery = false;
          this.logEvent('completed', '服务端完成，开始自动下载', job.id);
        } else {
          job.state = 'generating'; job.error = null; // completed 未附 URL：短查询等待结果地址
        }
      } else if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) {
        attempt.resolved = true; attempt.terminalConfirmed = true;
        job.state = 'failed'; job.error = `服务商确认失败：${st}`;
      } else {
        job.state = 'generating';
        const p = Number(res.json.progress ?? res.json.percent);
        if (Number.isFinite(p) && p >= 0 && p <= 100) { job.progress = p; job.progressKnown = true; }
        else job.progressKnown = false;
      }
    } else if (res.status === 0) {
      attempt.pollErrors++;
      job.error = '查询网络错误：保留原 video_id，稍后继续查询。';
      await sleep(Math.min(60000, 5000 * attempt.pollErrors));
    } else if (res.status === 401 || res.status === 403) {
      job.pollCredentialRejected = true;
      job.state = 'blocked'; job.error = `查询认证被拒（HTTP ${res.status}）：启用有效密钥后自检将恢复查询原任务`;
      this.stopFlag = true;
    } else if (res.status === 404 || res.status === 400) {
      job.state = 'blocked'; job.error = `查询返回 HTTP ${res.status}：请检查任务状态后继续原任务`;
      this.stopFlag = true;
    } else {
      attempt.pollErrors++;
      await sleep(10000);
    }
    this.onJobUpdate(job);
  }

  _completedObservations() {
    const out = [];
    for (const j of this.project.jobs) for (const a of j.attempts || []) {
      if (a.acceptedAt && a.remoteCompletedAt) out.push({ acceptedAt: a.acceptedAt, remoteCompletedAt: a.remoteCompletedAt });
    }
    return out;
  }

  async _deferredWait(job) {
    const attempt = lastAttempt(job);
    const waitMs = (attempt?.notBefore || 0) - Date.now();
    if (waitMs > 0) { this.onQueueState(`任务 ${job.id} 退避等待 ${Math.ceil(waitMs / 1000)} 秒`); await sleep(Math.min(waitMs, 5000)); return; }
    job.state = 'pending'; job.error = null; // 明确未创建的限流允许安全重试
    this.onJobUpdate(job);
  }

  // ---------- 下载与恢复（第 36.7—36.8、38 章） ----------
  async _downloadOrRecover(job) {
    const attempt = lastAttempt(job);
    if (!attempt?.url) { job.state = 'blocked'; job.error = '没有可下载的 URL'; return; }
    // 1. 本地恢复优先：浏览器缓存 / 目录原片 / 回执（第 38.4 章）
    const local = await this._tryLocalRestore(job, attempt);
    if (local) return;
    // 2. 网络退避检查
    const now = Date.now();
    if (attempt.downloadRetryAt > now) {
      this.onQueueState(`原视频下载重试将在 ${Math.ceil((attempt.downloadRetryAt - now) / 1000)} 秒后继续`);
      await sleep(Math.min(attempt.downloadRetryAt - now, 5000));
      return;
    }
    // 3. 下载（诊断 + 多通道）
    const diag = { version: 'runtime', pageOrigin: location.origin, startedAt: nowIso(), channels: [] };
    attempt.downloadDiagnostic = diag;
    this.onJobUpdate(job);
    try {
      const blob = await this.transport.media(attempt.url, {
        diag,
        onProgress: (recv, total) => { job.downloadBytes = recv; job.downloadTotal = total; this.onJobUpdate(job); },
      });
      // MP4 签名 + 大小
      const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
      if (String.fromCharCode(...head.slice(4, 8)) !== 'ftyp' || blob.size < 1024) { const e = new Error('MP4 签名缺失'); e.code = 'invalid_media'; throw e; }
      if (blob.size > DOWNLOAD_MAX_BYTES) { const e = new Error('超过 512MB 上限'); e.code = 'too_large'; throw e; }
      // 4. 固化字节 + SHA
      const sha = await sha256Hex(await blob.arrayBuffer());
      // 5. 浏览器缓存 + raw 落盘 + 回执 + 项目检查点，全部成功才释放远端槽位
      attempt.downloadSequence++;
      const seq = attempt.downloadSequence > 1 ? `_d${attempt.downloadSequence}` : '';
      attempt.rawBlobKey = await blobStore.put(blob);
      attempt.rawSha256 = sha;
      attempt.rawPath = `raw/${job.episode}/${job.id}_v${attempt.number}${seq}.mp4`;
      const dir = this.hooks.getDirHandle?.();
      if (dir) {
        await writeFile(dir, attempt.rawPath, blob);
        const receipt = { schema: 'x-ai-download-v1', jobUid: job.uid, attempt: attempt.number, videoId: attempt.videoId, requestHash: attempt.requestHash || '', path: attempt.rawPath, sha256: sha, bytes: blob.size, savedAt: nowIso() };
        await writeFile(dir, attempt.rawPath + '.json', JSON.stringify(receipt, null, 2));
      }
      attempt.downloadCompleteAt = nowIso();
      if (attempt.videoId) attempt.remoteReleasedAt = nowIso();
      attempt.bytes = blob.size; attempt.downloadedAt = nowIso();
      attempt.downloadFailures = 0; attempt.downloadRetryAt = 0;
      job.downloadBytes = null; job.downloadTotal = null;
      // 6. 进入后台校验并释放远端槽位（下一独立镜可接续）
      job.state = 'checking'; job.error = null; job.downloadRecovery = false;
      await this.persist(true);
      this.logEvent('downloaded', `${(blob.size / 1e6).toFixed(1)}MB sha256=${sha.slice(0, 12)}…，转入后台校验`, job.id);
      this._startLocalCheck(job);
    } catch (e) {
      attempt.downloadFailures = (attempt.downloadFailures || 0) + 1;
      const round = Math.min(attempt.downloadFailures, DOWNLOAD_BACKOFFS.length) - 1;
      const waitS = DOWNLOAD_BACKOFFS[round];
      attempt.downloadRetryAt = Date.now() + waitS * 1000;
      attempt.downloadErrors = (attempt.downloadErrors || []).slice(-19)
        .concat([{ at: nowIso(), code: e.code || (e.upstreamStatus ? `http_${e.upstreamStatus}` : 'fetch_unreadable'), message: String(e.message).slice(0, 160) }]);
      // 失效链接：按原 video_id 刷新（受认证节奏 + 最短间隔）
      const stale = [403, 404, 410].includes(e.upstreamStatus) || attempt.downloadFailures > 2;
      if (stale && this.getSettingsKey?.() !== false && Date.now() - (attempt.lastLinkRefreshAt || 0) > LINK_REFRESH_MIN_GAP) {
        attempt.lastLinkRefreshAt = Date.now();
        await this._refreshLink(job, attempt);
      }
      // 保持 download 状态：自动恢复，不转 blocked（第 36.8 章）
      job.state = 'download'; job.error = null; job.downloadRecovery = true;
      job.downloadRetryIn = waitS;
      this.logEvent('download-retry', `第 ${attempt.downloadFailures} 轮失败（${e.code || e.message}），${waitS}s 后自动重试`, job.id);
    }
    this.onJobUpdate(job);
  }

  async _refreshLink(job, attempt) {
    const profile = profileForJob(job);
    const model = attempt.request?.model || profile.apiModel;
    const res = await this.transport.api('GET', `/agnesapi?video_id=${encodeURIComponent(attempt.videoId)}&model_name=${model}`, { op: 'poll', job });
    if (res.ok && res.json) {
      const url = res.json.url || res.json.video_url || res.json.output?.url || null;
      if (typeof url === 'string' && url.startsWith('https://') && url !== attempt.url) {
        attempt.downloadUrlHistory = (attempt.downloadUrlHistory || []).slice(-4).concat([{ at: nowIso(), url: attempt.url }]);
        attempt.url = url;
        attempt.downloadFailures = 0; // 新链接重新计轮
        this.logEvent('link-refresh', '已获取新的原视频地址', job.id);
      }
    }
  }

  // 本地恢复：浏览器缓存 → 目录原片（回执身份核对）
  async _tryLocalRestore(job, attempt) {
    try {
      if (attempt.rawBlobKey) {
        const b = await blobStore.get(attempt.rawBlobKey);
        if (b && b.size) { await this._acceptLocalBytes(job, attempt, b, '浏览器缓存'); return true; }
      }
      const dir = this.hooks.getDirHandle?.();
      if (dir && attempt.rawPath && await fileExists(dir, attempt.rawPath)) {
        const file = await (await import('./storage.js')).readFileFromHandle(dir, attempt.rawPath);
        const sha = await sha256Hex(await file.arrayBuffer());
        if (!attempt.rawSha256 || sha === attempt.rawSha256) {
          await this._acceptLocalBytes(job, attempt, file, '本地原片');
          return true;
        }
      }
    } catch (e) { /* 本地恢复失败则走网络 */ }
    return false;
  }

  async _acceptLocalBytes(job, attempt, blob, source) {
    attempt.downloadCompleteAt = attempt.downloadCompleteAt || nowIso();
    attempt.remoteReleasedAt = attempt.remoteReleasedAt || nowIso();
    attempt.bytes = attempt.bytes || blob.size;
    job.state = 'checking'; job.error = null; job.downloadRecovery = false;
    await this.persist(true);
    this.logEvent('restored', `从${source}恢复原片，转入后台校验`, job.id);
    this._startLocalCheck(job);
    this.onJobUpdate(job);
  }

  // ---------- 后台技术校验（uid 去重；不阻塞下一镜） ----------
  _startLocalCheck(job) {
    if (this.localChecks.has(job.uid)) return;
    this.localChecks.add(job.uid);
    (async () => {
      try {
        await this._check(job);
      } finally {
        this.localChecks.delete(job.uid);
        this.persist();
      }
    })();
  }

  async _check(job) {
    const attempt = lastAttempt(job);
    const raw = attempt.rawBlobKey ? await blobStore.get(attempt.rawBlobKey) : null;
    if (!raw) { job.state = 'download'; job.error = null; job.downloadRecovery = true; this.onJobUpdate(job); return; }
    this.onJobUpdate(job);
    const { qa, frames } = await inspectVideoBlob(raw, { expectSeconds: job.seconds, aspect: job.aspect, onStage: s => this.onQueueState(`${job.id} ${s}`) });
    durationQA(qa, job.seconds); // 有效超长原片直接采用（第 34.8 章）
    attempt.qa = qa;
    attempt.blobKey = attempt.rawBlobKey;
    attempt.sha256 = attempt.rawSha256 || await sha256Hex(await raw.arrayBuffer());
    attempt.bytes = raw.size;
    attempt.path = `clips/${job.episode}/${job.id}_v${attempt.number}${attempt.downloadSequence > 1 ? `_d${attempt.downloadSequence}` : ''}.mp4`;
    attempt.frameKeys = []; attempt.frameDirectory = `checks/${job.id}_v${attempt.number}`;
    for (const f of frames) attempt.frameKeys.push(await blobStore.put(f.blob));
    if (qa.lastFrame) {
      attempt.lastFrameKey = await blobStore.put(qa.lastFrame);
      attempt.lastFramePath = `${attempt.frameDirectory}/last.png`;
      attempt.lastFrameSha256 = await sha256Hex(await qa.lastFrame.arrayBuffer());
    }
    const dir = this.hooks.getDirHandle?.();
    if (dir) {
      try {
        await writeFile(dir, attempt.path, raw);
        await writeFile(dir, `${attempt.frameDirectory}/report.json`, JSON.stringify({ job: job.id, attempt: attempt.number, qa: redact(qa), frames: frames.length }, null, 2));
        for (let i = 0; i < frames.length; i++) await writeFile(dir, `${attempt.frameDirectory}/frame_${i + 1}.jpg`, frames[i].blob);
        if (qa.lastFrame) await writeFile(dir, `${attempt.frameDirectory}/last.png`, qa.lastFrame);
      } catch (e) { job.error = `磁盘写入失败：${e.message}。浏览器副本已保留。`; }
    }
    if (qa.fatal.length) {
      job.state = 'needs_redo'; job.error = `技术检查未通过：${qa.fatal.join('；')}`;
      this.logEvent('check-failed', qa.fatal.join('；'), job.id);
    } else if (qa.technical === 'passed') {
      job.current = JSON.parse(JSON.stringify(attempt));
      job.state = 'ready'; job.error = null;
      this.logEvent('check-passed', '技术检查通过，等待人工内容审核', job.id);
    } else {
      job.state = 'blocked'; job.error = '本地校验未完成（完整解码未执行或检查中断），原文件已保留';
    }
    this.onJobUpdate(job);
  }

  // 页面内刷新（第 32.2 章）：Runner 停止时安全查询第一个在途原编号
  async safeRefresh() {
    if (this.running) { this.onJobUpdate(); return { ok: true, running: true }; }
    const job = this.project.jobs.find(j =>
      ['queued', 'generating', 'download', 'deferred', 'blocked'].includes(j.state) ||
      (j.state === 'pending' && lastAttempt(j)?.videoId && !lastAttempt(j).resolved && !lastAttempt(j).terminalConfirmed));
    if (!job) return { ok: true, nothing: true };
    const attempt = lastAttempt(job);
    if (!attempt?.videoId) return { ok: true, nothing: true };
    job.state = 'queued'; // 陈旧标签让位于已知编号
    const r = await this._poll(job);
    await this.persist();
    this.onJobUpdate(job);
    return { ok: true, job: job.id, result: r };
  }

  // 手动恢复入口
  async redownload(jobId) {
    const job = this._job(jobId); if (!job) return;
    const attempt = lastAttempt(job);
    if (!attempt?.url) { job.error = '没有已知的视频 URL'; return; }
    job.state = 'download'; job.error = null; job.downloadRecovery = false;
    attempt.downloadRetryAt = 0; // 立即尝试
    this.onJobUpdate(job);
    if (!this.running) await this.start();
  }

  async bindVideoId(jobId, videoId) {
    const job = this._job(jobId); const attempt = lastAttempt(job);
    if (!attempt) return false;
    const clean = String(videoId || '').trim(); if (!clean) return false;
    attempt.videoId = clean; attempt.resolved = true; attempt.acceptedAt = attempt.acceptedAt || nowIso(); attempt.boundBy = 'manual';
    job.state = 'queued'; job.error = null;
    this.logEvent('bound', `人工绑定 video_id=${clean}`, job.id);
    await this.persist();
    return true;
  }

  async markUncreated(jobId, evidence) {
    const job = this._job(jobId); const attempt = lastAttempt(job);
    if (!attempt) return false;
    attempt.uncreatedEvidence = String(evidence || '').trim() || '用户核实未创建';
    attempt.resolved = true; attempt.rejectedBeforeCreation = true;
    job.state = 'pending'; job.error = null;
    this.logEvent('uncreated', `已核实未创建：${attempt.uncreatedEvidence.slice(0, 80)}`, job.id);
    await this.persist();
    return true;
  }
}

function findVideoId(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.video_id === 'string' && json.video_id) return json.video_id;
  if (typeof json.videoId === 'string' && json.videoId) return json.videoId;
  for (const v of Object.values(json)) {
    if (v && typeof v === 'object') { const hit = findVideoId(v); if (hit) return hit; }
  }
  return null;
}

function redactRequest(payload) {
  const out = { model: payload.model, seconds: payload.seconds, mode: payload.mode, size: payload.size, aspect_ratio: payload.aspect_ratio, n: payload.n, prompt: payload.prompt };
  if (payload.seed !== undefined) out.seed = payload.seed;
  for (const k of ['images', 'audios']) if (payload[k]) out[k] = payload[k].map(() => '本地二进制素材，未导出');
  if (payload.first_frame) out.first_frame = '本地二进制素材，未导出';
  if (payload.last_frame) out.last_frame = '本地二进制素材，未导出';
  return out;
}

async function toDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('素材编码失败'));
    r.readAsDataURL(blob);
  });
}
