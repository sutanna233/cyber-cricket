/* ===========================================================
   赛博斗蛐蛐 · 手机端适配（行为层）
   -----------------------------------------------------------
   1) 触摸设备标记（body.cc-touch）
   2) 首次触摸解锁音频（移动浏览器要求用户手势后才能出声）
   3) 竖屏小屏时提示"横屏更好看"（可点掉，5 秒自动消失）
   4) 双击缩放抑制 + 拖拽时页面不滚动（配合 mobile.css 的 touch-action）
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});

  const coarse = (() => {
    try {
      return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        || (navigator.maxTouchPoints || 0) > 1;
    } catch (e) { return false; }
  })();
  const smallScreen = (() => { try { return window.innerWidth <= 900; } catch (e) { return false; } })();

  function markBody() {
    try {
      document.body.classList.toggle('cc-touch', coarse);
      document.body.classList.toggle('cc-mobile', smallScreen);
    } catch (e) { /* ignore */ }
  }

  // ---------- 音频解锁 ----------
  let audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const A = CC.assets;
      if (!A) return;
      if (typeof A.resumeAll === 'function') A.resumeAll();               // 恢复被浏览器挂起的 AudioContext
      if (typeof A.play === 'function') A.play('ui_click', { volume: 0.001 });  // 用一次极轻的音效真正"点火"
      // 只有拿到操作权限（注册用户/管理员）才自动起 BGM；游客静音观战，避免手机突然出声
      const canPlay = !!(CC.access && CC.access.caps && CC.access.caps.place);
      if (canPlay && typeof A.music === 'function') A.music('bgm_battle_loop');
    } catch (e) { /* ignore */ }
  }

  // ---------- 手机布局：运行时注入样式 ----------
  // 说明：样式表里的媒体查询可能被其它规则压住（且缓存/优先级难排查），
  // 这里在运行时往文档最后追加一个 <style>，并带 !important，保证一定生效。
  const LAYOUT_CSS = [
    '.cc-app{width:100%!important;max-width:100%!important;padding:6px 6px 36px!important;gap:8px!important;flex-direction:column!important}',
    '.cc-hud{position:sticky!important;top:0;z-index:30;flex-wrap:wrap!important;gap:4px!important;font-size:12px!important;padding:6px 8px!important}',
    '.cc-hud .cc-title{font-size:14px!important}',
    '.cc-hud .cc-stat{font-size:11px!important}',
    '.cc-hud .cc-btn{min-height:34px!important;padding:6px 12px!important;font-size:12px!important}',
    '.cc-stage{flex-direction:column!important;width:100%!important;gap:8px!important}',
    '.cc-stage-canvas{width:100%!important;transform:none!important}',
    '#stage{width:100%!important;height:auto!important;aspect-ratio:960/600}',
    '.cc-bench{width:100%!important;max-width:100%!important;max-height:none!important;padding:6px!important}',
    '.cc-bench-title{font-size:12px!important}',
    '.cc-bench-tools{flex-wrap:wrap!important;gap:6px!important}',
    '.cc-bench-hint{display:none!important}',
    '.cc-bench-list{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(92px,1fr))!important;gap:6px!important;max-height:50vh;overflow-y:auto!important;overflow-x:hidden!important;padding:4px!important}',
    '.cc-card{min-height:96px}',
    '.cc-foot,.cc-status{display:none!important}',
    'button,.cc-btn{min-height:40px}',
    '#cc-access-badge{position:fixed!important;left:0;right:0;bottom:0;display:flex!important;align-items:center;justify-content:center;gap:6px;padding:6px 8px;font-size:10.5px!important;background:rgba(10,14,22,.94);border-top:1px solid #23304a;opacity:1}',
    '#cc-access-badge a{color:#7fe3ff;text-decoration:none}',
  ].join('\n');

  const LANDSCAPE_CSS = [
    '.cc-stage{flex-direction:row!important;align-items:stretch!important}',
    '.cc-stage-canvas{flex:1 1 auto!important;width:auto!important}',
    '#stage{width:100%!important;height:auto!important;max-height:76vh!important;aspect-ratio:960/600}',
    '.cc-bench{flex:0 0 200px!important;width:200px!important}',
    '.cc-bench-list{max-height:46vh}',
    '.cc-hud{position:static!important}',
  ].join('\n');

  function injectLayoutCss() {
    try {
      let st = document.getElementById('cc-mobile-style');
      if (!st) {
        st = document.createElement('style');
        st.id = 'cc-mobile-style';
        document.head.appendChild(st);   // 放最后 → 优先级最高
      }
      const w = window.innerWidth, h = window.innerHeight;
      const narrow = w <= 900;
      const landscapeShort = w <= 1000 && h <= 520 && w > h;
      let css = '';
      if (narrow) css += LAYOUT_CSS + '\n';
      if (landscapeShort) css += LANDSCAPE_CSS + '\n';
      if (st.textContent !== css) st.textContent = css;
      return { narrow, landscapeShort, len: css.length };
    } catch (e) { return null; }
  }
  function rotateTip() {
    if (!coarse) return;
    const portrait = (() => { try { return window.innerHeight > window.innerWidth; } catch (e) { return false; } })();
    if (!portrait || window.innerWidth > 560) return;      // 只在小屏竖屏提示
    if (document.getElementById('cc-rotate-tip')) return;
    const d = document.createElement('div');
    d.id = 'cc-rotate-tip';
    d.textContent = '横过来看更清楚（点这里关掉）';
    d.onclick = () => d.remove();
    document.body.appendChild(d);
    setTimeout(() => { if (d.parentNode) d.remove(); }, 6000);
  }

  // ---------- 触摸行为 ----------
  function bindTouch() {
    // 首次手势解锁音频
    const once = () => { unlockAudio(); window.removeEventListener('pointerdown', once, true); };
    window.addEventListener('pointerdown', once, true);
    window.addEventListener('touchstart', once, { capture: true, passive: true });

    // 抑制双击缩放（iOS Safari 的老问题）
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });

    // 拖拽期间别让页面跟着滚（画布自身由 CSS 的 touch-action:none 兜住）
    document.addEventListener('touchmove', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest('#stage,.cc-bench-list,.cc-report,.cc-panel')) {
        if (t.closest('.cc-bench-list,.cc-report,.cc-panel')) return;   // 这些允许滚动
        e.preventDefault();
      }
    }, { passive: false });

    // 屏幕旋转 / 尺寸变化时刷新标记
    window.addEventListener('resize', () => setTimeout(() => { markBody(); injectLayoutCss(); rotateTip(); }, 120));
    window.addEventListener('orientationchange', () => setTimeout(() => { markBody(); injectLayoutCss(); rotateTip(); }, 250));
  }

  function install() {
    markBody();
    injectLayoutCss();
    bindTouch();
    rotateTip();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
  setTimeout(install, 400);

  CC.mobile = {
    coarse, smallScreen,
    isTouch: () => coarse,
    isMobileLayout: () => (() => { try { return window.innerWidth <= 900; } catch (e) { return false; } })(),
    unlockAudio,
    injectLayoutCss,
    _audioUnlocked: () => audioUnlocked,
  };
})();
