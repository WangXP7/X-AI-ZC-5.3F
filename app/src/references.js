// references.js — 文本 / 素材上下文递归解析：定位、去重、来源哈希、替换记录。
// 支持语法（第 11 章）：{{file:…}}、{{引用:…}}、@file(…)、[文本](路径#标题)、![图](路径)、
// [声音](路径)、整字段路径、JSON $ref 与 #/指针、素材清单（files=*.json）。
// 不执行文档内任何代码或指令；只按明确语法取数据。
import { sha256Hex } from './core.js';

const BUDGET = {
  depth: 12, files: 500, fileBytes: 2_000_000, totalBytes: 10_000_000,
  fieldChars: 12000, ops: 20000, rowsChars: 10_000_000,
};

const MEDIA_RE = /\.(png|jpe?g|webp|wav|mp3|m4a|aac|ogg|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const DELIMS = [',', '\t', ';', '|', '，', '；'];

export function needsResolution(spec) {
  const re = /(\{\{(file|引用):[^}]+\}\}|@file\([^)]*\)|\[[^\]]*\]\([^)]+\)|\{\$ref)|\.\.?\//;
  return re.test(spec.promptRaw || '') || re.test(spec.dialogueRaw || '') ||
         (spec.refs?.images || []).some(r => !MEDIA_RE.test(r.path)) ||
         (spec.refs?.audios || []).some(r => !MEDIA_RE.test(r.path)) ||
         !!spec.promptFile || !!spec.dialogueFile;
}

export function normalizePath(p) {
  let s = String(p).trim().replace(/\\/g, '/');
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1);
  if (/^[a-z]+:\/\//i.test(s) || /^[a-z]:/i.test(s) || s.startsWith('/')) throw new Error(`不允许绝对路径或 URL：${p}`);
  const out = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) throw new Error(`路径越出授权目录：${p}`); out.pop(); continue; }
    out.push(part);
  }
  if (!out.length) throw new Error(`路径为空：${p}`);
  return out.join('/');
}

// ---------- 编码识别（UTF-8 / UTF-16 BOM / GB18030 回退） ----------
export function decodeBytes(buf) {
  const b = new Uint8Array(buf);
  try {
    if (b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(buf), encoding: 'UTF-16LE' };
    if (b[0] === 0xFE && b[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(buf), encoding: 'UTF-16BE' };
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (/\uFFFD/.test(text)) {
      try { text = new TextDecoder('gb18030').decode(buf); return { text, encoding: 'GB18030（回退，请核对）' }; }
      catch { return { text, encoding: 'UTF-8（含无效字节）' }; }
    }
    return { text: text.replace(/^\uFEFF/, ''), encoding: 'UTF-8' };
  } catch (e) {
    return { text: '', encoding: 'unknown', error: e.message };
  }
}

// ---------- 主解析 ----------
export async function resolveReferences(batch, rootHandle, { shotIds = null, onProgress, baseDir = '' } = {}) {
  const ctx = {
    root: rootHandle,
    index: null,            // 由 batch-panel 注入：Map<relPath, {handle, name, alias}>
    filesRead: 0, totalBytes: 0, ops: 0,
    cache: new Map(),       // relPath -> {sha256, bytes, text?, parsed?}
    baseDir,                // 主清单所在目录（相对 root），文本引用的第一层基准
  };
  const results = [];
  const rows = batch.rows.filter(r => r.spec && (!shotIds || shotIds.includes(r.spec.id)));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; const spec = row.spec;
    onProgress?.(i, rows.length, spec.id);
    const r = {
      id: spec.id,
      prompt: spec.promptRaw, dialogue: spec.dialogueRaw,
      media: [], mediaUsed: [], textSources: [], replacements: [],
      errors: [],
    };
    const baseChain = baseDir ? [`${baseDir}/__main__#`] : [];
    try {
      // 1. 展开素材引用（files / images / audio 列）
      for (const ref of [...(spec.refs?.images || []), ...(spec.refs?.audios || [])]) {
        const m = await resolveMediaRef(ctx, ref, spec.id, r, baseChain);
        if (m) r.media.push(m);
      }
      // 2. 递归展开 prompt / dialogue
      const p = await resolveText(ctx, spec.promptRaw, { shotId: spec.id, field: 'prompt', chain: baseChain, r });
      r.prompt = p.text; r.textSources.push(...p.sources); r.replacements.push(...p.replacements);
      const d = await resolveText(ctx, spec.dialogueRaw, { shotId: spec.id, field: 'dialogue', chain: baseChain, r });
      r.dialogue = d.text; r.textSources.push(...d.sources); r.replacements.push(...d.replacements);
      // 占位编号：Picture / Audio 分别从 1（引用发现顺序已稳定）
      const pics = r.media.filter(m => m.kind === 'image');
      const auds = r.media.filter(m => m.kind === 'audio');
      r.prompt = assignPlaceholders(r.prompt, pics, auds);
      r.dialogue = assignPlaceholders(r.dialogue, pics, auds);
      if (r.prompt.length > BUDGET.fieldChars) r.errors.push(`prompt 展开 ${r.prompt.length} 字，超过 ${BUDGET.fieldChars}`);
      if (r.dialogue.length > BUDGET.fieldChars) r.errors.push(`dialogue 展开 ${r.dialogue.length} 字，超过 ${BUDGET.fieldChars}`);
    } catch (e) {
      r.errors.push(e.message || String(e));
    }
    results.push(r);
  }
  return { results, budget: { filesRead: ctx.filesRead, totalBytes: ctx.totalBytes, ops: ctx.ops } };
}

