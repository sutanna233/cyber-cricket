/* ===========================================================
   赛博斗蛐蛐 · 输入层（input）
   契约：CC.input.init(canvas)
   玩家唯一三类输入：拖放/点击放置（含拖回单位池）、空格暂停、按钮（ui 绑定）
   战斗阶段禁止一切放置输入；Esc 取消选中
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});

  const SLOT_HIT_RADIUS = 72;

  const state = {
    canvas: null,
    selected: null,   // {from:'bench'|'slot', unitId, slotIndex}
    dragging: null,   // {from:'bench'|'slot', unitId, slotIndex}
    hover: null,      // {slotIndex, valid, unitId} —— render.js 期望的对象形态（line 553/659）
    hoverIndex: null,
    pointer: { x: 0, y: 0, inside: false },
    bound: false,
  };

  let handlers = null;

  function main() { return CC.main || null; }
  function boardMod() { return CC.board || null; }
  function canPlace() {
    const m = main();
    if (m && typeof m.canPlace === 'function') return !!m.canPlace();
    return true;
  }
  function handlerTable() {
    if (handlers) return handlers;
    const U = CC.ui;
    if (U && typeof U.handlers === 'function') return U.handlers();
    return null;
  }
  function dispatch(name, a, b) {
    const H = handlerTable();
    if (!H || typeof H[name] !== 'function') return false;
    try { return H[name](a, b) !== false; } catch (e) {
      const m = main();
      if (m && typeof m.fail === 'function') m.fail(e);
      return false;
    }
  }

  // ---------- 坐标：世界 → 画布 ----------
  function project(x, z) {
    const S = CC.sprites;
    if (S && typeof S.project === 'function') {
      try {
        const p = S.project(x, z, 0);
        if (p && isFinite(p.sx) && isFinite(p.sy)) return p;
      } catch (e) { /* 降级 */ }
    }
    // 降级近似（sprites 缺席时仍可布阵）：世界 1200×700 → 画布 960×600，斜角俯视
    const wx = Number(x) || 0, wz = Number(z) || 0;
    return { sx: (wx / 1200) * 960, sy: 140 + (wz / 700) * 360 + (wx / 1200) * 60 };
  }

  function canvasSize() {
    const c = state.canvas;
    return { w: (c && c.width) || 960, h: (c && c.height) || 600 };
  }

  function canvasPoint(ev) {
    const c = state.canvas;
    const size = canvasSize();
    let rect = null;
    if (c && typeof c.getBoundingClientRect === 'function') {
      try { rect = c.getBoundingClientRect(); } catch (e) { rect = null; }
    }
    if (!rect) rect = { left: 0, top: 0, width: size.w, height: size.h };
    const cw = size.w, ch = size.h;
    const sx = rect.width ? cw / rect.width : 1;
    const sy = rect.height ? ch / rect.height : 1;
    const cx = (ev && typeof ev.clientX === 'number') ? ev.clientX : 0;
    const cy = (ev && typeof ev.clientY === 'number') ? ev.clientY : 0;
    return { x: (cx - (rect.left || 0)) * sx, y: (cy - (rect.top || 0)) * sy };
  }

  function ownSlots() {
    const b = boardMod();
    if (!b || typeof b.allSlots !== 'function') return [];
    let list = [];
    try { list = b.allSlots() || []; } catch (e) { list = []; }   // 当前摆阵侧「启用中」的槽位
    return Array.isArray(list) ? list : [];
  }

  // 槽位在画布上的位置（用槽位自带的世界坐标投影）
  function slotScreen(index) {
    const list = ownSlots();
    let entry = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].index === index) { entry = list[i]; break; }
    }
    if (!entry && typeof index === 'number' && list[index]) entry = list[index];   // 兼容按下标传入
    if (!entry || !entry.pos) return null;
    return project(entry.pos[0], entry.pos[1]);
  }

  // 命中测试：返回槽位对象（index 为全局下标）
  function hitEntry(x, y) {
    const list = ownSlots();
    let best = null, bestD = SLOT_HIT_RADIUS * SLOT_HIT_RADIUS;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.pos) continue;
      const p = project(s.pos[0], s.pos[1]);
      if (!p) continue;
      const dx = p.sx - x, dy = p.sy - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = s; }
    }
    return best;
  }

  function hitSlot(x, y) {
    const e = hitEntry(x, y);
    return e ? e.index : -1;
  }

  // 悬停信息：render.js 读取 hover.slotIndex / hover.valid / hover.unitId
  function updateHover(x, y) {
    const entry = hitEntry(x, y);
    if (!entry) {
      state.hoverIndex = null;
      state.hover = null;
      return null;
    }
    const sel = state.dragging || state.selected;
    const carry = sel ? sel.unitId : null;
    const other = entry.unitId && entry.unitId !== carry ? entry.unitId : null;
    state.hoverIndex = entry.index;
    state.hover = {
      slotIndex: entry.index,
      index: entry.index,
      side: entry.side,
      valid: !!carry || !other,                       // 目标槽可落子（空槽，或拖着自己）
      unitId: carry || entry.unitId || null,
      lane: entry.lane,
      occupied: !!entry.unitId,
    };
    return state.hover;
  }

  // ---------- 选中 / 拖拽 ----------
  function selectBench(unitId) {
    if (!unitId) return null;
    if (state.selected && state.selected.unitId === unitId && state.selected.from === 'bench') {
      state.selected = null;
      return null;
    }
    state.selected = { from: 'bench', unitId: unitId, slotIndex: -1 };
    return state.selected;
  }

  function selectSlot(slotIndex) {
    const list = ownSlots();
    let s = null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].index === slotIndex) { s = list[i]; break; }
    if (!s || !s.unitId) return null;
    state.selected = { from: 'slot', unitId: s.unitId, slotIndex: s.index };
    return state.selected;
  }

  function cancelSelection() {
    state.selected = null;
    state.dragging = null;
    return true;
  }

  function placeSelectedAt(slotIndex) {
    const sel = state.selected;
    if (!sel) return false;
    if (!canPlace()) return false;
    const ok = sel.from === 'slot'
      ? dispatch('onMove', sel.slotIndex, slotIndex) : dispatch('onPlace', sel.unitId, slotIndex);
    if (ok && sel.from === 'slot') state.selected = null;
    return ok;
  }

  function removeAt(slotIndex) {
    if (!canPlace()) return false;
    const ok = dispatch('onRemove', slotIndex);
    if (ok) state.selected = null;
    return ok;
  }

  // ---------- 画布上的指针交互 ----------
  function onPointerDown(ev) {
    if (!canPlace()) return;
    const p = canvasPoint(ev);
    state.pointer.x = p.x; state.pointer.y = p.y; state.pointer.inside = true;
    const entry = hitEntry(p.x, p.y);
    if (!entry) return;
    updateHover(p.x, p.y);
    if (entry.unitId) {
      const benchSelection = state.selected && state.selected.from === 'bench' ? state.selected : null;
      state.dragging = { from: 'slot', unitId: entry.unitId, slotIndex: entry.index, moved: false,
        startX: p.x, startY: p.y, benchSelection };
      state.selected = { from: 'slot', unitId: entry.unitId, slotIndex: entry.index };
      updateHover(p.x, p.y);
      return;
    }
    if (state.selected) placeSelectedAt(entry.index);
  }

  function onPointerMove(ev) {
    const p = canvasPoint(ev);
    state.pointer.x = p.x; state.pointer.y = p.y; state.pointer.inside = true;
    if (state.dragging && Math.hypot(p.x - state.dragging.startX, p.y - state.dragging.startY) >= 5) state.dragging.moved = true;
    updateHover(p.x, p.y);
  }

  function onPointerUp(ev) {
    if (!state.dragging) return;
    const drag = state.dragging;
    state.dragging = null;
    if (!drag.moved) {
      if (drag.benchSelection) {
        dispatch('onPlace', drag.benchSelection.unitId, drag.slotIndex);
        state.selected = drag.benchSelection;
      }
      return;
    }
    if (!canPlace()) return;
    if (overBench(ev)) { removeAt(drag.slotIndex); return; }   // 拖回单位池 = 移除
    const p = canvasPoint(ev);
    const entry = hitEntry(p.x, p.y);
    if (!entry) return;
    dispatch('onMove', drag.slotIndex, entry.index);
    state.selected = null;
  }

  function overBench(ev) {
    const bench = (CC.ui && CC.ui.els && CC.ui.els.bench) || byId('bench');
    if (bench && typeof bench.getBoundingClientRect === 'function') {
      let r = null;
      try { r = bench.getBoundingClientRect(); } catch (e) { r = null; }
      if (r && (r.width || r.height)) {
        const cx = (ev && ev.clientX) || 0, cy = (ev && ev.clientY) || 0;
        return cx >= (r.left || 0) && cx <= (r.left || 0) + r.width &&
          cy >= (r.top || 0) && cy <= (r.top || 0) + r.height;
      }
    }
    // 无布局信息时：画布右侧区域视为单位池
    const c = state.canvas;
    if (!c) return false;
    let rect = null;
    try { rect = c.getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect) return false;
    const cx = (ev && ev.clientX) || 0;
    return cx > (rect.left || 0) + (rect.width || 0);
  }

  function byId(id) {
    if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return null;
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  // ---------- 单位池卡片拖拽（HTML5 DnD） ----------
  function benchEl() {
    return (CC.ui && CC.ui.els && CC.ui.els.benchList) || byId('benchList');
  }

  function unitIdFromEvent(ev) {
    const U = CC.ui;
    if (U && typeof U.cardIdFromEvent === 'function') return U.cardIdFromEvent(ev);
    return null;
  }

  function onDragStart(ev) {
    const id = unitIdFromEvent(ev);
    if (!id || !canPlace()) { if (ev && ev.preventDefault) ev.preventDefault(); return; }
    const B = boardMod(); if (B && B.noteActivity) B.noteActivity();
    state.dragging = { from: 'bench', unitId: id, slotIndex: -1, moved: true };
    state.selected = { from: 'bench', unitId: id, slotIndex: -1 };
    if (ev) {
      if (ev.dataTransfer && typeof ev.dataTransfer.setData === 'function') {
        try { ev.dataTransfer.setData('text/plain', id); } catch (e) { /* ignore */ }
      }
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
    }
  }

  function onDragEnd() {
    state.dragging = null;
  }

  function onDrop(ev) {
    const id = (ev && ev.dataTransfer && typeof ev.dataTransfer.getData === 'function')
      ? (ev.dataTransfer.getData('text/plain') || '') : '';
    const unitId = id || (state.dragging && state.dragging.unitId) || (state.selected && state.selected.unitId);
    state.dragging = null;
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (!unitId || !canPlace()) return;
    const p = canvasPoint(ev);
    const entry = hitEntry(p.x, p.y);
    if (!entry) return;
    const selected = state.selected;
    if (selected && selected.from === 'slot') {
      dispatch('onMove', selected.slotIndex, entry.index);
      state.selected = null;
    } else {
      dispatch('onPlace', unitId, entry.index);
      state.selected = null;
    }
  }

  function onBenchDrop(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const drag = state.dragging;
    state.dragging = null;
    if (!drag || drag.from !== 'slot') return;
    removeAt(drag.slotIndex);
  }

  // ---------- 键盘 ----------
  function press(key) {
    const k = String(key || '');
    if (k === ' ' || k === 'Spacebar' || k === 'Space') { dispatch('onPause'); return 'pause'; }
    if (k === 'Escape' || k === 'Esc') { cancelSelection(); return 'cancel'; }
    return null;
  }

  function onKeyDown(ev) {
    if (!ev) return;
    const key = ev.key || '';
    const tag = (ev.target && ev.target.tagName) ? String(ev.target.tagName).toUpperCase() : '';
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return;  // 交给按钮自身的 click，避免双触发
    if (key === ' ' || key === 'Spacebar' || key === 'Space') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      press(' ');
      return;
    }
    if (key === 'Escape' || key === 'Esc') press('Escape');
  }

  // ---------- 初始化 ----------
  function init(canvas, h) {
    handlers = h || null;
    state.canvas = canvas || byId('stage') || null;
    const target = state.canvas;
    if (target && typeof target.addEventListener === 'function') {
      const hasPointer = (typeof target.onpointerdown !== 'undefined') ||
        (typeof window !== 'undefined' && typeof window.PointerEvent === 'function');
      const down = hasPointer ? 'pointerdown' : 'mousedown';
      const move = hasPointer ? 'pointermove' : 'mousemove';
      const up = hasPointer ? 'pointerup' : 'mouseup';
      try {
        target.addEventListener(down, onPointerDown);
        target.addEventListener(move, onPointerMove);
        target.addEventListener(up, onPointerUp);
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener(move, (ev) => { if (state.dragging && ev.target !== target) onPointerMove(ev); });
          document.addEventListener(up, (ev) => { if (state.dragging && ev.target !== target) onPointerUp(ev); });
        }
        if (hasPointer) target.addEventListener('pointerleave', () => { state.hover = null; state.hoverIndex = null; state.pointer.inside = false; });
        else target.addEventListener('mouseleave', () => { state.hover = null; state.hoverIndex = null; state.pointer.inside = false; });
        target.addEventListener('dragover', (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); });
        target.addEventListener('drop', onDrop);
      } catch (e) { /* 忽略：无头环境下无事件系统 */ }
    }
    const pool = benchEl();
    if (pool && typeof pool.addEventListener === 'function') {
      try {
        pool.addEventListener('dragstart', onDragStart);
        pool.addEventListener('dragend', onDragEnd);
      } catch (e) { /* ignore */ }
    }
    const bench = (CC.ui && CC.ui.els && CC.ui.els.bench) || byId('bench');
    if (bench && typeof bench.addEventListener === 'function') {
      try {
        bench.addEventListener('dragover', (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); });
        bench.addEventListener('drop', onBenchDrop);
      } catch (e) { /* ignore */ }
    }
    if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
      try { document.addEventListener('keydown', onKeyDown); } catch (e) { /* ignore */ }
    } else if (typeof globalThis.addEventListener === 'function') {
      try { globalThis.addEventListener('keydown', onKeyDown); } catch (e) { /* ignore */ }
    }
    state.bound = true;
    return CC.input;
  }

  CC.input = {
    init, state, press, cancelSelection,
    selectBench, selectSlot, placeSelectedAt, removeAt,
    hitSlot, hitEntry, slotScreen, project, overBench,
    dispatch,
    handlers: (h) => { if (h) handlers = h; return handlerTable(); },
  };
})();
