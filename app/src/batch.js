// batch.js — CSV / JSON / 纯文本清单解析、分隔符识别、字段别名与 spec 生成。
// 设计依据：docs/X-AI详细设计文档.md 第 10 章。
import { isSafeId } from './core.js';

export const DELIMS = [',', '\t', ';', '|', '，', '；'];

// ---------- 分隔符识别 ----------
export function detectDelimiter(text, aliases) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const scores = DELIMS.map(d => ({ d, n: firstLine.split(d).length - 1 }));
  scores.sort((a, b) => b.n - a.n);
  const best = scores[0];
  if (!best || best.n < 1) return { delim: null, ambiguity: false };
  const tied = scores.filter(s => s.n === best.n && s.n > 0);
  if (tied.length > 1) return { delim: null, ambiguity: true, candidates: tied.map(t => t.d) };
  return { delim: best.d, ambiguity: false };
}

// ---------- CSV 行解析（保留引号内换行 / 分隔符，"" 转义） ----------
export function parseDSV(text, delim) {
  const rows = [];
  let row = []; let field = ''; let inQuote = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += c;
    } else if (c === '"') inQuote = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push({ cells: row, line: rows.length + 1 });
      row = [];
    } else field += c;
  }
  if (inQuote) throw new Error('引号未闭合：请检查 CSV 单元格内的双引号。');
  row.push(field);
  if (row.length > 1 || row[0].trim() !== '') rows.push({ cells: row, line: rows.length + 1 });
  return rows;
}

// ---------- 字段别名（第 10.2 章） ----------
const ALIASES = {
  id: ['镜号', '镜头编号', 'id'],
  episode: ['分集', '分组', '集名', 'episode'],
  prompt: ['agnesai实际提示词', 'prompt', '提示词', '画面动作', '画面与动作', '画面描述'],
  promptFile: ['prompt_file', 'prompt_path', 'prompt_ref', '提示词文件', '提示词路径', '提示词引用'],
  dialogueFile: ['dialogue_file', 'dialogue_ref', '对白文件', '台词文件', '对白引用'],
  seconds: ['seconds', '秒数', '时长秒', '时长'],
  aspect: ['aspect_ratio', 'aspect', '画面比例', '比例'],
  mode: ['mode', '生成模式', '生成方式'],
  dialogue: ['dialogue', '对白', '指定对白', '台词'],
  seed: ['seed', '随机种子'],
  files: ['assetids', 'files', '素材', '参考素材', '参考文件', '素材编号', '素材路径'],
  images: ['images', 'image_paths', '参考图', '图片路径', '图像路径', '当前图像引用', '当前图像候选引用'],
  audio: ['audio', 'audio_paths', '参考声音', '声音路径', '音频路径', '声音参考'],
  first: ['first_frame', '首帧'],
  last: ['last_frame', '尾帧'],
  continuity: ['continuity_from', '衔接镜号'],
};

export function normalizeHeader(h) {
  return String(h || '').trim().normalize('NFC').toLowerCase().replace(/[\s_（）()]/g, '');
}
function headerToField(h) {
  const n = normalizeHeader(h);
  for (const [field, list] of Object.entries(ALIASES)) if (list.some(a => normalizeHeader(a) === n)) return field;
  return null;
}

// ---------- 模式映射 ----------
function mapMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (['text', '文字生成', '文字', '文本'].includes(s) || s.startsWith('text')) return 'text';
  if (['reference', '参考生成', '参考'].includes(s) || s.startsWith('ref')) return 'reference';
  if (['keyframe', '首尾帧生成', '首尾帧'].includes(s)) return 'keyframe';
  return `__invalid__${v}`;
}

const EMPTY_VALUES = new Set(['', '无', 'none', 'null', '-', '—', 'nan']);

