// media.js — 素材元信息、图片优化、声音裁切、视频检查与 FFmpeg WASM 拼接。
// 设计依据：docs/X-AI详细设计文档.md 第 9、13、14 章。
import { sha256Hex, ASPECT_DIMS, bytesHuman } from './core.js';

// ---------- 图片导入检查 ----------
export async function inspectImageFile(file) {
  const out = { width: 0, height: 0, errors: [] };
  try {
    const bmp = await createImageBitmap(file);
    out.width = bmp.width; out.height = bmp.height; bmp.close?.();
  } catch (e) {
    out.errors.push(`无法解码为图片（${e.message || e}）`);
    return out;
  }
  const { IMAGE_W_MINMAX, IMAGE_RATIO_MINMAX } = await import('./core.js');
  const [wmin, wmax] = IMAGE_W_MINMAX;
  const ratio = out.width / out.height;
  if (out.width < wmin || out.height < wmin) out.errors.push(`尺寸 ${out.width}×${out.height} 低于 ${wmin}px 下限`);
  if (out.width > wmax || out.height > wmax) out.errors.push(`尺寸 ${out.width}×${out.height} 超过 ${wmax}px 上限`);
  if (ratio < IMAGE_RATIO_MINMAX[0] || ratio > IMAGE_RATIO_MINMAX[1]) out.errors.push(`宽高比 ${ratio.toFixed(2)} 超出 0.4–2.5`);
  if (file.size >= 150_000_000) out.errors.push('文件超过 150MB，不导入');
  else if (file.size >= 15_000_000) out.errors.push('文件超过 15MB 请求限制，需优化后再用');
  return out;
}

export async function inspectAudioFile(file) {
  const out = { duration: 0, errors: [] };
  try {
    const buf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    out.duration = audio.duration;
    ctx.close?.();
  } catch (e) {
    out.errors.push(`无法解码声音（${e.message || e}）`);
  }
  return out;
}

// ---------- 图片优化（第 9.4 章） ----------
export async function optimizeImageFile(file, { keepFormat = false } = {}) {
  const bmp = await createImageBitmap(file);
  const long = Math.max(bmp.width, bmp.height);
  const scale = long > 2048 ? 2048 / long : 1;
  let w = Math.max(1, Math.round(bmp.width * scale));
  let h = Math.max(1, Math.round(bmp.height * scale));
  bmp.close?.();
  // 补边到 0.4–2.5 比例
  let ratio = w / h;
  let cw = w, ch = h;
  if (ratio < 0.4) cw = Math.round(h * 0.4);
  if (ratio > 2.5) ch = Math.round(w / 2.5);
  cw = Math.max(256, Math.min(cw, 2048)); ch = Math.max(256, Math.min(ch, 2048));
  // 若画布超限则整体缩小内容
  if (cw > 2048 || ch > 2048) { const k = Math.min(2048 / cw, 2048 / ch); cw = Math.round(cw * k); ch = Math.round(ch * k); }

  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ece9e3';
  ctx.fillRect(0, 0, cw, ch);
  const dw = Math.round(w * Math.min(cw / w, ch / h));
  const dh = Math.round(h * Math.min(cw / w, ch / h));
  const bmp2 = await createImageBitmap(file);
  ctx.drawImage(bmp2, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
  bmp2.close?.();

  const type = (keepFormat && ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) ? file.type : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const blob = await new Promise(res => canvas.toBlob(res, type, type === 'image/jpeg' ? 0.92 : undefined));
  canvas.width = canvas.height = 0;
  return { blob, width: cw, height: ch, type, ext };
}

// ---------- 声音裁切（第 9.5 章）：输出 48kHz 单声道 16 位 WAV ----------
export async function trimAudioToWav(file, startSec, endSec) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  ctx.close?.();
  const sr = 48000;
  const s0 = Math.max(0, Math.floor(startSec * audio.sampleRate));
  const s1 = Math.min(audio.length, Math.ceil(endSec * audio.sampleRate));
  const frames = Math.max(1, Math.round((s1 - s0) * sr / audio.sampleRate));
  const wav = new ArrayBuffer(44 + frames * 2);
  const dv = new DataView(wav);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + frames * 2, true); ws(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const src = Math.min(audio.length - 1, s0 + Math.round(i * audio.sampleRate / sr));
    const v = audio.numberOfChannels > 0 ? audio.getChannelData(0)[src] : 0;
    dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32767))), true);
  }
  return new Blob([wav], { type: 'audio/wav' });
}

