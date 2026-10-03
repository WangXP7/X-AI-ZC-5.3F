# -*- coding: utf-8 -*-
# app.js 集成补丁：experience/Pavo/Studio/入队清空/提示词解析/看门狗/互斥播放/进度卡/素材筛选
import io

p = 'app/src/app.js'
src = io.open(p, encoding='utf-8', newline='').read()
NL = '\r\n' if '\r\n' in src else '\n'

def rep(old, new):
    global src
    assert old in src, 'MISSING: ' + old[:70].replace('\n', '\\n')
    src = src.replace(old, new, 1)

# 1) 导入新模块
rep("import { concatenateClips, ffmpegAvailable } from './media.js';",
    """import { concatenateClips, ffmpegAvailable } from './media.js';
import { installPlaybackController } from './playback.js';
import { QueueWatchdog } from './queue-watchdog.js';
import { parsePromptSpec } from './prompt-spec.js';
import { cooldownRemainingSeconds, pendingSubmission } from './submission-policy.js';
import { MODEL_PROFILES, modelOptions, profileById, modeLimits } from './models.js';""")

# 2) state 增加 experience / pavoSelected / filters
rep("""const state = {
  project: null,
  dirHandle: null,""",
    """const state = {
  project: null,
  dirHandle: null,
  experience: 'easy',
  pavoSelected: [],
  pavoAspect: '16:9',
  pavoSeconds: 12,
  assetFilters: { version: 'effective', kind: 'all', status: 'all', q: '' },""")

# 3) init：能力检查后加 experience 载入；锁后 initCore 内加 ensureStudios/watchdog/playback
rep("""  // 3. 项目工作副本
  let saved = null;""",
    """  // 3. 项目工作副本
  let saved = null;""")

rep("""    } else {
      state.project = saved;
    }
  }
  if (!state.project) state.project = makeProject();""",
    """    } else {
      state.project = saved;
    }
  }
  if (!state.project) state.project = makeProject();
  ensureStudios(state.project);""")

# imports for ensureStudios
rep("import { SCHEMA, makeProject, newJob, validateProjectFile, validateJob, STATE_LABELS, stateBadgeKind,",
    "import { SCHEMA, makeProject, newJob, validateProjectFile, validateJob, STATE_LABELS, stateBadgeKind, ensureStudios, activeStudio, durationQA,")

# 4) initCore 末尾：playback + watchdog + experience + pavo 初始化
rep("""  // 7. UI
  bindUI();
step('ui-bound');
  renderAll();""",
    """  // 7. UI
  state.experience = (await idbGet('state', 'experience')) || 'easy';
  bindUI();
  bindExperience();
  bindPavo();
  installPlaybackController(document);
  state.watchdog = new QueueWatchdog({
    project: state.project,
    runner: state.runner,
    persist: persistProject,
    logEvent,
    hasKey: () => !!credentials.key,
    hasDirPermission: () => !state.dirHandle || !!state.dirHandle,
  });
  state.watchdog.start();
  renderAll();
  applyExperience();
  updateModelOptions();""")

# idbGet helper
rep("""// ================= 工具 =================""",
    """// ================= 工具 =================
async function idbGet(store, key) {
  const { idb } = await import('./storage.js');
  try { return await idb.get(store, key); } catch { return null; }
}""")

# 5) bindUI：模式切换支持 pavo + 刷新状态按钮 + Pavo 绑定 + 筛选 + 清空恢复
rep("""  // 模式切换
  document.querySelectorAll('input[name=gen-mode]').forEach(r => r.addEventListener('change', () => {
    const batch = document.querySelector('input[name=gen-mode]:checked').value === 'batch';
    for (const ed of [$('single-editor'), $('batch-editor')]) { ed.hidden = ed.id !== (batch ? 'batch-editor' : 'single-editor'); ed.disabled = ed.id !== (batch ? 'batch-editor' : 'single-editor'); }
  }));""",
    """  // 模式切换（含 PavoAI）
  document.querySelectorAll('input[name=gen-mode]').forEach(r => r.addEventListener('change', () => {
    const v = document.querySelector('input[name=gen-mode]:checked').value;
    const map = { pavo: 'pavo-editor', single: 'single-editor', batch: 'batch-editor' };
    for (const ed of [$('pavo-editor'), $('single-editor'), $('batch-editor')]) {
      const on = ed.id === map[v];
      ed.hidden = !on; ed.disabled = !on;
    }
    renderPavoChips();
  }));""")

rep("""  // 任务页
  $('btn-run-queue').addEventListener('click', async () => {""",
    """  // 任务页
  $('btn-refresh-status').addEventListener('click', async () => {
    const b = $('btn-refresh-status');
    b.disabled = true; b.textContent = '正在刷新';
    try { await state.runner.safeRefresh(); } finally { b.disabled = false; b.textContent = '刷新状态'; }
  });
  $('btn-run-queue').addEventListener('click', async () => {""")