// ---------- 主入口：parseBatch ----------
export function parseBatch(text, defaults = {}) {
  const result = {
    kind: null, rows: [], fields: [], unknownCols: [], errors: [], notes: [],
    delimiter: null, episodeMap: new Map(),
  };
  let src = String(text || '').replace(/^\uFEFF/, '').normalize('NFC');
  if (!src.trim()) { result.errors.push('清单内容为空'); return result; }

  const def = {
    seconds: defaults.seconds || 8, aspect: defaults.aspect || '9:16',
    episode: defaults.episode || 'EP01', prefix: defaults.prefix || 'S',
  };

  const tryJSON = () => {
    const t = src.trim();
    if (!(t.startsWith('[') || t.startsWith('{'))) return false;
    try {
      const data = JSON.parse(t);
      let arr = Array.isArray(data) ? data : (Array.isArray(data.shots) ? data.shots : null);
      if (!arr) { result.errors.push('JSON 需为数组，或包含 shots 数组'); return true; }
      result.kind = 'json';
      for (const item of arr) {
        const row = {};
        for (const [k, v] of Object.entries(item || {})) row[k] = v;
        result.rows.push(row);
      }
      return true;
    } catch (e) { result.errors.push(`JSON 解析失败：${e.message}`); return true; }
  };

  const tryTable = () => {
    const det = detectDelimiter(src, ALIASES);
    if (det.ambiguity) { result.errors.push(`分隔符歧义：表头同时匹配 ${det.candidates.join(' ')}，请统一分隔符`); return true; }
    if (!det.delim) return false;
    let rows;
    try { rows = parseDSV(src, det.delim); } catch (e) { result.errors.push(e.message); return true; }
    if (rows.length < 1) return false;
    const header = rows[0].cells.map(h => h.trim());
    const fields = header.map(headerToField);
    const known = fields.filter(Boolean);
    if (known.length < 2) return false;
    result.kind = 'table'; result.delimiter = det.delim; result.fields = fields;
    // 重复规范名检查
    const seen = new Map();
    fields.forEach((f, i) => { if (f) { if (seen.has(f)) result.errors.push(`表头第 ${i + 1} 列与第 ${seen.get(f) + 1} 列映射了同一字段「${f}」`); else seen.set(f, i); } });
    fields.forEach((f, i) => { if (!f && header[i]) result.unknownCols.push(header[i]); });
    for (const r of rows.slice(1)) {
      if (r.cells.length !== header.length) { result.errors.push(`第 ${r.line} 行列数（${r.cells.length}）与表头（${header.length}）不一致`); continue; }
      const row = {};
      fields.forEach((f, i) => { if (f) row[f] = r.cells[i]; });
      row.__line = r.line;
      result.rows.push(row);
    }
    return true;
  };

  const tryPlainText = () => {
    // 独立一行的 2+ 短横线、3+ 等号 / 星号 / 下划线分段
    const lines = src.split(/\r?\n/);
    const isSep = l => /^\s*(-{2,}|={3,}|\*{3,}|_{3,})\s*$/.test(l);
    const paras = []; let cur = [];
    for (const l of lines) {
      if (isSep(l)) { if (cur.some(x => x.trim())) paras.push(cur); cur = []; }
      else cur.push(l);
    }
    if (cur.some(x => x.trim())) paras.push(cur);
    if (paras.length <= 1) return false;
    result.kind = 'text';
    for (const p of paras) {
      const body = p.map(x => x.trimEnd()).join('\n');
      if (body.trim()) result.rows.push({ prompt: body });
    }
    return true;
  };

  if (!tryJSON()) if (!tryTable()) if (!tryPlainText()) { result.errors.push('无法识别清单格式：未检测到可识别的表头字段，也不像 JSON 或分段文本'); return result; }
  if (result.errors.length) return result;

  // ---------- 行 → spec ----------
  let auto = 0;
  const episodeCounter = new Map(); // 中文集名 → EPxx
  for (const row of result.rows) {
    const err = m => result.errors.push(`第 ${row.__line || (result.rows.indexOf(row) + 1)} 行：${m}`);
    const val = f => {
      const v = row[f];
      if (v === undefined || v === null) return '';
      return typeof v === 'string' ? v.trim() : v;
    };
    const spec = { sourceLine: row.__line || null, sourceReferences: [], textSources: [], referenceReplacements: [] };

    // 镜号
    let id = String(val('id') ?? '').trim();
    if (!id) { auto++; id = `${def.prefix}${String(auto).padStart(2, '0')}`; spec.autoId = true; }
    spec.id = id;
    // 分组（中文集名按本批出现顺序映射 EPxx）
    let ep = String(val('episode') ?? '').trim();
    if (!ep) ep = def.episode;
    else if (!isSafeId(ep)) {
      if (!episodeCounter.has(ep)) episodeCounter.set(ep, `EP${String(episodeCounter.size + 1).padStart(2, '0')}`);
      ep = episodeCounter.get(ep);
    }
    spec.episode = ep; spec.episodeTitle = String(val('episode') ?? '').trim() || '';
    // 提示词
    spec.promptFile = String(val('promptFile') ?? '').trim();
    spec.dialogueFile = String(val('dialogueFile') ?? '').trim();
    let prompt = String(val('prompt') ?? '');
    let dialogue = String(val('dialogue') ?? '');
    if (spec.promptFile) { prompt = `{{file:${spec.promptFile}}}`; }
    if (spec.dialogueFile) { dialogue = `{{file:${spec.dialogueFile}}}`; }
    spec.promptRaw = prompt; spec.dialogueRaw = dialogue;
    // 参数
    const secsRaw = String(val('seconds') ?? '').trim();
    if (secsRaw) {
      const n = Number(secsRaw);
      if (!Number.isInteger(n) || n < 4 || n > 12) err(`时长「${secsRaw}」须为 4–12 秒整数`);
      else spec.seconds = n;
    } else spec.seconds = def.seconds;
    const aspRaw = String(val('aspect') ?? '').trim();
    if (aspRaw) { if (!['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'].includes(aspRaw)) err(`画幅「${aspRaw}」不受支持`); else spec.aspect = aspRaw; }
    else spec.aspect = def.aspect;
    const seedRaw = String(val('seed') ?? '').trim();
    if (seedRaw) {
      const n = Number(seedRaw);
      if (!Number.isInteger(n) || n < 0 || n > 2147483647) err(`随机种子「${seedRaw}」不合法`);
      else spec.seed = n;
    }
    // 模式
    let mode = mapMode(val('mode'));
    if (typeof mode === 'string' && mode.startsWith('__invalid__')) err(`生成方式「${mode.slice(11)}」无法识别`);
    // 素材引用（files 优先；明确空值 = 无参考）
    const refs = { images: [], audios: [], explicit: false };
    const filesRaw = row.files;
    if (filesRaw !== undefined && filesRaw !== null) {
      refs.explicit = true;
      parseRefList(filesRaw, refs.images, refs.audios, spec.sourceReferences, err);
    } else {
      const imgRaw = row.images, auRaw = row.audio;
      if ((imgRaw !== undefined && imgRaw !== null) || (auRaw !== undefined && auRaw !== null)) {
        refs.explicit = true;
        parseRefList(imgRaw ?? '', refs.images, refs.audios, spec.sourceReferences, err, 'image');
        parseRefList(auRaw ?? '', refs.images, refs.audios, spec.sourceReferences, err, 'audio');
      }
    }
    spec.refs = refs;
    // 首尾帧
    spec.first = String(val('first') ?? '').trim();
    spec.last = String(val('last') ?? '').trim();
    // 衔接
    spec.continuity = String(val('continuity') ?? '').trim();
    // 显式 mode 优先；否则按引用 / 首尾帧决定
    if (!mode) {
      if (spec.first || spec.last) mode = 'keyframe';
      else if (refs.explicit ? (refs.images.length || refs.audios.length) : false) mode = 'reference';
      else mode = 'text';
    }
    spec.mode = mode;
    result.rows[result.rows.indexOf(row)].spec = spec;
  }
  return result;
}

