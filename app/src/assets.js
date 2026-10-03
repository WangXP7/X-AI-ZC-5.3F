// assets.js — 素材导入计划、逐项进度（停止 / 继续 / 重试）、批量图片优化与复用。
// 设计依据：docs/X-AI详细设计文档.md 第 9.1、9.4、16.2 章，docs/素材操作说明.md。
import { sha256Hex, uuid, nowIso, IMAGE_BYTES_MAX_EXCL, IMAGE_BYTES_IMPORT_MAX_EXCL } from './core.js';
import { blobStore, persistAssetFile } from './storage.js';
import { inspectImageFile, inspectAudioFile, optimizeImageFile } from './media.js';

export class AssetManager {
  constructor({ project, dirHandle, persist, logEvent }) {
    this.project = project; this.dirHandle = dirHandle; this.persist = persist;
    this.logEvent = logEvent || (() => {});
    this.stopFlag = false;
  }

  setDirHandle(h) { this.dirHandle = h; }

  // ---------- 预检计划（尚未读取 / 导入） ----------
  planImport(fileList) {
    const files = [...fileList];
    const plan = {
      total: files.length,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      items: files.map(f => ({
        file: f, name: f.name, kind: f.type.startsWith('audio') ? 'audio' : (f.type.startsWith('image') ? 'image' : null),
        bytes: f.size, status: 'pending', note: '',
      })),
    };
    for (const it of plan.items) {
      if (!it.kind) { it.status = 'error'; it.note = '不支持的文件类型（需要 PNG / JPEG / WebP / 常见声音格式）'; }
      else if (it.bytes >= IMAGE_BYTES_IMPORT_MAX_EXCL) { it.status = 'error'; it.note = '超过 150MB 单文件导入上限'; }
      else if (it.kind === 'image' && it.bytes >= IMAGE_BYTES_MAX_EXCL) { it.status = 'warning'; it.note = '超过 15MB 请求限制，导入后需优化'; }
    }
    return plan;
  }

  // ---------- 逐项执行（可停止，完成当前项后停） ----------
  async execute(plan, { onProgress, onItem, onDone } = {}) {
    this.stopFlag = false;
    const results = [];
    for (const it of plan.items) {
      if (this.stopFlag && it.status === 'pending') break;
      if (it.status === 'done' || it.status === 'error') { results.push(it); continue; }
      onItem?.(it);
      try {
        const res = await this._importOne(it);
        Object.assign(it, res);
      } catch (e) {
        it.status = 'error'; it.note = e.message || String(e);
      }
      results.push(it);
      onProgress?.(results.length, plan.total, it.name);
    }
    await this.persist();
    onDone?.(results);
    return results;
  }

  stopAfterCurrent() { this.stopFlag = true; }

  async _importOne(it) {
    const file = it.file;
    const buf = await file.arrayBuffer();
    const sha = await sha256Hex(buf);
    const kind = it.kind;
    let meta = { errors: [], width: 0, height: 0, duration: 0 };
    if (kind === 'image') meta = await inspectImageFile(file);
    else meta = await inspectAudioFile(file);
    if (meta.errors.some(e => e.includes('150MB'))) throw new Error(meta.errors.join('；'));
    // 去重：只有同名且 SHA-256 相同才复用同一身份（第 27.2 章）；字节同但文件名不同分别登记
    const dup = this.project.assets.find(a => a.name === file.name && a.sha256 === sha);
    if (dup) {
      if (!dup.aliases?.includes(file.name)) dup.aliases = [...(dup.aliases || []), file.name];
      // 缓存缺失时用本次已核验数据补齐，不制造第二份记录
      if (!dup.blobKey) dup.blobKey = await blobStore.put(new Blob([buf], { type: file.type || 'application/octet-stream' }));
      if (kind === 'image' && meta.errors.length) return { status: 'warning', assetId: dup.id, note: `复用已有素材；${meta.errors.join('；')}` };
      return { status: 'duplicate', assetId: dup.id, note: `同名同内容，已复用（${dup.name}）` };
    }
    const blobKey = await blobStore.put(new Blob([buf], { type: file.type || 'application/octet-stream' }));
    const isImage = kind === 'image';
    // 未修改原素材一律 storage=source：原件不写、不改名、不复制到输出 references（第 30.2 章）。
    // 浏览器保留工作缓存（blobKey）用于预览、校验与恢复。
    const asset = {
      id: uuid(), kind, name: file.name, type: file.type || (isImage ? 'image/*' : 'audio/*'),
      bytes: file.size, sha256: sha, errors: meta.errors || [], width: meta.width || 0, height: meta.height || 0,
      duration: meta.duration || 0, blobKey, path: '', storage: 'source',
      sources: [], aliases: [file.name], legacyPaths: [],
      createdAt: nowIso(), status: meta.errors.length ? 'warning' : 'success',
      sourceNote: '原素材（浏览器工作缓存；仅引用，不写入输出目录）',
    };
    this.project.assets.push(asset);
    // 纳入当前 Studio 成员
    import('./core.js').then(({ activeStudio }) => {
      const st = activeStudio(this.project);
      if (!st.assetIds.includes(asset.id)) st.assetIds.push(asset.id);
    }).catch(() => {});
    this.logEvent('asset-import', `${asset.name} sha256=${sha.slice(0, 12)}…（源引用）`, null);
    return { status: asset.errors.length ? 'warning' : 'success', assetId: asset.id, note: asset.errors.join('；') };
  }

