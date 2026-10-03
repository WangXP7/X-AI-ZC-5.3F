// models.js — 平台 / API / 模型 / 模式能力注册（第 34 章）。
// 请求上限不硬编码在控件里；界面、校验与导出说明共用本文件数据。
// 新增平台必须先补真实规格与适配器，再出现在生产下拉中。

export const MODEL_PROFILES = [
  {
    id: 'agnes-video-2.5-flash',
    platformId: 'agnesai',
    platformName: 'AgnesAI',
    apiModel: 'agnes-video-2.5-flash',
    modelLabel: 'Agnes Video 2.5 Flash',
    version: '2.5',
    resolution: '720P',
    adapter: 'agnes-flash-v1',
    modes: {
      text: { minSeconds: 4, maxSeconds: 12, step: 1 },
      reference: { minSeconds: 4, maxSeconds: 12, step: 1 },
      keyframe: { minSeconds: 4, maxSeconds: 12, step: 1 },
    },
    references: { imagesMax: 5, audiosMax: 3, fileBytesMaxExclusive: 15000000 },
    submission: { cooldownSeconds: 60 }, // 成功受理后的平台冷却（第 35 章），不替代请求间隔
    origins: ['https://api.agnes-ai.cn', 'https://apihub.agnes-ai.com'],
    poll: { firstEstimateSeconds: 20, pollSeconds: 10 }, // 第 39 章：首查估算与后续查询
  },
];

// 可见但未接入的模型占位：不能发请求，不能声明可用（第 36.5 章）。
export const UPCOMING_MODELS = [
  { id: 'minimax-h3-local', label: 'MiniMax H3 本地化部署(待接入)', available: false },
  { id: 'xai-upcoming', label: 'X-AI（即将发布）', available: false },
];

export const DEFAULT_PROFILE_ID = MODEL_PROFILES[0].id;

export function profileById(id) {
  return MODEL_PROFILES.find(p => p.id === id) || null;
}

export function profileForJob(job) {
  return profileById(job.profileId) || MODEL_PROFILES[0];
}

export function modeLimits(profile, mode) {
  return profile.modes[mode] || profile.modes.text;
}

export function secondsChoices(profile, mode) {
  const { minSeconds, maxSeconds, step } = modeLimits(profile, mode);
  const out = [];
  for (let s = minSeconds; s <= maxSeconds; s += step) out.push(s);
  return out;
}

export function modelOptions() {
  const real = MODEL_PROFILES.map(p => ({
    value: p.id,
    label: `${p.platformName} · ${p.modelLabel} · ${p.resolution} · 每段 ${p.modes.text.minSeconds}–${p.modes.text.maxSeconds} 秒（请求上限）`,
    available: true,
  }));
  const upcoming = UPCOMING_MODELS.map(m => ({ value: m.id, label: m.label, available: false }));
  return [...real, ...upcoming];
}
