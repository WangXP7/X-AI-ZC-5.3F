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
    // 重复复用（同字节）
    const dup = this.project.assets.find(a => a.sha256 === sha);
    const kind = it.kind;
    let meta = { errors: [], width: 0, height: 0, duration: 0 };
    if (kind === 'image') meta = await inspectImageFile(file);
    else meta = await inspectAudioFile(file);
    if (meta.errors.some(e => e.includes('150MB'))) throw new Error(meta.errors.join('；'));

    if (dup) {
      // 合并本次路径 / 别名信息
      if (!dup.aliases?.includes(file.name)) dup.aliases = [...(dup.aliases || []), file.name];
      if (kind === 'image' && meta.errors.length) {
        dup.errors = meta.errors;
        return { status: 'warning', assetId: dup.id, note: `复用已有素材；${meta.errors.join('；')}` };
      }
      return { status: 'duplicate', assetId: dup.id, note: `与已有素材字节相同，已复用（${dup.name}）` };
    }

    const blobKey = await blobStore.put(new Blob([buf], { type: file.type || 'application/octet-stream' }));
    const isImage = kind === 'image';
    const rel = `references/${file.name}`;
    const asset = {
      id: uuid(), kind, name: file.name, type: file.type || (isImage ? 'image/*' : 'audio/*'),
      bytes: file.size, sha256: sha, errors: meta.errors || [], width: meta.width || 0, height: meta.height || 0,
      duration: meta.duration || 0, blobKey, path: rel, aliases: [file.name],
      createdAt: nowIso(), status: 'success',
    };
    // 管理副本落盘（无目录时仅浏览器保存）
    if (this.dirHandle) {
      try { await persistAssetFile(this.dirHandle, asset, new Blob([buf], { type: asset.type }), this.project); }
      catch (e) { asset.status = 'warning'; asset.errors.push(`磁盘写入失败：${e.message}`); }
    } else {
      asset.path = ''; // 仅浏览器副本
    }
    this.project.assets.push(asset);
    this.logEvent('asset-import', `${asset.name} sha256=${sha.slice(0, 12)}…`, null);
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
        const a = it.asset;
        const blob = await blobStore.get(a.blobKey);
        if (!blob) throw new Error('浏览器中的原图副本丢失，请重新导入');
        const keepFormat = !!a.path; // 原路径素材保留原格式
        const opt = await optimizeImageFile(blob, { keepFormat });
        const optSha = await sha256Hex(await opt.blob.arrayBuffer());
        // 已有同一派生版则复用
        let derived = this.project.assets.find(x => x.derivedFrom === a.id && x.sha256 === optSha);
        if (!derived) {
          const baseName = a.name.replace(/\.[^.]+$/, '');
          const ext = opt.ext;
          // 同名冲突：不同来源同名或原文件就在目标路径 → 用 素材ID/原名
          const samePathExists = this.project.assets.some(x => x !== a && x.path === `references/${baseName}.${ext}`);
          const rel = samePathExists ? `references/${a.id}/${baseName}.${ext}` : `references/${baseName}.${ext}`;
          const blobKey = await blobStore.put(opt.blob);
          derived = {
            id: uuid(), kind: 'image', name: `${baseName}.${ext}`, type: opt.type,
            bytes: opt.blob.size, sha256: optSha, width: opt.width, height: opt.height,
            duration: 0, blobKey, path: rel, aliases: [`${baseName}.${ext}`],
            derivedFrom: a.id, transform: `长边≤2048 等比缩放并补边至 0.4–2.5 比例；格式 ${opt.type}`,
            errors: [], createdAt: nowIso(), status: 'success',
          };
          this.project.assets.push(derived);
          if (this.dirHandle) {
            try { await persistAssetFile(this.dirHandle, derived, opt.blob, this.project); }
            catch (e) { derived.status = 'warning'; derived.errors.push(`磁盘写入失败：${e.message}`); }
          }
        }
        a.effectiveAssetId = derived.id;
        it.status = 'success'; it.note = `优化为 ${derived.width}×${derived.height} ${derived.name}`;
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
