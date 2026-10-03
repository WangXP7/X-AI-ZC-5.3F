// core.js — 通用规则、状态标签、校验与脱敏。全部为纯函数，不接触 DOM。
// 设计依据：docs/X-AI详细设计文档.md 第 8、9、12、27、34、36 章。
import { MODEL_PROFILES, DEFAULT_PROFILE_ID, modeLimits } from './models.js';

export const SCHEMA = 'x-ai-project-v1';
export const MODEL_ID = 'agnes-video-2.5-flash';
export const MODEL_DISPLAY = 'AgnesAI · Agnes Video 2.5 Flash · 720P · 请求上限 12 秒';
export const ORIGINS = ['https://api.agnes-ai.cn', 'https://apihub.agnes-ai.com'];
export const ASPECT_DIMS = {
  '9:16': [720, 1280], '16:9': [1280, 704], '1:1': [720, 720],
  '4:3': [960, 720], '3:4': [720, 960], '21:9': [1680, 720],
};
export const AUTH_GAP_MIN = 90;          // 1.2.5 起由 request-pacing 接管；此处仅保留常量供旧代码兼容
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
  const studioId = uuid();
  return {
    schema: SCHEMA, id: uuid(), name, createdAt: t, updatedAt: t,
    settings: { origin: ORIGINS[0], connection: 'direct', gap: AUTH_GAP_MIN, submitGapSeconds: 61 },
    studios: [{ id: studioId, name, createdAt: t, assetIds: [], archivedAssetIds: [], draft: null }],
    activeStudioId: studioId,
    jobs: [], assets: [], episodes: [], events: [],
    queueControl: { paused: false },
  };
}

// ensureStudios：为没有 studios 的旧记录创建初始成员，把现有 Assets 纳入（第 27.7 章）。
export function ensureStudios(project) {
  if (!Array.isArray(project.studios) || !project.studios.length) {
    project.studios = [{
      id: uuid(), name: project.name || '我的视频项目', createdAt: nowIso(),
      assetIds: (project.assets || []).map(a => a.id),
      archivedAssetIds: [], draft: null,
    }];
  }
  if (!project.studios.some(s => s.id === project.activeStudioId)) {
    project.activeStudioId = project.studios[0].id;
  }
  // 成员存在性：剔除指向不存在 Asset 的成员
  const ids = new Set((project.assets || []).map(a => a.id));
  for (const s of project.studios) {
    s.assetIds = (s.assetIds || []).filter(id => ids.has(id));
    s.archivedAssetIds = (s.archivedAssetIds || []).filter(id => ids.has(id));
  }
  return project;
}

export function activeStudio(project) {
  ensureStudios(project);
  return project.studios.find(s => s.id === project.activeStudioId) || project.studios[0];
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
    durationSource: spec.durationSource || 'default', promptSeconds: spec.promptSeconds ?? null,
    profileId: spec.profileId || DEFAULT_PROFILE_ID, experience: spec.experience || '',
    creationMode: spec.creationMode || '', studioId: spec.studioId || '', studioName: spec.studioName || '',
    autoSubmit: !!spec.autoSubmit, createdAt: t, updatedAt: t, reviewedAt: null,
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
  // Studio 结构（第 27.7 章）：ID 唯一、成员存在、活动 ID 有效、草稿类型
  if (p.studios !== undefined) {
    if (!Array.isArray(p.studios) || !p.studios.length) errs.push('studios 需为非空数组');
    else {
      const sids = new Set();
      const aids = new Set((p.assets || []).map(a => a.id));
      for (const s of p.studios) {
        if (!s.id || sids.has(s.id)) errs.push('Studio ID 缺失或重复');
        sids.add(s.id);
        for (const k of ['assetIds', 'archivedAssetIds']) {
          if (s[k] !== undefined && !Array.isArray(s[k])) errs.push(`Studio.${k} 需为数组`);
          else for (const id of s[k] || []) if (!aids.has(id)) errs.push(`Studio 成员指向不存在的素材：${String(id).slice(0, 8)}…`);
        }
        if (s.draft !== undefined && s.draft !== null && typeof s.draft !== 'object') errs.push('Studio.draft 需为对象');
      }
      if (p.activeStudioId && !sids.has(p.activeStudioId)) errs.push('activeStudioId 无效');
    }
  }
  if (p.queueControl !== undefined && (typeof p.queueControl !== 'object' || p.queueControl === null)) errs.push('queueControl 需为对象');
  return errs;
}

export const STATE_LABELS = {
  draft: '草稿', invalid: '素材需处理', pending: '待提交', submitting: '正在提交',
  unknown: '已提交 · 待返回', queued: '服务端排队', generating: '生成中', deferred: '退避等待',
  download: '已生成 · 自动下载中', checking: '已下载 · 后台校验中', ready: '已生成 · 待内容审核', approved: '内容审核通过',
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
  // 时长按平台 / 模式能力校验（第 34 章）：上限是请求上限，不是成片长度门槛
  {
    const profile = MODEL_PROFILES.find(p => p.id === (job.profileId || DEFAULT_PROFILE_ID)) || MODEL_PROFILES[0];
    const lim = modeLimits(profile, job.mode);
    if (!Number.isInteger(job.seconds) || job.seconds < lim.minSeconds || job.seconds > lim.maxSeconds) {
      errors.push(`时长必须为 ${lim.minSeconds}–${lim.maxSeconds} 秒整数（当前平台 ${profile.platformName} ${job.mode} 模式请求上限 ${lim.maxSeconds} 秒）`);
    }
  }
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

// ---------- 时长 QA（第 34.8 章） ----------
// 仅拒绝无法读取、非有限或 ≤0 的时长；有效返回不因超过请求秒数或 12 秒判致命
// （12 秒是请求上限，不是成片长度门槛）。明显短于请求 0.5 秒仅提醒。
export function durationQA(qa, requestedSeconds) {
  if (!qa || !Number.isFinite(qa.duration) || qa.duration <= 0) {
    qa.fatal = qa.fatal || [];
    qa.fatal.push('无法读取有效视频时长');
    qa.technical = 'failed';
    return qa;
  }
  qa.fatal = (qa.fatal || []).filter(f => !/与计划|超过 12|超过12/.test(f));
  if (requestedSeconds && qa.duration < requestedSeconds - 0.5) {
    qa.warnings = qa.warnings || [];
    qa.warnings.push(`实际 ${qa.duration.toFixed(2)} 秒，明显短于请求的 ${requestedSeconds} 秒，请查看是否完整`);
  }
  qa.technical = qa.fatal.length ? 'failed' : (qa.fullDecode === 'passed' ? 'passed' : 'partial');
  return qa;
}

// reconcileDurationQA：仅升级"完整解码 passed + 实际时长有效 + 旧 fatal 恰为历史时长判定"的旧 QA；
// 其他技术错误保持，人工 rejected 不自动恢复（第 34.8 章）。
export function reconcileDurationQA(attempt) {
  const qa = attempt?.qa;
  if (!qa || qa.fullDecode !== 'passed') return false;
  if (!Number.isFinite(qa.duration) || qa.duration <= 0) return false;
  if (attempt.technicalPassed) return false;
  const oldFatal = qa.fatal || [];
  const onlyDuration = oldFatal.length > 0 && oldFatal.every(f => /与计划|超过 12|超过12|超过.*12 秒|12.05/.test(f));
  if (!onlyDuration) return false;
  qa.fatal = [];
  qa.technical = 'passed';
  return true;
}
