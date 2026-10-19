/* ===========================================================
   赛博斗蛐蛐 · 阵容生成与对局等级（waves）
   契约：CC.waves.enemySquad({count,difficulty,seed,exclude}) -> [{id,slot}]
        CC.waves.nextDifficulty(level) -> number
   上帝视角下不分你我：enemySquad 只是「给某一侧生成一套阵容」，
   难度 = 中立的对局等级（每场缓慢提升，纯观赏节奏），与任何一方的胜负无关。
   随机全部走 CC.util.RNG（可种子），禁止 Math.random
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});

  const MAX_SLOTS = 6;

  // ---------- 本地小工具（util 未就绪时兜底，不抛错） ----------
  function number(v, d) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : d;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function round2(v) { return Math.round(v * 100) / 100; }

  function hashParts(arr) {
    const U = CC.util;
    if (U && typeof U.hashParts === 'function') {
      try { return U.hashParts(arr); } catch (e) { /* fallthrough */ }
    }
    let h = 2166136261 >>> 0;
    const s = arr.join('|');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function rngFrom(seed) {
    const U = CC.util;
    if (U && typeof U.RNG === 'function') {
      try { return U.RNG(seed); } catch (e) { /* fallthrough */ }
    }
    // 极小兜底 mulberry32（与 util 同族，保证无 Math.random）
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
      range(lo, hi) { return lo + r.next() * (hi - lo); },
      int(lo, hi) { return Math.floor(lo + r.next() * (hi - lo + 1)); },
      pick(arr) { return arr[Math.floor(r.next() * arr.length)]; },
      chance(p) { return r.next() < p; },
      sign() { return r.next() < 0.5 ? -1 : 1; },
    };
    return r;
  }

  function fighters() { return CC.fighters || null; }
  function getUnit(id) {
    const F = fighters();
    return F && typeof F.get === 'function' ? F.get(id) : null;
  }

  // 战力评分（用于难度窗口）
  function power(u) {
    const s = (u && u.stats) || {};
    return number(s.hp, 0) * 0.5 + number(s.atk, 0) * 4 + number(s.def, 0) * 2 +
      number(s.crit, 0) * 300 + number(s.spd, 0) * 0.2;
  }

  function normalizeList(v) {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }

  function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ---------- 槽位分配：前排(lane0: 0,1,2) / 后排(lane1: 3,4,5) ----------
  function assignSlots(picks, rng) {
    const front = [], back = [];
    picks.forEach((id) => {
      const u = getUnit(id);
      if (u && u.pos === 'back') back.push(id); else front.push(id);
    });
    const out = [];
    const lanes = [{ ids: front, slots: [0, 1, 2] }, { ids: back, slots: [3, 4, 5] }];
    lanes.forEach((lane) => {
      const slots = shuffleInPlace(lane.slots.slice(), rng);
      lane.ids.forEach((id, i) => {
        if (i < slots.length) out.push({ id: id, slot: slots[i] });
      });
    });
    // 某一排超过 3 个时，溢出的丢到剩余空槽
    const used = out.map((e) => e.slot);
    const free = [0, 1, 2, 3, 4, 5].filter((s) => used.indexOf(s) < 0);
    picks.forEach((id) => {
      const placed = out.some((e) => e.id === id);
      if (!placed) {
        const s = free.shift();
        if (s !== undefined) out.push({ id: id, slot: s });
      }
    });
    out.sort((a, b) => a.slot - b.slot);
    return out;
  }

  // ---------- 敌波 ----------
  function enemySquad(opts) {
    const o = opts || {};
    const count = Math.floor(clamp(number(o.count, MAX_SLOTS), 1, MAX_SLOTS));
    const difficulty = Math.max(1, number(o.difficulty, 1));
    const exclude = normalizeList(o.exclude).map(String);

    const F = fighters();
    let pool = [];
    if (F && typeof F.playable === 'function') pool = F.playable();
    else if (F && typeof F.all === 'function') pool = F.all();
    if (!Array.isArray(pool)) pool = [];
    pool = pool.filter((u) => u && u.id && exclude.indexOf(u.id) < 0);
    if (!pool.length) return [];

    const visible = pool.filter((u) => !u.hidden);
    const usable = visible.length ? visible : pool;
    const sorted = usable.slice().sort((a, b) => power(a) - power(b));
    const len = sorted.length;
    const bias = clamp((difficulty - 1) / 6, 0, 1);
    // 窗口从“最弱 count 只”平滑滑到“最强一段”：难度越高，窗口越靠上
    const w = Math.max(Math.min(count, len), Math.round(len * (0.4 + 0.3 * bias)));
    const start = Math.round((len - w) * bias);
    const windowUnits = sorted.slice(start, start + w);

    const seed = number(o.seed,
      hashParts(['waves', count, round2(difficulty), exclude.join(',')]));
    const rng = rngFrom(seed >>> 0);

    const bag = shuffleInPlace(windowUnits.slice(), rng);
    const picks = bag.slice(0, Math.min(count, bag.length)).map((u) => u.id);

    return assignSlots(picks, rng);
  }

  // ---------- 对局等级曲线（中立、缓慢提升） ----------
  function nextDifficulty(level) {
    const n = Math.max(0, Math.floor(number(level, 0)));
    const d = 1 + 0.14 * n + 0.01 * n * n;
    return round2(clamp(d, 1, 8));
  }

  CC.waves = {
    enemySquad,
    squad: enemySquad,          // 中立别名
    nextDifficulty,
    levelFor: nextDifficulty,   // 中立别名：第 n 场的对局等级
    power,
    MAX_SLOTS,
    rngFrom,
  };
})();
