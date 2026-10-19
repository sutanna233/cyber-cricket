/* ===========================================================
   赛博斗蛐蛐 · 摆阵盘（board）—— 上帝视角，两侧都能摆，每侧人数 1~6 可配
   每侧最多 6 槽 = 3 列 × 2 排
     lane0 = 前排（row0，更靠中线）
     lane1 = 后排（row1）
   槽位编号（全局唯一）：A 侧 0..5，B 侧 6..11
     侧内下标 = 全局下标 % 6     → 0,1,2 前排 / 3,4,5 后排
   启用规则：某侧人数 = N 时只启用侧内下标 0..N-1（前排优先，稳定可预期）
   世界平面 1200×700，擂台中心 (600,350)：A 在左半场，B 在右半场
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});

  const COLS = 3;
  const ROWS = 2;
  const SLOT_COUNT = COLS * ROWS;          // 每侧最多 6 槽
  const MIN_SIZE = 1;
  const MAX_SIZE = SLOT_COUNT;
  const AUTO_START_SECONDS = 5;
  const SIDES = ['A', 'B'];
  const WORLD = { W: 1200, D: 700 };

  // frontX / backX = 前排 / 后排距中心的纵深距离（两侧镜像）
  //   A 前排 = 600-400 = 200，A 后排 = 600-480 = 120
  //   B 前排 = 600+400 = 1000，B 后排 = 600+480 = 1080   → 两侧前排相距 800
  const LAYOUT = {
    centerX: 600,
    centerZ: 350,
    zSpread: 150,  // 列间距（z：200 / 350 / 500）
    frontX: 400,
    backX: 480,
  };

  let poolIds = [];
  let side = { A: [], B: [] };
  let sizes = { A: MAX_SIZE, B: MAX_SIZE };
  let active = 'A';
  let autoStart = AUTO_START_SECONDS;
  let armed = false;
  let fullArmed = false;   // 允许“摆满立即开打”：进入摆阵先给 5 秒缓冲，任何摆阵动作后解锁
  let fillCount = 0;
  let lastChange = { side: 'A', size: MAX_SIZE, returned: [] };

  // ---------- 低依赖小工具 ----------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function number(v, d) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : d;
  }
  function sizeOf(n) {
    const v = typeof n === 'number' ? n : parseFloat(n);
    if (!isFinite(v)) return MIN_SIZE;                 // NaN / 乱码 → 最小
    return clamp(Math.round(v), MIN_SIZE, MAX_SIZE);
  }
  function hashParts(arr) {
    const U = CC.util;
    if (U && typeof U.hashParts === 'function') {
      try { return U.hashParts(arr); } catch (e) { /* fallthrough */ }
    }
    let h = 2166136261 >>> 0;
    const s = arr.join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rngFrom(seed) {
    const U = CC.util;
    if (U && typeof U.RNG === 'function') {
      try { return U.RNG(seed); } catch (e) { /* fallthrough */ }
    }
    let a = (typeof seed === 'number' ? seed : hashParts([String(seed)])) >>> 0;
    if (a === 0) a = 0x9e3779b9;
    const r = {
      seed: a,
      next() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int(lo, hi) { return Math.floor(lo + r.next() * (hi - lo + 1)); },
    };
    return r;
  }

  // ---------- 侧与下标 ----------
  function normSide(s) {
    const v = String(s == null ? '' : s).toUpperCase();
    return SIDES.indexOf(v) >= 0 ? v : active;
  }
  function sideOfIndex(index) { return number(index, -1) >= SLOT_COUNT ? 'B' : 'A'; }
  function toGlobal(s, i) { return normSide(s) === 'B' ? (i + SLOT_COUNT) : i; }
  function toLocal(index) {
    const i = number(index, -1);
    if (i < 0) return -1;
    return i >= SLOT_COUNT ? (i - SLOT_COUNT) : i;
  }
  function arr(s) { return side[normSide(s)]; }
  function size(s) { return sizes[normSide(s)]; }
  function enabled(s) { return arr(s).filter((x) => x.slot < sizes[normSide(s)]); }

  function slotPos(index, s) {
    const i = clamp(toLocal(index), 0, SLOT_COUNT - 1);
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const z = LAYOUT.centerZ + (col - (COLS - 1) / 2) * LAYOUT.zSpread;
    const depth = row === 0 ? LAYOUT.frontX : LAYOUT.backX;
    const x = (normSide(s) === 'B') ? (LAYOUT.centerX + depth) : (LAYOUT.centerX - depth);
    return [x, z];
  }

  // 镜像 = 以擂台中心 x 轴对称
  function mirror(pos) {
    const p = Array.isArray(pos) ? pos : [LAYOUT.centerX, LAYOUT.centerZ];
    return [2 * LAYOUT.centerX - number(p[0], LAYOUT.centerX), number(p[1], LAYOUT.centerZ)];
  }

  function buildSide(s) {
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      out.push({
        index: toGlobal(s, i),
        slot: i,
        side: s,
        col: col,
        row: row,
        lane: row,
        pos: slotPos(i, s),
        unitId: null,
      });
    }
    return out;
  }

  function rebuild() {
    side = { A: buildSide('A'), B: buildSide('B') };
  }

  // ---------- 初始化 ----------
  function init(ids) {
    const list = Array.isArray(ids) ? ids.filter((x) => !!x) : [];
    poolIds = list.slice();
    rebuild();
    sizes = { A: MAX_SIZE, B: MAX_SIZE };
    active = 'A';
    autoStart = AUTO_START_SECONDS;
    armed = true;
    fullArmed = false;
    fillCount = 0;
    lastChange = { side: 'A', size: MAX_SIZE, returned: [] };
    return slotsView('A');
  }

  function slotsView(s) {
    return enabled(s).map((x) => ({
      index: x.index, slot: x.slot, side: x.side, col: x.col, row: x.row, lane: x.lane,
      pos: [x.pos[0], x.pos[1]], unitId: x.unitId,
    }));
  }

  // 两侧启用中的槽位（渲染层用；index 全局唯一，hover 高亮不会串侧）
  function allSlots() { return slotsView('A').concat(slotsView('B')); }

  function slotOf(unitId, s) {
    const list = arr(s);
    for (let i = 0; i < list.length; i++) if (list[i].unitId === unitId) return list[i].index;
    return -1;
  }

  // ---------- 单位池（每侧独立可用池） ----------
  function sidePlacedIds(s) {
    return arr(s).map((x) => x.unitId).filter((x) => !!x);
  }
  function benchIds(s) {
    return poolIds.slice();
  }

  // ---------- 每侧上场人数 ----------
  // setSize(side, n)：clamp 到 1..6；超出新上限的已放置单位退回池
  function setSize(s, n) {
    const sd = normSide(s);
    const next = sizeOf(n);
    sizes[sd] = next;
    const returned = [];
    arr(sd).forEach((x) => {
      if (x.unitId && x.slot >= next) {
        returned.push(x.unitId);
        x.unitId = null;
      }
    });
    lastChange = { side: sd, size: next, returned: returned };
    noteActivity();
    return next;
  }

  function lastSizeChange() { return lastChange; }

  // ---------- 摆放 / 撤下 ----------
  function place(unitId, index, s) {
    if (!unitId) return false;
    const i = number(index, -1);
    if (i < 0 || i >= SLOT_COUNT * 2) return false;
    const sd = (s === undefined || s === null) ? sideOfIndex(i) : normSide(s);
    if (poolIds.indexOf(unitId) < 0) return false;
    const target = arr(sd)[toLocal(i)];
    if (!target) return false;
    if (target.slot >= sizes[sd]) return false;                  // 该槽未启用
    if (target.unitId === unitId) return true;                   // 幂等
    target.unitId = unitId;
    noteActivity();
    return true;
  }

  function remove(index, s) {
    const i = number(index, -1);
    if (i < 0 || i >= SLOT_COUNT * 2) return null;
    const sd = (s === undefined || s === null) ? sideOfIndex(i) : normSide(s);
    const target = arr(sd)[toLocal(i)];
    if (!target || !target.unitId) return null;
    const id = target.unitId;
    target.unitId = null;
    noteActivity();
    return id;
  }

  // 无参 = 两侧清空（人数保持）；带 side = 只清一侧
  function move(from, to) {
    const source = allSlots().find((x) => x.index === from);
    const target = allSlots().find((x) => x.index === to);
    if (!source || !target || !source.unitId) return false;
    const a = arr(source.side)[source.slot], b = arr(target.side)[target.slot];
    const id = a.unitId; a.unitId = b.unitId; b.unitId = id;
    noteActivity();
    return true;
  }

  function clear(s) {
    const list = (s === undefined || s === null) ? SIDES.slice() : [normSide(s)];
    list.forEach((sd) => arr(sd).forEach((x) => { x.unitId = null; }));
    if (!s) {
      fillCount = 0;
      armed = true;
      fullArmed = false;
      autoStart = AUTO_START_SECONDS;
    }
    return true;
  }

  // 把某一侧补满到它的人数上限（池内随机，可种子）
  // 兼容旧签名：autoFill(seed[, side]) 与 新签名：autoFill(side[, seed])
  function autoFill(a, b) {
    let s = null, seed = null;
    if (typeof a === 'string') { s = a; seed = (typeof b === 'number') ? b : null; }
    else { seed = (typeof a === 'number') ? a : null; s = (b === undefined || b === null) ? active : b; }
    const sd = normSide(s);
    const list = enabled(sd);
    const free = list.filter((x) => !x.unitId).map((x) => x.index);
    if (!free.length) return 0;
    const avail = benchIds(sd);
    if (!avail.length) return 0;
    const sv = (seed === null)
      ? hashParts(['board-autofill', sd, sizes[sd], fillCount, poolIds.join(','), free.join(',')])
      : seed;
    const rng = rngFrom(sv >>> 0);
    for (let i = avail.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = avail[i]; avail[i] = avail[j]; avail[j] = t;
    }
    let n = 0;
    for (let k = 0; k < free.length; k++) {
      arr(sd)[toLocal(free[k])].unitId = avail[k % avail.length];
      n++;
    }
    fillCount++;
    return n;
  }

  // 空着的一侧按各自人数自动随机满编（两侧都兜底）
  function autoFillEmpty(seed) {
    const out = { A: 0, B: 0 };
    SIDES.forEach((sd, k) => {
      if (filledCount(sd) > 0) return;
      const sv = (seed === undefined || seed === null) ? null : ((seed + k * 7919) >>> 0);
      out[sd] = autoFill(sd, sv);
    });
    return out;
  }

  // 外部阵容（[{id,slot}]，slot 为侧内下标）落到某一侧，最多到该侧人数上限
  function applySquad(squad, s) {
    const sd = normSide(s);
    const list = Array.isArray(squad) ? squad : [];
    let n = 0;
    list.forEach((e) => {
      if (!e || !e.id) return;
      if (n >= sizes[sd]) return;
      if (poolIds.indexOf(e.id) < 0) return;
      const local = clamp(number(e.slot, 0), 0, sizes[sd] - 1);
      let target = arr(sd)[local];
      if (!target || target.slot >= sizes[sd] || target.unitId) {
        target = enabled(sd).find((x) => !x.unitId) || null;
      }
      if (!target || target.unitId) return;
      target.unitId = e.id;
      n++;
    });
    return n;
  }

  function filledCount(s) { return enabled(s).filter((x) => !!x.unitId).length; }
  function isFull(s) { return filledCount(s) >= sizes[normSide(s)] && sizes[normSide(s)] > 0; }
  function isFullAll() { return isFull('A') && isFull('B'); }
  function countAll() { return { A: filledCount('A'), B: filledCount('B') }; }

  // ---------- 自动开打倒计时 ----------
  // 任何玩家动作 → 重置 5 秒并解锁“摆满立即开打”
  function noteActivity() {
    autoStart = AUTO_START_SECONDS;
    armed = true;
    fullArmed = false;   // 替换满编阵容后也保留5秒调整时间
    return autoStart;
  }

  function tick(dt) {
    if (!armed) return autoStart;
    if (isFull(active) && fullArmed) { autoStart = 0; return autoStart; }
    const d = Math.max(0, number(dt, 0));
    autoStart = Math.max(0, autoStart - d);
    return autoStart;
  }

  function autoStartIn() {
    if (isFull(active) && fullArmed) return 0;
    return armed ? Math.max(0, autoStart) : 0;
  }

  function shouldStart() {
    if (isFull(active) && fullArmed) return true;
    return armed && autoStart <= 0;
  }

  // 进入摆阵：给 5 秒缓冲（即使当前一侧已满也不立刻开打），任何摆阵动作后解锁
  function setAutoStart(seconds) {
    autoStart = Math.max(0, number(seconds, AUTO_START_SECONDS));
    armed = true;
    fullArmed = false;
    return autoStart;
  }

  function disarm() { armed = false; fullArmed = false; autoStart = AUTO_START_SECONDS; }

  // ---------- 当前操作侧 ----------
  function activeSide() { return active; }
  function setActiveSide(s) { active = normSide(s); return active; }

  // ---------- 输出阵容 ----------
  function sideLineup(s) {
    const sd = normSide(s);
    const out = [];
    enabled(sd).forEach((x) => {
      if (x.unitId) out.push({ id: x.unitId, slot: x.index, lane: x.lane, col: x.col, pos: [x.pos[0], x.pos[1]] });
    });
    return out;
  }
  function lineup() { return { A: sideLineup('A'), B: sideLineup('B') }; }

  // 外部 [{id,slot}] → B 侧（slot 为侧内下标）带镜像坐标
  function enemyLineup(squad) {
    const list = Array.isArray(squad) ? squad : [];
    const out = [];
    list.forEach((e) => {
      if (!e || !e.id) return;
      const local = clamp(number(e.slot, 0), 0, MAX_SIZE - 1);
      out.push({ id: e.id, slot: toGlobal('B', local), pos: slotPos(local, 'B') });
    });
    out.sort((a, b) => a.slot - b.slot);
    return out;
  }

  // ---------- 存档 ----------
  function rawSlots(s) {
    if (s === undefined || s === null) {
      return { A: arr('A').map((x) => x.unitId).slice(0, sizes.A), B: arr('B').map((x) => x.unitId).slice(0, sizes.B) };
    }
    return enabled(s).map((x) => x.unitId);
  }

  function sizes_() { return { A: sizes.A, B: sizes.B }; }

  function applySideList(list, s) {
    const sd = normSide(s);
    let n = 0;
    if (!Array.isArray(list)) return 0;
    for (let i = 0; i < sizes[sd]; i++) {
      const id = list[i];
      if (!id || poolIds.indexOf(id) < 0) continue;
      arr(sd)[i].unitId = id;
      n++;
    }
    return n;
  }

  // data 支持 {size:{A,B}, lineup:{A:[],B:[]}}、{A:[],B:[]} 与旧格式 [](只填 A)
  function applyRawSlots(data, s) {
    clear();
    if (s !== undefined && s !== null) return applySideList(data, s);
    if (Array.isArray(data)) return applySideList(data, 'A');
    if (data && typeof data === 'object') {
      if (data.size) {
        sizes.A = sizeOf(data.size.A);
        sizes.B = sizeOf(data.size.B);
      }
      const lu = data.lineup || data;
      return applySideList(lu.A, 'A') + applySideList(lu.B, 'B');
    }
    return 0;
  }

  CC.board = {
    COLS, ROWS, SLOT_COUNT, MIN_SIZE, MAX_SIZE, AUTO_START_SECONDS, SIDES, LAYOUT, WORLD,
    init,
    slots: slotsView, allSlots, slotsRaw: (s) => arr(s),
    slotPos, mirror, slotOf, sideOfIndex, toGlobal, toLocal,
    setSize, size, sizes: sizes_, lastSizeChange,
    place, remove, move, clear, autoFill, autoFillEmpty, applySquad,
    isFull, isFullAll, filledCount, countAll, isFullArmed: () => fullArmed,
    activeSide, setActiveSide,
    noteActivity, tick, autoStartIn, shouldStart, setAutoStart, disarm,
    lineup, sideLineup, enemyLineup,
    benchIds, poolIds: () => poolIds.slice(),
    rawSlots, applyRawSlots,
  };
})();