function assignPlaceholders(text, pics, auds) {
  let t = text;
  // 媒体在展开时以 〈Picture:path〉 临时标记存在
  for (const m of pics) {
    const idx = pics.indexOf(m) + 1;
    t = t.split(`〈Picture:${m.path}〉`).join(`<Picture ${idx}>`);
  }
  for (const m of auds) {
    const idx = auds.indexOf(m) + 1;
    t = t.split(`〈Audio:${m.path}〉`).join(`<Audio ${idx}>`);
  }
  return t;
}

// ---------- 素材引用 ----------
async function resolveMediaRef(ctx, ref, shotId, r, baseChain) {
  ctx.ops++;
  if (ctx.ops > BUDGET.ops) throw new Error('解析操作数超预算，请拆批');
  let path;
  try { path = normalizePath(ref.path); } catch (e) { r.errors.push(`素材「${ref.raw}」：${e.message}`); return null; }
  if (MEDIA_RE.test(path)) {
    const dedup = r.media.find(m => m.path === path);
    if (dedup) { if (ref.alias) dedup.alias = ref.alias; return dedup; }
    const kind = IMAGE_RE.test(path) ? 'image' : 'audio';
    const m = { kind, path, alias: ref.alias || null, raw: ref.raw, sha256: null };
    try {
      const file = await readFromIndex(ctx, path);
      m.sha256 = await sha256Hex(await file.arrayBuffer());
      m.bytes = file.size; m.name = path.split('/').pop();
    } catch (e) { r.errors.push(`素材「${ref.raw}」无法读取：${e.message}`); return null; }
    return m;
  }
  // 非媒体路径：素材清单（JSON / CSV / TXT），继续读取其中的媒体路径
  const file = await readFromIndex(ctx, path);
  const { text } = decodeBytes(await file.arrayBuffer());
  const list = parseAssetManifest(path, text);
  if (!list.length) { r.errors.push(`素材清单「${ref.raw}」没有可定位的媒体路径`); return null; }
  if (ref.fragment) {
    const picked = list.filter(x => x.alias === ref.fragment);
    if (!picked.length) { r.errors.push(`素材清单「${ref.raw}」中找不到编号「${ref.fragment}」`); return null; }
    list.length = 0; list.push(...picked);
  }
  let first = null;
  for (const item of list) {
    const mp = normalizeRelTo(path, item.path);
    if (!MEDIA_RE.test(mp)) continue;
    const dedup = r.media.find(m => m.path === mp);
    if (dedup) { if (item.alias) dedup.alias = dedup.alias || item.alias; if (!first) first = dedup; continue; }
    const m = { kind: IMAGE_RE.test(mp) ? 'image' : 'audio', path: mp, alias: item.alias || ref.alias || null, raw: `${ref.raw}#${item.alias || ''}`, sha256: null };
    try {
      const mf = await readFromIndex(ctx, mp);
      m.sha256 = await sha256Hex(await mf.arrayBuffer());
      m.bytes = mf.size; m.name = mp.split('/').pop();
    } catch (e) { r.errors.push(`素材清单「${ref.raw}」中的「${item.path}」无法读取：${e.message}`); continue; }
    r.media.push(m);
    if (!first) first = m;
  }
  return first;
}

