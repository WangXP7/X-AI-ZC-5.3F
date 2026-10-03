// storage.js — IndexedDB（x-ai-studio v1：state / blobs / handles）与授权本地目录的读写、备份。
// 设计依据：docs/X-AI详细设计文档.md 第 6、8 章。
import { sha256Hex, redact, nowIso, safeFilePart } from './core.js';

const DB_NAME = 'x-ai-studio';
const DB_VERSION = 1;

let _db = null;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('state')) d.createObjectStore('state');
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      if (!d.objectStoreNames.contains('handles')) d.createObjectStore('handles');
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result?.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  }));
}
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export const idb = {
  get: (store, key) => tx(store, 'readonly', s => idbReq(s.get(key))),
  set: (store, key, val) => tx(store, 'readwrite', s => idbReq(s.put(val, key))),
  del: (store, key) => tx(store, 'readwrite', s => idbReq(s.delete(key))),
  keys: (store) => tx(store, 'readonly', s => idbReq(s.getAllKeys())),
};

// ---------- 项目工作副本（串行保存链） ----------
let saveChain = Promise.resolve();
let _lastProjectJson = '';      // 内容相同跳过重写（第 31.3 章）
let _lastMappingJson = '';
export function loadProject() { return idb.get('state', 'project'); }
export function loadRate() { return idb.get('state', 'rate'); }
export function saveRate(rate) { return idb.set('state', 'rate', rate); }
export function saveVault(vault) { return idb.set('state', 'vault', vault); }
export function loadVault() { return idb.get('state', 'vault'); }

let _outputDir = null;
export function setOutputDir(dirHandle) { _outputDir = dirHandle || null; }

export function saveProject(project, { deferMapping = false } = {}) {
  // Promise 链保证串行快照。deferMapping=true 时本轮只保存 project.json，
  // reference-mapping.json 由批处理结束 / onChange 完整刷新（第 31.3 章）。
  const run = saveChain.then(async () => {
    project.updatedAt = nowIso();
    const json = JSON.stringify(redact(project), null, 2);
    const changed = json !== _lastProjectJson;
    await idb.set('state', 'project', project);
    _lastProjectJson = json;
    const dir = _outputDir;
    if (dir) {
      if (changed) {
        try { await writeFile(dir, 'project.json', json); } catch (e) { noteWriteDiag('project.json', 'write', e); }
      }
      if (!deferMapping) {
        try { await writeMappingIfChanged(dir, project); } catch (e) { noteWriteDiag('reference-mapping.json', 'write', e); }
      }
    }
    return true;
  });
  saveChain = run.catch(() => {});
  return run;
}

async function writeMappingIfChanged(dir, project) {
  const mapping = buildReferenceMapping(project);
  const json = JSON.stringify(mapping, null, 2);
  if (json === _lastMappingJson) return; // 映射无变化不重写（不因 at 时间变化而写）
  await writeFile(dir, 'reference-mapping.json', json);
  _lastMappingJson = json;
}

// 写入诊断（第 31.4 章）：最近 50 条本地异常或恢复记录；不含字节、密钥、提示词、绝对盘符。
export async function noteWriteDiag(relPath, stage, err, outcome = null) {
  try {
    const list = (await idb.get('state', 'write-diagnostics')) || [];
    list.push({
      at: nowIso(), path: relPath, stage,
      code: err?.name || String(err).slice(0, 40),
      message: String(err?.message || err).slice(0, 120),
      outcome: outcome || '',
    });
    while (list.length > 50) list.shift();
    await idb.set('state', 'write-diagnostics', list);
  } catch { /* 诊断失败不影响业务 */ }
}

// ---------- Blob ----------
export const blobStore = {
  put: async (blob) => {
    const key = crypto.randomUUID();
    await idb.set('blobs', key, blob);
    return key;
  },
  get: (key) => idb.get('blobs', key),
  del: (key) => idb.del('blobs', key),
  keys: () => idb.keys('blobs'),
};

// ---------- 文件句柄 ----------
export const handleStore = {
  setOutput: (h) => idb.set('handles', 'output', h),
  getOutput: () => idb.get('handles', 'output'),
  clearOutput: () => idb.del('handles', 'output'),
};

// ---------- 目录与项目文件 ----------
export async function pickOutputDirectory() {
  if (!window.showDirectoryPicker) throw new Error('此浏览器不支持文件夹授权，请使用桌面版 Chrome / Edge。');
  return window.showDirectoryPicker({ id: 'x-ai-output', mode: 'readwrite' });
}
export async function pickSourceDirectory() {
  if (!window.showDirectoryPicker) throw new Error('此浏览器不支持文件夹授权，请使用桌面版 Chrome / Edge。');
  return window.showDirectoryPicker({ id: 'x-ai-input', mode: 'read' });
}
export async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

