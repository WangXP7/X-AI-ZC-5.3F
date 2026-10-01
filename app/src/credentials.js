// credentials.js — 普通密钥（会话内存）、本机免口令默认配置（仅本机部署）、高级保险箱（PBKDF2 + AES-GCM）。
// 设计依据：docs/X-AI详细设计文档.md 第 15 章。
import { saveVault, loadVault } from './storage.js';

const KEY_RE = /^sk-[A-Za-z0-9_-]{12,}$/;

export const credentials = {
  key: null,            // 会话内存中的活动 KEY；绝不写入项目 / 日志 / 持久存储
  hasDefault: false,    // 本机私有默认配置是否载入成功
  defaultLabel: '',

  statusText() {
    if (this.key) return this.hasDefault ? '系统默认密钥已启用' : '会话密钥已启用';
    return '未启用密钥';
  },
  onChange: null, // UI 订阅

  emit() { this.onChange?.(); },

  async initialize() {
    // 发布版没有 private/default-access.json（fetch 404），访客填自己的 KEY。
    try {
      const res = await fetch('private/default-access.json', { cache: 'no-store' });
      if (res.ok) {
        const cfg = await res.json();
        if (cfg && cfg.format === 'x-ai-local-default-v1') {
          const key = await openLocalDefault(cfg);
          if (key) { this.key = key; this.hasDefault = true; this.defaultLabel = cfg.label || '本机默认'; }
        }
      }
    } catch { /* 发布版属正常情况 */ }
    this.emit();
  },

  useNewKey(input) {
    const key = String(input || '').trim();
    if (!KEY_RE.test(key)) {
      const e = new Error('密钥格式错误：确认复制的是以 sk- 开头的 API KEY（至少 12 位随机字符）。');
      e.field = 'key-input';
      throw e;
    }
    this.key = key;
    this.emit();
  },

  useDefaultAgain() { this.key = this.key && this.hasDefault ? this.key : this.key; this.emit(); },
  stop() { this.key = null; this.hasDefault = false; this.emit(); },

  // ---------- 高级保险箱（用户主动保存） ----------
  async vaultSave(key, password) {
    if (!KEY_RE.test(String(key || '').trim())) throw new Error('KEY 格式错误：需以 sk- 开头。');
    if (typeof password !== 'string' || password.length < 12) throw new Error('口令至少 12 位；口令不保存，忘记后只能重新输入 KEY。');
    const vault = await sealVault(key.trim(), password);
    await saveVault(vault);
  },
  async vaultUnlock(password) {
    const vault = await loadVault();
    if (!vault) throw new Error('本浏览器没有已保存的加密副本。');
    const key = await openVault(vault, password);
    if (!key) throw new Error('解锁口令不正确，或加密副本已损坏。');
    this.key = key; this.hasDefault = false; this.emit();
    return true;
  },
  async vaultExists() { return !!(await loadVault()); },
};

// ---------- 本机免口令封装：x-ai-local-default-v1 ----------
async function openLocalDefault(cfg) {
  try {
    const raw = base64ToBytes(cfg.openingKey);
    const iv = base64ToBytes(cfg.iv);
    const cipher = base64ToBytes(cfg.cipher);
    const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, cipher);
    const text = new TextDecoder().decode(plain);
    return KEY_RE.test(text) ? text : null;
  } catch { return null; }
}

// ---------- 保险箱：x-ai-vault-v1（PBKDF2-SHA256 + AES-256-GCM） ----------
async function sealVault(key, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = 310000;
  const aesKey = await deriveKey(password, salt, iterations);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(key));
  return {
    format: 'x-ai-vault-v1', iterations,
    salt: bytesToBase64(salt), iv: bytesToBase64(iv), cipher: bytesToBase64(new Uint8Array(cipher)),
    createdAt: new Date().toISOString(),
  };
}

async function openVault(vault, password) {
  try {
    if (vault.format !== 'x-ai-vault-v1') return null;
    const it = Math.min(1000000, Math.max(100000, vault.iterations || 310000));
    const aesKey = await deriveKey(password, base64ToBytes(vault.salt), it);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(vault.iv) }, aesKey, base64ToBytes(vault.cipher));
    const text = new TextDecoder().decode(plain);
    return KEY_RE.test(text) ? text : null;
  } catch { return null; }
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function bytesToBase64(b) { return btoa(String.fromCharCode(...b)); }
function base64ToBytes(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
