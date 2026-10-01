// app.js — 初始化、页面协调、目录 / 恢复、入队、队列 UI、人工审核与拼接。
// 设计依据：docs/X-AI详细设计文档.md 第 3、4、5、6、12、13、14 章。
import { SCHEMA, makeProject, newJob, validateProjectFile, validateJob, STATE_LABELS, stateBadgeKind,
         escapeHTML, bytesHuman, nowIso, redact, isSafeId, ASPECT_DIMS, MODEL_ID, MODEL_DISPLAY,
         AUDIOS_MAX, IMAGES_MAX, buildRequestPrompt } from './core.js';
import * as storage from './storage.js';
import { credentials } from './credentials.js';
import { AssetManager } from './assets.js';
import { BatchPanel } from './batch-panel.js';
import { parseBatch } from './batch.js';
import { Runner, Transport, lastAttempt } from './engine.js';
import { concatenateClips, ffmpegAvailable } from './media.js';

const $ = id => document.getElementById(id);
const state = {
  project: null,
  dirHandle: null,
  runner: null,
  transport: null,
  assetMgr: null,
  batchPanel: null,
  singleSelected: [],        // 单段参考 assetIds
  batchDefaultsAssets: [],   // 批量共用 assetIds
  jobsShown: 60,
  assetSel: new Set(),
  pickCtx: null,             // {mode:'single'|'batch'|'frame', kind:null|'image'|'audio'}
  progCtx: null,
  detailJobId: null,
  imgState: { fit: true, zoom: 1, url: null },
};

// ================= 工具 =================
function toast(message, kind = '', ms = 7000) {
  const box = $('toast-box');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function feedback(el, kind, html) {
  el.hidden = !html;
  el.className = `feedback ${kind}`;
  el.innerHTML = html;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return url; // 仅表示已请求下载，不保证已保存
}
function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch { return iso; } }

async function logEvent(kind, message, jobId = null) {
  const p = state.project;
  if (!p) return;
  p.events.push({ at: nowIso(), kind, message: String(redact(message)), jobId });
  if (p.events.length > 4000) p.events.splice(0, p.events.length - 4000);
  await storage.saveProject(p);
}

// ================= 初始化 =================
export async function init() {
  window.__xaiSteps = window.__xaiSteps || [];
  const step = (s) => { window.__xaiSteps.push(s); };
step('start');
  // 1. 能力检查
  const problems = [];
  if (!window.isSecureContext) problems.push('当前不是安全上下文（需 HTTPS 或 localhost）：加密、文件授权与锁不可用。');
  if (!navigator.locks) problems.push('此浏览器不支持 Web Locks：无法保证同源单实例。');
  if (!globalThis.crypto?.subtle) problems.push('此浏览器不支持 Web Crypto。');
  if (!window.showDirectoryPicker) problems.push('此浏览器不支持文件夹授权（File System Access）：仍可使用浏览器保存，但无法写本地目录。请使用桌面版 Chrome / Edge。');
  if (problems.length) {
    $('init-banner').hidden = false;
    $('init-banner').innerHTML = `<b>功能受限：</b><ul style="margin:4px 0 0;padding-left:18px">${problems.map(p => `<li>${escapeHTML(p)}</li>`).join('')}</ul>`;
  }

step('caps-done');
  // 2. 同源单实例锁：回调保持 pending 以持有锁；用标志位判断是否获得
  if (navigator.locks) {
    let got = false;
    navigator.locks.request('x-ai-studio-tab', { ifAvailable: true }, lock => {
      if (!lock) return;
      got = true;
      return new Promise(() => {}); // 持锁直到页面关闭
    });
    await new Promise(r => setTimeout(r, 120)); // 等待锁授予回调执行
    if (!got) {
      $('lockscreen').hidden = false;
      $('app-root').setAttribute('aria-hidden', 'true');
      return;
    }
  }
  $('btn-lock-retry').addEventListener('click', () => location.reload());

step('lock-done');
  // 3. 项目工作副本
  let saved = null;
  try { saved = await storage.loadProject(); } catch (e) { console.warn(e); }
  if (saved && saved.schema === SCHEMA) {
    const errs = validateProjectFile(saved);
    if (errs.length) {
      $('init-banner').hidden = false;
      $('init-banner').innerHTML = `<b>本地项目记录未通过校验，已按新项目启动（记录保留在浏览器中）：</b><ul style="margin:4px 0 0;padding-left:18px">${errs.map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>`;
    } else {
      state.project = saved;
    }
  }
  if (!state.project) state.project = makeProject();

step('project-loaded');
  // 4. 输出目录句柄
  try {
    const h = await storage.handleStore.getOutput();
    if (h && (await h.queryPermission({ mode: 'readwrite' })) === 'granted') setDirHandle(h, { restored: true });
    else if (h) $('dir-status').textContent = `目录「${h.name}」需要重新授权：点击“选择输出目录”并再次选择它。`;
  } catch { /* ignore */ }

step('handle-restored');
  // 5. 面板
  state.transport = new Transport({
    getSettings: () => ({ ...state.project.settings, key: credentials.key }),
    onAuthWait: (sec) => { $('queue-state').textContent = `认证间隔等待 ${sec}s（每次认证请求 ≥90 秒）`; },
  });
  state.assetMgr = new AssetManager({
    project: state.project, dirHandle: state.dirHandle,
    persist: () => storage.saveProject(state.project),
    logEvent,
  });
  state.batchPanel = new BatchPanel({ project: state.project, assets: state.assetMgr, logEvent });
  state.runner = new Runner({
    project: state.project,
    persist: (toDisk = false) => persistProject(toDisk),
    transport: state.transport,
    mediaDir: () => state.dirHandle ? { dirHandle: state.dirHandle } : null,
    logEvent,
    onJobUpdate: () => { renderJobs(); renderStats(); },
    onQueueState: (s) => { $('queue-state').textContent = s; },
    hooks: {
      readAssetBlob: (a) => state.assetMgr.readAssetBlob(a),
      onAuthRejected: () => toast('认证被拒绝（401/403）：已暂停新提交。请检查密钥。', 'err'),
    },
  });

step('panels-created');
  // 6. 密钥
  credentials.onChange = renderKeyStatus;
  await credentials.initialize();

step('credentials-done');
  // 7. UI
  bindUI();
step('ui-bound');
  renderAll();
  // 诊断钩子：仅供测试与支持排查使用；不暴露密钥，仅引用活动对象。
  window.__xai = {
    project: state.project,
    state,
    runner: state.runner,
    credentials,
    assetMgr: state.assetMgr,
    batchPanel: state.batchPanel,
  };
  $('app-root').removeAttribute('aria-hidden');
step('rendered');
  document.documentElement.dataset.ready = 'true';
}

async function persistProject(toDisk = false) {
  await storage.saveProject(state.project);
  if (toDisk && state.dirHandle) {
    try { await storage.writeProjectFiles(state.dirHandle, state.project); }
    catch (e) { console.warn('磁盘检查点写入失败', e); }
  }
}

function setDirHandle(h, { restored = false } = {}) {
  state.dirHandle = h;
  state.assetMgr.setDirHandle(h);
  $('dir-name').textContent = h.name;
  $('dir-status').textContent = restored
    ? '已恢复授权的输出目录。生成产物、素材副本与项目记录写入这个目录。'
    : '已授权。生成产物、素材副本与项目记录将写入这个目录。';
  $('btn-save-project').hidden = false;
}

// ================= 渲染 =================
function renderAll() {
  renderStats(); renderJobs(); renderAssets(); renderEpisodes(); renderKeyStatus();
  renderBatchDefaultsSummary(); renderRefLists();
}

function renderKeyStatus() {
  $('key-status-text').textContent = credentials.statusText();
  $('key-dot').className = `key-dot ${credentials.key ? 'on' : 'off'}`;
  $('keys-state').textContent = credentials.key
    ? `${credentials.statusText()}（${credentials.hasDefault ? '本机默认配置' : '本次会话输入'}）。注意：已启用 ≠ 已通过服务商认证或有余额。`
    : '未启用密钥。发布版不包含私人默认配置：请在下方粘贴自己的 sk- KEY。';
}