async function writeFile(dirHandle, relPath, data, { createDirs = true } = {}) {
  // 稳定本地写入协议（第 31.2 章）：输入先固化为稳定字节；每次尝试重新查找各级句柄；
  // createWritable(exclusive)；close 后回读核对 SHA；仅短暂状态错误有限重试（150/450/1000/2000ms，最多 5 次）。
  const parts = relPath.split('/').filter(Boolean);
  const expectedSha = await sha256Hex(await toStableBlob(data).arrayBuffer());
  const backoffs = [150, 450, 1000, 2000];
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, backoffs[Math.min(attempt - 1, backoffs.length - 1)]));
    let w = null;
    try {
      let dir = dirHandle;
      for (const p of parts.slice(0, -1)) {
        dir = createDirs ? await dir.getDirectoryHandle(p, { create: true }) : await dir.getDirectoryHandle(p);
      }
      const fh = await dir.getFileHandle(parts.at(-1), { create: true });
      w = await fh.createWritable({ mode: 'exclusive' });
      await w.write(await toStableBlob(data));
      await w.close(); w = null;
      // 回读核对：内容与预期一致才算成功；close 后报错但内容一致 → verified-after-error
      const back = await readFileFromHandle(dirHandle, relPath);
      const backSha = await sha256Hex(await back.arrayBuffer());
      if (backSha !== expectedSha) {
        const e = new Error('写入内容与预期不一致'); e.name = 'WriteVerificationError';
        throw e;
      }
      return true;
    } catch (e) {
      if (w) { try { await w.abort(); } catch { /* ignore */ } w = null; }
      lastErr = e;
      const transient = ['InvalidStateError', 'NotReadableError', 'NoModificationAllowedError', 'AbortError'].includes(e.name);
      if (e.name === 'WriteVerificationError') { await noteWriteDiag(relPath, 'verify', e, 'failed'); throw e; }
      if (!transient) {
        await noteWriteDiag(relPath, 'open/write', e, 'failed');
        throw e; // 权限、空间等不盲重试
      }
      // 短暂错误：可能已提交成功——先重读核对
      try {
        const back = await readFileFromHandle(dirHandle, relPath);
        const backSha = await sha256Hex(await back.arrayBuffer());
        if (backSha === expectedSha) { await noteWriteDiag(relPath, 'verify', e, 'verified-after-error'); return true; }
      } catch { /* 仍不可读，继续重试 */ }
      await noteWriteDiag(relPath, 'open/write', e, 'retry');
    }
  }
  throw lastErr || new Error('写入失败');
}

export { writeFile, fileExists };

async function toStableBlob(data) {
  if (data instanceof Blob) return data;
  if (data instanceof File) return new Blob([await data.arrayBuffer()], { type: data.type || 'application/octet-stream' }); // 先读成稳定字节，避免读写同文件失效
  return new Blob([data]);
}

async function fileExists(dirHandle, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  try {
    let dir = dirHandle;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    await dir.getFileHandle(parts.at(-1));
    return true;
  } catch { return false; }
}

export async function readFileFromHandle(rootHandle, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  let dir = rootHandle;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const fh = await dir.getFileHandle(parts.at(-1));
  return fh.getFile();
}

// 递归枚举目录（限制深度 / 数量，跳过 .git）
export async function* walkDirectory(dirHandle, prefix = '', depth = 0, state = { count: 0, max: 20000, depth: 64 }) {
  if (depth > state.depth) return;
  for await (const [name, handle] of dirHandle.entries()) {
    if (state.count >= state.max) return;
    if (name === '.git' || name.startsWith('.DS_')) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'file') { state.count++; yield { rel, handle }; }
    else if (handle.kind === 'directory') yield* walkDirectory(handle, rel, depth + 1, state);
  }
}

// ---------- references 备份（第 6.2 章） ----------
export async function backupReferences(dirHandle, onProgress) {
  const refs = dirHandle.getDirectoryHandle('references', { create: false }).catch(() => null);
  if (!refs) return null; // 无 references，无需备份
  let entries = [];
  try { entries = []; for await (const it of walkDirectory(await refs)) entries.push(it); } catch { /* ignore */ }
  if (!entries.length) return null;

  const stamp = new Date();
  const name = `references_${stamp.toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${Math.random().toString(36).slice(2, 6)}`;
  const backups = await dirHandle.getDirectoryHandle('backups', { create: true });
  const target = await backups.getDirectoryHandle(name, { create: true });
  const manifest = { createdAt: nowIso(), files: [] };

  for (const { rel, handle } of entries) {
    const file = await handle.getFile();
    const srcSha = await sha256Hex(await file.arrayBuffer());
    await writeFile(target, `references/${rel}`, file);
    // 回读核对哈希
    const back = await readFileFromHandle(target, `references/${rel}`);
    const backSha = await sha256Hex(await back.arrayBuffer());
    if (backSha !== srcSha) throw new Error(`备份校验失败：${rel}`);
    manifest.files.push({ path: rel, bytes: file.size, sha256: srcSha });
    onProgress?.(manifest.files.length, entries.length, rel);
  }
  await writeFile(target, 'manifest.json', JSON.stringify(manifest, null, 2));
  return { name, count: manifest.files.length, path: `backups/${name}` };
}

