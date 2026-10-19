/* 本地音量设置：静音只影响声音，不暂停战斗。 */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  if (!CC.assets || typeof document === 'undefined') return;
  const KEY = 'cyber-cricket-audio-v1';
  let volume = 30, muted = false;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Number.isFinite(saved.volume)) volume = Math.max(0, Math.min(100, saved.volume));
    if (saved) muted = saved.muted === true;
  } catch (e) { /* 存储不可用时仍可调节 */ }
  function apply() {
    CC.assets.setVolume({ master: muted ? 0 : volume / 100 });
  }
  apply();
  function mount() {
    if (document.getElementById('cc-audio-controls')) return;
    const host = document.querySelector('.hud-right') || document.body;
    if (host !== document.body) host.style.flexWrap = 'wrap';
    const controls = document.createElement('div');
    controls.id = 'cc-audio-controls';
    controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    if (host === document.body) controls.style.cssText += 'position:fixed;bottom:8px;left:8px;z-index:100;background:#111827;padding:6px;border-radius:8px;color:#eef;';
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'cc-btn ghost';
    button.title = '静音 / 恢复声音';
    const label = document.createElement('label');
    label.textContent = '音量 ';
    label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
    slider.value = String(volume); slider.setAttribute('aria-label', '游戏音量');
    slider.style.cssText = 'width:80px;min-height:34px;cursor:pointer;';
    const value = document.createElement('span');
    value.style.minWidth = '3em';
    function update() {
      apply();
      button.textContent = muted || volume === 0 ? '恢复声音' : '静音';
      button.setAttribute('aria-pressed', String(muted || volume === 0));
      value.textContent = (muted ? 0 : volume) + '%';
      try { localStorage.setItem(KEY, JSON.stringify({ volume, muted })); } catch (e) { /* 静默 */ }
    }
    button.addEventListener('click', function () {
      if (volume === 0) { volume = 30; slider.value = '30'; muted = false; }
      else muted = !muted;
      update();
    });
    slider.addEventListener('input', function () { volume = Number(slider.value); muted = false; update(); });
    label.appendChild(slider); label.appendChild(value);
    controls.appendChild(button); controls.appendChild(label); host.appendChild(controls);
    update();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