function renderStats() {
  const p = state.project;
  $('stat-jobs').textContent = p.jobs.length;
  $('stat-ready').textContent = p.jobs.filter(j => ['ready', 'approved'].includes(j.state)).length;
  $('stat-assets').textContent = p.assets.length;
  $('stat-episodes').textContent = p.episodes.length;
}

const JOB_ACTIONS = {
  pending: [{ label: '修订 / 查看', act: 'detail' }],
  submitting: [],
  unknown: [{ label: '绑定 video_id', act: 'bind' }, { label: '已核实未创建', act: 'uncreated' }, { label: '详情', act: 'detail' }],
  queued: [{ label: '详情', act: 'detail' }],
  generating: [{ label: '详情', act: 'detail' }],
  deferred: [{ label: '详情', act: 'detail' }],
  download: [{ label: '重新下载', act: 'redownload' }, { label: '详情', act: 'detail' }],
  checking: [{ label: '详情', act: 'detail' }],
  ready: [{ label: '预览与审核', act: 'detail' }, { label: '确认内容审核通过', act: 'approve' }, { label: '标记不合格', act: 'reject' }],
  approved: [{ label: '预览', act: 'detail' }, { label: '标记不合格', act: 'reject' }],
  needs_redo: [{ label: '修订 / 查看', act: 'detail' }, { label: '重新下载', act: 'redownload' }, { label: '重新校验', act: 'recheck' }],
  failed: [{ label: '修订 / 查看', act: 'detail' }],
  blocked: [{ label: '继续原任务', act: 'resume' }, { label: '重新下载', act: 'redownload' }, { label: '重新校验', act: 'recheck' }, { label: '详情', act: 'detail' }],
};

function renderJobs() {
  const list = $('job-list');
  const jobs = state.project.jobs;
  list.innerHTML = '';
  const shown = jobs.slice(-state.jobsShown).reverse(); // 最新在前
  for (const j of shown) {
    const card = document.createElement('div');
    card.className = `job-card state-${j.state}`;
    const at = lastAttempt(j);
    const meta = [];
    meta.push(`${j.seconds}s · ${j.aspect} · ${({ text: '文字', reference: '参考', keyframe: '首尾帧' })[j.mode] || j.mode}`);
    if (j.assetIds.length) meta.push(`参考 ${j.assetIds.length}`);
    if (at?.videoId) meta.push(`video_id ${at.videoId.slice(0, 10)}…`);
    if (at?.number) meta.push(`V${j.attempts.length}（尝试 ${at.number}）`);
    card.innerHTML = `
      <div class="job-head">
        <span class="job-id">${escapeHTML(j.id)}</span>
        <span class="job-ep">${escapeHTML(j.episode)}</span>
        <span class="state-badge ${stateBadgeKind(j.state)}">${STATE_LABELS[j.state] || j.state}</span>
        <span class="muted">${escapeHTML(meta.join(' · '))}</span>
      </div>
      <div class="job-prompt">${escapeHTML(j.prompt.slice(0, 120))}${j.prompt.length > 120 ? '…' : ''}</div>
      ${j.error ? `<div class="job-err">${escapeHTML(j.error)}</div>` : ''}
      ${qaWarnings(at) ? `<div class="job-warn">${escapeHTML(qaWarnings(at))}</div>` : ''}
      ${['queued', 'generating'].includes(j.state) ? `<div class="job-progress"><div style="width:${Math.max(4, j.progress || 4)}%"></div></div>` : ''}
      <div class="job-actions"></div>`;
    const acts = card.querySelector('.job-actions');
    for (const a of (JOB_ACTIONS[j.state] || [])) {
      const b = document.createElement('button');
      b.className = 'btn light small';
      b.textContent = a.label;
      b.addEventListener('click', () => jobAction(a.act, j.id));
      acts.appendChild(b);
    }
    list.appendChild(card);
  }
  $('btn-more-jobs').hidden = jobs.length <= state.jobsShown;
  if (!jobs.length) list.innerHTML = `<div class="empty muted">还没有任务。去“创作工作台”检查并加入队列。</div>`;
}
function qaWarnings(at) {
  if (!at?.qa?.warnings?.length) return '';
  return at.qa.warnings.join('；');
}

function renderEpisodes() {
  const p = state.project;
  const box = $('episode-list');
  box.innerHTML = '';
  const groups = new Map();
  for (const j of p.jobs) {
    if (!groups.has(j.episode)) groups.set(j.episode, []);
    groups.get(j.episode).push(j);
  }
  if (!groups.size) { box.innerHTML = '<div class="empty muted">入队并生成通过后，可在这里按组合成整集。</div>'; return; }
  for (const [ep, jobs] of groups) {
    const ok = jobs.every(j => ['ready', 'approved'].includes(j.state) && j.current?.qa?.technical === 'passed');
    const aspects = new Set(jobs.map(j => j.aspect));
    const audioOk = jobs.every(j => j.current?.qa?.hasAudio !== false);
    const item = document.createElement('div');
    item.className = 'episode-item';
    item.innerHTML = `
      <b>${escapeHTML(ep)}</b>
      <span class="muted">${jobs.length} 镜 · ${ok ? '可拼接' : '有未通过/未完成的镜头'}${aspects.size > 1 ? ' · 画幅不一致' : ''}${!audioOk ? ' · 有镜头缺音轨' : ''}</span>
      <button type="button" class="btn ${ok && aspects.size === 1 && audioOk ? 'primary' : 'light'} small" ${ok && aspects.size === 1 && audioOk ? '' : 'disabled'}>拼接 ${escapeHTML(ep)}</button>
      <span class="muted" data-ep-status></span>`;
    item.querySelector('button').addEventListener('click', () => concatEpisode(ep, jobs));
    const prev = p.episodes.filter(e => e.id === ep).at(-1);
    if (prev) {
      const v = document.createElement('div');
      v.className = 'ep-vid';
      v.innerHTML = `<span class="muted">最新成片 ${escapeHTML(prev.path || '')}（${fmtTime(prev.createdAt)}）</span>`;
      const video = document.createElement('video');
      video.controls = true; video.preload = 'metadata'; video.style.maxWidth = '300px';
      if (prev.blobKey) storage.blobStore.get(prev.blobKey).then(b => { if (b) video.src = URL.createObjectURL(b); });
      v.appendChild(video);
      item.appendChild(v);
    }
    box.appendChild(item);
  }
}

async function concatEpisode(ep, jobs) {
  const dlgConfirm = confirm(`拼接 ${ep}：将按任务顺序合并 ${jobs.length} 个镜头，使用 FFmpeg 统一画幅、24fps、48kHz 音轨。输入总大小需 ≤450MB。继续？`);
  if (!dlgConfirm) return;
  const totalBytes = jobs.reduce((s, j) => s + (j.current?.bytes || 0), 0);
  if (totalBytes > 450_000_000) { toast(`输入总大小 ${bytesHuman(totalBytes)} 超过 450MB 上限`, 'err'); return; }
  toast('拼接中：FFmpeg 运行可能需要一些时间…');
  try {
    const clips = [];
    for (const j of jobs) {
      const blob = await storage.blobStore.get(j.current.blobKey);
      if (!blob) throw new Error(`镜头 ${j.id} 的当前视频副本缺失`);
      clips.push({ name: `${j.id}.mp4`, blob });
    }
    const aspect = jobs[0].aspect;
    const out = await concatenateClips(clips, aspect, p => { $('queue-state').textContent = `拼接进度 ${(p * 100).toFixed(0)}%`; });
    const outBlob = out || await (async () => { throw new Error('FFmpeg 未返回输出'); })();
    const totalPlanned = jobs.reduce((s, j) => s + j.seconds, 0);
    const meta = await videoMeta(outBlob);
    if (Math.abs(meta.duration - totalPlanned) > 0.5) {
      toast(`成片总时长 ${meta.duration.toFixed(2)}s 与计划 ${totalPlanned}s 差超过 0.5s，请检查`, 'err', 12000);
    }
    const blobKey = await storage.blobStore.put(outBlob);
    const version = state.project.episodes.filter(e => e.id === ep).length + 1;
    const episode = {
      id: ep, version, path: `episodes/${ep}_v${version}.mp4`, blobKey,
      sha256: await cryptoHash(await outBlob.arrayBuffer()),
      seconds: meta.duration, createdAt: nowIso(),
      inputs: jobs.map(j => ({ id: j.id, path: j.current.path, sha256: j.current.sha256 })),
      fullDecode: 'passed', review: '待人工审核（拼接完成不等于内容通过）',
    };
    state.project.episodes.push(episode);
    if (state.dirHandle) {
      try { await storage.writeFile(state.dirHandle, episode.path, outBlob); await persistProject(true); }
      catch (e) { toast(`磁盘写入失败：${e.message}（浏览器副本已保留）`, 'err'); }
    } else await persistProject();
    logEvent('episode', `${ep} v${version} 拼接完成：${jobs.map(j => j.id).join(',')}`, null);
    renderEpisodes(); renderStats();
    toast(`${ep} v${version} 拼接完成，请完整观看审核。`);
  } catch (e) {
    toast(`拼接失败：${e.message}`, 'err', 12000);
  }
}

