// engine.js — 认证节流（每次认证请求 ≥90 秒）、创建 / 查询 / 下载、尝试状态与结果接受。
// 设计依据：docs/X-AI详细设计文档.md 第 12、13、17 章。
// 铁律：未知 POST 不自动重发；查询失败沿原 video_id；用户未启动队列不创建。
import { uuid, nowIso, redact, sha256Hex, buildRequestPrompt, MODEL_ID, STATE_LABELS,
         DOWNLOAD_MAX_BYTES, AUTH_GAP_MIN } from './core.js';
import { blobStore, saveProject, loadRate, saveRate, writeFile } from './storage.js';
import { inspectVideoBlob } from './media.js';

// ---------- Transport：90 秒认证节流 ----------
export class Transport {
  constructor({ getSettings, onAuthWait } = {}) {
    this.getSettings = getSettings || (() => ({ origin: 'https://api.agnes-ai.cn', gap: AUTH_GAP_MIN, key: null }));
    this.onAuthWait = onAuthWait || (() => {});
  }

  // 认证请求（计入 90 秒槽）。返回 {ok, status, json, text}
  async api(method, path, { jsonBody = null, timeoutMs = 180000 } = {}) {
    const settings = this.getSettings();
    if (!settings.key) return { ok: false, status: 0, error: 'no-key', message: '未启用密钥：请填写自己的 KEY 或启用默认配置。' };
    const gapMs = Math.max(AUTH_GAP_MIN, settings.gap || AUTH_GAP_MIN) * 1000;
    const rate = (await loadRate()) || { last: 0, notBefore: 0 };
    const nextAt = Math.max((rate.last || 0) + gapMs, rate.notBefore || 0);
    const waitMs = nextAt - Date.now();
    if (waitMs > 0) this.onAuthWait(Math.ceil(waitMs / 1000));
    await sleep(Math.max(0, waitMs));
    // 先保存时间槽，再发请求（失败也占槽）
    await saveRate({ last: Date.now(), notBefore: rate.notBefore || 0 });

    const url = settings.origin + path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${settings.key}`,
          ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
        redirect: 'error',        // 拒绝认证重定向
        credentials: 'omit',
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { ok: res.ok, status: res.status, json: parsed, text };
    } catch (e) {
      return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : 'network', message: String(e.message || e) };
    } finally { clearTimeout(timer); }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Runner ----------
export class Runner {
  constructor({ project, persist, transport, mediaDir, logEvent, onJobUpdate, onQueueState, hooks = {} }) {
    this.project = project;       // 引用 app 的活动 project 对象
    this.persist = persist;       // async (toDisk=false) => {}
    this.transport = transport;
    this.logEvent = logEvent;     // (kind, message, jobId) => {}
    this.onJobUpdate = onJobUpdate || (() => {});
    this.onQueueState = onQueueState || (() => {});
    this.mediaDir = mediaDir;     // null、{dirHandle} 或 () => {dirHandle}
    this.hooks = hooks;           // {readAssetBlob(asset), toast(msg, kind)}
    this.running = false;
    this.pausedNew = false;       // 暂停新提交：允许当前任务继续，到边界停止
    this.stopFlag = false;
  }

  getDirHandle() {
    const md = typeof this.mediaDir === 'function' ? this.mediaDir() : this.mediaDir;
    return md?.dirHandle || null;
  }

  setProject(p) { this.project = p; }
  setMediaDir(dir) { this.mediaDir = dir; }

  async start() {
    if (this.running) return;
    if (navigator.locks) {
      const ok = await navigator.locks.request('x-ai-production-runner', { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        await this._loop();
        return true;
      });
      if (!ok) { this.onQueueState('另一个页面正在运行队列'); return; }
    } else {
      await this._loop();
    }
  }

  stop() { this.stopFlag = true; }

  _job(id) { return this.project.jobs.find(j => j.id === id); }

  async _loop() {
    this.running = true; this.stopFlag = false;
    this.onQueueState('队列运行中');
    try {
      for (;;) {
        if (this.stopFlag) break;
        const jobs = this.project.jobs;
        // 1. 在途任务优先（第 12.2 章）
        const active = jobs.find(j => ['queued', 'generating', 'download', 'checking', 'deferred', 'blocked'].includes(j.state));
        if (active) {
          await this._step(active);
          continue;
        }
        if (jobs.some(j => j.state === 'submitting' || j.state === 'unknown')) {
          this.onQueueState('存在待核实的提交，已暂停整队');
          break;
        }
        if (this.pausedNew) { this.onQueueState('已暂停新提交（当前任务已处理完成）'); break; }
        const next = jobs.find(j => j.state === 'pending');
        if (!next) { this.onQueueState('队列空闲：没有待提交的任务'); break; }
        await this._submit(next);
        await this.persist();
      }
    } finally {
      this.running = false;
      this.onQueueState(this.stopFlag ? '队列已停止' : '队列空闲');
    }
  }

  // ---------- 单步：按状态推进 ----------
  async _step(job) {
    this.onJobUpdate(job);
    switch (job.state) {
      case 'queued': case 'generating': return this._poll(job);
      case 'download': return this._download(job);
      case 'checking': return this._check(job);
      case 'deferred': return this._deferredWait(job);
      case 'blocked': this.onQueueState(`任务 ${job.id} 需处理：${job.error || ''}`); this.stopFlag = true; return;
      default: return;
    }
  }

  // ---------- 提交（第 12.4 / 12.5 章） ----------
  async _submit(job) {
    const attempt = {
      number: job.attempts.length + 1, createdAt: nowIso(), reason: job.revisionReason || '首次生成',
      snapshot: {
        prompt: job.prompt, dialogue: job.dialogue, seconds: job.seconds, aspect: job.aspect,
        mode: job.mode, seed: job.seed, assetIds: [...job.assetIds],
        firstFrame: job.firstFrame, lastFrame: job.lastFrame, continuityFrom: job.continuityFrom,
      },
      inputHashes: {}, videoId: null, taskId: null, response: null, submitError: null,
      pollResponse: null, polledAt: null, url: null,
      deferrals: 0, queuePolls: 0, pollErrors: 0,
      resolved: false, terminalConfirmed: false, rejectedBeforeCreation: false, uncreatedEvidence: null,
      rawBlobKey: null, rawPath: null, rawSha256: null,
      blobKey: null, path: null, sha256: null, bytes: 0, downloadedAt: null, qa: null,
      frameDirectory: null, frameKeys: [], lastFrameKey: null, lastFramePath: null, lastFrameSha256: null,
      continuityInput: null, downloadSequence: 0, downloadHistory: [],
    };
    // 读取素材字节（回读 + 哈希核对）
    const images = []; const audios = []; const imageNames = [];
    try {
      for (const id of job.assetIds) {
        const asset = this.project.assets.find(a => a.id === id);
        if (!asset) throw new Error(`素材记录缺失：${id}`);
        const blob = await this.hooks.readAssetBlob(asset);
        if (!blob) throw new Error(`素材字节不可读：${asset.name}`);
        const sha = await sha256Hex(await blob.arrayBuffer());
        const expect = asset.sha256;
        if (expect && sha !== expect) throw new Error(`素材 ${asset.name} 内容与记录哈希不一致，请重新导入`);
        attempt.inputHashes[asset.name] = sha;
        if (asset.kind === 'image') { images.push(blob); imageNames.push(asset.name); }
        else audios.push(blob);
      }
    } catch (e) {
      job.state = 'blocked'; job.error = `素材回读失败：${e.message}`;
      this.logEvent('submit-blocked', job.error, job.id);
      return;
    }
    // 衔接前镜末帧
    if (job.continuityFrom && job.mode === 'reference') {
      const prev = this.project.jobs.find(j => j.id === job.continuityFrom);
      if (!prev || !prev.current?.lastFrameKey) {
        job.state = 'blocked'; job.error = `前镜 ${job.continuityFrom} 没有可用的结束画面`;
        this.logEvent('submit-blocked', job.error, job.id);
        return;
      }
      const frameBlob = await blobStore.get(prev.current.lastFrameKey);
      if (!frameBlob) { job.state = 'blocked'; job.error = `前镜 ${job.continuityFrom} 结束画面数据缺失`; return; }
      images.push(frameBlob); imageNames.push(`${job.continuityFrom}-末帧.png`);
      attempt.continuityInput = { fromJob: prev.id, frameSha256: prev.current.lastFrameSha256, videoSha256: prev.current.sha256 };
    }

    const requestPrompt = buildRequestPrompt(job, imageNames);
    const payload = {
      model: MODEL_ID,
      seconds: String(job.seconds),
      mode: job.mode,
      size: '720P',
      aspect_ratio: job.aspect,
      n: 1,
    };
    if (job.seed !== null && job.seed !== undefined) payload.seed = job.seed;
    if (job.mode === 'keyframe') {
      if (job.firstFrame) payload.first_frame = await toDataUri(await blobStore.get(job.firstFrame));
      if (job.lastFrame) payload.last_frame = await toDataUri(await blobStore.get(job.lastFrame));
    }
    payload.prompt = requestPrompt;
    if (job.mode === 'reference') {
      // 真实文件经 FileReader 编码为 Data URI 随请求发送（第 17.3 章）
      payload.images = await Promise.all(images.map(b => toDataUri(b)));
      payload.audios = audios.length ? await Promise.all(audios.map(b => toDataUri(b))) : undefined;
      if (!payload.audios) delete payload.audios;
    }

    // 请求脱敏摘要 + requestHash（可复核，不可还原）
    const redactedRequest = { model: payload.model, seconds: payload.seconds, mode: payload.mode, size: payload.size, aspect_ratio: payload.aspect_ratio, n: payload.n, prompt: payload.prompt };
    if (payload.seed !== undefined) redactedRequest.seed = payload.seed;
    if (payload.images) redactedRequest.images = payload.images.map(() => '本地二进制素材，未导出');
    if (payload.audios) redactedRequest.audios = payload.audios.map(() => '本地二进制素材，未导出');
    if (payload.first_frame) redactedRequest.first_frame = '本地二进制素材，未导出';
    if (payload.last_frame) redactedRequest.last_frame = '本地二进制素材，未导出';
    attempt.request = redactedRequest;
    attempt.requestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ model: payload.model, seconds: payload.seconds, prompt: payload.prompt })));

    job.state = 'submitting'; job.error = null; job.updatedAt = nowIso();
    attempt.submittedAt = nowIso();
    job.attempts.push(attempt);
    await this.persist(true); // 磁盘检查点
    this.logEvent('submit', `第 ${attempt.number} 次尝试提交（${job.mode}）`, job.id);

    const res = await this.transport.api('POST', '/v1/videos', { jsonBody: payload });
    attempt.response = { status: res.status, body: res.json ? redact(res.json) : (res.text || '').slice(0, 2000) };

    if (res.ok && res.json) {
      const vid = findVideoId(res.json);
      if (vid) {
        attempt.videoId = vid; attempt.resolved = true;
        job.state = 'queued'; job.progress = 0; job.error = null;
        this.logEvent('queued', `已接受：video_id=${vid}`, job.id);
      } else if (res.json.task_id || res.json.id) {
        attempt.taskId = res.json.task_id || res.json.id;
        job.state = 'unknown'; job.error = '服务返回 task_id 但没有 video_id：task_id 不一定可查询视频，请人工核实后再继续。';
        this.logEvent('unknown', '创建响应缺少 video_id', job.id);
      } else {
        job.state = 'unknown'; job.error = '创建响应无法识别（无 video_id）。';
      }
    } else if (res.status === 429 && /rate_limit/i.test(res.text || '')) {
      attempt.rejectedBeforeCreation = true; attempt.resolved = true;
      attempt.deferrals++;
      const wait = backoffSeconds(attempt.deferrals);
      job.state = 'deferred'; job.error = `限流：${wait} 秒后最早重试`;
      attempt.notBefore = Date.now() + wait * 1000;
      this.logEvent('deferred', `429 限流，退避 ${wait}s`, job.id);
    } else if (res.status === 503 && /queue_full/i.test(res.text || '')) {
      attempt.rejectedBeforeCreation = true; attempt.resolved = true;
      attempt.deferrals++;
      const wait = backoffSeconds(attempt.deferrals);
      job.state = 'deferred'; job.error = `服务端队列满：${wait} 秒后最早重试`;
      attempt.notBefore = Date.now() + wait * 1000;
    } else if ([400, 401, 403, 422].includes(res.status)) {
      attempt.rejectedBeforeCreation = true; attempt.resolved = true;
      attempt.terminalConfirmed = true;
      job.state = 'failed'; job.error = `创建被拒绝（HTTP ${res.status}）：${(res.json?.error?.message || res.text || '').slice(0, 200)}`;
      this.logEvent('failed', job.error, job.id);
      if (res.status === 401 || res.status === 403) { this.pausedNew = true; this.onQueueState('认证被拒绝，已暂停新提交'); this.hooks.onAuthRejected?.(); }
    } else {
      // 网络错误 / 5xx / 非 JSON / 超时：可能已创建收费任务 → unknown，不自动重发
      job.state = 'unknown';
      job.error = `提交结果未知（${res.error === 'timeout' ? '超时' : res.status ? 'HTTP ' + res.status : '网络错误'}）。可能已创建收费任务，请核实后再继续，不要盲目重发。`;
      this.logEvent('unknown', job.error, job.id);
    }
    this.onJobUpdate(job);
  }

  // ---------- 查询（沿原 video_id） ----------
  async _poll(job) {
    const attempt = lastAttempt(job);
    if (!attempt?.videoId) {
      job.state = 'unknown'; job.error = '缺少 video_id，无法查询';
      return;
    }
    const res = await this.transport.api('GET', `/agnesapi?video_id=${encodeURIComponent(attempt.videoId)}&model_name=${MODEL_ID}`);
    attempt.polledAt = nowIso();
    if (res.ok && res.json) {
      attempt.pollResponse = redact(res.json);
      const st = String(res.json.status || res.json.state || '').toLowerCase();
      const url = res.json.url || res.json.video_url || res.json.output?.url || res.json.data?.[0]?.url || null;
      if (['completed', 'success', 'succeeded', 'done'].includes(st) && url) {
        if (typeof url === 'string' && url.startsWith('https://') && !url.includes('@')) {
          attempt.url = url;
          job.state = 'download'; job.error = null;
        } else { job.state = 'blocked'; job.error = '完成但返回的下载地址不可用（需公网 HTTPS 且无内嵌凭据）'; }
      } else if (['completed', 'success', 'succeeded', 'done'].includes(st) && !url) {
        job.state = 'blocked'; job.error = '服务商报告完成但没有返回视频 URL';
      } else if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) {
        attempt.resolved = true; attempt.terminalConfirmed = true;
        job.state = 'failed'; job.error = `服务商确认失败：${st}`;
      } else {
        // 未知非终止状态保守显示生成中，不猜失败
        job.state = 'generating';
        const p = Number(res.json.progress ?? res.json.percent);
        if (Number.isFinite(p)) job.progress = Math.max(0, Math.min(100, p));
      }
    } else if (res.status === 0) {
      attempt.pollErrors++;
      job.error = '查询网络错误：保留原 video_id，稍后继续查询。';
      await sleep(Math.min(60000, 5000 * attempt.pollErrors));
    } else if ([400, 401, 403, 404].includes(res.status)) {
      job.state = 'blocked'; job.error = `查询返回 HTTP ${res.status}：请检查密钥 / 任务状态后继续原任务`;
      this.stopFlag = true;
    } else {
      attempt.pollErrors++;
      await sleep(10000);
    }
    this.onJobUpdate(job);
  }

  // ---------- 退避等待 ----------
  async _deferredWait(job) {
    const attempt = lastAttempt(job);
    const nb = attempt?.notBefore || 0;
    const waitMs = nb - Date.now();
    if (waitMs > 0) {
      this.onQueueState(`任务 ${job.id} 退避等待 ${Math.ceil(waitMs / 1000)} 秒`);
      await sleep(Math.min(waitMs, 5000));
      return; // 保持 deferred，循环回来再看
    }
    job.state = 'pending'; job.error = null;
    // 明确未创建的限流允许安全重试：同一次尝试保留证据，新一轮 POST 建立新尝试
    this.onJobUpdate(job);
  }

  // ---------- 下载（第 13.1 章 1–2 步） ----------
  async _download(job) {
    const attempt = lastAttempt(job);
    if (!attempt?.url) { job.state = 'blocked'; job.error = '没有可下载的 URL'; return; }
    this.onJobUpdate(job);
    try {
      // CDN 下载不带 Authorization；HTTPS 且无内嵌凭据
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);
      const res = await fetch(attempt.url, { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('Content-Length') || 0);
      if (len > DOWNLOAD_MAX_BYTES) throw new Error(`文件 ${len} 字节超过 512MB 下载上限`);
      const blob = await res.blob();
      if (blob.size > DOWNLOAD_MAX_BYTES) throw new Error('下载内容超过 512MB 上限');
      attempt.downloadSequence++;
      const rawSha = await sha256Hex(await blob.arrayBuffer());
      // 同一 video_id 重新下载得到不同字节时保留历史
      if (attempt.rawSha256 && attempt.rawSha256 !== rawSha) {
        attempt.downloadHistory.push({ seq: attempt.downloadSequence - 1, sha256: attempt.rawSha256, path: attempt.rawPath, blobKey: attempt.rawBlobKey });
      }
      attempt.rawBlobKey = await blobStore.put(blob);
      attempt.rawSha256 = rawSha;
      attempt.rawPath = `raw/${job.episode}/${job.id}_v${attempt.number}${attempt.downloadSequence > 1 ? `_d${attempt.downloadSequence}` : ''}.mp4`;
      job.state = 'checking'; job.error = null;
      this.logEvent('downloaded', `${bytesHuman(blob.size)} sha256=${rawSha.slice(0, 12)}…`, job.id);
    } catch (e) {
      job.error = `下载失败：${e.message}。可重试下载，无需新生成。`;
      this.stopFlag = true; // blocked 边界：等用户操作
      job.state = 'blocked';
    }
    this.onJobUpdate(job);
  }

  // ---------- 本地校验（第 13.1 章 3–8 步） ----------
  async _check(job) {
    const attempt = lastAttempt(job);
    const raw = attempt.rawBlobKey ? await blobStore.get(attempt.rawBlobKey) : null;
    if (!raw) { job.state = 'download'; job.error = '原始下载缺失，需要重新下载'; return; }
    this.onJobUpdate(job);
    const { qa, frames } = await inspectVideoBlob(raw, { expectSeconds: job.seconds, aspect: job.aspect, onStage: s => this.onQueueState(`${job.id} ${s}`) });
    attempt.qa = qa;
    // 经检查登记
    attempt.blobKey = attempt.rawBlobKey;
    attempt.sha256 = attempt.rawSha256;
    attempt.bytes = raw.size;
    attempt.downloadedAt = nowIso();
    attempt.path = `clips/${job.episode}/${job.id}_v${attempt.number}${attempt.downloadSequence > 1 ? `_d${attempt.downloadSequence}` : ''}.mp4`;
    // 抽帧与末帧保存
    attempt.frameKeys = []; attempt.frameDirectory = `checks/${job.id}_v${attempt.number}`;
    for (const f of frames) {
      const key = await blobStore.put(f.blob);
      attempt.frameKeys.push(key);
    }
    if (qa.lastFrame) {
      attempt.lastFrameKey = await blobStore.put(qa.lastFrame);
      attempt.lastFramePath = `${attempt.frameDirectory}/last.png`;
      attempt.lastFrameSha256 = await sha256Hex(await qa.lastFrame.arrayBuffer());
    }
    if (this.getDirHandle()) {
      try {
        const dir = this.getDirHandle();
        await writeFile(dir, attempt.path, raw);
        await writeFile(dir, `${attempt.frameDirectory}/report.json`, JSON.stringify({ job: job.id, attempt: attempt.number, qa: redact(qa), frames: frames.length }, null, 2));
        for (let i = 0; i < frames.length; i++) await writeFile(dir, `${attempt.frameDirectory}/frame_${i + 1}.jpg`, frames[i].blob);
        if (qa.lastFrame) await writeFile(dir, `${attempt.frameDirectory}/last.png`, qa.lastFrame);
      } catch (e) {
        job.error = `磁盘写入失败：${e.message}。浏览器副本已保留，重新授权后可继续。`;
      }
    }
    if (qa.fatal.length) {
      job.state = 'needs_redo'; job.error = `技术检查未通过：${qa.fatal.join('；')}`;
      this.logEvent('check-failed', qa.fatal.join('；'), job.id);
    } else if (qa.technical === 'passed') {
      job.current = JSON.parse(JSON.stringify(attempt)); // current 为尝试副本
      job.state = 'ready'; job.error = null;
      this.logEvent('check-passed', '技术检查通过，等待人工内容审核', job.id);
    } else {
      job.state = 'blocked'; job.error = '本地校验未完成（完整解码未执行或检查中断），原始文件已保留';
    }
    this.onJobUpdate(job);
  }

  // 重新下载（不创建新视频）
  async redownload(jobId) {
    const job = this._job(jobId);
    if (!job) return;
    const attempt = lastAttempt(job);
    if (!attempt?.url) { job.error = '没有已知的视频 URL'; return; }
    job.state = 'download'; job.error = null;
    this.onJobUpdate(job);
    if (!this.running) { await this.start(); }
  }

  // 手动绑定 video_id（unknown 恢复）
  async bindVideoId(jobId, videoId) {
    const job = this._job(jobId);
    const attempt = lastAttempt(job);
    if (!attempt) return false;
    const clean = String(videoId || '').trim();
    if (!clean) return false;
    attempt.videoId = clean; attempt.resolved = true;
    attempt.boundBy = 'manual';
    job.state = 'queued'; job.error = null;
    this.logEvent('bound', `人工绑定 video_id=${clean}`, job.id);
    await this.persist();
    return true;
  }

  // 记录“已核实未创建”（unknown → pending，需依据）
  async markUncreated(jobId, evidence) {
    const job = this._job(jobId);
    const attempt = lastAttempt(job);
    if (!attempt) return false;
    attempt.uncreatedEvidence = String(evidence || '').trim() || '用户核实未创建';
    attempt.resolved = true; attempt.rejectedBeforeCreation = true;
    job.state = 'pending'; job.error = null;
    this.logEvent('uncreated', `已核实未创建：${attempt.uncreatedEvidence.slice(0, 80)}`, job.id);
    await this.persist();
    return true;
  }
}

function backoffSeconds(level) {
  return Math.min(3600, AUTH_GAP_MIN * Math.pow(2, Math.min(level, 6)));
}

async function toDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('素材编码失败'));
    r.readAsDataURL(blob);
  });
}

export function lastAttempt(job) { return job.attempts?.at(-1) || null; }

function findVideoId(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.video_id === 'string' && json.video_id) return json.video_id;
  if (typeof json.videoId === 'string' && json.videoId) return json.videoId;
  for (const v of Object.values(json)) {
    if (v && typeof v === 'object') { const hit = findVideoId(v); if (hit) return hit; }
  }
  return null;
}

function bytesHuman(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