  // ---------- 批量图片优化（第 9.4 章） ----------
  planOptimize(assetIds) {
    return assetIds.map(id => this.project.assets.find(a => a.id === id)).filter(a => a && a.kind === 'image').map(a => ({
      asset: a, status: a.effectiveAssetId ? 'skipped' : 'pending',
      note: a.effectiveAssetId ? '已有合规优化版' : '',
    }));
  }

  async executeOptimize(items, { onProgress, onItem } = {}) {
    this.stopFlag = false;
    const out = [];
    for (const it of items) {
      if (this.stopFlag && it.status === 'pending') break;
      onItem?.(it);
      if (it.status !== 'pending') { out.push(it); continue; }
      try {
        let a = it.asset;
        // 1.0 错误命名的旧派生版再次优化：以原 Asset 为本次输入（第 27.3 章）
        if (a.derivedFrom && a.name !== (this.project.assets.find(x => x.id === a.derivedFrom)?.name ?? a.name)) {
          const orig = this.project.assets.find(x => x.id === a.derivedFrom);
          if (orig) { a = orig; it.asset = orig; }
        }
        const blob = await blobStore.get(a.blobKey);
        if (!blob) throw new Error('浏览器中的原图副本丢失，请重新导入');
        const opt = await optimizeImageFile(blob, { keepFormat: true });
        const optSha = await sha256Hex(await opt.blob.arrayBuffer());
        // 同一原图已有相同派生结果则复用（按内容与目标名判断）
        const origName = a.name;
        let derived = this.project.assets.find(x => x.derivedFrom === a.id && x.sha256 === optSha && x.name === origName);
        if (!derived) {
          const versionId = uuid();
          const rel = `references/optimized/${a.id}/${versionId}/${origName}`;
          const blobKey = await blobStore.put(opt.blob);
          derived = {
            id: uuid(), kind: 'image', name: origName, type: opt.type,
            bytes: opt.blob.size, sha256: optSha, width: opt.width, height: opt.height,
            duration: 0, blobKey, path: rel, aliases: [origName],
            derivedFrom: a.id, versionId,
            transform: `同名优化：长边≤2048 等比缩放并补边至 0.4–2.5 比例；保持 ${opt.type} 实际编码`,
            errors: [], createdAt: nowIso(), status: 'success',
          };
          this.project.assets.push(derived);
          if (this.dirHandle) {
            await persistAssetFile(this.dirHandle, derived, opt.blob, this.project);
          }
        }
        a.effectiveAssetId = derived.id;
        it.status = 'success'; it.note = `优化为 ${derived.width}×${derived.height}（同名 ${origName}）`;
        it.derived = derived;
      } catch (e) {
        it.status = 'error'; it.note = e.message || String(e);
      }
      out.push(it);
      onProgress?.(out.length, items.length, it.asset.name);
    }
    await this.persist();
    return out;
  }

  // 由 Asset 记录取可读 Blob（引擎请求时回读）
  async readAssetBlob(asset) {
    // 源路径素材：从源目录句柄回读并核对
    if (asset.storage === 'source' && this.sourceRoots?.size) {
      for (const s of asset.sources || []) {
        const root = this.sourceRoots.get(s.root);
        if (!root) continue;
        try {
          const file = await readFileFrom(root, s.path);
          const sha = await sha256Hex(await file.arrayBuffer());
          if (sha !== asset.sha256) throw new Error(`源文件已变化：${s.path}`);
          return file;
        } catch (e) { throw e; }
      }
      throw new Error('原路径素材需要重新授权源目录后才能提交');
    }
    // 有效优化版优先
    if (asset.effectiveAssetId) {
      const eff = this.project.assets.find(x => x.id === asset.effectiveAssetId);
      if (eff) return this.readAssetBlob(eff);
    }
    const blob = await blobStore.get(asset.blobKey);
    if (!blob) throw new Error(`素材 ${asset.name} 的浏览器副本丢失`);
    return blob;
  }
}

async function readFileFrom(rootHandle, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  let dir = rootHandle;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const fh = await dir.getFileHandle(parts.at(-1));
  return fh.getFile();
}
