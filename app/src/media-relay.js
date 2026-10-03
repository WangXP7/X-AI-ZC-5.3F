// media-relay.js — Pages/远程来源的自动本机媒体通道（第 40 章）。
// 读取同源 media-relay.json（协议 x-ai-media-v1、精确 pageOrigins、唯一 endpoint）；
// /__xai_media_session 握手取得 15 分钟内存短期凭证；POST /__xai_media 带 X-XAI-Media-Token。
// 凭证只在内存，过期前 30 秒续取；media_session_required 时重新握手。
// 本通道只代理固定 Agnes 输出 CDN 的 /videos/*.mp4，不代理认证 API，不携带任何密钥。

const CFG_URL = new URL('../media-relay.json', import.meta.url).href;

export class AutomaticMediaRelay {
  constructor() {
    this.cfg = null;
    this.cfgLoaded = false;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.unavailableUntil = 0;   // 本机服务不可用时的检测退避
    this.lastError = '';
  }

  eligible(pageOrigin, mediaUrl) {
    if (!this.cfgLoaded) return false; // 需先 load()
    if (!this.cfg) return false;
    if (Date.now() < this.unavailableUntil) return false;
    if (!this.cfg.pageOrigins?.includes(pageOrigin)) return false;
    if (!this.isSupportedMediaUrl(mediaUrl)) return false;
    return true;
  }

  isSupportedMediaUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.port && u.port !== '443') return false;
      if (u.username || u.password) return false;
      if (!/\/videos\/.+\.(mp4|mov)(\?|$)/.test(u.pathname)) return false;
      if (this.cfg.allowedMediaHosts && !this.cfg.allowedMediaHosts.includes(u.hostname)) return false;
      return true;
    } catch { return false; }
  }

  async load() {
    if (this.cfgLoaded) return this.cfg;
    this.cfgLoaded = true;
    try {
      const res = await fetch(CFG_URL, { cache: 'no-store' });
      if (!res.ok) { this.cfg = null; return null; }
      const cfg = await res.json();
      if (cfg?.protocol !== 'x-ai-media-v1' || !cfg.endpoint || !Array.isArray(cfg.pageOrigins)) { this.cfg = null; return null; }
      this.cfg = cfg;
      return cfg;
    } catch { this.cfg = null; return null; }
  }

  async endpoint() {
    await this.load();
    return this.cfg?.endpoint || null;
  }

  async token() {
    if (this.token && Date.now() < this.tokenExpiresAt - 30000) return this.token;
    await this.load();
    if (!this.cfg) throw new Error('本机下载服务未配置');
    const res = await fetch(this.cfg.endpoint.replace(/\/__xai_media$/, '/__xai_media_session'), {
      credentials: 'omit', cache: 'no-store',
    });
    if (!res.ok) {
      this.unavailableUntil = Date.now() + 30000; // 30 秒后复查（第 40.5 章）
      const e = new Error('本机下载服务未连接 · 自动检测中'); e.code = 'relay_unavailable';
      throw e;
    }
    const j = await res.json();
    if (j?.protocol !== 'x-ai-media-v1' || !j.token) { const e = new Error('会话握手失败'); e.code = 'media_session_required'; throw e; }
    this.token = j.token;
    this.tokenExpiresAt = Date.now() + (Number(j.expiresInSeconds) || 900) * 1000;
    return this.token;
  }

  noteUnavailable(message) {
    this.unavailableUntil = Date.now() + 30000;
    this.lastError = String(message || '').slice(0, 160);
  }
}