// ---------- FFmpeg WASM 引擎（单实例、串行） ----------
let ffmpeg = null;
let ffmpegLoading = null;
let ffChain = Promise.resolve();

const WASM_URL = new URL('../vendor/ffmpeg-core/ffmpeg-core.wasm', import.meta.url).href;

// 整体读取 wasm；连接提前断开（Content-Length 不符）时抛错，由分块续传兜底。
async function fetchWasmWhole(onLog) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), 240000);
  try {
    const res = await fetch(WASM_URL, { signal: ctrl.signal, cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024) throw new Error('wasm 过小，疑似截断');
    onLog?.(`wasm 整体加载完成：${(buf.byteLength / 1e6).toFixed(1)}MB`);
    return buf;
  } finally { clearTimeout(timer); }
}

// 分块续传：用 Range 请求逐块读取，任一块失败自动重试（对抗截断型隧道）。
async function fetchWasmChunked(onLog, chunkBytes = 2 * 1024 * 1024) {
  const probe = await fetch(WASM_URL, { headers: { 'Range': 'bytes=0-0' } });
  if (!probe.ok && probe.status !== 206) throw new Error(`Range 探测失败：HTTP ${probe.status}`);
  const cr = probe.headers.get('Content-Range');
  await probe.body?.cancel?.().catch?.(() => {});
  const total = cr ? Number(cr.split('/')[1]) : Number(probe.headers.get('Content-Length'));
  if (!Number.isFinite(total) || total <= 0) throw new Error('无法获得 wasm 总大小');
  const out = new Uint8Array(total);
  for (let start = 0; start < total; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, total) - 1;
    let done = false;
    for (let attempt = 1; attempt <= 4 && !done; attempt++) {
      try {
        const res = await fetch(WASM_URL, { headers: { 'Range': `bytes=${start}-${end}` } });
        if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength !== end - start + 1) throw new Error(`分块不完整：${buf.byteLength}/${end - start + 1}`);
        out.set(buf, start);
        done = true;
      } catch (e) {
        onLog?.(`wasm 分块 ${start}-${end} 第 ${attempt} 次失败：${e.message}`);
        if (attempt === 4) throw new Error(`wasm 分块下载失败：${e.message}`);
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    onLog?.(`wasm 分块进度 ${end + 1}/${total}`);
  }
  onLog?.(`wasm 分块加载完成：${(total / 1e6).toFixed(1)}MB`);
  return out.buffer;
}

async function obtainWasmBuffer(onLog) {
  try {
    return await fetchWasmWhole(onLog);
  } catch (e) {
    onLog?.(`整体加载失败（${e.message}），改用分块续传`);
    return await fetchWasmChunked(onLog);
  }
}

// UMD 构建通过 <script> 加载，全局命名空间为 FFmpegWASM（含 FFmpeg 类）。
function loadUmdScript(src) {
  if (window.FFmpegWASM?.FFmpeg) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('vendor/ffmpeg/ffmpeg.js 加载失败'));
    document.head.appendChild(s);
  });
}

async function loadFFmpeg(onLog) {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    await loadUmdScript(new URL('../vendor/ffmpeg/ffmpeg.js', import.meta.url).href);
    const ns = window.FFmpegWASM || window.FFmpeg;
    const FFmpegClass = ns?.FFmpeg || ns;
    if (typeof FFmpegClass !== 'function') throw new Error('FFmpeg 引擎不可用（UMD 全局缺失）');
    const ff = new FFmpegClass();
    ff.on('log', ({ message }) => onLog?.(message));
    const baseURL = new URL('../vendor/ffmpeg-core/', import.meta.url).href;
    // 优先整体加载；隧道截断时自动分块续传，再以 blob URL 交给引擎
    let wasmURL = baseURL + 'ffmpeg-core.wasm';
    try {
      const buf = await obtainWasmBuffer(onLog);
      wasmURL = URL.createObjectURL(new Blob([buf], { type: 'application/wasm' }));
    } catch (e) {
      onLog?.(`wasm 预加载失败（${e.message}），退回引擎内置加载`);
    }
    await ff.load({ coreURL: baseURL + 'ffmpeg-core.js', wasmURL });
    ffmpeg = ff;
    return ff;
  })();
  return ffmpegLoading;
}