// 解析引用列表：支持 | ; ； 换行与 JSON 数组；C01=路径 登记编号。
function parseRefList(raw, images, audios, sourceRefs, err, kindHint = null) {
  let items = [];
  if (Array.isArray(raw)) items = raw.map(String);
  else if (typeof raw === 'string') {
    const t = raw.trim();
    if (EMPTY_VALUES.has(t.toLowerCase())) { items = []; return; }
    if (t.startsWith('[')) { try { items = JSON.parse(t).map(String); } catch { items = t.split(/[|;；\n]/); } }
    else items = t.split(/[|;；\n]/);
  }
  for (const item of items) {
    const s = String(item).trim();
    if (!s || EMPTY_VALUES.has(s.toLowerCase())) continue;
    const m = s.match(/^([A-Za-z0-9_-]{1,32})\s*=\s*(.+)$/);
    const alias = m ? m[1] : null;
    const pathPart = (m ? m[2] : s).trim();
    const entry = { alias, raw: s, path: pathPart, kind: kindHint };
    const isMediaPath = /\.(png|jpe?g|webp|wav|mp3|m4a|aac|ogg|flac)$/i.test(pathPart);
    if (kindHint === 'audio' || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(pathPart)) audios.push(entry);
    else if (kindHint === 'image' || /\.(png|jpe?g|webp)$/i.test(pathPart) || !isMediaPath) images.push(entry);
    sourceRefs.push(s);
  }
}