async function videoMeta(blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.preload = 'metadata';
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej; v.src = url; });
  const d = v.duration; const w = v.videoWidth; const h = v.videoHeight;
  URL.revokeObjectURL(url);
  return { duration: d, width: w, height: h };
}
async function cryptoHash(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ---------- 素材库渲染 ----------
function renderAssets() {
  const grid = $('asset-grid');
  const assets = state.project.assets;
  grid.innerHTML = '';
  $('asset-count').textContent = assets.length ? `${assets.length} 项 · 已选 ${state.assetSel.size}` : '';
  $('asset-empty').hidden = assets.length > 0;
  for (const a of assets) {
    const card = document.createElement('div');
    card.className = 'asset-card' + (a.kind === 'image' && a.width / (a.height || 1) >= 2 ? ' wide' : '');
    const issues = a.errors?.length ? `<div class="asset-issues ${a.status === 'error' ? 'bad' : ''}">${escapeHTML(a.errors.join('；'))}</div>` : '';
    const eff = a.effectiveAssetId ? state.project.assets.find(x => x.id === a.effectiveAssetId) : null;
    const effNote = eff ? `<div class="asset-meta">使用优化版：${escapeHTML(eff.name)}</div>` : '';
    const storageNote = a.storage === 'source' ? '原路径引用（不复制）' : (a.path ? '' : '仅浏览器副本');
    card.innerHTML = `
      <input type="checkbox" class="sel" ${state.assetSel.has(a.id) ? 'checked' : ''}>
      <span class="asset-kind">${a.kind === 'image' ? '图片' : '声音'}${a.storage === 'source' ? ' · 源' : ''}</span>
      <div class="asset-media"></div>
      <div class="asset-body">
        <div class="asset-name" title="${escapeHTML(a.name)}">${escapeHTML(a.name)}</div>
        <div class="asset-meta">${bytesHuman(a.bytes)} · ${escapeHTML(storageNote)}</div>
        ${effNote}${issues}
        <div class="asset-actions">
          <button type="button" class="btn light small" data-act="use">用于当前分镜</button>
          ${a.kind === 'image' ? '<button type="button" class="btn light small" data-act="view">全图</button>' : ''}
        </div>
      </div>`;
    const media = card.querySelector('.asset-media');
    if (a.blobKey) {
      storage.blobStore.get(a.blobKey).then(b => {
        if (!b) return;
        if (a.kind === 'image') {
          const img = document.createElement('img');
          img.loading = 'lazy'; img.decoding = 'async'; img.alt = a.name;
          img.src = URL.createObjectURL(b);
          media.appendChild(img);
        } else {
          const audio = document.createElement('audio');
          audio.controls = true; audio.preload = 'metadata'; audio.src = URL.createObjectURL(b);
          media.appendChild(audio);
        }
      });
    } else {
      media.innerHTML = '<span class="muted">原路径素材<br>提交时回读源目录</span>';
      media.style.fontSize = '12px';
    }
    card.querySelector('.sel').addEventListener('change', ev => {
      ev.target.checked ? state.assetSel.add(a.id) : state.assetSel.delete(a.id);
      $('asset-count').textContent = `${assets.length} 项 · 已选 ${state.assetSel.size}`;
    });
    media.addEventListener('click', () => { if (a.kind === 'image' && a.blobKey) openImageViewer(a); });
    card.querySelector('[data-act="use"]').addEventListener('click', () => {
      state.singleSelected.push(a.id);
      renderRefLists();
      toast(`已加入单段参考（当前 ${state.singleSelected.length} 项），入队时会做组合检查`);
    });
    card.querySelector('[data-act="view"]')?.addEventListener('click', () => openImageViewer(a));
    grid.appendChild(card);
  }
}

// ================= UI 绑定 =================
function bindUI() {
  // 导航
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });
  // 密钥
  $('btn-key-status').addEventListener('click', openKeysDialog);
  $('btn-help').addEventListener('click', () => switchPage('guide'));
  // 模式切换
  document.querySelectorAll('input[name=gen-mode]').forEach(r => r.addEventListener('change', () => {
    const batch = document.querySelector('input[name=gen-mode]:checked').value === 'batch';
    for (const ed of [$('single-editor'), $('batch-editor')]) { ed.hidden = ed.id !== (batch ? 'batch-editor' : 'single-editor'); ed.disabled = ed.id !== (batch ? 'batch-editor' : 'single-editor'); }
  }));
  // 目录
  $('btn-choose-dir').addEventListener('click', chooseOutputDir);
  $('btn-save-project').addEventListener('click', async () => {
    try { await persistProject(true); toast('project.json、reference-mapping.json 与过程 MD 已写入输出目录'); }
    catch (e) { toast(`写入失败：${e.message}`, 'err'); }
  });
  // 单段
  $('s-prompt').addEventListener('input', () => { $('s-prompt-count').textContent = `${$('s-prompt').value.length} / 12000`; });
  $('s-mode').addEventListener('change', () => {
    document.querySelector('.keyframe-only').hidden = $('s-mode').value !== 'keyframe';
  });
  $('btn-pick-assets').addEventListener('click', () => openPickDialog({ mode: 'single', kind: null }));
  $('btn-add-files').addEventListener('click', () => $('s-files').click());
  $('s-files').addEventListener('change', async ev => {
    if (!ev.target.files.length) return;
    await runImport(ev.target.files, { autoSelect: true });
    ev.target.value = '';
  });
  $('btn-sample').addEventListener('click', () => {
    $('s-prompt').value = '小熊抬头看向远处的灯火，镜头缓慢推近，微风拂过草丛。';
    $('s-prompt-count').textContent = `${$('s-prompt').value.length} / 12000`;
  });
  $('btn-constraints').addEventListener('click', () => {
    const job = collectSingleSpec();
    if (!job) return;
    const text = buildRequestPrompt({ ...job, prompt: '' }, state.singleSelected.map(id => state.project.assets.find(a => a.id === id)?.name).filter(Boolean));
    const extra = text.replace(/^\s*【对白约束】[\s\S]*?「.*?」/m, '').trim();
    $('s-prompt').value = ($('s-prompt').value.trim() + '\n\n' + extra).trim();
    $('s-prompt-count').textContent = `${$('s-prompt').value.length} / 12000`;
    toast('已按当前画幅 / 参考 / 衔接补充确定性运行约束（不会改写剧情）');
  });
  $('btn-enqueue-single').addEventListener('click', enqueueSingle);
  // 批量
  $('btn-batch-sample').addEventListener('click', () => {
    $('batch-text').value = `镜号,分组,时长秒,画幅,提示词,对白\nS01,EP01,8,9:16,小熊抬头看向远处的灯火，镜头缓慢推近,\nS02,EP01,6,9:16,灯火在风中摇曳，小熊迈步向前,你好呀`;
  });
  $('btn-batch-import').addEventListener('click', () => $('batch-file').click());
  $('batch-file').addEventListener('change', async ev => {
    const f = ev.target.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { toast('主清单超过 10MB 上限', 'err'); return; }
    $('batch-text').value = await f.text();
    ev.target.value = '';
    toast('清单已导入：请核对后展开引用或直接预览');
  });
  $('btn-batch-dir').addEventListener('click', chooseBatchDir);
  $('btn-batch-expand').addEventListener('click', expandBatch);
  $('btn-batch-export').addEventListener('click', () => {
    if (!state.batchPanel.expandedText) return;
    download(new Blob([state.batchPanel.expandedText], { type: 'application/json' }), 'X-AI_展开清单.json');
  });
  $('btn-batch-preview').addEventListener('click', previewBatch);
  $('btn-batch-assets').addEventListener('click', () => openPickDialog({ mode: 'batch', kind: null }));
  $('btn-enqueue-batch').addEventListener('click', enqueueBatch);
  // 任务页
  $('btn-run-queue').addEventListener('click', async () => {
    if (!credentials.key) { toast('请先启用密钥（右上角）', 'err'); return; }
    state.runner.pausedNew = false;
    state.runner.start();
  });
  $('btn-pause-new').addEventListener('click', () => {
    state.runner.pausedNew = true;
    toast('已请求暂停新提交：当前任务会继续查询 / 下载 / 检查，到新任务边界停止。这不是云端取消。');
  });
  $('btn-export-md').addEventListener('click', () => {
    download(new Blob([storage.processMarkdown(state.project)], { type: 'text/markdown' }), 'X-AI_制作过程与结果.md');
  });
  $('btn-more-jobs').addEventListener('click', () => { state.jobsShown += 60; renderJobs(); });
  // 素材库
  $('btn-asset-add').addEventListener('click', () => $('asset-files').click());
  $('asset-files').addEventListener('change', async ev => {
    if (!ev.target.files.length) return;
    await runImport(ev.target.files, { autoSelect: false });
    ev.target.value = '';
  });
  $('btn-asset-all').addEventListener('click', () => { state.project.assets.forEach(a => state.assetSel.add(a.id)); renderAssets(); });
  $('btn-asset-opt-candidates').addEventListener('click', () => {
    state.project.assets.forEach(a => {
      if (a.kind === 'image' && (a.errors?.some(e => /15MB|尺寸|比例/.test(e)) || a.bytes >= 15_000_000 || !a.effectiveAssetId)) state.assetSel.add(a.id);
    });
    renderAssets();
  });
  $('btn-asset-clear').addEventListener('click', () => { state.assetSel.clear(); renderAssets(); });
  $('btn-asset-optimize').addEventListener('click', runOptimize);
  $('btn-asset-zip').addEventListener('click', runZip);
  // 弹窗
  bindKeysDialog();
  bindPickDialog();
  bindProgressDialog();
  bindDetailDialog();
  bindImageDialog();
}

