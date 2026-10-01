// batch-panel.js — 批量面板：源目录索引、清单位置选择、引用展开、入队前复核。
// 设计依据：docs/X-AI详细设计文档.md 第 5.2、10、11 章。
import { parseBatch } from './batch.js';
import { resolveReferences, verifyResolvedDocuments, needsResolution } from './references.js';
import { sha256Hex } from './core.js';
import { walkDirectory } from './storage.js';

export class BatchPanel {
  constructor({ project, assets, logEvent }) {
    this.project = project;
    this.assets = assets;          // AssetManager（用于把引用的素材登记为 source 记录）
    this.logEvent = logEvent || (() => {});
    this.rootHandle = null;        // 清单与素材共同上级目录
    this.index = new Map();        // relPath -> {handle, name}
    this.aliasIndex = new Map();   // alias -> relPath[]
    this.listRelPath = null;       // 所选清单相对路径
    this.batch = null;             // parseBatch 结果
    this.resolved = null;          // resolveReferences 结果
    this.expandedText = null;      // 可下载的展开 JSON
  }

  async chooseRoot() {
    if (!window.showDirectoryPicker) throw new Error('此浏览器不支持文件夹授权，请使用桌面版 Chrome / Edge。');
    this.rootHandle = await window.showDirectoryPicker({ id: 'x-ai-input', mode: 'read' });
    await this.buildIndex();
    return this.listFiles();
  }

  async buildIndex(onProgress) {
    if (!this.rootHandle) return;
    this.index = new Map(); this.aliasIndex = new Map();
    let count = 0;
    for await (const { rel, handle } of walkDirectory(this.rootHandle, '', 0)) {
      this.index.set(rel, { handle, name: rel.split('/').pop() });
      // 登记编号别名：C01、C01_ 等前缀
      const m = handle.name.match(/^([A-Za-z][A-Za-z0-9_-]{0,15}?)[_\s.\-]/);
      if (m) {
        const arr = this.aliasIndex.get(m[1]) || [];
        arr.push(rel);
        this.aliasIndex.set(m[1], arr);
      }
      count++;
      if (onProgress && count % 500 === 0) onProgress(count);
    }
  }

  listFiles() {
    // 供下拉选择清单：文本与清单类文件
    const listExts = /\.(csv|tsv|txt|json|md)$/i;
    const files = [...this.index.entries()]
      .filter(([rel]) => listExts.test(rel))
      .map(([rel]) => rel)
      .sort();
    return files;
  }

  async loadListFile(relPath) {
    const hit = this.index.get(relPath);
    if (!hit) throw new Error(`找不到清单：${relPath}`);
    this.listRelPath = relPath;
    const file = await hit.handle.getFile();
    const text = await file.text();
    return text;
  }

  parse(text, defaults) {
    this.batch = parseBatch(text, defaults);
    return this.batch;
  }

  // ---------- 读取引用并展开 ----------
  async expand({ onProgress } = {}) {
    if (!this.batch) throw new Error('请先导入或粘贴清单');
    // 仅当存在相对路径 / 引用语法时才需要源目录（设计第 3.2、10 章）
    const anyNeeds = this.batch.rows.some(r => r.spec && needsResolution(r.spec));
    if (anyNeeds && (!this.rootHandle || !this.index.size)) {
      throw new Error('清单包含相对路径或引用语法：请先选择清单与素材的共同上级目录并建立索引');
    }
    const baseDir = this.listRelPath ? this.listRelPath.split('/').slice(0, -1).join('/') : '';
    const res = await resolveReferences(this.batch, this.rootHandle, {
      baseDir, index: anyNeeds ? this.index : null, onProgress,
    });
    this.resolved = res;
    // 展开后的可下载清单（媒体路径相对原 CSV 目录）
    const baseDirOfList = baseDir;
    this.expandedText = JSON.stringify({
      exportedAt: new Date().toISOString(),
      note: '媒体路径相对原 CSV 所在目录；重新导入时放在相同相对位置。',
      shots: res.results.map(r => {
        const spec = this.batch.rows.find(x => x.spec?.id === r.id)?.spec;
        return {
          id: r.id, episode: spec?.episode, seconds: spec?.seconds, aspect: spec?.aspect, mode: spec?.mode,
          prompt: r.prompt, dialogue: r.dialogue,
          errors: r.errors,
          files: r.media.map(m => ({
            kind: m.kind, path: relTo(baseDirOfList, m.path), alias: m.alias, sha256: m.sha256,
          })),
          textSources: r.textSources,
        };
      }),
    }, null, 2);
    return res;
  }