# 6) 素材筛选与清空/恢复绑定
rep("""  $('btn-asset-optimize').addEventListener('click', runOptimize);""",
    """  for (const [id, key] of [['asset-filter-version', 'version'], ['asset-filter-kind', 'kind'], ['asset-filter-status', 'status']]) {
    $(id).addEventListener('change', ev => { state.assetFilters[key] = ev.target.value; renderAssets(); });
  }
  $('asset-filter-q').addEventListener('input', ev => { state.assetFilters.q = ev.target.value.trim().toLowerCase(); renderAssets(); });
  $('btn-asset-clear-lib').addEventListener('click', async () => {
    const st = activeStudio(state.project);
    if (!st.assetIds.length) { toast('当前创作项目的素材库已经是空的'); return; }
    if (!confirm(`清空素材库：当前创作项目的 ${st.assetIds.length} 项素材成员将归档（不删除文件、浏览器数据、历史任务）。可稍后恢复。继续？`)) return;
    st.archivedAssetIds = [...(st.archivedAssetIds || []), ...st.assetIds];
    st.assetIds = [];
    await persistProject();
    renderAssets(); toast('素材库已清空（可恢复）');
  });
  $('btn-asset-restore').addEventListener('click', async () => {
    const st = activeStudio(state.project);
    st.assetIds = [...(st.assetIds || []), ...(st.archivedAssetIds || [])];
    st.archivedAssetIds = [];
    await persistProject();
    renderAssets(); toast('已恢复清空的素材');
  });
  $('btn-auto-associate').addEventListener('click', autoAssociate);
  $('btn-asset-optimize').addEventListener('click', runOptimize);""")

# 7) renderAssets：筛选 + Studio 成员范围（一次性替换）
rep("""function renderAssets() {
  const grid = $('asset-grid');
  const assets = state.project.assets;
  grid.innerHTML = '';""",
    """function filterAssets(assets) {
  const f = state.assetFilters;
  const byId = new Map(assets.map(a => [a.id, a]));
  return assets.filter(a => {
    if (f.version === 'effective') {
      if (a.derivedFrom) {
        let root = a;
        while (root && root.derivedFrom) root = byId.get(root.derivedFrom);
        if (root && root.effectiveAssetId && root.effectiveAssetId !== a.id) return false;
      } else if (a.effectiveAssetId) {
        return false; // 原图已被有效替代：当前有效视图隐藏原图
      }
    } else if (f.version === 'original' && a.derivedFrom) return false;
    else if (f.version === 'derived' && !a.derivedFrom) return false;
    if (f.kind !== 'all' && a.kind !== f.kind) return false;
    if (f.status === 'ok' && (a.errors || []).length) return false;
    if (f.status === 'pending' && !(a.errors || []).length) return false;
    if (f.q) {
      const hay = `${a.name} ${(a.aliases || []).join(' ')} ${a.path || ''}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
}

function renderAssets() {
  const grid = $('asset-grid');
  const st = activeStudio(state.project);
  $('btn-asset-restore').hidden = !(st.archivedAssetIds || []).length;
  const assets = filterAssets(state.project.assets.filter(a => (st.assetIds || []).includes(a.id) || a.effectiveAssetId));
  grid.innerHTML = '';""")

# 删除旧的 regex 过滤器插入段（不再需要）
src = src.replace('''# 修正上面 filterAssets 中的重复声明问题（重写该过滤函数）
import re
src = re.sub(r"function filterAssets\\(assets\\) \\{[\\s\\S]*?\\n\\}\\n\\nfunction renderAssets", """function filterAssets(assets) {
  const f = state.assetFilters;
  const byId = new Map(assets.map(a => [a.id, a]));
  return assets.filter(a => {
    if (f.version === 'effective') {
      if (a.derivedFrom) {
        // 派生版：仅当它是其原资产链的当前有效版时显示
        let root = a;
        while (root?.derivedFrom) root = byId.get(root.derivedFrom);
        if (root && root.effectiveAssetId && root.effectiveAssetId !== a.id) return false;
      } else if (a.effectiveAssetId) {
        return false; // 原图已被有效替代：当前有效视图隐藏原图
      }
    } else if (f.version === 'original' && a.derivedFrom) return false;
    else if (f.version === 'derived' && !a.derivedFrom) return false;
    if (f.kind !== 'all' && a.kind !== f.kind) return false;
    if (f.status === 'ok' && (a.errors || []).length) return false;
    if (f.status === 'pending' && !(a.errors || []).length) return false;
    if (f.q) {
      const hay = `${a.name} ${(a.aliases || []).join(' ')} ${a.path || ''}`.toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  });
}

function renderAssets""", src, 1)

''', '')