function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  const titles = { studio: '创作工作台', tasks: '任务与成片', assets: '本地素材库', guide: '操作指南' };
  $('page-title').textContent = titles[page] || '';
}

// ---------- 输出目录 ----------
async function chooseOutputDir() {
  try {
    if (state.runner?.running) { toast('队列运行中，请先停止队列再切换目录', 'err'); return; }
    const h = await storage.pickOutputDirectory();
    // 检查候选目录是否已有项目
    let existing = null;
    try {
      const fh = await h.getFileHandle('project.json');
      const f = await fh.getFile();
      existing = JSON.parse(await f.text());
    } catch { /* 无项目 */ }
    if (existing) {
      const errs = validateProjectFile(existing);
      if (!errs.length && confirm(`目录「${h.name}」已有项目「${existing.name}」（${existing.jobs?.length || 0} 个任务）。恢复该项目吗？\n取消则不写入该目录。`)) {
        state.project = existing;
        state.batchPanel.project = state.project;
        state.assetMgr.project = state.project;
        await storage.saveProject(state.project);
      } else return;
    }
    // 已有 references 先备份（备份失败停止后续写入）
    $('dir-status').textContent = '检查已有 references…';
    let backup = null;
    try { backup = await storage.backupReferences(h, (n, total, rel) => { $('dir-status').textContent = `备份 references：${n}/${total} ${rel}`; }); }
    catch (e) {
      $('dir-status').textContent = '备份失败，已停止写入。';
      toast(`references 备份失败：${e.message}。原文件保持原样，未做任何写入。`, 'err', 12000);
      return;
    }
    if (backup) toast(`已备份 ${backup.count} 个已有文件到 ${backup.path}/（含 SHA-256 manifest）`);
    setDirHandle(h);
    await storage.handleStore.setOutput(h);
    await persistProject(true);
    renderAll();
    toast('输出目录已就绪');
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast(`选择目录失败：${e.message}`, 'err');
  }
}

// ---------- 单段 ----------
function collectSingleSpec() {
  const spec = {
    id: $('s-id').value.trim() || 'S01',
    episode: $('s-episode').value.trim() || 'EP01',
    prompt: $('s-prompt').value,
    dialogue: $('s-dialogue').value.trim(),
    seconds: Number($('s-seconds').value),
    aspect: $('s-aspect').value,
    mode: $('s-mode').value,
    seed: $('s-seed').value === '' ? null : Number($('s-seed').value),
    assetIds: [...state.singleSelected],
    firstFrame: $('s-first').value || null,
    lastFrame: $('s-last').value || null,
    continuityFrom: $('s-continuity').value.trim() || null,
    sourceReferences: [], textSources: [], referenceReplacements: [],
  };
  return spec;
}

function enqueueSingle() {
  const fb = $('single-feedback');
  const spec = collectSingleSpec();
  const job = newJob(spec);
  const { errors, warnings } = validateJob(job, state.project);
  if (errors.length) {
    feedback(fb, 'err', `<b>未入队（有错误）：</b><ul>${errors.map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>${warnings.length ? `<b>警告：</b><ul>${warnings.map(w => `<li>${escapeHTML(w)}</li>`).join('')}</ul>` : ''}`);
    return;
  }
  state.project.jobs.push(job);
  logEvent('input_approved', `任务 ${job.id} 入队（${spec.mode}，${spec.seconds}s ${spec.aspect}）`, job.id);
  persistProject(state.dirHandle ? true : false);
  feedback(fb, 'ok', `<b>已入队：</b>${escapeHTML(job.id)}。实际付费生成需到“任务与成片”点击“开始 / 继续队列”。`);
  // 生成下一个未使用的 Sxx 镜号
  let n = parseInt(spec.id.replace(/\D/g, ''), 10) || state.project.jobs.length;
  let next;
  do { n++; next = `${spec.id.replace(/\d+/, '')}${String(n).padStart(2, '0')}`; } while (state.project.jobs.some(j => j.id === next));
  $('s-id').value = next;
  renderAll();
}

// ---------- 批量 ----------
async function chooseBatchDir() {
  try {
    const files = await state.batchPanel.chooseRoot();
    $('batch-dir-row').hidden = false;
    const sel = $('batch-list-select');
    sel.innerHTML = files.map(f => `<option value="${escapeHTML(f)}">${escapeHTML(f)}</option>`).join('');
    if (files.length) {
      state.batchPanel.listRelPath = files[0];
      toast(`已索引 ${state.batchPanel.index.size} 个文件。请在下拉中选择清单，再“读取引用并展开”。`);
    } else toast('目录索引完成，但没有找到清单类文件（csv / tsv / txt / json / md）', 'err');
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast(`选择目录失败：${e.message}`, 'err');
  }
}