  // ---------- 入队 specs（整批复核文本哈希后生成） ----------
  async specsForQueue({ defaults } = {}) {
    if (!this.batch || !this.resolved) throw new Error('请先读取引用并展开');
    // 入队前重新读取文本并比对哈希
    const verify = await verifyResolvedDocuments(this.resolved.results, this.rootHandle, this.index);
    if (!verify.ok) {
      const e = new Error(`预览后文本已变化或不可读，需要重新展开：\n${verify.failures.slice(0, 5).join('\n')}`);
      e.details = verify.failures;
      throw e;
    }
    const specs = [];
    const errors = [];
    for (const r of this.resolved.results) {
      if (r.errors.length) { errors.push(`镜 ${r.id}：${r.errors[0]}`); continue; }
      const spec = this.batch.rows.find(x => x.spec?.id === r.id)?.spec;
      if (!spec) continue;
      const s = {
        id: spec.id, episode: spec.episode, episodeTitle: spec.episodeTitle,
        prompt: r.prompt, dialogue: r.dialogue,
        seconds: spec.seconds, aspect: spec.aspect, mode: spec.mode,
        seed: spec.seed ?? null,
        assetIds: [],           // 媒体按路径在提交时读取；登记为 source 引用
        firstFrame: null, lastFrame: null,
        continuityFrom: spec.continuity || null,
        sourceReferences: spec.sourceReferences || [],
        textSources: r.textSources,
        referenceReplacements: r.replacements,
        mediaPaths: r.media.map(m => ({ kind: m.kind, path: m.path, sha256: m.sha256, alias: m.alias })),
      };
      specs.push(s);
    }
    return { specs, errors };
  }

  // 将引用的源素材登记为项目 Asset（storage:'source'，不复制字节）
  async registerSourceAssets(spec) {
    for (const m of spec.mediaPaths || []) {
      let asset = this.project.assets.find(a => a.kind === m.kind && a.path === m.path && a.storage === 'source');
      if (!asset) {
        let sha = m.sha256;
        let bytes = 0; let width = 0; let height = 0; let duration = 0; let errors = [];
        try {
          const hit = this.index.get(m.path);
          if (hit) {
            const file = await hit.handle.getFile();
            bytes = file.size;
            sha = await sha256Hex(await file.arrayBuffer());
          }
        } catch (e) { errors = [`源文件暂不可读：${e.message}`]; }
        asset = {
          id: crypto.randomUUID(), kind: m.kind, name: m.path.split('/').pop(),
          type: m.kind === 'image' ? 'image/*' : 'audio/*',
          bytes, sha256: sha || '', errors, width, height, duration,
          blobKey: null, path: m.path, storage: 'source',
          sources: [{ root: 'batch-root', rootName: this.rootHandle?.name || '', path: m.path }],
          aliases: m.alias ? [m.alias] : [], createdAt: new Date().toISOString(),
          status: errors.length ? 'warning' : 'success',
        };
        this.project.assets.push(asset);
      }
      spec.assetIds.push(asset.id);
      if (m.kind === 'image') spec.__imagePaths = spec.__imagePaths || [];
    }
  }
}

function relTo(baseDir, absRel) {
  // 把相对 root 的路径重新表示为相对原 CSV 目录
  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const parts = absRel.split('/').filter(Boolean);
  let i = 0;
  while (i < baseParts.length && i < parts.length && baseParts[i] === parts[i]) i++;
  const ups = baseParts.length - i;
  const out = [...Array.from({ length: ups }, () => '..'), ...parts.slice(i)];
  return out.join('/') || absRel;
}