// 串行执行一次 ffmpeg 命令；输入均为 Blob（写虚拟文件），返回输出 Blob。
export async function ffmpegRun(files, args, { onLog, onProgress } = {}) {
  const run = ffChain.then(async () => {
    const ff = await loadFFmpeg(onLog);
    if (onProgress) ff.on('progress', ({ progress }) => onProgress(Math.max(0, Math.min(1, progress))));
    const names = [];
    try {
      for (const f of files) { await ff.writeFile(f.name, new Uint8Array(await f.blob.arrayBuffer())); names.push(f.name); }
      await ff.exec(args);
      const outName = args.at(-1);
      if (outName === '-') return null; // -f null：只验证解码，无输出文件
      const data = await ff.readFile(outName);
      const blob = new Blob([data.buffer ?? data], { type: outName.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream' });
      return blob;
    } finally {
      if (onProgress) ff.off?.('progress');
      for (const n of names) { try { await ff.deleteFile(n); } catch { /* ignore */ } }
    }
  });
  ffChain = run.catch(() => {});
  return run;
}

export async function ffmpegAvailable() {
  try { await loadFFmpeg(); return true; } catch (e) { console.warn('FFmpeg 加载失败', e); return false; }
}

// ---------- 视频检查（第 13 章） ----------
export async function inspectVideoBlob(blob, { expectSeconds, aspect, onStage } = {}) {
  const qa = {
    duration: 0, width: 0, height: 0, fps: null, hasAudio: null,
    fullDecode: 'not_run', technical: 'partial', fatal: [], warnings: [], darkRatios: [], error: null,
  };
  const frames = [];
  try {
    // 1. 容器签名（第一层，不是容器形式证明）
    const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const sig = String.fromCharCode(...head.slice(4, 8));
    if (sig !== 'ftyp' || blob.size < 1024) {
      qa.fatal.push('MP4 容器签名缺失或文件过小');
      qa.technical = 'failed';
      return { qa, frames };
    }
    // 2. 元信息
    onStage?.('读取视频元信息');
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.preload = 'metadata'; video.muted = true;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res; video.onerror = () => rej(new Error('浏览器无法解析视频元信息'));
      setTimeout(() => rej(new Error('读取元信息超时')), 30000);
      video.src = url;
    });
    qa.duration = video.duration; qa.width = video.videoWidth; qa.height = video.videoHeight;
    const hasAudioTrack = await detectAudio(blob);
    qa.hasAudio = hasAudioTrack;

    // 3. 时长 / 画幅 / 最低分辨率容差（第 13.2 章）
    if (qa.duration > 12.05) qa.fatal.push(`时长 ${qa.duration.toFixed(2)}s 超过 12.05s`);
    else if (expectSeconds && Math.abs(qa.duration - expectSeconds) > 0.25) qa.fatal.push(`时长 ${qa.duration.toFixed(2)}s 与计划 ${expectSeconds}s 差超过 0.25s`);
    if (aspect && ASPECT_DIMS[aspect]) {
      const [tw, th] = ASPECT_DIMS[aspect];
      const want = tw / th; const got = qa.width && qa.height ? qa.width / qa.height : 0;
      if (Math.abs(got - want) > 0.045) qa.fatal.push(`画幅比例 ${got.toFixed(3)} 与目标 ${want.toFixed(3)} 差超过 0.045`);
    }
    if (Math.min(qa.width, qa.height) < 680) qa.fatal.push(`最小边 ${Math.min(qa.width, qa.height)}px 明显低于 720P`);

    // 4. 五点抽帧 + 暗像素 + 结束附近末帧（13.3）
    onStage?.('五点抽帧');
    const ratios = [0.06, 0.27, 0.5, 0.73, 0.97];
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(480, qa.width || 480); canvas.height = Math.round(canvas.width * (qa.height || 854) / (qa.width || 480)) || 270;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < ratios.length; i++) {
      const t = Math.max(0.01, Math.min(qa.duration - 0.05, qa.duration * ratios[i]));
      const blob_i = await seekFrame(video, canvas, ctx, t);
      if (blob_i) {
        frames.push({ t, blob: blob_i });
        const dark = await darkRatio(canvas, ctx);
        qa.darkRatios.push(+dark.toFixed(3));
        if (dark > 0.9) qa.warnings.push(`第 ${i + 1} 采样点暗像素 ${(dark * 100).toFixed(0)}%（可能是合理夜景）`);
      }
    }
    // 末帧（结束附近 0.08s，seek 不保证编码序列最后一帧）
    const lastT = Math.max(0.01, qa.duration - 0.08);
    const lastBlob = await seekFrame(video, canvas, ctx, lastT, { fullSize: true });
    qa.lastFrame = lastBlob || null;

    // 5. 完整解码（FFmpeg WASM）
    onStage?.('FFmpeg 完整解码');
    try {
      const ok = await ffmpegAvailable();
      if (!ok) { qa.fullDecode = 'not_run'; qa.warnings.push('FFmpeg 引擎未加载，完整解码未执行'); }
      else {
        await ffmpegRun([{ name: 'in.mp4', blob }], ['-v', 'error', '-i', 'in.mp4', '-f', 'null', '-'], { onLog: m => {
          if (/^Error|Invalid|error decoding|corrupt/i.test(m)) qa._decodeErr = (qa._decodeErr || '') + m + '\n';
        }});
        if (qa._decodeErr) { qa.fullDecode = 'failed'; qa.fatal.push('完整解码失败：' + qa._decodeErr.split('\n')[0]); }
        else {
          qa.fullDecode = 'passed';
          qa.fps = await probeFps(blob);
          if (qa.fps != null && Math.abs(qa.fps - 24) > 0.1) qa.warnings.push(`帧率 ${qa.fps.toFixed(2)} 与 24 差超过 0.1，拼接时会统一到 24fps`);
        }
      }
    } catch (e) {
      qa.fullDecode = 'not_run'; qa.warnings.push('完整解码无法执行：' + (e.message || e));
    }
    URL.revokeObjectURL(url);
    qa.technical = qa.fatal.length ? 'failed' : (qa.fullDecode === 'passed' ? 'passed' : 'partial');
    return { qa, frames };
  } catch (e) {
    qa.error = e.message || String(e);
    qa.technical = 'partial';
    return { qa, frames };
  }
}