async function expandBatch() {
  const fb = $('batch-feedback');
  try {
    // 优先使用下拉选中的清单
    const sel = $('batch-list-select');
    if (!$('batch-text').value.trim() && sel.options.length) {
      $('batch-text').value = await state.batchPanel.loadListFile(sel.value);
    }
    const defaults = {
      seconds: Number($('b-seconds').value) || 8, aspect: $('b-aspect').value,
      episode: $('b-episode').value.trim() || 'EP01', prefix: $('b-prefix').value.trim() || 'S',
    };
    const batch = state.batchPanel.parse($('batch-text').value, defaults);
    if (batch.errors.length) {
      feedback(fb, 'err', `<b>清单解析错误（未展开）：</b><ul>${batch.errors.slice(0, 12).map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>`);
      return;
    }
    if (batch.rows.length > 1000) { feedback(fb, 'err', '每批最多 1000 镜，请拆批'); return; }
    feedback(fb, '', '');
    $('batch-preview').hidden = false;
    $('batch-expand-info').textContent = '正在递归展开引用…';
    const res = await state.batchPanel.expand({
      onProgress: (i, n, id) => { $('batch-expand-info').textContent = `展开中 ${i + 1}/${n}：${id}`; },
    });
    const bad = res.results.filter(r => r.errors.length);
    $('batch-expand-info').textContent =
      `读取 ${res.budget.filesRead} 个文本文件 / ${bytesHuman(res.budget.totalBytes)}；` +
      `${batch.rows.length} 镜，${res.results.reduce((s, r) => s + r.media.length, 0)} 个媒体引用；` +
      (bad.length ? `⚠ ${bad.length} 镜有错误，整批禁止入队` : '全部展开成功');
    renderBatchPreview();
    feedback(fb, bad.length ? 'err' : 'ok', bad.length
      ? `<ul>${bad.slice(0, 8).map(r => `<li>镜 ${escapeHTML(r.id)}：${escapeHTML(r.errors[0])}</li>`).join('')}</ul>`
      : '引用展开完成。请预览字段与素材映射，然后“检查整批并加入队列”。');
  } catch (e) {
    feedback(fb, 'err', escapeHTML(e.message));
  }
}

function renderBatchPreview() {
  const bp = state.batchPanel;
  if (!bp.batch || !bp.resolved) return;
  const byId = new Map(bp.resolved.results.map(r => [r.id, r]));
  const table = $('batch-table');
  const rows = bp.batch.rows.filter(r => r.spec).slice(0, 20); // 批量预览前 20 镜
  let html = '<thead><tr><th>镜号</th><th>分组</th><th>秒</th><th>画幅</th><th>方式</th><th>提示词（展开后）</th><th>素材</th></tr></thead><tbody>';
  for (const r of rows) {
    const s = r.spec; const res = byId.get(s.id);
    html += `<tr><td>${escapeHTML(s.id)}</td><td>${escapeHTML(s.episode)}</td><td>${s.seconds}</td><td>${escapeHTML(s.aspect)}</td><td>${escapeHTML(s.mode)}</td><td class="editable" data-id="${escapeHTML(s.id)}">${escapeHTML((res?.prompt || s.promptRaw).slice(0, 160))}</td><td>${escapeHTML((res?.media || []).map(m => m.path.split('/').pop()).join(', ') || '—')}</td></tr>`;
  }
  html += '</tbody>';
  table.innerHTML = html;
  $('batch-unknown-cols').textContent = bp.batch.unknownCols.length ? `未识别列（仅作说明，不会进入请求）：${bp.batch.unknownCols.join('、')}` : '';
  // 替换记录
  const reps = bp.resolved.results.flatMap(r => r.replacements.map(x => ({ id: r.id, ...x })));
  $('batch-replacements').innerHTML = reps.length ? `<h4>文本替换（${reps.length}）</h4>` + reps.slice(0, 30).map(x => `
    <div class="expand-block"><b>${escapeHTML(x.id)}</b> <span class="src">${escapeHTML(x.field)}</span>
    <details><summary>替换前 / 后</summary><pre>${escapeHTML(x.before.slice(0, 500))}</pre><pre>${escapeHTML(x.after.slice(0, 500))}</pre></details></div>`).join('') : '';
}

function previewBatch() {
  if (!state.batchPanel?.batch) { toast('请先导入清单并展开引用', 'err'); return; }
  $('batch-preview').hidden = false;
  renderBatchPreview();
  if (!state.batchPanel.resolved) $('batch-expand-info').textContent = '尚未展开引用：仅显示原始解析结果。';
}

async function enqueueBatch() {
  const fb = $('batch-feedback');
  try {
    if (!state.batchPanel.batch) { feedback(fb, 'err', '请先导入清单并展开引用'); return; }
    if (!state.batchPanel.resolved) { feedback(fb, 'err', '请先“读取引用并展开”'); return; }
    const { specs, errors } = await state.batchPanel.specsForQueue();
    if (errors.length) { feedback(fb, 'err', `<b>文本复核失败（整批不入队）：</b><ul>${errors.slice(0, 8).map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>`); return; }
    // 登记源素材（不复制字节）
    for (const s of specs) await state.batchPanel.registerSourceAssets(s);
    // 整批校验：任一错误都不入队
    const jobs = specs.map(s => newJob(s));
    const allErrors = []; const allWarnings = [];
    for (const j of jobs) {
      const { errors: es, warnings: ws } = validateJob(j, state.project, jobs.filter(x => x !== j));
      allErrors.push(...es); allWarnings.push(...ws);
    }
    if (allErrors.length) {
      feedback(fb, 'err', `<b>整批未入队（${allErrors.length} 个错误）：</b><ul>${allErrors.slice(0, 12).map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>`);
      return;
    }
    state.project.jobs.push(...jobs);
    await logEvent('input_approved', `批量入队 ${jobs.length} 镜`, null);
    await persistProject(true);
    feedback(fb, 'ok', `已整批入队 ${jobs.length} 镜。请到“任务与成片”开始队列。`);
    switchPage('tasks');
    renderAll();
  } catch (e) {
    feedback(fb, 'err', escapeHTML(e.message));
  }
}

function renderBatchDefaultsSummary() {
  $('batch-defaults-summary').textContent =
    `默认 ${$('b-seconds').value}s · ${$('b-aspect').value} · ${$('b-episode').value} · 共用素材 ${state.batchDefaultsAssets.length} 项`;
}

// ---------- 任务操作 ----------
function jobAction(act, jobId) {
  const job = state.project.jobs.find(j => j.id === jobId);
  if (!job) return;
  const runner = state.runner;
  switch (act) {
    case 'detail': openDetail(jobId); break;
    case 'bind': {
      const vid = prompt(`任务 ${job.id} 处于“提交结果待核实”。\n请输入从服务商控制台找到的原 video_id（会沿它继续查询，不会新建收费任务）：`);
      if (vid) runner.bindVideoId(jobId, vid).then(ok => { if (ok) { toast('已绑定原 video_id，继续查询原任务'); renderJobs(); } });
      break;
    }
    case 'uncreated': {
      const ev = prompt(`任务 ${job.id}：确认“服务端未创建”需要依据。\n请填写核实依据（例如：控制台无此任务 / 服务商客服确认），将恢复为待提交：`);
      if (ev !== null) runner.markUncreated(jobId, ev).then(() => { toast('已记录核实依据，恢复为待提交'); renderJobs(); });
      break;
    }
    case 'redownload': runner.redownload(jobId); break;
    case 'recheck': job.state = 'checking'; job.error = null; persistProject(); renderJobs(); if (!runner.running) runner.start(); break;
    case 'resume': job.error = null; persistProject(); if (!runner.running) { runner.pausedNew = false; runner.start(); } break;
    case 'approve': {
      if (confirm(`确认已完整观看并听审 ${job.id} 的当前视频？\n确认后 review=approved（整集仍需审核）。`)) {
        job.state = 'approved'; job.review = 'approved'; job.reviewedAt = nowIso();
        logEvent('review', `${job.id} 人工内容审核通过`, job.id);
        persistProject(); renderJobs(); renderEpisodes();
      }
      break;
    }
    case 'reject': {
      const reason = prompt(`标记 ${job.id} 不合格，请记录具体原因（人物 / 画面 / 动作 / 对白 / 声音 / 连续性）：`);
      if (reason) {
        job.state = 'needs_redo'; job.review = 'rejected'; job.revisionReason = reason; job.reviewedAt = nowIso();
        job.error = `人工标记：${reason}`;
        logEvent('review', `${job.id} 人工标记不合格：${reason}`, job.id);
        persistProject(); renderJobs();
      }
      break;
    }
  }
}

