/* 手机行为层：动态屏幕标记、首次手势解锁音频及画布拖拽保护。布局统一由 mobile.css 管理。 */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  let installed = false;
  let audioUnlocked = false;
  let resizeTimer = null;

  function viewport() {
    return { width: window.innerWidth || document.documentElement.clientWidth,
      height: window.innerHeight || document.documentElement.clientHeight };
  }

  function isTouch() {
    try {
      return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        || (navigator.maxTouchPoints || 0) > 0;
    } catch (e) { return false; }
  }

  function isMobileLayout() {
    try {
      const size = viewport();
      return size.width <= 900 || size.width <= 1000 && size.height <= 520 && size.width > size.height;
    } catch (e) { return false; }
  }

  function markBody() {
    if (!document.body) return;
    document.body.classList.toggle('cc-touch', isTouch());
    document.body.classList.toggle('cc-mobile', isMobileLayout());
  }

  function unlockAudio() {
    if (audioUnlocked) return true;
    const assets = CC.assets;
    if (!assets || typeof assets.resumeAll !== 'function') return false;
    try {
      assets.resumeAll();
      if (typeof assets.play === 'function') assets.play('ui_click', { vol: 0.001 });
      const canPlay = !!(CC.access && CC.access.caps && CC.access.caps.place);
      if (canPlay && typeof assets.music === 'function') assets.music('bgm_battle_loop');
      audioUnlocked = true;
      return true;
    } catch (e) { return false; }
  }

  // 兼容已有调试入口；清理旧版注入样式，响应式规则只保留在 mobile.css。
  function injectLayoutCss() {
    const previous = document.getElementById('cc-mobile-style');
    if (previous) previous.remove();
    markBody();
    const size = viewport();
    return { narrow: size.width <= 900,
      landscapeShort: size.width <= 1000 && size.height <= 520 && size.width > size.height, len: 0 };
  }

  function firstGesture() {
    if (!unlockAudio()) return;
    window.removeEventListener('pointerdown', firstGesture, true);
    window.removeEventListener('touchstart', firstGesture, true);
  }

  function updateViewport() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(markBody, 120);
  }

  function install() {
    injectLayoutCss();
    if (installed) return;
    installed = true;
    window.addEventListener('pointerdown', firstGesture, { capture: true, passive: true });
    window.addEventListener('touchstart', firstGesture, { capture: true, passive: true });
    // Safari 的回退保护只处理画布上的实际拖拽；战报、按钮和页面保留原生滚动与点击。
    document.addEventListener('touchmove', (event) => {
      const dragging = CC.input && CC.input.state && CC.input.state.dragging;
      const target = event.target;
      if (dragging && event.cancelable && target && target.closest && target.closest('#stage')) event.preventDefault();
    }, { passive: false });
    window.addEventListener('resize', updateViewport, { passive: true });
    window.addEventListener('orientationchange', updateViewport, { passive: true });
  }

  CC.mobile = {
    get coarse() { return isTouch(); },
    get smallScreen() { return viewport().width <= 900; },
    isTouch: isTouch,
    isMobileLayout: isMobileLayout,
    unlockAudio: unlockAudio,
    injectLayoutCss: injectLayoutCss,
    _audioUnlocked: () => audioUnlocked,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
