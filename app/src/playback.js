// playback.js — 页面内互斥试听 / 试看（第 28 章）。
// 捕获阶段监听 play：新播放开始时暂停其他 audio/video；只调用 pause()，不回退进度。
// 导航 / 切换 Studio 用 pauseAll()；dialog 关闭与元素移除也暂停。抽帧 / metadata 等脱离 DOM
// 的媒体元素不参与预览控制。

let activeEl = null;
let installed = false;

export function installPlaybackController(doc = document) {
  if (installed) return { pauseAll, dispose };
  installed = true;

  doc.addEventListener('play', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLAudioElement || t instanceof HTMLVideoElement)) return;
    if (t.__xaiTechnical) return; // 技术用途（脱离 DOM）不参与互斥
    // 暂停此前活动元素
    if (activeEl && activeEl !== t && !activeEl.paused) { try { activeEl.pause(); } catch { /* ignore */ } }
    // 遍历页面其余媒体，暂停仍在播放的
    for (const el of doc.querySelectorAll('audio, video')) {
      if (el !== t && !el.paused && !el.ended) { try { el.pause(); } catch { /* ignore */ } }
    }
    activeEl = t;
  }, true);

  // 活动元素被移除：暂停
  const mo = new MutationObserver(() => {
    if (activeEl && !doc.contains(activeEl)) {
      try { activeEl.pause(); } catch { /* ignore */ }
      activeEl = null;
    }
  });
  mo.observe(doc.documentElement, { childList: true, subtree: true });

  // dialog 关闭时暂停其中媒体（open 属性变化双保险）
  doc.addEventListener('close', (e) => {
    if (e.target instanceof HTMLDialogElement) pauseIn(e.target);
  }, true);
  const mo2 = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName === 'open' && m.target instanceof HTMLDialogElement && !m.target.open) pauseIn(m.target);
    }
  });
  document.querySelectorAll('dialog').forEach(d => mo2.observe(d, { attributes: true, attributeFilter: ['open'] }));

  function pauseIn(root) {
    for (const el of root.querySelectorAll('audio, video')) { try { el.pause(); } catch { /* ignore */ } }
    if (activeEl && root.contains(activeEl)) activeEl = null;
  }

  function pauseAll() {
    for (const el of doc.querySelectorAll('audio, video')) { try { el.pause(); } catch { /* ignore */ } }
    activeEl = null;
  }

  function dispose() {
    pauseAll();
    mo.disconnect(); mo2.disconnect();
    installed = false;
  }

  return { pauseAll, dispose };
}
