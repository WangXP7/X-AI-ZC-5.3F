// gate.js — 静态站点的客户端授权密码门。
// 性质（如实说明）：这是共享口令的准入门槛，不是安全边界——静态文件本身可被直接读取。
// 强密码门（服务端会话）见 tools/server.py 的隧道/本机部署；两者自动互斥：
// 在服务端网关后面（/auth-state 返回 serverGate:true）时不再二次询问。
// 验证方式：PBKDF2-SHA256（310000 次）与 assets/site-auth.json 中的哈希比对；口令不存储、不传输。

const GATE_KEY = 'xai-site-gate-ok';

function gateMarkup() {
  return `
  <div id="site-gate" style="position:fixed;inset:0;z-index:9999;background:#f6f6f3;display:flex;align-items:center;justify-content:center;padding:24px;
       font:15px/1.65 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#252633;">
    <main style="width:100%;max-width:380px;background:#fff;border:1px solid #e3e1da;border-radius:14px;padding:30px 28px 26px;box-shadow:0 8px 30px rgba(37,38,51,.07);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
        <img src="assets/logo.svg" alt="X-AI" style="width:44px;height:44px;" onerror="this.style.display='none'">
        <div>
          <div style="font-size:20px;font-weight:650;letter-spacing:.3px;">X-AI</div>
          <div style="font-size:11px;color:#656270;letter-spacing:2.2px;">VIDEO STUDIO</div>
        </div>
      </div>
      <p style="color:#656270;font-size:14px;margin:10px 0 18px;">此站点需要授权密码才能访问。密码由发布者设置，验证在本机浏览器完成。</p>
      <form id="gate-form">
        <label for="gate-pw" style="display:block;font-size:14px;margin-bottom:6px;color:#44455a;">授权密码</label>
        <input id="gate-pw" type="password" autocomplete="current-password" autofocus required
               style="width:100%;padding:10px 12px;font-size:15px;border:1px solid #cfcdc4;border-radius:9px;">
        <button type="submit" style="width:100%;margin-top:16px;padding:11px 14px;font-size:15px;font-weight:600;color:#fff;background:#6750cc;border:0;border-radius:9px;cursor:pointer;">进入工作台</button>
      </form>
      <div id="gate-err" style="display:none;margin-top:14px;padding:9px 12px;border-radius:8px;font-size:14px;color:#8f1d2c;background:#fbeaed;border:1px solid #eec4ca;"></div>
      <div style="margin-top:18px;font-size:12px;color:#656270;text-align:center;">X-AI 1.0 · ® YiQiXP</div>
    </main>
  </div>`;
}

async function pbkdf2Hex(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let failCount = 0;

async function showGate(cfg) {
  const holder = document.createElement('div');
  holder.innerHTML = gateMarkup();
  document.body.appendChild(holder.firstElementChild);
  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-pw');
  const err = document.getElementById('gate-err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (failCount >= 5) {
      err.style.display = 'block';
      err.textContent = '尝试过于频繁，请 30 秒后再试。';
      return;
    }
    try {
      const hex = await pbkdf2Hex(input.value, cfg.salt, cfg.iterations);
      if (constantTimeEqual(hex, cfg.hash)) {
        sessionStorage.setItem(GATE_KEY, '1');
        document.getElementById('site-gate').remove();
        startApp();
      } else {
        failCount += 1;
        err.style.display = 'block';
        err.textContent = '授权密码不正确，请重试。';
        input.value = '';
        input.focus();
        setTimeout(() => { failCount = Math.max(0, failCount - 1); }, 30000);
      }
    } catch (ex) {
      err.style.display = 'block';
      err.textContent = '验证失败：' + (ex.message || ex);
    }
  });
  input.focus();
}

function startApp() {
  import('./main.js').catch((e) => {
    document.body.insertAdjacentHTML('beforeend',
      `<div style="position:fixed;inset:auto 0 0 0;padding:10px;background:#fbeaed;color:#7d2231;font-size:14px;">应用加载失败：${String(e.message || e)}</div>`);
  });
}

(async function boot() {
  // 1) 服务端网关后面：不再二次询问
  try {
    const res = await fetch('auth-state', { credentials: 'include', cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      if (j && j.serverGate) { startApp(); return; }
    }
  } catch { /* 静态托管：走客户端门 */ }
  // 2) 本会话已解锁
  if (sessionStorage.getItem(GATE_KEY) === '1') { startApp(); return; }
  // 3) 客户端密码门
  try {
    const cfg = await (await fetch('assets/site-auth.json', { cache: 'no-store' })).json();
    if (cfg && cfg.format === 'x-ai-site-gate-v1') { await showGate(cfg); return; }
  } catch (e) {
    // 无门配置（例如本地开发版）：直接进入
    startApp();
  }
})();
