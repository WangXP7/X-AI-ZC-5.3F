// core.js — 通用规则、状态标签、校验与脱敏。全部为纯函数，不接触 DOM。
// 设计依据：docs/X-AI详细设计文档.md 第 8、9、12 章。

export const SCHEMA = 'x-ai-project-v1';
export const MODEL_ID = 'agnes-video-2.5-flash';
export const MODEL_DISPLAY = 'AgnesAI · Agnes Video 2.5 Flash · 720P · 最长 12 秒';
export const ORIGINS = ['https://api.agnes-ai.cn', 'https://apihub.agnes-ai.com'];
export const ASPECT_DIMS = {
  '9:16': [720, 1280], '16:9': [1280, 704], '1:1': [720, 720],
  '4:3': [960, 720], '3:4': [720, 960], '21:9': [1680, 720],
};
export const AUTH_GAP_MIN = 90;          // 每次认证请求最小间隔（秒）
export const PROMPT_MAX = 12000;         // JS 字符串长度计数（不是 token，也不是字节数）
export const SEED_MAX = 2147483647;
export const IMAGE_BYTES_MAX_EXCL = 15_000_000;   // API 参考文件 <15MB
export const IMAGE_BYTES_IMPORT_MAX_EXCL = 150_000_000; // 可导入但超请求限制
export const IMAGE_W_MINMAX = [256, 5760];
export const IMAGE_RATIO_MINMAX = [0.4, 2.5];
export const IMAGES_MAX = 5;
export const AUDIOS_MAX = 3;
export const AUDIO_SECONDS_RANGE = [2, 12.001];
export const REQUEST_BODY_MAX_EXCL = 50_000_000;
export const DOWNLOAD_MAX_BYTES = 512_000_000;
export const JOBS_MAX = 1000;

// ---------- 基础工具 ----------
export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function nowIso() { return new Date().toISOString(); }

export async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 脱敏：去掉敏感命名字段、sk- 字符串与完整 Data URI。程序规则，不是通用 DLP。
const SENSITIVE_KEY = /key|token|secret|password|authorization|credential/i;
export function redact(value) {
  if (typeof value === 'string') {
    return value
      .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
      .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/gi, '本地二进制素材，未导出');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '***' : redact(v);
    return out;
  }
  return value;
}

export function bytesHuman(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ---------- ID / 名称规则（第 9.2 章） ----------
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'lpt1']);
export function isSafeId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s) && !RESERVED.has(s.toLowerCase());
}
export function safeFilePart(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || '_';
}

// ---------- 项目 / Job ----------
export function makeProject(name = '我的视频项目') {
  const t = nowIso();
  return {
    schema: SCHEMA, id: uuid(), name, createdAt: t, updatedAt: t,
    settings: { origin: ORIGINS[0], connection: 'direct', gap: AUTH_GAP_MIN },
    jobs: [], assets: [], episodes: [], events: [],
  };
}

export function newJob(spec) {
  const t = nowIso();
  return {
    uid: uuid(), id: spec.id, episode: spec.episode, episodeTitle: spec.episodeTitle || '',
    prompt: spec.prompt, dialogue: spec.dialogue || '', seconds: spec.seconds, aspect: spec.aspect,
    mode: spec.mode, seed: spec.seed ?? null, assetIds: spec.assetIds || [],
    firstFrame: spec.firstFrame || null, lastFrame: spec.lastFrame || null,
    continuityFrom: spec.continuityFrom || null, sourceReferences: spec.sourceReferences || [],
    textSources: spec.textSources || [], referenceReplacements: spec.referenceReplacements || [],
    state: 'pending', review: 'pending', attempts: [], current: null,
    error: null, progress: 0, revisionReason: '',
    createdAt: t, updatedAt: t, reviewedAt: null,
  };
}