# 8) collectSingleSpec：提示词解析 + 新字段
rep("""function collectSingleSpec() {
  const spec = {
    id: $('s-id').value.trim() || 'S01',
    episode: $('s-episode').value.trim() || 'EP01',
    prompt: $('s-prompt').value,
    dialogue: $('s-dialogue').value.trim(),
    seconds: Number($('s-seconds').value),
    aspect: $('s-aspect').value,
    mode: $('s-mode').value,""",
    """function collectSingleSpec() {
  const parsed = parsePromptSpec({ promptText: $('s-prompt').value, dialogueText: $('s-dialogue').value.trim(), defaultSeconds: Number($('s-seconds').value) });
  const seconds = parsed.seconds ?? Number($('s-seconds').value);
  const spec = {
    id: $('s-id').value.trim() || 'S01',
    episode: $('s-episode').value.trim() || 'EP01',
    prompt: parsed.prompt,
    dialogue: parsed.dialogue,
    seconds,
    durationSource: parsed.secondsSource,
    promptSeconds: parsed.seconds,
    ambiguousDuration: parsed.ambiguous,
    aspect: $('s-aspect').value,
    mode: $('s-mode').value,""")

# 9) enqueueSingle：歧义阻止；入队成功清空输入；easy/pavo 自动启动
rep("""function enqueueSingle() {
  const fb = $('single-feedback');
  const spec = collectSingleSpec();
  const job = newJob(spec);""",
    """function enqueueSingle() {
  const fb = $('single-feedback');
  const spec = collectSingleSpec();
  if (spec.ambiguousDuration) {
    feedback(fb, 'err', `时长声明歧义：${spec.promptSeconds || ''}。请保留一个明确总时长后再入队。`);
    return;
  }
  const st = activeStudio(state.project);
  spec.studioId = st.id; spec.studioName = st.name;
  spec.experience = state.experience;
  spec.creationMode = 'single';
  spec.profileId = MODEL_PROFILES[0].id;
  spec.autoSubmit = state.experience === 'easy';
  const job = newJob(spec);""")

rep("""  state.project.jobs.push(job);
  logEvent('input_approved', `任务 ${job.id} 入队（${spec.mode}，${spec.seconds}s ${spec.aspect}）`, job.id);
  persistProject(state.dirHandle ? true : false);
  feedback(fb, 'ok', `<b>已入队：</b>${escapeHTML(job.id)}。实际付费生成需到“任务与成片”点击“开始 / 继续队列”。`);
  // 生成下一个未使用的 Sxx 镜号
  let n = parseInt(spec.id.replace(/\\D/g, ''), 10) || state.project.jobs.length;
  let next;
  do { n++; next = `${spec.id.replace(/\\d+/, '')}${String(n).padStart(2, '0')}`; } while (state.project.jobs.some(j => j.id === next));
  $('s-id').value = next;
  renderAll();
}""",
    """  state.project.jobs.push(job);
  logEvent('input_approved', `任务 ${job.id} 入队（${spec.mode}，${spec.seconds}s ${spec.aspect}）`, job.id);
  persistProject(state.dirHandle ? true : false);
  // 入队成功即清空本轮创作输入（第 37.5 章）：提示词、对白、种子、参考、首末帧；保留参数与镜号推进
  $('s-prompt').value = ''; $('s-prompt-count').textContent = '0 / 12000';
  $('s-dialogue').value = ''; $('s-seed').value = '';
  state.singleSelected = [];
  renderRefLists();
  let n = parseInt(spec.id.replace(/\\D/g, ''), 10) || state.project.jobs.length;
  let next;
  do { n++; next = `${spec.id.replace(/\\d+/, '')}${String(n).padStart(2, '0')}`; } while (state.project.jobs.some(j => j.id === next));
  $('s-id').value = next;
  const cd = cooldownRemainingSeconds(state.project);
  Promise.resolve(cd).then(s => {
    const extra = s > 0 ? `平台成功冷却 ${s}s 后自动提交。` : '将按请求间隔自动接续。';
    feedback(fb, 'ok', `<b>${escapeHTML(job.id)} 已进入队列；输入框已准备好下一镜。</b>${state.experience === 'easy' ? extra : '到“任务与成片”点击“开始 / 继续队列”开始生成。'}`);
    renderAll();
  });
  if (state.experience === 'easy' && !state.runner.running) state.runner.start({ onlyUids: [job.uid] });
}""")

io.open(p, 'w', encoding='utf-8', newline='').write(src)
print('app.js patch 1 done')