// ---------- 项目落盘（第 6.5 章输出树） ----------
export function processMarkdown(project) {
  const lines = [];
  lines.push(`# X-AI 制作过程与结果`, '', `- 项目：${project.name}`, `- 项目 ID：${project.id}`, `- 更新时间：${nowIso()}`, '');
  lines.push('## 任务', '', '| 镜号 | 分组 | 状态 | 时长 | 画幅 | 模式 | 当前视频 | SHA-256 |', '|---|---|---|---|---|---|---|---|');
  for (const j of project.jobs) {
    lines.push(`| ${j.id} | ${j.episode} | ${j.state} | ${j.seconds}s | ${j.aspect} | ${j.mode} | ${j.current?.path || '—'} | ${j.current?.sha256 ? j.current.sha256.slice(0, 12) + '…' : '—'} |`);
  }
  lines.push('', '## 文本来源');
  for (const j of project.jobs) {
    for (const ts of j.textSources || []) lines.push(`- ${j.id} ${ts.field}：${ts.path}#${ts.selection || ''} sha256=${ts.sha256?.slice(0, 12)}…`);
    for (const r of j.referenceReplacements || []) lines.push(`- ${j.id} 替换 ${r.field}：${JSON.stringify(r.before).slice(0, 80)} → ${JSON.stringify(r.after).slice(0, 80)}`);
  }
  lines.push('', '## 事件（脱敏）');
  for (const e of project.events.slice(-400)) lines.push(`- ${e.at} ${e.kind} ${e.jobId ? '[' + e.jobId + ']' : ''} ${e.message}`);
  return lines.join('\n');
}

export async function writeProjectFiles(dirHandle, project) {
  await writeFile(dirHandle, 'project.json', JSON.stringify(redact(project), null, 2));
  const mapping = buildReferenceMapping(project);
  await writeFile(dirHandle, 'reference-mapping.json', JSON.stringify(mapping, null, 2));
  await writeFile(dirHandle, 'X-AI_制作过程与结果.md', processMarkdown(project));
}

export function buildReferenceMapping(project) {
  const out = { generatedAt: nowIso(), mappings: [] };
  for (const a of project.assets) {
    if (a.storage === 'source') {
      const eff = a.effectiveAssetId ? project.assets.find(x => x.id === a.effectiveAssetId) : null;
      out.mappings.push({
        sourcePath: a.sources?.map(s => `${s.rootName}/${s.path}`).join(' | ') || a.path,
        sha256: a.sha256,
        effectivePath: eff?.path || null,
        effectiveSha256: eff?.sha256 || null,
        assetId: a.id,
      });
    }
  }
  return out;
}

// 把浏览器中的管理素材写为 references 副本（仅非 source 素材）
export async function persistAssetFile(dirHandle, asset, blob, project) {
  const rel = asset.path;
  if (!rel || asset.storage === 'source') return false;
  if (await fileExists(dirHandle, rel)) {
    // 写入前备份旧字节
    const old = await readFileFromHandle(dirHandle, rel);
    const oldBuf = await old.arrayBuffer();
    const oldSha = await sha256Hex(oldBuf);
    if (oldSha === asset.sha256) return true;
    const stamp = nowIso().replace(/[:.]/g, '-');
    const backups = await dirHandle.getDirectoryHandle('backups', { create: true });
    const name = `replaced_${stamp.slice(0, 19)}_${Math.random().toString(36).slice(2, 6)}`;
    const target = await backups.getDirectoryHandle(name, { create: true });
    await writeFile(target, rel, oldBuf);
    asset.backupPath = `backups/${name}/${rel}`;
    await writeFile(target, 'manifest.json', JSON.stringify({ replaced: rel, sha256: oldSha }, null, 2));
  }
  await writeFile(dirHandle, rel, blob);
  return true;
}

// ---------- 素材 ZIP（store，不重编码） ----------
export async function buildZip(entries, onProgress) {
  // entries: [{name, blob}]; 总量 ≤500MB
  const MAX = 500_000_000;
  let total = entries.reduce((s, e) => s + e.blob.size, 0);
  if (total >= MAX) throw new Error(`勾选内容约 ${Math.round(total / 1e6)}MB，超过单包 500MB，请分批`);
  const chunks = []; const central = []; let offset = 0;
  const enc = new TextEncoder();
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  async function crc32(blob) {
    let crc = 0xFFFFFFFF;
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) crc = crcTable[(crc ^ value[i]) & 0xFF] ^ (crc >>> 8);
      await new Promise(r => setTimeout(r, 0)); // 让出主线程
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  const used = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let name = e.name;
    const lower = name.toLowerCase();
    if (used.has(lower)) { const dot = name.lastIndexOf('.'); name = dot > 0 ? `${name.slice(0, dot)}_${i}${name.slice(dot)}` : `${name}_${i}`; }
    used.add(name.toLowerCase());
    const data = new Uint8Array(await e.blob.arrayBuffer());
    const crc = await crc32(e.blob);
    const nameBytes = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8
    lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
    onProgress?.(i + 1, entries.length, name);
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true); eocd.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}