export function validateProjectFile(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['项目文件不是 JSON 对象'];
  if (p.schema !== SCHEMA) errs.push(`schema 不是 ${SCHEMA}`);
  if (!Array.isArray(p.jobs)) errs.push('jobs 缺失或不是数组');
  if (p.jobs?.length > JOBS_MAX) errs.push(`任务数超过 ${JOBS_MAX}`);
  const seenUid = new Set(); const seenId = new Set();
  for (const j of p.jobs || []) {
    if (!j.uid || seenUid.has(j.uid)) errs.push(`任务 ${j.id || '?'} 缺少 uid 或重复`);
    seenUid.add(j.uid);
    if (seenId.has(j.id)) errs.push(`镜号重复：${j.id}`);
    seenId.add(j.id);
    for (const [k, bad] of [['path', /(^|[\\/])\.\.($|[\\/])|^[A-Za-z]:|^\//], ['rawPath', /(^|[\\/])\.\.($|[\\/])|^[A-Za-z]:|^\//]]) {
      if (j.current?.[k] && bad.test(j.current[k])) errs.push(`任务 ${j.id} 的 ${k} 含不允许的路径`);
    }
    if (j.state && !STATE_LABELS[j.state]) errs.push(`任务 ${j.id} 状态未知：${j.state}`);
  }
  // 只允许一个在途（submitting / unknown）任务
  const inflight = (p.jobs || []).filter(j => j.state === 'submitting' || j.state === 'unknown');
  if (inflight.length > 1) errs.push(`发现 ${inflight.length} 个在途任务，最多允许 1 个`);
  if (!p.settings || typeof p.settings !== 'object') errs.push('settings 缺失');
  else if (p.settings.origin && !ORIGINS.includes(p.settings.origin)) errs.push('settings.origin 不在允许的域名列表');
  return errs;
}

export const STATE_LABELS = {
  draft: '草稿', invalid: '素材需处理', pending: '审核通过 · 待提交', submitting: '正在提交',
  unknown: '提交结果待核实', queued: '服务端排队', generating: '生成中', deferred: '退避等待',
  download: '待下载', checking: '本地校验中', ready: '已生成 · 待内容审核', approved: '内容审核通过',
  needs_redo: '不合格待处理', failed: '生成失败', blocked: '需处理后继续',
};
export function stateBadgeKind(state) {
  switch (state) {
    case 'ready': case 'approved': return 'ok';
    case 'needs_redo': case 'failed': return 'bad';
    case 'blocked': case 'unknown': case 'deferred': case 'invalid': return 'warn';
    case 'queued': case 'generating': case 'submitting': case 'download': case 'checking': return 'run';
    default: return '';
  }
}
const ASSET_LABELS = { success: '完成', warning: '待处理', duplicate: '复用', skipped: '跳过', error: '失败' };
export const ASSET_STATUS_LABELS = ASSET_LABELS;

// ---------- Job 校验（入队整批检查点，第 5.4 / 9 章） ----------
export function validateJob(job, project, extraJobs = []) {
  const errors = []; const warnings = [];
  const all = [...(project?.jobs || []), ...extraJobs].filter(j => j !== job);

  if (!isSafeId(job.id)) errors.push(`镜号「${job.id || '空'}」不合法：需字母/数字开头，仅字母数字下划线短横线，≤64 位`);
  else if (all.some(j => j.id === job.id)) errors.push(`镜号「${job.id}」已存在`);
  if (!isSafeId(job.episode)) errors.push(`分组「${job.episode || '空'}」不合法`);
  if (typeof job.prompt !== 'string' || !job.prompt.trim()) errors.push('画面与动作不能为空');
  else if (job.prompt.length > PROMPT_MAX) errors.push(`画面与动作超过 ${PROMPT_MAX} 字（当前 ${job.prompt.length}）`);
  if (!Number.isInteger(job.seconds) || job.seconds < 4 || job.seconds > 12) errors.push('时长必须为 4–12 秒整数');
  if (!ASPECT_DIMS[job.aspect]) errors.push(`画幅 ${job.aspect} 不受支持`);
  if (job.seed !== null && job.seed !== undefined && (!Number.isInteger(job.seed) || job.seed < 0 || job.seed > SEED_MAX)) errors.push('随机种子须为 0–2147483647 整数或留空');

  const images = job.assetIds.map(id => project.assets.find(a => a.id === id)).filter(a => a && a.kind === 'image');
  const audios = job.assetIds.map(id => project.assets.find(a => a.id === id)).filter(a => a && a.kind === 'audio');
  const missing = job.assetIds.filter(id => !project.assets.some(a => a.id === id));
  for (const id of missing) errors.push(`引用的素材不存在：${id.slice(0, 8)}…`);

  if (job.mode === 'text') {
    if (job.assetIds.length) errors.push('文字生成不能携带参考素材');
    if (job.firstFrame || job.lastFrame) errors.push('文字生成不能携带首尾帧');
    if (job.continuityFrom) errors.push('文字生成不能衔接前镜画面');
  } else if (job.mode === 'reference') {
    if (!job.assetIds.length && !job.continuityFrom) errors.push('参考生成至少需要一个参考素材或有效的前镜衔接');
    if (job.firstFrame || job.lastFrame) errors.push('参考生成不能指定首尾帧');
  } else if (job.mode === 'keyframe') {
    if (!job.firstFrame && !job.lastFrame) errors.push('首尾帧生成至少需要一帧');
    if (job.assetIds.some(id => audios.some(a => a.id === id))) errors.push('首尾帧生成不能携带参考声音');
    if (job.continuityFrom) errors.push('首尾帧生成不能衔接前镜画面');
  } else errors.push(`生成方式 ${job.mode} 未知`);

  if (images.length > IMAGES_MAX) errors.push(`参考图最多 ${IMAGES_MAX} 张（当前 ${images.length}）`);
  if (audios.length > AUDIOS_MAX) errors.push(`参考声音最多 ${AUDIOS_MAX} 段（当前 ${audios.length}）`);
  const audioDur = audios.reduce((s, a) => s + (a.duration || 0), 0);
  if (audios.length && (audioDur < AUDIO_SECONDS_RANGE[0] || audioDur > AUDIO_SECONDS_RANGE[1])) {
    errors.push(`声音总时长须在 2–12 秒（当前 ${audioDur.toFixed(2)} 秒）`);
  }
  for (const a of [...images, ...audios]) {
    if (a.kind === 'image') {
      if (a.bytes >= IMAGE_BYTES_MAX_EXCL) errors.push(`图片「${a.name}」超过 15MB，不能作为请求输入`);
      if ((a.errors || []).length) warnings.push(`图片「${a.name}」存在待处理问题：${a.errors.join('；')}`);
    }
  }
  // 请求体估算：文本 + Base64 素材（约 +1/3）
  let bodyBytes = job.prompt.length + (job.dialogue?.length || 0);
  for (const id of job.assetIds) {
    const a = project.assets.find(x => x.id === id);
    if (a) bodyBytes += Math.ceil((a.bytes || 0) * 4 / 3);
  }
  if (bodyBytes >= REQUEST_BODY_MAX_EXCL) errors.push(`请求体估算 ${bytesHuman(bodyBytes)} 超过 50MB 上限，请减少素材`);

  const dcount = (job.dialogue || '').replace(/\s/g, '').length;
  if (job.dialogue && job.seconds > 0 && dcount / job.seconds > 5) warnings.push(`对白密度较高（约 ${(dcount / job.seconds).toFixed(1)} 字/秒），可能出现赶词`);
  return { errors, warnings };
}

// ---------- 请求构造（第 17.2 章） ----------
// imageNames：与 job.assetIds 中图片顺序一致的文件名数组（用于 <Picture n> 说明）。
export function buildRunConstraints(job, imageNames = []) {
  const lines = ['【X-AI运行约束】'];
  const [w, h] = ASPECT_DIMS[job.aspect] || [720, 1280];
  const orient = (job.aspect === '9:16' || job.aspect === '3:4') ? '竖屏' : (job.aspect === '1:1' ? '方形' : '横屏');
  lines.push(`- 画幅 ${job.aspect}（${orient} ${w}×${h}）：主体完整填充画面，避免黑边、水印与字幕。`);
  if (job.mode === 'reference') {
    imageNames.forEach((name, i) => {
      lines.push(`- <Picture ${i + 1}>（${name}）作为参考，保持人物 / 场景身份一致；不要复刻参考板的白底拼贴版式。`);
    });
  }
  if (job.continuityFrom) lines.push(`- 本镜延续「${job.continuityFrom}」结束时的画面状态：保持角色、道具、视线与方向连贯。`);
  return lines.join('\n');
}

export function buildRequestPrompt(job, imageNames = []) {
  let p = job.prompt.trim();
  const dialogue = (job.dialogue || '').trim();
  if (dialogue) {
    p += `\n\n【对白约束】画面中角色只说出以下指定对白，不要朗读动作说明、旁白或字幕内容：\n「${dialogue}」`;
  }
  p += '\n\n' + buildRunConstraints(job, imageNames);
  return p;
}