// ---------- 详情弹窗 ----------
function bindDetailDialog() {
  $('detail-close').addEventListener('click', () => $('dlg-detail').close());
}

function openDetail(jobId) {
  const job = state.project.jobs.find(j => j.id === jobId);
  if (!job) return;
  state.detailJobId = jobId;
  $('detail-title').textContent = `任务详情 · ${job.id}`;
  const at = lastAttempt(job);
  const body = $('detail-body');
  const editable = ['pending', 'failed', 'needs_redo', 'draft', 'invalid'].includes(job.state);
  const cur = job.current;
  body.innerHTML = `
    <div class="detail-sec">
      <span class="state-badge ${stateBadgeKind(job.state)}">${STATE_LABELS[job.state]}</span>
      <span class="muted">　${escapeHTML(job.episode)} · ${job.seconds}s · ${escapeHTML(job.aspect)} · ${({ text: '文字', reference: '参考', keyframe: '首尾帧' })[job.mode]}</span>
      ${job.error ? `<div class="job-err">${escapeHTML(job.error)}</div>` : ''}
      ${job.revisionReason ? `<div class="job-warn">修订原因：${escapeHTML(job.revisionReason)}</div>` : ''}
    </div>
    ${cur ? `<div class="detail-sec"><h4>当前视频</h4>
      <video controls preload="metadata" style="max-width:340px;border-radius:10px;background:#000" id="detail-video"></video>
      <div class="kv" style="margin-top:6px">
        <dt>路径</dt><dd>${escapeHTML(cur.path || '')}</dd>
        <dt>SHA-256</dt><dd>${escapeHTML(cur.sha256 || '')}</dd>
        <dt>时长 / 分辨率</dt><dd>${cur.qa ? cur.qa.duration.toFixed(2) + 's · ' + cur.qa.width + '×' + cur.qa.height : '—'}</dd>
        <dt>技术检查</dt><dd>${cur.qa ? `${cur.qa.technical}（完整解码 ${cur.qa.fullDecode}）` : '—'}</dd>
      </div></div>` : ''}
    <div class="detail-sec"><h4>画面与动作${editable ? '（修订后保存为新版本）' : ''}</h4>
      <textarea id="d-prompt" rows="4" ${editable ? '' : 'disabled'}>${escapeHTML(job.prompt)}</textarea>
      <h4>指定对白</h4>
      <textarea id="d-dialogue" rows="2" ${editable ? '' : 'disabled'}>${escapeHTML(job.dialogue)}</textarea>
      ${editable ? `<div class="inline-form">
        <label class="mini-label" for="d-seconds">时长</label><input id="d-seconds" type="number" min="4" max="12" value="${job.seconds}" style="max-width:90px">
        <label class="mini-label" for="d-aspect">画幅</label>
        <select id="d-aspect" style="max-width:120px">${Object.keys(ASPECT_DIMS).map(a => `<option ${a === job.aspect ? 'selected' : ''}>${a}</option>`).join('')}</select>
        <label class="mini-label" for="d-mode">方式</label>
        <select id="d-mode" style="max-width:120px">${['text', 'reference', 'keyframe'].map(m => `<option value="${m}" ${m === job.mode ? 'selected' : ''}>${({ text: '文字', reference: '参考', keyframe: '首尾帧' })[m]}</option>`).join('')}</select>
      </div>
      <div class="inline-form"><button type="button" class="btn primary" id="d-save">保存修订（pending）</button>
      <span class="muted">保留旧尝试与历史；队列由你启动才会创建新尝试。</span></div>` : ''}
    </div>
    <div class="detail-sec"><h4>请求摘要（脱敏）</h4>
      <pre style="white-space:pre-wrap;background:#f7f6f2;padding:8px 10px;border-radius:8px;font-size:12.5px">${escapeHTML(at?.request ? JSON.stringify(at.request, null, 2) : '尚无提交尝试')}</pre>
      ${at?.requestHash ? `<div class="muted">requestHash ${escapeHTML(at.requestHash.slice(0, 24))}…</div>` : ''}
    </div>
    ${at?.qa?.darkRatios?.length ? `<div class="detail-sec"><h4>抽帧（五点采样）</h4><div class="frame-row-view" id="detail-frames"></div></div>` : ''}
    ${job.textSources?.length ? `<div class="detail-sec"><h4>文本来源</h4><ul class="muted" style="font-size:13px">${job.textSources.map(ts => `<li>${escapeHTML(ts.path)}#${escapeHTML(ts.selection || '')} · ${escapeHTML(ts.encoding || '')} · sha256 ${escapeHTML((ts.sha256 || '').slice(0, 12))}…</li>`).join('')}</ul></div>` : ''}
    <div class="detail-sec"><h4>尝试历史（${job.attempts.length}）</h4>
      ${job.attempts.map(a => `<div class="attempt">V${a.number} · ${fmtTime(a.createdAt)} · ${a.videoId ? 'video_id ' + escapeHTML(a.videoId.slice(0, 14)) + '…' : (a.rejectedBeforeCreation ? '明确拒绝（未创建）' : '无 video_id')} · ${a.qa ? 'QA ' + escapeHTML(a.qa.technical) : ''}${a.uncreatedEvidence ? ` · 核实依据：${escapeHTML(a.uncreatedEvidence.slice(0, 60))}` : ''}</div>`).join('') || '<div class="muted">尚无尝试</div>'}
    </div>`;
  // 视频与抽帧
  if (cur?.blobKey) storage.blobStore.get(cur.blobKey).then(b => { const v = $('detail-video'); if (v && b) v.src = URL.createObjectURL(b); });
  const framesBox = $('detail-frames');
  if (framesBox && at?.frameKeys?.length) {
    at.frameKeys.forEach(async (k, i) => {
      const b = await storage.blobStore.get(k);
      if (!b) return;
      const img = document.createElement('img');
      img.alt = `frame ${i + 1}`;
      img.src = URL.createObjectURL(b);
      framesBox.appendChild(img);
    });
  }
  $('d-save')?.addEventListener('click', () => saveRevision(job));
  $('dlg-detail').showModal();
}

function saveRevision(job) {
  // 未确认结束的远端任务禁止修订收费重做（第 14.1 章）
  if (['submitting', 'unknown', 'queued', 'generating', 'deferred', 'download', 'checking'].includes(job.state)) {
    toast('当前任务尚未确认结束，不能建立新的收费尝试。请先恢复 / 核实。', 'err');
    return;
  }
  const prompt = $('d-prompt').value.trim();
  if (!prompt) { toast('画面与动作不能为空', 'err'); return; }
  job.prompt = prompt;
  job.dialogue = $('d-dialogue').value.trim();
  job.seconds = Number($('d-seconds').value);
  job.aspect = $('d-aspect').value;
  job.mode = $('d-mode').value;
  const { errors } = validateJob(job, state.project);
  if (errors.length) { toast(`修订未保存：${errors[0]}`, 'err', 12000); return; }
  job.state = 'pending'; job.review = 'pending'; job.error = null;
  job.current = null; // 新版本待生成；历史尝试保留
  logEvent('revision', `${job.id} 修订保存，恢复为待提交`, job.id);
  persistProject(state.dirHandle ? true : false);
  $('dlg-detail').close();
  renderJobs(); renderEpisodes();
  toast(`${job.id} 已保存修订（pending）。队列由你启动才会创建新尝试。`);
}

