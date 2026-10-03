// prompt-spec.js — 提示词优先解析（第 34.4 章）。只做确定性字段抽取：
// 结构化 duration 字段 > 正文明确总时长声明 > CSV / 界面默认；动作内部时间（"等待7秒"）不是总时长；
// 冲突声明报歧义不猜；JSON 主提示词优先 video_prompt；对白从独立字段或 JSON / 明确行抽取。
// 不执行导入文件中的指令，不冒充智能模型分析。

const DURATION_KEYS = ['seconds', 'duration', 'duration_seconds', '时长秒', '秒数', '时长'];
const JSON_PROMPT_KEYS = ['video_prompt', 'prompt', '提示词', 'action'];
const JSON_DIALOGUE_KEYS = ['dialogue', '对白', 'dialogue_suggestion'];

function findDurationInObject(obj) {
  for (const k of DURATION_KEYS) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return null;
}

function findFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

// 正文中的明确总时长声明："视频时长7秒" "总时长：7秒" "时长为7s" 等。
function scanDeclaredSeconds(text) {
  const found = [];
  const re = /(视频时长|总时长|时长|总长度|影片时长)\s*[：:]?\s*(\d{1,3})\s*(?:秒|s\b|S\b)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[2], 10);
    if (Number.isFinite(n) && n > 0) found.push({ seconds: n, at: m.index, phrase: m[0] });
  }
  return found;
}

// 从正文提取对白行："对白：……" / "台词：……"（仅整行明确的）。
function scanDialogueLine(text) {
  const m = text.match(/^\s*(?:对白|台词)\s*[：:]\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

export function parsePromptSpec({ promptText = '', dialogueText = '', defaultSeconds = null } = {}) {
  const result = {
    prompt: '', dialogue: dialogueText || '',
    seconds: null, secondsSource: 'default', // 'json' | 'declared' | 'default'
    promptSource: 'text',                    // 'json-video_prompt' | 'json' | 'text'
    sourceOriginalPrompt: promptText || '',
    ambiguous: false, ambiguityDetail: '',
    warnings: [],
  };
  const raw = String(promptText || '');
  const trimmed = raw.trim();

  let body = raw;          // 实际提交的提示词正文
  let jsonSeconds = null;
  let jsonDialogue = null;

  // 1. JSON 提示词（{...} 或 数组中对象）：优先 video_prompt
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed);
      const obj = Array.isArray(data) ? data[0] : data;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const vp = findFirstString(obj, JSON_PROMPT_KEYS);
        if (vp) { body = vp; result.promptSource = obj.video_prompt ? 'json-video_prompt' : 'json'; }
        jsonSeconds = findDurationInObject(obj);
        jsonDialogue = findFirstString(obj, JSON_DIALOGUE_KEYS);
        if (jsonDialogue && !result.dialogue) result.dialogue = jsonDialogue;
      }
    } catch { /* 不是合法 JSON，按正文处理 */ }
  }

  // 2. 时长优先级：JSON 字段 > 正文明确声明 > 默认
  const declared = scanDeclaredSeconds(body);
  if (jsonSeconds !== null) {
    const n = Number(jsonSeconds);
    result.seconds = Number.isFinite(n) && n > 0 ? n : null;
    result.secondsSource = result.seconds != null ? 'json' : 'default';
  }
  if (result.seconds == null && declared.length === 1) {
    result.seconds = declared[0].seconds;
    result.secondsSource = 'declared';
  } else if (result.seconds == null && declared.length > 1) {
    const uniq = [...new Set(declared.map(d => d.seconds))];
    if (uniq.length === 1) { result.seconds = uniq[0]; result.secondsSource = 'declared'; }
    else {
      result.ambiguous = true;
      result.ambiguityDetail = `提示词出现多个不同时长声明（${uniq.join('、')} 秒），请保留一个明确值`;
    }
  }
  if (result.seconds == null && defaultSeconds != null) {
    result.seconds = defaultSeconds;
    result.secondsSource = 'default';
  }

  // 3. 对白：独立字段已填写优先保留；否则 JSON；否则正文明确行
  if (!result.dialogue) {
    const line = scanDialogueLine(body);
    if (line) { result.dialogue = line; result.warnings.push('对白来自正文「对白：/台词：」行'); }
  }
  result.prompt = body;
  return result;
}