function normalizeRelTo(baseFile, p) {
  // 每层相对路径以该层文件所在目录为基准
  const dir = baseFile.split('/').slice(0, -1).join('/');
  return normalizePath((dir ? dir + '/' : '') + p);
}

function parseAssetManifest(path, text) {
  const out = [];
  if (path.endsWith('.json')) {
    try {
      const data = JSON.parse(text);
      const items = Array.isArray(data) ? data : Array.isArray(data.files) ? data.files : null;
      if (items) for (const it of items) {
        if (typeof it === 'string') out.push({ path: it });
        else if (it?.path) out.push({ path: it.path, alias: it.id || it.alias || null });
      } else for (const [k, v] of Object.entries(data)) if (typeof v === 'string') out.push({ path: v, alias: k });
    } catch { /* 非清单 JSON */ }
  } else if (path.endsWith('.csv') || path.endsWith('.tsv')) {
    const delim = text.includes('\t') && !text.includes(',') ? '\t' : ',';
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const cells = line.split(delim);
      const alias = cells[0]?.trim(); const p = cells[1]?.trim();
      if (p) out.push({ path: p, alias });
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^(?:[A-Za-z0-9_-]{1,32}\s*=\s*)?(.+)$/);
      if (m) out.push({ path: m[1] });
    }
  }
  return out;
}

async function readFromIndex(ctx, relPath) {
  if (!ctx.index) throw new Error('未选择清单与素材目录，无法定位相对路径素材');
  const hit = ctx.index.get(relPath);
  if (!hit) throw new Error(`在已授权目录中找不到：${relPath}`);
  return hit.handle.getFile();
}

// ---------- 文本递归 ----------
async function readTextFile(ctx, path) {
  if (ctx.cache.has(path)) return ctx.cache.get(path);
  if (ctx.filesRead >= BUDGET.files) throw new Error(`不同文本文件数超过 ${BUDGET.files}，请拆批`);
  const file = await readFromIndex(ctx, path);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > BUDGET.fileBytes) throw new Error(`文本文件 ${path} 超过 2MB`);
  ctx.totalBytes += bytes.byteLength;
  if (ctx.totalBytes > BUDGET.totalBytes) throw new Error(`已读取文本字节总计超过 10MB，请拆批`);
  ctx.filesRead++;
  ctx.ops++;
  const { text, encoding } = decodeBytes(bytes);
  const sha = await sha256Hex(bytes);
  const entry = { sha256: sha, bytes: bytes.byteLength, text, encoding };
  ctx.cache.set(path, entry);
  return entry;
}

