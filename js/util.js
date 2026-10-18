/* ===========================================================
   赛博斗蛐蛐 · 放置 ARPG —— 基础工具层
   全部挂在全局命名空间 CC 下，浏览器与 Node 无头测试通用
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});

  // ---------- 数值 ----------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function approach(cur, target, delta) {
    if (cur < target) return Math.min(cur + delta, target);
    if (cur > target) return Math.max(cur - delta, target);
    return target;
  }
  function sign(v) { return v < 0 ? -1 : v > 0 ? 1 : 0; }
  function round2(v) { return Math.round(v * 100) / 100; }

  // ---------- 可种子随机（mulberry32） ----------
  function seedFrom(str) {
    let h = 2166136261 >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function RNG(seed) {
    let a = (typeof seed === 'number' ? seed : seedFrom(seed)) >>> 0;
    if (a === 0) a = 0x9e3779b9;
    const self = {
      seed: a,
      next() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      range(lo, hi) { return lo + self.next() * (hi - lo); },
      int(lo, hi) { return Math.floor(lo + self.next() * (hi - lo + 1)); },
      pick(arr) { return arr[Math.floor(self.next() * arr.length)]; },
      chance(p) { return self.next() < p; },
      sign() { return self.next() < 0.5 ? -1 : 1; },
      // 快照 / 还原（回放与快进一致性用）
      snapshot() { return a >>> 0; },
      restore(v) { a = v >>> 0; },
    };
    return self;
  }

  // ---------- 状态哈希（确定性校验用） ----------
  function fnv1a(str, h) {
    let x = (h === undefined ? 2166136261 : h) >>> 0;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
    return x >>> 0;
  }
  function hashParts(parts) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < parts.length; i++) h = fnv1a(String(parts[i]), h);
    return h >>> 0;
  }
  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  // ---------- 几何 ----------
  function dist2(ax, az, bx, bz) {
    const dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }
  function dist(ax, az, bx, bz) { return Math.sqrt(dist2(ax, az, bx, bz)); }

  // 角度差（度，归一化到 -180..180）
  function angleDelta(a, b) {
    let d = (a - b) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  // ---------- 简易缓动 ----------
  const ease = {
    outQuad: (t) => 1 - (1 - t) * (1 - t),
    inQuad: (t) => t * t,
    outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
    outElastic: (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
  };

  // ---------- 时间格式 ----------
  function mmss(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  CC.util = {
    clamp, lerp, approach, sign, round2,
    RNG, seedFrom,
    fnv1a, hashParts, hex8,
    dist, dist2, angleDelta,
    ease, mmss,
  };
})();
