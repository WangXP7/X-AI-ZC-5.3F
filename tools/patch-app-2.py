# -*- coding: utf-8 -*-
# app.js 补丁 2：experience 切换、Pavo 流程、进度卡、模型选项、自动关联、入队反馈定时器
import io
p = 'app/src/app.js'
src = io.open(p, encoding='utf-8').read()

def rep(old, new):
    global src
    assert old in src, 'MISSING: ' + old[:70].replace('\n', '\\n')
    src = src.replace(old, new, 1)

# 1) 在文件末尾追加新函数组
src += '''
// ================= 1.2 版本：小白版 / 专家版、PavoAI、进度卡 =================
function applyExperience() {
  const easy = state.experience !== 'pro';
  $('exp-easy').setAttribute('aria-pressed', String(easy));
  $('exp-pro').setAttribute('aria-pressed', String(!easy));
  $('exp-hint').textContent = easy ? '最少操作：提示词 → 素材 → 生成' : '完整参数与管理区域';
  // 小白版隐藏管理区域（第 35.1 章）：目录卡 / 模式切换说明保留 Pavo 入口
  document.querySelectorAll('.exp-pro-only').forEach(el => { el.hidden = easy; });
  // 小白版默认进入 Pavo 标签
  if (easy) {
    const pavo = document.querySelector('input[name=gen-mode][value=pavo]');
    if (pavo) { pavo.checked = true; pavo.dispatchEvent(new Event('change')); }
  }
}

function bindExperience() {
  $('exp-easy').addEventListener('click', async () => {
    state.experience = 'easy';
    await import('./storage.js').then(m => m.idb.set('state', 'experience', 'easy'));
    applyExperience();
  });
  $('exp-pro').addEventListener('click', async () => {
    state.experience = 'pro';
    await import('./storage.js').then(m => m.idb.set('state', 'experience', 'pro'));
    applyExperience();
  });
}

function updateModelOptions() {
  const opts = modelOptions();
  for (const sel of [$('video-model'), $('pavo-model')]) {
    if (!sel) continue;
    sel.innerHTML = opts.map(o => `<option value="${o.value}"${o.available ? '' : ' disabled'}>${o.label}</option>`).join('');
  }
  // Pavo 时长按钮按当前 profile 生成
  const profile = MODEL_PROFILES[0];
  const row = $('pavo-seconds-row');
  row.innerHTML = profile ? (() => {
    const lim = modeLimits(profile, 'reference');
    let out = '';
    for (let s = lim.minSeconds; s <= lim.maxSeconds; s++) out += `<button type="button" data-seconds="${s}"${s === state.pavoSeconds ? ' class="on"' : ''}>${s}</button>`;
    return out;
  })() : '';
  row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.pavoSeconds = Number(b.dataset.seconds);
    row.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    updatePavoSummary();
  }));
}

function updatePavoSummary() {
  $('pavo-summary').textContent = `${state.pavoAspect} · ${state.pavoSeconds}s · 720P`;
}

function bindPavo() {
  const pop = document.querySelector('.pavo-settings');
  $('pavo-summary').addEventListener('click', (e) => {
    // 手动切换展开收起；aria-expanded 同步（第 35.3 章）
    requestAnimationFrame(() => $('pavo-summary').setAttribute('aria-expanded', String(pop.open)));
  });
  document.addEventListener('click', (e) => {
    if (pop.open && !pop.contains(e.target) && e.target !== $('pavo-summary')) {
      pop.open = false; $('pavo-summary').setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop.open) { pop.open = false; $('pavo-summary').setAttribute('aria-expanded', 'false'); }
  });
  $('pavo-aspect-row').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    state.pavoAspect = b.dataset.aspect === 'auto' ? '16:9' : b.dataset.aspect; // Auto 本地解析：无图 16:9
    $('pavo-aspect-row').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    updatePavoSummary();
  }));
  $('btn-pavo-assets').addEventListener('click', () => openPickDialog({ mode: 'pavo', kind: null }));
  $('btn-pavo-generate').addEventListener('click', pavoGenerate);
  setInterval(renderPavoPosition, 1000);
}

function renderPavoChips() {
  const ul = $('pavo-chips');
  if (!ul) return;
  ul.innerHTML = '';
  for (const id of state.pavoSelected) {
    const a = state.project.assets.find(x => x.id === id);
    if (!a) continue;
    const li = document.createElement('li');
    li.innerHTML = `${a.kind === 'image' ? '🖼' : '🔊'} ${escapeHTML(a.name)}<button type="button" class="ref-x" title="移除">✕</button>`;
    li.querySelector('.ref-x').addEventListener('click', () => {
      state.pavoSelected = state.pavoSelected.filter(x => x !== id);
      renderPavoChips();
    });
    ul.appendChild(li);
  }
}

function renderPavoPosition() {
  const el = $('pavo-position');
  if (!el || $('pavo-editor').hidden) return;
  const { position } = pendingSubmission(state.project, null);
  cooldownRemainingSeconds(state.project).then(cd => {
    const parts = [];
    if (position) parts.push(`队列第 ${position} 位`);
    if (cd > 0) parts.push(`成功冷却 ${cd}s`);
    el.textContent = parts.join(' · ');
  });
}

// Pavo 生成：解析提示词 → 自动模式 → 入队（冷却不拒收）→ 清空输入 → 自动接续
async function pavoGenerate() {
  const fb = $('pavo-feedback');
  const promptText = $('pavo-prompt').value;
  if (!promptText.trim()) { feedback(fb, 'err', '请先描述画面与动作。'); return; }
  const parsed = parsePromptSpec({ promptText, defaultSeconds: state.pavoSeconds });
  if (parsed.ambiguous) { feedback(fb, 'err', `时长声明歧义：${parsed.ambiguityDetail}`); return; }
  const st = activeStudio(state.project);
  // 全能模式：有参考取 reference，无参考取 text（第 34.3 章）
  let mode = $('pavo-generation-mode').value;
  if (mode === 'auto') mode = state.pavoSelected.length ? 'reference' : 'text';
  const spec = {
    id: nextShotId('S'), episode: $('s-episode')?.value?.trim() || 'EP01',
    prompt: parsed.prompt, dialogue: parsed.dialogue,
    seconds: parsed.seconds ?? state.pavoSeconds, durationSource: parsed.secondsSource, promptSeconds: parsed.seconds,
    aspect: state.pavoAspect, mode,
    seed: null, assetIds: [...state.pavoSelected], firstFrame: null, lastFrame: null, continuityFrom: null,
    sourceReferences: [], textSources: [], referenceReplacements: [],
    studioId: st.id, studioName: st.name, experience: state.experience === 'pro' ? 'pro' : 'easy',
    creationMode: 'pavo', profileId: MODEL_PROFILES[0].id, autoSubmit: true,
  };
  const job = newJob(spec);
  const { errors } = validateJob(job, state.project);
  if (errors.length) { feedback(fb, 'err', `<b>未入队：</b><ul>${errors.map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>`); return; }
  state.project.jobs.push(job);
  await logEvent('input_approved', `任务 ${job.id} 入队（PavoAI，${spec.mode}，${spec.seconds}s）`, job.id);
  await persistProject(state.dirHandle ? true : false);
  // 入队成功即清空本轮创作输入（第 37.5 章）：提示词与素材 chips；保留模型 / 模式 / 画幅 / 时长
  $('pavo-prompt').value = '';
  state.pavoSelected = [];
  renderPavoChips();
  const cd = await cooldownRemainingSeconds(state.project);
  feedback(fb, 'ok', `<b>${escapeHTML(job.id)} 已进入队列；输入框已准备好下一镜。</b>${cd > 0 ? `平台成功冷却 ${cd}s 后自动提交。` : '将按请求间隔自动接续。'}`);
  renderAll();
  if (!state.runner.running) state.runner.start({ onlyUids: [job.uid] });
}

function nextShotId(prefix) {
  let n = 0;
  for (const j of state.project.jobs) {
    const m = j.id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}${String(n + 1).padStart(2, '0')}`;
}

// 自动关联素材库（第 27.4 章）：完整文件名（NFC、大小写不敏感）唯一匹配；有效版优先；歧义整批拒绝
async function autoAssociate() {
  const fb = $('single-feedback');
  const text = $('s-prompt').value;
  if (!text.trim()) { feedback(fb, 'err', '请先在提示词中写出素材文件名，例如：以 C02_齐天大圣.png 为人物参考。'); return; }
  const st = activeStudio(state.project);
  const norm = s => String(s).normalize('NFC').toLowerCase();
  const byName = new Map();
  for (const a of state.project.assets.filter(x => (st.assetIds || []).includes(x.id) || x.effectiveAssetId)) {
    const list = byName.get(norm(a.name)) || [];
    list.push(a);
    byName.set(norm(a.name), list);
  }
  const matched = []; const missing = []; const ambiguous = [];
  const seen = new Set();
  for (const [n, list] of byName) {
    if (!text.toLowerCase().includes(n)) continue;
    // 取有效版本
    let pick = list[0];
    for (const cand of list) if (cand.effectiveAssetId) pick = byName.get(norm(pick.name))?.find(x => x.id === cand.effectiveAssetId) || pick;
    const eff = pick.effectiveAssetId ? state.project.assets.find(x => x.id === pick.effectiveAssetId) : pick;
    if (list.length > 1 && !text.includes(pick.path || '') && new Set(list.map(x => x.id)).size > 1 && pick.effectiveAssetId == null) {
      ambiguous.push(n); continue;
    }
    if (!seen.has(eff.id)) { seen.add(eff.id); matched.push(eff); }
  }
  for (const a of st.assetIds.map(id => state.project.assets.find(x => x.id === id)).filter(Boolean)) {
    const n = norm(a.name);
    if (text.toLowerCase().includes(n) && !byName.has(n)) missing.push(a.name);
  }
  if (ambiguous.length) { feedback(fb, 'err', `同名素材存在多个候选：${ambiguous.join('、')}。请写完整已登记路径或手动选择。`); return; }
  if (!matched.length) { feedback(fb, 'err', '未匹配到素材：请确认已导入，并在提示词中写完整文件名（含扩展名）。'); return; }
  const merged = [...state.singleSelected];
  for (const a of matched) if (!merged.includes(a.id)) merged.push(a.id);
  const imgs = merged.filter(id => state.project.assets.find(x => x.id === id)?.kind === 'image').length;
  const auds = merged.filter(id => state.project.assets.find(x => x.id === id)?.kind === 'audio').length;
  if (imgs > 5 || auds > 3) { feedback(fb, 'err', `合并后参考超限（图 ${imgs}/5，声 ${auds}/3），请删减后再应用。`); return; }
  state.singleSelected = merged;
  $('s-mode').value = state.pavoSelected && merged.some(id => state.project.assets.find(x => x.id === id)?.kind === 'audio') ? 'reference' : 'reference';
  renderRefLists();
  feedback(fb, 'ok', `已关联 ${matched.length} 项素材：${matched.map(a => escapeHTML(a.name)).join('、')}。可在参考列表中移除。`);
}

// 动态进度卡（第 32/33 章）：每秒更新数字与当前阶段，不重建任务卡
function renderQProgress() {
  const card = $('qprogress');
  if (!card || $('page-tasks').classList.contains('active') === false) return;
  const jobs = state.project.jobs;
  const ready = jobs.filter(j => ['ready', 'approved'].includes(j.state)).length;
  const active = jobs.filter(j => ['submitting', 'queued', 'generating', 'download', 'checking', 'deferred'].includes(j.state)).length;
  const pending = jobs.filter(j => j.state === 'pending').length;
  const issue = jobs.filter(j => ['needs_redo', 'failed', 'invalid', 'blocked', 'unknown'].includes(j.state)).length;
  $('qp-total').textContent = jobs.length;
  $('qp-ready').textContent = ready;
  $('qp-active').textContent = active;
  $('qp-pending').textContent = pending;
  $('qp-issue').textContent = issue;
  const pct = jobs.length ? Math.round(ready / jobs.length * 100) : 0;
  $('qp-bar-fill').style.width = pct + '%';
  $('qp-pct').textContent = pct + '%';
  const cur = jobs.find(j => ['submitting', 'queued', 'generating', 'download', 'checking'].includes(j.state));
  $('qp-current').textContent = cur
    ? `${cur.id} · ${STATE_LABELS[cur.state] || cur.state}${cur.downloadBytes ? ` · 已收 ${(cur.downloadBytes / 1e6).toFixed(1)}MB` : ''}`
    : (state.runner.running ? '运行中' : '空闲');
  // 看门狗自检信息
  const wi = $('watchdog-info');
  if (wi && state.watchdog?.lastCheck) {
    const lc = state.watchdog.lastCheck;
    wi.textContent = `自检 ${new Date(lc.at).toLocaleTimeString()} · ${lc.message}`;
  }
}
setInterval(renderQProgress, 1000);
'''

io.open(p, 'w', encoding='utf-8', newline='').write(src)
print('app.js patch 2 done')