async function resolveText(ctx, text, { shotId, field, chain, r, depth = 0 }) {
  const sources = []; const replacements = [];
  let out = String(text ?? '');
  if (depth > BUDGET.depth) throw new Error(`递归层数超过 ${BUDGET.depth}，疑似链式引用过深：${chain.at(-1) || ''}`);
  if (!out.trim()) return { text: out, sources, replacements };

  const before = out;

  // 整字段就是明确文件路径（../xx.md#标题 或 ./xx.txt）
  const whole = out.trim().match(/^(\.\.?\/[^\s|;；]+)(#(.+))?$/);
  if (whole) {
    const res = await expandFileRef(ctx, whole[1], whole[3] || null, { shotId, field, chain, r, depth });
    sources.push(...res.sources); replacements.push(...res.replacements);
    return { text: res.text, sources, replacements };
  }

  // {{file:…}} / {{引用:…}} / @file(…)
  const inline = /(\{\{(?:file|引用):\s*([^}]+?)\s*\}\}|@file\(\s*([^)]+?)\s*\))/g;
  for (;;) {
    const m = inline.exec(out);
    if (!m) break;
    ctx.ops++;
    if (ctx.ops > BUDGET.ops) throw new Error('解析操作数超预算，请拆批');
    const pathRaw = m[2] || m[3];
    const res = await expandFileRef(ctx, pathRaw, null, { shotId, field, chain, r, depth });
    sources.push(...res.sources); replacements.push(...res.replacements);
    out = out.replace(m[1], () => res.text);
    if (out.length > BUDGET.rowsChars) throw new Error('展开行累计大小超预算');
  }

  // Markdown 链接：![图](路径) / [文本](路径#标题)
  const md = /(!?)\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (;;) {
    const m = md.exec(out);
    if (!m) break;
    ctx.ops++;
    if (ctx.ops > BUDGET.ops) throw new Error('解析操作数超预算，请拆批');
    const isImg = m[1] === '!';
    const target = m[3].startsWith('<') && m[3].endsWith('>') ? m[3].slice(1, -1) : m[3];
    if (/^https?:\/\//i.test(target)) continue; // 不抓取外部网页
    let path; try { path = normalizeRelTo(chainBase(chain), target); } catch { continue; }
    if (MEDIA_RE.test(path)) {
      // 图片 / 声音 → 登记占位，不当文字
      const kind = IMAGE_RE.test(path) ? 'image' : 'audio';
      let media = r.media.find(x => x.path === path);
      if (!media) {
        media = { kind, path, alias: null, raw: target, sha256: null };
        try {
          const file = await readFromIndex(ctx, path);
          media.sha256 = await sha256Hex(await file.arrayBuffer());
          media.bytes = file.size; media.name = path.split('/').pop();
          r.media.push(media);
        } catch (e) { r.errors.push(`引用的${kind === 'image' ? '图片' : '声音'}「${target}」无法读取：${e.message}`); continue; }
      }
      const tag = kind === 'image' ? `〈Picture:${path}〉` : `〈Audio:${path}〉`;
      out = out.replace(m[0], () => (isImg ? tag : `${m[2]}：${tag}`));
    } else {
      const res = await expandFileRef(ctx, target, null, { shotId, field, chain, r, depth });
      sources.push(...res.sources); replacements.push(...res.replacements);
      out = out.replace(m[0], () => res.text);
    }
    if (out.length > BUDGET.rowsChars) throw new Error('展开行累计大小超预算');
  }

  // JSON $ref
  try {
    const j = JSON.parse(out);
    if (j && typeof j === 'object' && !Array.isArray(j) && j.$ref) {
      const res = await expandFileRef(ctx, j.$ref.split('#')[0], j.$ref.includes('#') ? j.$ref.split('#')[1] : null, { shotId, field, chain, r, depth });
      sources.push(...res.sources); replacements.push(...res.replacements);
      out = res.text;
    }
  } catch { /* 不是 JSON，保持文本 */ }

  if (out !== before) replacements.push({ field, before, after: out });
  return { text: out, sources, replacements };
}

function chainBase(chain) {
  // 当前链顶文件目录；空链表示基准为“原 CSV 目录”（由索引相对路径直接定位）
  const top = chain.at(-1);
  return top ? top.split('#')[0] : '';
}
function relToRoot(baseFile, p) {
  const dir = baseFile ? baseFile.split('/').slice(0, -1).join('/') : '';
  return normalizePath((dir ? dir + '/' : '') + p);
}

// 读取一个文件引用并按类型选择内容，继续递归展开
async function expandFileRef(ctx, pathRaw, fragment, { shotId, field, chain, r, depth }) {
  const path = relToRoot(chainBase(chain), pathRaw.replace(/^\.\//, ''));
  const chainId = `${path}#${fragment || ''}`;
  if (chain.includes(chainId)) throw new Error(`循环引用：${chain.concat(chainId).join(' → ')}`);
  const nextChain = [...chain, chainId];

  const file = await readTextFile(ctx, path);
  const source = { root: 'source-dir', path, sha256: file.sha256, encoding: file.encoding, field, selection: fragment || '', chain: nextChain.slice() };

  let selected = file.text;
  const lower = path.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    selected = selectMarkdown(file.text, fragment, shotId);
  } else if (lower.endsWith('.json')) {
    selected = selectJson(file.text, fragment, shotId, path);
    // JSON 选中对象若含 $ref / 内容继续按文本展开
  } else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    selected = selectCsvRow(file.text, shotId, path);
  } else if (MEDIA_RE.test(lower)) {
    throw new Error(`文本位置引用了媒体文件 ${path}；请用 Markdown 链接或素材列引用媒体`);
  }
  if (selected == null) throw new Error(`在 ${path} 中找不到${fragment ? `片段「${fragment}」` : shotId ? `镜号「${shotId}」` : '可选内容'}`);

  const res = await resolveText(ctx, selected, { shotId, field, chain: nextChain, r, depth: depth + 1 });
  r.textSources.push(source);
  return { text: res.text, sources: [source], replacements: res.replacements };
}

function selectMarkdown(text, fragment, shotId) {
  // 代码 fence 内标题不用于章节定位
  const lines = text.split(/\r?\n/);
  const heads = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (!inFence) { const m = l.match(/^(#{1,6})\s+(.+?)\s*#*$/); if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i }); }
  });
  const want = fragment || shotId;
  if (!want) return text;
  const hit = heads.filter(h => h.title === want || h.title.includes(want));
  if (!hit.length) return null;
  const h = hit[0];
  const next = heads.slice(heads.indexOf(h) + 1).find(x => x.level <= h.level);
  return lines.slice(h.line + 1, next ? next.line : lines.length).join('\n').trim();
}

function selectJson(text, fragment, shotId, path) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`JSON 解析失败 ${path}：${e.message}`); }
  if (fragment && fragment.startsWith('/')) {
    let cur = data;
    for (const k of fragment.split('/').filter(Boolean)) cur = cur?.[k];
    if (cur === undefined) return null;
    return typeof cur === 'string' ? cur : JSON.stringify(cur, null, 2);
  }
  if (shotId && Array.isArray(data?.shots)) {
    const hit = data.shots.find(s => String(s.id) === shotId || String(s.镜号) === shotId);
    if (hit?.prompt != null) return String(hit.prompt);
    if (hit) return JSON.stringify(hit, null, 2);
  }
  if (shotId && data && typeof data === 'object' && data[shotId] != null) {
    const v = data[shotId];
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  }
  if (data?.prompt != null) return String(data.prompt);
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function selectCsvRow(text, shotId, path) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;
  const first = lines[0];
  const delim = DELIMS.map(d => ({ d, n: first.split(d).length - 1 })).sort((a, b) => b.n - a.n)[0].d;
  const header = first.split(delim).map(h => h.trim());
  const idIdx = header.findIndex(h => ['镜号', '镜头编号', 'id'].includes(h));
  const promptIdx = header.findIndex(h => ['prompt', '提示词', '画面动作', '画面描述', '画面与动作'].includes(h));
  const dialogueIdx = header.findIndex(h => ['dialogue', '对白', '指定对白', '台词'].includes(h));
  const hits = [];
  for (const l of lines.slice(1)) {
    const cells = l.split(delim);
    if (idIdx >= 0 && cells[idIdx]?.trim() === shotId) hits.push(cells);
  }
  if (!hits.length) return null;
  if (hits.length > 1) throw new Error(`${path} 中镜号 ${shotId} 出现 ${hits.length} 次，存在歧义`);
  const c = hits[0];
  if (promptIdx >= 0 && c[promptIdx]) return c[promptIdx];
  if (dialogueIdx >= 0 && c[dialogueIdx]) return c[dialogueIdx];
  return c.join('\n');
}

// ---------- 入队前复核：重新读取文本并比对哈希（第 11.5 章） ----------
export async function verifyResolvedDocuments(resolvedRows, rootHandle, index) {
  const failures = [];
  for (const row of resolvedRows) {
    for (const ts of row.textSources || []) {
      try {
        const hit = index.get(ts.path);
        if (!hit) throw new Error(`文件已不在目录中：${ts.path}`);
        const file = await hit.handle.getFile();
        const sha = await sha256Hex(await file.arrayBuffer());
        if (sha !== ts.sha256) throw new Error(`文本已变化：${ts.path}`);
      } catch (e) {
        failures.push(`镜 ${row.id}：${e.message}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