// ---------- 素材导入 / 优化 / ZIP ----------
async function runImport(fileList, { autoSelect = false } = {}) {
  const plan = state.assetMgr.planImport(fileList);
  const dlg = $('dlg-progress');
  $('prog-title').textContent = '素材校验与导入';
  $('prog-plan').textContent = `共 ${plan.total} 个文件，约 ${bytesHuman(plan.totalBytes)}。以下为预检说明；点击前尚未读取或导入。`;
  $('prog-results').innerHTML = '';
  resetProgressDialog({ running: true });
  dlg.showModal();
  state.progCtx = { plan, mode: 'import', autoSelect };
  await state.assetMgr.execute(plan, {
    onProgress: (n, total, name) => {
      $('prog-bar').value = Math.round(n / total * 100);
      $('prog-count').textContent = `${n}/${total}`;
      $('prog-current').textContent = name;
    },
    onItem: () => {},
    onDone: (results) => {
      const counts = results.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
      $('prog-current').textContent = `完成：${Object.entries(counts).map(([k, v]) => `${({ success: '完成', warning: '待处理', duplicate: '复用', skipped: '跳过', error: '失败', pending: '未处理' })[k] || k} ${v}`).join(' · ')}`;
      renderResults(results);
      resetProgressDialog({ running: false });
      renderAssets(); renderStats(); renderRefLists();
      if (autoSelect) {
        for (const r of results) if (r.assetId && ['success', 'duplicate', 'warning'].includes(r.status)) state.singleSelected.push(r.assetId);
        renderRefLists();
      }
    },
  });
}

async function runOptimize() {
  if (!state.assetSel.size) { toast('请先勾选要优化的图片', 'err'); return; }
  const items = state.assetMgr.planOptimize([...state.assetSel]);
  if (!items.length) { toast('勾选中没有图片', 'err'); return; }
  if (!confirm(`批量优化 ${items.length} 张图片：\n1. 等比缩放（长边 ≤2048）并补边至 0.4–2.5 比例，不裁切主体；\n2. 原路径引用保留原格式与文件名，其他输出 JPEG；\n3. 每张重新校验并记录派生关系；原文件保留。\n继续？`)) return;
  const dlg = $('dlg-progress');
  $('prog-title').textContent = '批量优化图片';
  $('prog-plan').textContent = `将处理 ${items.length} 张图片。声音不会被批量优化（需单独指定裁切区间）。`;
  $('prog-results').innerHTML = '';
  resetProgressDialog({ running: true });
  dlg.showModal();
  await state.assetMgr.executeOptimize(items, {
    onProgress: (n, total, name) => {
      $('prog-bar').value = Math.round(n / total * 100);
      $('prog-count').textContent = `${n}/${total}`;
      $('prog-current').textContent = name;
    },
    onItem: () => {},
  }).then(results => {
    renderResults(results);
    resetProgressDialog({ running: false });
    renderAssets(); renderStats();
    toast('优化完成。合规的路径引用优化版已自动映射；内容仍需查看。');
  });
}

async function runZip() {
  if (!state.assetSel.size) { toast('请先勾选素材', 'err'); return; }
  const entries = []; const manifest = { exportedAt: nowIso(), items: [] };
  for (const id of state.assetSel) {
    const a = state.project.assets.find(x => x.id === id);
    if (!a) continue;
    if (!a.blobKey) { manifest.items.push({ name: a.name, missing: '本地副本丢失（原路径素材不在 ZIP 中）' }); continue; }
    const blob = await storage.blobStore.get(a.blobKey);
    if (blob) { entries.push({ name: a.name, blob }); manifest.items.push({ name: a.name, sha256: a.sha256, bytes: a.bytes }); }
  }
  if (!entries.length) { toast('勾选的素材没有可打包的本地副本', 'err'); return; }
  entries.push({ name: 'X-AI_素材清单.json', blob: new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }) });
  try {
    toast('正在打包（store 不重编码，含 CRC32）…');
    const zip = await storage.buildZip(entries, (n, total) => { $('queue-state').textContent = `ZIP ${n}/${total}`; });
    download(zip, `X-AI_素材_${new Date().toISOString().slice(0, 10)}.zip`);
    toast('ZIP 已准备好，已请求浏览器下载（实际保存以浏览器下载列表为准）', 'ok');
  } catch (e) {
    toast(`打包失败：${e.message}`, 'err');
  }
}

function renderResults(results) {
  const labels = { success: '完成', warning: '待处理', duplicate: '复用', skipped: '跳过', error: '失败', pending: '未处理' };
  $('prog-results').innerHTML = results.map(r => `
    <div class="prog-line ${r.status === 'error' ? 'error' : r.status === 'warning' ? 'warning' : 'ok'}">
      <span class="st">${labels[r.status] || r.status}</span><span>${escapeHTML(r.name || '')}</span>
      <span class="muted">${escapeHTML(r.note || '')}</span></div>`).join('');
  const hasFail = results.some(r => r.status === 'error');
  const hasPending = results.some(r => r.status === 'pending');
  $('prog-retry').hidden = !hasFail;
  $('prog-continue').hidden = !hasPending;
  $('prog-export').hidden = false;
}

// ---------- 进度弹窗 ----------
function resetProgressDialog({ running }) {
  $('prog-bar').value = 0; $('prog-count').textContent = ''; $('prog-current').textContent = '';
  $('prog-stop').hidden = !running;
  $('prog-continue').hidden = true; $('prog-retry').hidden = true; $('prog-export').hidden = true;
  $('prog-close').hidden = running;
}
function bindProgressDialog() {
  $('prog-stop').addEventListener('click', () => { state.assetMgr.stopAfterCurrent(); $('prog-stop').disabled = true; });
  $('prog-close').addEventListener('click', () => { $('dlg-progress').close(); $('prog-stop').disabled = false; });
  $('prog-continue').addEventListener('click', () => {
    const plan = state.progCtx?.plan;
    if (!plan) return;
    resetProgressDialog({ running: true });
    state.assetMgr.execute(plan, {
      onProgress: (n, total, name) => { $('prog-bar').value = Math.round(n / total * 100); $('prog-count').textContent = `${n}/${total}`; $('prog-current').textContent = name; },
      onDone: (results) => { renderResults(results); resetProgressDialog({ running: false }); renderAssets(); renderStats(); },
    });
  });
  $('prog-retry').addEventListener('click', () => {
    const plan = state.progCtx?.plan;
    if (!plan) return;
    for (const it of plan.items) if (it.status === 'error') { it.status = 'pending'; it.note = ''; }
    resetProgressDialog({ running: true });
    state.assetMgr.execute(plan, {
      onProgress: (n, total, name) => { $('prog-bar').value = Math.round(n / total * 100); $('prog-count').textContent = `${n}/${total}`; $('prog-current').textContent = name; },
      onDone: (results) => { renderResults(results); resetProgressDialog({ running: false }); renderAssets(); renderStats(); },
    });
  });
  $('prog-export').addEventListener('click', () => {
    const plan = state.progCtx?.plan;
    if (!plan) return;
    const rec = plan.items.map(({ name, kind, bytes, status, note }) => ({ name, kind, bytes, status, note }));
    download(new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' }), 'X-AI_处理记录.json');
  });
}

// ---------- 素材选择弹窗 ----------
function bindPickDialog() {
  $('pick-close').addEventListener('click', () => $('dlg-pick').close());
  $('pick-all').addEventListener('click', () => { $('pick-grid').querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = true; }); });
  $('pick-clear').addEventListener('click', () => { $('pick-grid').querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = false; }); });
  $('pick-confirm').addEventListener('click', () => {
    const ids = [...$('pick-grid').querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    const ctx = state.pickCtx;
    if (ctx?.mode === 'single') state.singleSelected = ids;
    if (ctx?.mode === 'batch') { state.batchDefaultsAssets = ids; renderBatchDefaultsSummary(); }
    if (ctx?.mode === 'frame-first') $('s-first').value = ids[0] || '';
    if (ctx?.mode === 'frame-last') $('s-last').value = ids[0] || '';
    renderRefLists();
    $('dlg-pick').close();
  });
}
function openPickDialog(ctx) {
  state.pickCtx = ctx;
  const grid = $('pick-grid');
  grid.innerHTML = '';
  $('pick-title').textContent = ctx.mode === 'batch' ? '选择批量共用素材' : ctx.mode === 'single' ? '选择参考素材' : ctx.mode === 'frame-first' ? '选择首帧图片' : '选择尾帧图片';
  $('pick-hint').textContent = ctx.mode === 'single'
    ? '图 ≤5 张、声 ≤3 段；组合限制在入队时校验。'
    : ctx.mode === 'batch' ? '仅当清单未写任何参考列时使用。' : '只能选择图片。';
  const assets = state.project.assets.filter(a => !ctx.kind || a.kind === ctx.kind);
  const selected = new Set(ctx.mode === 'single' ? state.singleSelected : ctx.mode === 'batch' ? state.batchDefaultsAssets : []);
  for (const a of assets) {
    const label = document.createElement('label');
    label.className = 'asset-card';
    label.innerHTML = `<input type="checkbox" value="${a.id}" ${selected.has(a.id) ? 'checked' : ''} style="position:absolute;top:8px;left:8px;width:17px;height:17px">
      <div class="asset-media" style="cursor:pointer"></div>
      <div class="asset-body"><div class="asset-name">${escapeHTML(a.name)}</div><div class="asset-meta">${bytesHuman(a.bytes)}</div></div>`;
    const media = label.querySelector('.asset-media');
    if (a.blobKey) {
      storage.blobStore.get(a.blobKey).then(b => {
        if (!b) return;
        if (a.kind === 'image') { const img = document.createElement('img'); img.loading = 'lazy'; img.src = URL.createObjectURL(b); img.alt = a.name; media.appendChild(img); }
        else { const au = document.createElement('audio'); au.controls = true; au.src = URL.createObjectURL(b); media.appendChild(au); }
      });
    } else media.innerHTML = '<span class="muted">源路径素材</span>';
    grid.appendChild(label);
  }
  $('pick-empty').hidden = assets.length > 0;
  $('dlg-pick').showModal();
}

