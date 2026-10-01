// main.js — 入口：等待 DOM 后启动初始化。
import { init } from './app.js';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(e => {
    console.error(e);
    document.getElementById('init-banner').hidden = false;
    document.getElementById('init-banner').textContent = `初始化失败：${e.message}`;
  }));
} else {
  init().catch(e => {
    console.error(e);
    document.getElementById('init-banner').hidden = false;
    document.getElementById('init-banner').textContent = `初始化失败：${e.message}`;
  });
}