async function detectAudio(blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('audio');
    a.preload = 'metadata'; a.muted = true;
    await new Promise((res, rej) => { a.onloadedmetadata = res; a.onerror = rej; setTimeout(() => rej(new Error('音频元信息超时')), 15000); a.src = url; });
    URL.revokeObjectURL(url);
    return !(a.webkitAudioDecodedByteCount === 0 || (a.mozHasAudio === false));
  } catch { return null; }
}

async function seekFrame(video, canvas, ctx, t, { fullSize = false } = {}) {
  try {
    await new Promise((res, rej) => {
      const handler = () => { cleanup(); res(); };
      const onErr = () => { cleanup(); rej(new Error('seek 失败')); };
      const cleanup = () => { video.removeEventListener('seeked', handler); video.removeEventListener('error', onErr); };
      video.addEventListener('seeked', handler); video.addEventListener('error', onErr);
      video.currentTime = t;
      setTimeout(() => { cleanup(); rej(new Error('seek 超时')); }, 15000);
    });
    let c = canvas, x = ctx;
    if (fullSize) {
      c = document.createElement('canvas'); c.width = video.videoWidth || canvas.width; c.height = video.videoHeight || canvas.height;
      x = c.getContext('2d');
    }
    x.drawImage(video, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, fullSize ? 'image/png' : 'image/jpeg', 0.9));
  } catch { return null; }
}

async function darkRatio(canvas, ctx) {
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0; const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (lum < 26) dark++;
  }
  return dark / n;
}

async function probeFps(blob) {
  try {
    const out = await ffmpegRun([{ name: 'in.mp4', blob }], ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', 'out.txt'], {});
    const txt = await out.text();
    const m = txt.trim().match(/^(\d+)\/(\d+)$/);
    if (m) return Number(m[1]) / Number(m[2]);
    return null;
  } catch { return null; }
}

// ---------- 按集拼接（第 14.4 章） ----------
export async function concatenateClips(clips, targetAspect, onProgress) {
  // clips: [{name, blob}] 顺序已按 jobs 排列
  const [tw, th] = ASPECT_DIMS[targetAspect] || [720, 1280];
  const args = [];
  const files = [];
  const filterParts = [];
  clips.forEach((c, i) => {
    files.push({ name: `in${i}.mp4`, blob: c.blob });
    filterParts.push(
      `[${i}:v]scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1,format=yuv420p[v${i}];`
    );
    filterParts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}];`);
  });
  const n = clips.length;
  filterParts.push(`${Array.from({ length: n }, (_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vout];`);
  filterParts.push(`${Array.from({ length: n }, (_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[aout]`);

  args.push('-v', 'error');
  for (const f of files) args.push('-i', f.name);
  args.push('-filter_complex', filterParts.join(''), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', 'out.mp4');
  return ffmpegRun(files, args, { onProgress });
}