// ---------- 全图 ----------
function openImageViewer(asset) {
  storage.blobStore.get(asset.blobKey).then(b => {
    if (!b) return;
    if (state.imgState.url) URL.revokeObjectURL(state.imgState.url);
    state.imgState = { fit: true, zoom: 1, url: URL.createObjectURL(b) };
    $('img-title').textContent = `全图 · ${asset.name}`;
    $('img-info').textContent = `${asset.width}×${asset.height} · ${bytesHuman(asset.bytes)}`;
    const view = $('img-view');
    view.src = state.imgState.url;
    $('img-viewport').classList.remove('orig');
    view.style.transform = '';
    $('dlg-image').showModal();
  });
}
function bindImageDialog() {
  $('img-close').addEventListener('click', () => $('dlg-image').close());
  const view = $('img-view');
  $('img-fit').addEventListener('click', () => {
    state.imgState.fit = true;
    $('img-viewport').classList.remove('orig'); view.style.transform = '';
    $('img-fit').classList.add('active'); $('img-orig').classList.remove('active');
  });
  $('img-orig').addEventListener('click', () => {
    state.imgState.fit = false;
    $('img-viewport').classList.add('orig');
    $('img-orig').classList.add('active'); $('img-fit').classList.remove('active');
  });
  $('img-zoom-in').addEventListener('click', () => {
    $('img-orig').click();
    state.imgState.zoom = Math.min(8, state.imgState.zoom * 1.25);
    view.style.transform = `scale(${state.imgState.zoom})`;
    view.style.transformOrigin = 'top left';
  });
  $('img-zoom-out').addEventListener('click', () => {
    state.imgState.zoom = Math.max(0.2, state.imgState.zoom / 1.25);
    view.style.transform = `scale(${state.imgState.zoom})`;
    view.style.transformOrigin = 'top left';
  });
}

// ---------- 密钥弹窗 ----------
function bindKeysDialog() {
  $('btn-use-key').addEventListener('click', () => {
    const fb = $('keys-feedback');
    try {
      credentials.useNewKey($('key-input').value);
      $('key-input').value = '';
      feedback(fb, 'ok', '已启用新密钥（仅本次会话内存使用）。');
    } catch (e) {
      feedback(fb, 'err', escapeHTML(e.message));
      $('key-input').classList.add('err');
      setTimeout(() => $('key-input').classList.remove('err'), 3000);
    }
    renderKeyStatus();
  });
  $('btn-test-conn').addEventListener('click', async () => {
    const fb = $('keys-feedback');
    if (!credentials.key) { feedback(fb, 'err', '请先启用密钥。'); return; }
    feedback(fb, '', '连接测试中（计入 90 秒认证间隔）…');
    const res = await state.transport.api('GET', '/v1/models');
    if (res.ok) {
      const flash = JSON.stringify(res.json || '').includes(MODEL_ID);
      feedback(fb, 'ok', `连接正常（HTTP 200）。${flash ? '模型列表包含 ' + MODEL_ID + '。' : '注意：模型列表中未发现 ' + MODEL_ID + '。'}“已启用 / 连接正常”不代表有余额或生成可用。`);
    } else if (res.status === 0) {
      feedback(fb, 'err', `连接失败（${res.error === 'timeout' ? '超时' : '网络错误'}）：检查网络、密钥权限及服务商状态；跨域问题见高级连接设置。`);
    } else {
      feedback(fb, 'err', `连接测试失败（HTTP ${res.status}）：${escapeHTML((res.text || '').slice(0, 160))}`);
    }
  });
  $('btn-vault-save').addEventListener('click', async () => {
    const fb = $('keys-feedback');
    try {
      await credentials.vaultSave($('vault-key').value, $('vault-pass').value);
      $('vault-key').value = ''; $('vault-pass').value = '';
      feedback(fb, 'ok', '已加密保存到本浏览器（PBKDF2 + AES-GCM）。下次可在“使用已存密钥”解锁。');
    } catch (e) { feedback(fb, 'err', escapeHTML(e.message)); }
  });
  $('btn-vault-unlock').addEventListener('click', async () => {
    const fb = $('keys-feedback');
    try {
      await credentials.vaultUnlock($('vault-unlock-pass').value);
      $('vault-unlock-pass').value = '';
      feedback(fb, 'ok', '解锁成功，密钥已启用（会话内存）。');
    } catch (e) { feedback(fb, 'err', escapeHTML(e.message)); }
    renderKeyStatus();
  });
  $('conn-origin').addEventListener('change', () => { state.project.settings.origin = $('conn-origin').value; persistProject(); });
  $('conn-gap').addEventListener('change', () => {
    const v = Math.max(90, Math.min(3600, Number($('conn-gap').value) || 90));
    state.project.settings.gap = v; $('conn-gap').value = v; persistProject();
  });
}
function openKeysDialog() {
  $('keys-advanced').open = false; // 每次打开默认收起
  $('conn-origin').value = state.project.settings.origin;
  $('conn-gap').value = state.project.settings.gap;
  credentials.vaultExists().then(has => {
    if (!has) $('btn-vault-unlock').disabled = true; else $('btn-vault-unlock').disabled = false;
  });
  renderKeyStatus();
  $('dlg-keys').showModal();
}

// ---------- 参考列表 ----------
function renderRefLists() {
  const ul = $('s-ref-list');
  ul.innerHTML = '';
  if (!state.singleSelected.length) ul.innerHTML = '<li class="ref-empty" style="border:0;background:none">未选择参考素材</li>';
  for (const id of state.singleSelected) {
    const a = state.project.assets.find(x => x.id === id);
    if (!a) continue;
    const li = document.createElement('li');
    li.innerHTML = `${a.kind === 'image' ? '🖼' : '🔊'} ${escapeHTML(a.name)}<button type="button" class="ref-x" title="移除">✕</button>`;
    li.querySelector('.ref-x').addEventListener('click', () => {
      state.singleSelected = state.singleSelected.filter(x => x !== id);
      renderRefLists();
    });
    ul.appendChild(li);
  }
  // 首尾帧下拉
  const images = state.project.assets.filter(a => a.kind === 'image');
  for (const [sel, cur] of [[$('s-first'), $('s-first').value], [$('s-last'), $('s-last').value]]) {
    sel.innerHTML = '<option value="">未选择</option>' + images.map(a => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('');
    sel.value = cur;
  }
  // 批量共用
  const bul = $('b-ref-list');
  bul.innerHTML = state.batchDefaultsAssets.length
    ? state.batchDefaultsAssets.map(id => {
        const a = state.project.assets.find(x => x.id === id);
        return `<li>${a ? escapeHTML(a.name) : id}</li>`;
      }).join('')
    : '<li class="ref-empty" style="border:0;background:none">未选择共用素材</li>';
}
