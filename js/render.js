/* ===========================================================
   赛博斗蛐蛐 · 放置 ARPG —— 渲染层
   CC.render.init(canvas) / CC.render.draw(match, view) / CC.render.hitstop()

   数据来源只有：match.battle.state（实体数组）+ match.battle.events（本 tick 事件）+ view
   表现：背景贴图 / 影子 / 贴图单位 / 斩击弧 / 命中火花 / 爆炸 / AOE 预警圈 /
        伤害飘字（普通·暴击分级）/ 连击数 / Boss 分段血条 / 震屏 / 命中停顿 /
        赛博故障位移 / 暂停遮罩 / 必杀全屏特写 / 报分卡
   绝不抛错：任何贴图、字段缺失都降级为矢量兜底。
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util || {};
  const clamp = U.clamp || function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
  const lerp = U.lerp || function (a, b, t) { return a + (b - a) * t; };
  const ease = U.ease || { outQuad: function (t) { return 1 - (1 - t) * (1 - t); } };
  const mmss = U.mmss || function (s) { return String(Math.max(0, Math.floor(s))); };

  const W = 960, H = 600;
  const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif';
  const MONO = 'ui-monospace,Consolas,"Courier New",monospace';

  const C = {
    a: '#7fe3ff', aDark: '#0d2734', b: '#ff56d6', bDark: '#2a0d22',
    ink: '#e9f6ff', dim: 'rgba(233,246,255,0.66)',
    crit: '#ffd166', critHot: '#ff6b3d', heal: '#8affc1', warn: '#ff56d6', gold: '#ffe066',
    panel: 'rgba(8,13,26,0.72)', panelEdge: 'rgba(127,227,255,0.45)',
  };

  // ---------------------------------------------------------------- 状态
  const R = {
    canvas: null, ctx: null, buf: null, bufCtx: null, bufOK: false,
    frame: 0, t: 0, simT: 0, lastSimT: 0, dt: 1 / 60,
    shake: { amp: 0, t: 0, dur: 1, x: 0, y: 0 },
    hitstopT: 0, glitchT: 0, glitchAmp: 0,
    parts: [], texts: [], banners: [], callouts: [], by: {},
    delayed: [],
    minionsByOwner: {},
    zoneSeen: {}, combo: {}, comboPeak: {}, maxCombo: 0,
    ult: { id: null, t: 0, dur: 0, name: '', caster: null },
    charging: {},
    reportT: 0, phase: 'fighting',
    rng: U.RNG ? U.RNG(0xC0FFEE) : null,
    counts: { drawImage: 0, fillRect: 0, fillText: 0, ops: 0 },
    lastBy: {}, kills: 0, hits: 0, crits: 0, maxParts: 0,
    paused: false,
  };

  const MAX_PARTS = 340;
  const MAX_TEXTS = 80;

  function rnd() {
    if (R.rng) return R.rng.next();
    return 0.5;
  }
  function rr(a, b) { return a + (b - a) * rnd(); }
  // 世界长度 → 屏幕长度（给雨区等半径换算用）
  function scaleSF(w) {
    const Sp = CC.sprites;
    return Sp && Sp.scaleX ? Math.max(Sp.scaleX(w), Sp.scaleZ(w)) : w;
  }

  // ---------------------------------------------------------------- 初始化
  function wrapCounter(ctx) {
    if (!ctx) return;
    try {
      if (ctx.drawImage && !ctx.__ccWrapped) {
        const orig = ctx.drawImage;
        ctx.drawImage = function () {
          R.counts.drawImage++; R.counts.ops++;
          try { return orig.apply(ctx, arguments); } catch (e) { return null; }
        };
        ctx.__ccWrapped = true;
      }
      ['fillRect', 'fillText', 'stroke', 'fill'].forEach(function (m) {
        if (ctx[m] && !ctx['__cc_' + m]) {
          const o = ctx[m];
          ctx[m] = function () {
            R.counts[m] = (R.counts[m] || 0) + 1; R.counts.ops++;
            try { return o.apply(ctx, arguments); } catch (e) { return null; }
          };
          ctx['__cc_' + m] = true;
        }
      });
    } catch (e) { /* 打桩 ctx 不可改也无所谓 */ }
  }

  function createCanvas(w, h) {
    try {
      if (typeof document !== 'undefined' && document.createElement) {
        const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
      }
      if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    } catch (e) { /* 降级 */ }
    return null;
  }

  function init(canvas) {
    R.canvas = canvas || null;
    R.ctx = null;
    try {
      if (canvas && canvas.getContext) R.ctx = canvas.getContext('2d');
    } catch (e) { R.ctx = null; }
    wrapCounter(R.ctx);
    // 离屏缓冲（赛博故障位移用）；没有也能跑
    R.buf = null; R.bufCtx = null; R.bufOK = false;
    try {
      const b = createCanvas(W, H);
      if (b && b.getContext) {
        const bc = b.getContext('2d');
        if (bc) { R.buf = b; R.bufCtx = bc; R.bufOK = true; wrapCounter(bc); }
      }
    } catch (e) { R.bufOK = false; }
    if (CC.sprites && CC.sprites.centerCamera) CC.sprites.centerCamera();
    return CC.render;
  }

  function ensureCtx(canvas) {
    if (!R.ctx) init(canvas || R.canvas);
    return R.ctx;
  }

  // ---------------------------------------------------------------- 特效/飘字
  function pushPart(p) {
    if (!p) return;
    if (R.parts.length >= MAX_PARTS) R.parts.shift();
    R.parts.push(p);
    if (R.parts.length > R.maxParts) R.maxParts = R.parts.length;
  }

  function spawn(kind, x, z, h, opt) {
    const o = opt || {};
    const life = o.life === undefined ? 0.4 : o.life;
    pushPart({
      kind: kind, x: x, z: z, h: h || 0, t: 0, life: life,
      size: o.size === undefined ? 40 : o.size,
      grow: o.grow === undefined ? 0.35 : o.grow,
      rot: o.rot === undefined ? rr(-0.5, 0.5) : o.rot,
      spin: o.spin === undefined ? rr(-3, 3) : o.spin,
      vx: o.vx || 0, vz: o.vz || 0, vh: o.vh || 0,
      alpha: o.alpha === undefined ? 1 : o.alpha,
      blend: o.blend === undefined ? 'lighter' : o.blend,
      layer: o.layer || 'air',
      color: o.color || null,
      sprite: o.sprite || kind,
      mirror: !!o.mirror,
      delay: o.delay || 0,
      // link / 连线类用
      tx: o.tx, tz: o.tz, th: o.th, to: o.to, width: o.width, curve: o.curve,
      seed: o.seed,
    });
  }

  // 延迟动作队列（例如石头落地那一刻才震屏/发声）
  function later(sec, fn) {
    if (typeof fn !== 'function') return;
    R.delayed.push({ at: R.t + Math.max(0, sec || 0), fn: fn });
    if (R.delayed.length > 40) R.delayed.shift();
  }

  // 技能名「喊话」：贴着施法者画小气泡（不占 HUD 位置，避免和最高连击混淆）
  function callout(x, z, h, str, color) {
    if (R.callouts.length > 6) R.callouts.shift();
    R.callouts.push({ x: x, z: z, h: h || 0, s: String(str), t: 0, life: 0.95, color: color || C.ink });
  }

  function floatText(x, z, h, str, opt) {
    const o = opt || {};
    if (R.texts.length >= MAX_TEXTS) R.texts.shift();
    // 同一位置短时间内的重复飘字合并（避免糊成一团）
    for (let i = R.texts.length - 1; i >= 0; i--) {
      const f = R.texts[i];
      if (f.t > 0.18) continue;
      const dx = f.x - x, dz = f.z - z;
      if (dx * dx + dz * dz < 625 && f.s === String(str)) return;
    }
    R.texts.push({
      x: x, z: z, h: h || 0, s: String(str), t: 0,
      life: o.life === undefined ? 0.6 : o.life,
      vy: o.vy === undefined ? 32 : o.vy,
      crit: !!o.crit, color: o.color || null, size: o.size || 0,
      vx: o.vx === undefined ? rr(-26, 26) : o.vx,
      dx: rr(-10, 10),
    });
  }

  function addShake(amp, dur) {
    R.shake.amp = Math.max(R.shake.amp, amp || 0);
    R.shake.dur = Math.max(0.05, dur || 0.15);
    R.shake.t = R.shake.dur;
  }
  function addHitstop(sec) {
    R.hitstopT = Math.max(R.hitstopT, clamp(sec === undefined ? 0.07 : sec, 0.06, 0.09));
  }
  function addGlitch(amp) {
    R.glitchAmp = Math.max(R.glitchAmp, amp || 0.6);
    R.glitchT = Math.max(R.glitchT, 0.16);
  }
  function announce(str, color) {
    // 同一招短时间不重复播报，最多两条并存
    for (let i = 0; i < R.banners.length; i++) {
      if (R.banners[i].s === str && R.banners[i].t < 0.35) return;
    }
    R.banners.push({ s: str, t: 0, life: 1.1, color: color || C.ink });
    if (R.banners.length > 2) R.banners.shift();
  }

  function updateTimers(realDt, animDt) {
    if (R.hitstopT > 0) R.hitstopT = Math.max(0, R.hitstopT - realDt);
    if (R.glitchT > 0) {
      R.glitchT = Math.max(0, R.glitchT - realDt);
      if (R.glitchT === 0) R.glitchAmp = 0;
    }
    if (R.shake.t > 0) {
      R.shake.t = Math.max(0, R.shake.t - realDt);
      const k = R.shake.dur > 0 ? R.shake.t / R.shake.dur : 0;
      const amp = R.shake.amp * k * k;
      R.shake.x = rr(-amp, amp);
      R.shake.y = rr(-amp * 0.7, amp * 0.7);
      if (CC.sprites && CC.sprites.setShake) CC.sprites.setShake(R.shake.x, R.shake.y);
      if (R.shake.t === 0) {
        R.shake.amp = 0;
        if (CC.sprites && CC.sprites.setShake) CC.sprites.setShake(0, 0);
      }
    }
    if (R.ult.t > 0) R.ult.t = Math.max(0, R.ult.t - realDt);

    const dt = animDt;
    // 粒子 / 飘字
    for (let i = R.parts.length - 1; i >= 0; i--) {
      const p = R.parts[i];
      p.t += dt;
      p.x += p.vx * dt; p.z += p.vz * dt; p.h += p.vh * dt;
      p.vh -= 60 * dt;
      if (p.h < 0) { p.h = 0; p.vh = 0; }
      p.rot += p.spin * dt;
      if (p.t >= p.life) R.parts.splice(i, 1);
    }
    for (let i = R.texts.length - 1; i >= 0; i--) {
      const f = R.texts[i];
      f.t += dt;
      f.h += f.vy * dt;
      f.x += f.vx * dt;
      f.vx *= (1 - 2.2 * dt);
      f.vy -= 34 * dt;
      if (f.t >= f.life) R.texts.splice(i, 1);
    }
    for (let i = R.banners.length - 1; i >= 0; i--) {
      R.banners[i].t += dt;
      if (R.banners[i].t >= R.banners[i].life) R.banners.splice(i, 1);
    }
    for (let i = R.callouts.length - 1; i >= 0; i--) {
      const c = R.callouts[i];
      c.t += dt;
      c.h += 14 * dt;
      if (c.t >= c.life) R.callouts.splice(i, 1);
    }
    // 延迟动作
    if (R.delayed.length) {
      for (let i = R.delayed.length - 1; i >= 0; i--) {
        if (R.t >= R.delayed[i].at) {
          const fn = R.delayed[i].fn;
          R.delayed.splice(i, 1);
          try { fn(); } catch (e) { /* 表现层回调不许炸 */ }
        }
      }
    }
  }

  // ---------------------------------------------------------------- 事件消费
  function indexEntities(st) {
    const by = {};
    if (!st) return by;
    const groups = [st.A, st.B, st.minions, st.projectiles, st.zones];
    for (let g = 0; g < groups.length; g++) {
      const arr = groups[g];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (e && e.id !== undefined) by[e.id] = e;
      }
    }
    return by;
  }

  function posOf(ev, by) {
    if (!ev) return { x: 600, z: 350, h: 0 };
    let x = ev.x, z = ev.z, h = ev.h;
    if ((x === undefined || z === undefined) && ev.unitId !== undefined && by[ev.unitId]) {
      const e = by[ev.unitId];
      if (x === undefined) x = e.x;
      if (z === undefined) z = e.z;
      if (h === undefined) h = e.h;
    }
    if ((x === undefined || z === undefined) && ev.targetId !== undefined && by[ev.targetId]) {
      const e = by[ev.targetId];
      if (x === undefined) x = e.x;
      if (z === undefined) z = e.z;
      if (h === undefined) h = e.h;
    }
    return {
      x: typeof x === 'number' ? x : 600,
      z: typeof z === 'number' ? z : 350,
      h: typeof h === 'number' ? h : 0,
    };
  }

  // 引擎事件里的 unitId 是「实体 id」，unit 类型 id 在 of / ent.unitId 上；
  // 测试 fixture 可能直接给类型 id —— 两种都兼容。
  function entOf(ev, by) {
    if (!ev) return null;
    if (by && ev.unitId !== undefined && by[ev.unitId]) return by[ev.unitId];
    if (by && ev.targetId !== undefined && by[ev.targetId]) return by[ev.targetId];
    return null;
  }
  function typeIdOf(ev, by) {
    if (!ev) return null;
    const e = by && ev.unitId !== undefined ? by[ev.unitId] : null;
    if (e && e.unitId) return e.unitId;
    if (typeof ev.of === 'string') return ev.of;
    if (typeof ev.unitId === 'string') return ev.unitId;
    return null;
  }
  function targetEnt(ev, by) {
    if (!ev || ev.targetId === undefined) return null;
    return (by && by[ev.targetId]) || null;
  }

  function unitNameOf(id) {
    const f = CC.fighters;
    const u = f && f.get ? f.get(id) : null;
    return (u && u.name) || id || '?';
  }

  function skillLabel(ev, by) {
    if (ev && ev.name) return ev.name;
    const key = String((ev && (ev.skill || ev.key)) || '');
    const tid = typeIdOf(ev, by);
    const u = tid && CC.fighters && CC.fighters.get ? CC.fighters.get(tid) : null;
    if (!u) return key || '技能';
    if (key === 's1' && u.s1) return u.s1.name;
    if (key === 's2' && u.s2) return u.s2.name;
    if (key === 'ult' && u.ult) return u.ult.name;
    return key || '技能';
  }

  function isUltEvent(ev) {
    if (!ev) return false;
    if (ev.ult === true) return true;
    return String(ev.skill || ev.key) === 'ult';
  }

  function consumeEvents(battle, st, dt) {
    const by = R.by;
    const Sp = CC.sprites;
    const evs = battle && Array.isArray(battle.events) ? battle.events : null;
    if (!evs || !evs.length) return;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (!ev || typeof ev !== 'object') continue;
      const type = ev.type || 'hit';
      const p = posOf(ev, by);
      if (type === 'hit') {
        R.hits++;
        const crit = !!ev.crit;
        if (crit) R.crits++;
        spawn(crit ? 'crit' : 'spark', p.x, p.z, p.h + 24, {
          size: crit ? 62 : 40, life: crit ? 0.3 : 0.2, grow: 0.4, alpha: crit ? 0.95 : 0.8,
          sprite: crit ? 'crit' : 'spark',
        });
        const dmg = ev.dmg === undefined ? 0 : ev.dmg;
        if (dmg > 0 || crit) {
          floatText(p.x, p.z, p.h + 48, (dmg >= 1 ? Math.round(dmg) : Math.round(dmg * 10) / 10),
            { crit: crit, life: crit ? 0.8 : 0.6 });
        }
        addShake(crit ? 9 : 3.5, crit ? 0.24 : 0.12);
        addHitstop(crit ? 0.085 : 0.06);
        if (crit) addGlitch(0.7);
        if (CC.assets && CC.assets.play) CC.assets.play(crit ? 'crit' : 'hit_light', { vol: crit ? 1 : 0.8 });
      } else if (type === 'cast') {
        const nm = skillLabel(ev, by);
        const e = entOf(ev, by);
        const tid = typeIdOf(ev, by);
        const isUlt = isUltEvent(ev);
        spawn('ring', p.x, p.z, 2, { size: 54, life: 0.42, grow: 1.6, alpha: 0.6, layer: 'ground', sprite: 'ring' });
        if (isUlt) {
          spawn('boom', p.x, p.z, 20, { size: 104, life: 0.36, grow: 0.5, alpha: 0.72 });
          spawn('ring', p.x, p.z, 4, { size: 80, life: 0.5, grow: 2.4, alpha: 0.5, layer: 'ground' });
          addShake(12, 0.4);
          addGlitch(1);
          announce('必杀 · ' + nm, C.crit);
          R.ult = { id: (ev.unitId === undefined ? null : ev.unitId), t: 1.0, dur: 1.0, name: nm };
          if (CC.assets && CC.assets.play) CC.assets.play('ult_release');
        } else {
          addShake(4, 0.18);
          spawn('slash_arc', p.x, p.z, 36, { size: 120, life: 0.22, grow: 0.3, alpha: 0.7, rot: ev.side === 'B' ? Math.PI : 0 });
          announce(nm, ev.side === 'B' ? C.b : C.a);
          if (CC.assets && CC.assets.play) CC.assets.play('skill_cast', { vol: 0.85 });
        }
        if (CC.assets && CC.assets.playSkill && tid) CC.assets.playSkill(tid, isUlt ? 'ult' : (ev.skill || ev.key || '1'), {});
        if (CC.assets && CC.assets.playVoice && tid && rnd() < 0.6) CC.assets.playVoice(tid, { vol: 0.9 });
      } else if (type === 'charge_start') {
        // 蓄力前摇开始：起手环 + 必杀读条音
        const isUlt = ev.ult === true || String(ev.key) === 'ult';
        const nm = ev.name || skillLabel(ev, by);
        R.charging[ev.unitId] = { key: ev.key || 's1', ult: isUlt, name: nm, dur: ev.dur || 0.5 };
        spawn('ring', p.x, p.z, 3, { size: isUlt ? 90 : 46, life: 0.4, grow: 1.5, alpha: 0.6, layer: 'ground' });
        if (isUlt) {
          announce('必杀蓄力 · ' + nm, C.warn);
          addShake(5, 0.3);
          if (CC.assets && CC.assets.play) CC.assets.play('ult_charge', { vol: 0.85 });
        } else if (CC.assets && CC.assets.play) {
          CC.assets.play('charge', { vol: 0.5 });
        }
      } else if (type === 'charge_done') {
        // 蓄力完成：出招闪光
        const rec = R.charging[ev.unitId] || {};
        const isUlt = rec.ult || String(ev.key) === 'ult';
        delete R.charging[ev.unitId];
        spawn('ring', p.x, p.z, (ev.h || 40), { size: isUlt ? 120 : 60, life: 0.3, grow: 1.0, alpha: 0.8 });
        spawn('spark', p.x, p.z, (ev.h || 40), { size: isUlt ? 70 : 40, life: 0.22, grow: 0.5 });
        if (isUlt) addShake(8, 0.3);
      } else if (type === 'interrupt') {
        // 打断：技能图标碎掉 + 红色「打断！」 + 蓄力条炸裂
        const isUlt = ev.ult === true || String(ev.key) === 'ult';
        delete R.charging[ev.unitId];
        floatText(p.x, p.z, (ev.h || 50) + 10, '打断！', { life: 1.0, crit: true, size: 20, color: '#ff5f6d' });
        if (ev.name) floatText(p.x, p.z, (ev.h || 50) - 6, String(ev.name).slice(0, 6), { life: 0.9, size: 12, color: 'rgba(255,180,180,0.95)' });
        // 蓄力条炸裂：碎片四散
        for (let k = 0; k < 8; k++) {
          spawn('shard', p.x, p.z, (ev.h || 50), {
            size: 13, life: rr(0.35, 0.7), blend: 'source-over',
            vx: rr(-170, 170), vz: rr(-90, 90), vh: rr(80, 230), spin: rr(-9, 9),
            color: isUlt ? '#ff8ad8' : '#9fe8ff',
          });
        }
        spawn('ring', p.x, p.z, (ev.h || 50), { size: 66, life: 0.32, grow: 1.4, alpha: 0.85, color: '#ff5f6d' });
        addShake(isUlt ? 12 : 8, 0.3);
        addGlitch(isUlt ? 0.9 : 0.5);
        addHitstop(0.08);
        if (CC.assets && CC.assets.play) CC.assets.play('block', { vol: 0.9 });
      } else if (type === 'pickup_spawn') {
        spawn('ring', p.x, p.z, 2, { size: 30, life: 0.35, grow: 1.4, alpha: 0.5, layer: 'ground' });
      } else if (type === 'zone') {
        // AOE 预警事件（引擎在落点前 push）
        spawn('ring', p.x, p.z, 2, { size: 60, life: 0.45, grow: 2.0, alpha: 0.45, layer: 'ground' });
        if (ev.stones) announce('乱石雨 x' + ev.stones, C.b);
      } else if (type === 'boom') {
        // 区域引爆
        const rr2 = Math.max(60, (ev.radius || 120) * 0.5);
        spawn('boom', p.x, p.z, 18, { size: rr2, life: 0.34, grow: 0.45, alpha: 0.7, sprite: ev.sprite || 'boom' });
        spawn('ring', p.x, p.z, 4, { size: rr2 * 0.8, life: 0.45, grow: 2.2, alpha: 0.5, layer: 'ground' });
        addShake(9, 0.3);
        addGlitch(0.6);
        if (CC.assets && CC.assets.play) CC.assets.play('explode', { vol: 0.85 });
      } else if (type === 'pickup') {
        // 拾取石头：吸附特效 + 「+1」 + 徽章跳动
        const count = ev.count || 1;
        const max = ev.max;
        floatText(p.x, p.z, 20, '+' + (ev.magnet ? '1' : (count > 0 ? 1 : 1)), { color: C.gold, life: 0.75, size: 14 });
        spawn('ring', p.x, p.z, 4, { size: 34, life: 0.32, grow: 1.2, alpha: 0.6, layer: 'ground' });
        const e2 = entOf(ev, by);
        if (e2 && typeof e2.x === 'number') {
          for (let k = 0; k < 4; k++) {
            const mx = (p.x + e2.x) / 2 + rr(-18, 18);
            const mz = (p.z + e2.z) / 2 + rr(-14, 14);
            spawn('vortex', mx, mz, 16 + rr(-6, 10), { size: 16, life: 0.3, grow: -0.6, alpha: 0.85, color: '#ffd166' });
          }
        }
        if (count > 0 && count % 5 === 0) announce('石头 x' + count + (max ? '/' + max : ''), C.gold);
        if (CC.assets && CC.assets.play) CC.assets.play('ui_confirm', { vol: 0.5 });
      } else if (type === 'stone_rain') {
        // 开始下石头雨：聚集 + 雨区提示
        const count = ev.count || 1;
        const radius = ev.radius || 200;
        announce('落石雨 x' + count, C.gold);
        spawn('ring', p.x, p.z, 3, { size: scaleSF(radius) * 1.5, life: 0.5, grow: -0.6, alpha: 0.5, layer: 'ground' });
        for (let k = 0; k < 6; k++) {
          const a = rr(0, Math.PI * 2);
          spawn('spark', p.x + Math.cos(a) * radius * 0.6, p.z + Math.sin(a) * radius * 0.6, 60 + rr(0, 120), {
            size: 20, life: 0.5, grow: -0.4, vx: -Math.cos(a) * 110, vz: -Math.sin(a) * 110, vh: -60, color: '#c8d2e2',
          });
        }
        addShake(6, 0.3);
        if (CC.assets && CC.assets.play) CC.assets.play('whoosh', { vol: 0.9, rate: 0.8 });
      } else if (type === 'stone_drop') {
        // 一块石头从天而降：下落轨迹 + 落点阴影（延迟到落地才起尘/震屏）
        const left = ev.left === undefined ? 0 : ev.left;
        spawn('stone_fall', p.x, p.z, 320, {
          size: 19, life: 0.32, grow: 0, blend: 'source-over', vh: -1020, spin: rr(-4, 4),
        });
        const land = 0.3;
        spawn('dust', p.x, p.z, 2, { size: 34, life: 0.34, grow: 1.5, alpha: 0.75, layer: 'ground', delay: land });
        for (let k = 0; k < 3; k++) {
          spawn('shard', p.x, p.z, 10, {
            size: 9, life: rr(0.25, 0.45), blend: 'source-over', delay: land,
            vx: rr(-150, 150), vz: rr(-90, 90), vh: rr(90, 220), spin: rr(-9, 9), color: '#8a93a2',
          });
        }
        later(land, function () {
          addShake(3.2, 0.14);
          if (CC.assets && CC.assets.play) CC.assets.play('land', { vol: 0.55, rate: rr(0.92, 1.12) });
        });
        if (left === 0) announce('石雨停了', C.dim);
      } else if (type === 'throw_stones') {
        // 兼容旧事件名（引擎保留别名）
        const n = Math.max(1, Math.min(10, ev.count || 1));
        const dirSign = (entOf(ev, by) || {}).side === 'B' ? -1 : 1;
        for (let k = 0; k < n; k++) {
          spawn('stone_fly', p.x + dirSign * 14 + rr(-8, 8), p.z + rr(-10, 10), 30, {
            size: 15, life: rr(0.34, 0.5), grow: 0, blend: 'source-over',
            vx: dirSign * rr(110, 190), vz: rr(-40, 40), vh: rr(60, 130), spin: rr(-6, 6),
          });
        }
        addShake(5, 0.2);
        if (CC.assets && CC.assets.play) CC.assets.play('whoosh', { vol: 0.8 });
      } else if (type === 'bounce') {
        // 弹道反弹
        spawn('spark', p.x, p.z, (ev.h || 30) + 10, { size: 32, life: 0.18, grow: 0.5 });
        floatText(p.x, p.z, (ev.h || 30) + 26, '弹', { color: '#9ff2ff', life: 0.5, size: 11 });
        if (CC.assets && CC.assets.play) CC.assets.play('hit_light', { vol: 0.5, rate: 1.4 });
      } else if (type === 'pull') {
        // 引力拖拽：收缩圈 + 向心粒子
        const radius = ev.radius || 240;
        spawn('ring', p.x, p.z, 3, { size: Sp.scaleX(radius) * 1.6, life: 0.42, grow: -0.72, alpha: 0.6, layer: 'ground' });
        const pulled = Math.min(10, ev.count || 4);
        for (let k = 0; k < pulled; k++) {
          const a = rr(0, Math.PI * 2);
          spawn('spark', p.x + Math.cos(a) * radius * 0.5, p.z + Math.sin(a) * radius * 0.5, 14, {
            size: 18, life: 0.36, grow: -0.5, vx: -Math.cos(a) * 120, vz: -Math.sin(a) * 120, alpha: 0.8,
          });
        }
        addShake(7, 0.28);
        floatText(p.x, p.z, 40, '引力', { color: '#c8a8ff', life: 0.7, size: 13 });
        if (CC.assets && CC.assets.play) CC.assets.play('whoosh', { vol: 0.9, rate: 0.7 });
      } else if (type === 'detonate') {
        // 引爆标记：红色爆炸 + 传票标记清空
        const marks = ev.marks || 1;
        spawn('boom', p.x, p.z, (ev.h || 30), { size: 70 + 60 * clamp(marks, 0, 3), life: 0.4, grow: 0.5, alpha: 0.8 });
        spawn('crit', p.x, p.z, (ev.h || 30) + 10, { size: 60, life: 0.3, grow: 0.6 });
        for (let k = 0; k < 6; k++) {
          spawn('spark', p.x, p.z, (ev.h || 30), {
            size: 22, life: rr(0.25, 0.5), vx: rr(-150, 150), vz: rr(-80, 80), vh: rr(40, 150), color: '#ff6b6b',
          });
        }
        addShake(11, 0.36); addGlitch(0.8); addHitstop(0.08);
        floatText(p.x, p.z, (ev.h || 30) + 40, '引爆 x' + marks, { color: '#ff6b6b', life: 0.9, size: 15 });
        if (CC.assets && CC.assets.play) CC.assets.play('explode');
      } else if (type === 'steal') {
        // 偷怒气：从目标到自己的能量连线
        const e2 = entOf(ev, by);
        if (e2 && typeof e2.x === 'number') {
          spawn('link', p.x, p.z, (ev.h || 30), {
            size: 12, life: 0.4, blend: 'lighter', alpha: 0.95, color: '#ffe066',
            tx: e2.x, tz: e2.z, th: (e2.h || 0) + 26, width: 3.4,
          });
        }
        floatText(p.x, p.z, (ev.h || 30) + 34, '怒气 -' + Math.round(ev.amount || 0), { color: '#ffe066', life: 0.8, size: 12 });
        if (CC.assets && CC.assets.play) CC.assets.play('buff', { vol: 0.6, rate: 1.3 });
      } else if (type === 'dash' || type === 'dodge') {
        // 突进/闪避残影
        const e2 = entOf(ev, by);
        const back = e2 && typeof e2.facing === 'number' ? -e2.facing : 1;
        for (let k = 0; k < 3; k++) {
          spawn('slash', p.x + back * (18 + k * 22), p.z, 24, {
            size: 54, life: 0.22, grow: 0.1, alpha: 0.4 - k * 0.1, rot: back > 0 ? Math.PI : 0,
          });
        }
        if (type === 'dodge') floatText(p.x, p.z, 42, '闪避', { color: '#9ff2ff', life: 0.55, size: 12 });
        if (CC.assets && CC.assets.play) CC.assets.play('whoosh', { vol: 0.5 });
      } else if (type === 'reflect') {
        spawn('ring', p.x, p.z, (ev.h || 20), { size: 40, life: 0.28, grow: 0.8, alpha: 0.75, color: '#ffe066' });
        floatText(p.x, p.z, (ev.h || 30) + 30, '反弹', { color: '#ffe066', life: 0.6, size: 12 });
      } else if (type === 'energy_full') {
        const e2 = entOf(ev, by);
        if (e2) {
          spawn('ring', e2.x, e2.z, (e2.h || 0) + 30, { size: 52, life: 0.5, grow: 1.4, alpha: 0.7, color: '#fff2a8' });
        }
      } else if (type === 'ko') {
        R.kills++;
        spawn('boom', p.x, p.z, 22, { size: 110, life: 0.38, grow: 0.55, alpha: 0.75 });
        spawn('ring', p.x, p.z, 4, { size: 64, life: 0.5, grow: 2.6, alpha: 0.6, layer: 'ground' });
        for (let k = 0; k < 8; k++) {
          spawn('spark', p.x, p.z, 28, {
            size: 26, life: rr(0.3, 0.6), alpha: 0.85,
            vx: rr(-130, 130), vz: rr(-70, 70), vh: rr(60, 190),
          });
        }
        addShake(14, 0.42); addHitstop(0.09); addGlitch(1);
        floatText(p.x, p.z, p.h + 62, 'KO!', { life: 1.0, crit: true, size: 26, color: C.critHot });
        announce('K.O.', C.critHot);
        if (CC.assets && CC.assets.play) CC.assets.play('ko');
      } else if (type === 'spawn') {
        spawn('ring', p.x, p.z, 2, { size: 46, life: 0.4, grow: 1.8, alpha: 0.6, layer: 'ground' });
        spawn('spark', p.x, p.z, 16, { size: 34, life: 0.28, alpha: 0.8 });
        if (CC.assets && CC.assets.play) CC.assets.play('spawn', { vol: 0.7 });
      } else if (type === 'heal') {
        const amt = ev.dmg || ev.amount || 0;
        floatText(p.x, p.z, p.h + 42, '+' + (amt >= 1 ? Math.round(amt) : Math.round(amt * 1000) / 10),
          { color: C.heal, life: 0.8 });
        spawn('ring', p.x, p.z, 6, { size: 42, life: 0.4, grow: 1.4, alpha: 0.6, layer: 'ground' });
        if (CC.assets && CC.assets.play) CC.assets.play('heal', { vol: 0.7 });
      } else if (type === 'buff') {
        spawn('ring', p.x, p.z, 8, { size: 40, life: 0.5, grow: 1.2, alpha: 0.5, layer: 'ground' });
        if (ev.kind && rnd() < 0.5) floatText(p.x, p.z, p.h + 54, String(ev.kind), { color: '#c8a8ff', life: 0.6, size: 11 });
        if (CC.assets && CC.assets.play && rnd() < 0.5) CC.assets.play('buff', { vol: 0.5 });
      } else if (type === 'shake') {
        addShake(ev.amp || ev.mag || 8, ev.dur || 0.2);
      } else if (type === 'hitstop') {
        addHitstop(ev.dur !== undefined ? ev.dur : (ev.ms !== undefined ? ev.ms / 1000 : 0.07));
      } else if (type === 'projectile') {
        spawn(ev.sprite || 'spark', p.x, p.z, p.h + 24, { size: 44, life: 0.3 });
      }
    }
  }

  // ---------------------------------------------------------------- 镜头
  function updateCamera(st, phase, dt) {
    const Sp = CC.sprites;
    if (!Sp) return;
    if (phase !== 'fighting' || !st) { Sp.centerCamera(); return; }
    const list = [];
    const add = (arr) => { if (Array.isArray(arr)) for (let i = 0; i < arr.length; i++) list.push(arr[i]); };
    add(st.A); add(st.B);
    let aliveA = 0, aliveB = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.alive === false) continue;
      if (e.side === 'B') aliveB++; else aliveA++;
    }
    Sp.followCamera(list, dt, { keepTogether: true, aliveA: aliveA, aliveB: aliveB });
  }

  // ---------------------------------------------------------------- 背景
  function drawBackground(ctx, phase) {
    const A = CC.assets, Sp = CC.sprites;
    // 天空底色
    if (ctx.createLinearGradient) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#070a18');
      g.addColorStop(0.42, '#0d1030');
      g.addColorStop(0.72, '#150f2c');
      g.addColorStop(1, '#07080f');
      ctx.fillStyle = g;
    } else ctx.fillStyle = '#0a0d1c';
    ctx.fillRect(0, 0, W, H);

    // 星空点缀（确定性 RNG）
    ctx.save();
    for (let i = 0; i < 70; i++) {
      const sx = ((i * 97) % 960) + (rnd() - 0.5) * 4;
      const sy = ((i * 53) % 260) + (rnd() - 0.5) * 4;
      const a = 0.18 + 0.5 * ((i * 37) % 100) / 100;
      ctx.fillStyle = 'rgba(180,225,255,' + a.toFixed(2) + ')';
      ctx.fillRect(sx, sy, 1.6, 1.6);
    }
    ctx.restore();

    // 天际线（menu.png 只取上半部分），随镜头做轻微视差
    const sky = A && A.texture ? A.texture('menu') : null;
    if (sky) {
      const meta = (A.bgMeta && A.bgMeta.menu) || null;
      const s = meta && meta.sky ? meta.sky : [0, 0, 1280, 400];
      const camX = Sp && Sp.camera ? Sp.camera().x : 600;
      const camZ = Sp && Sp.camera ? Sp.camera().z : 350;
      const par = (camX - 600) * 0.10;
      const parY = (camZ - 350) * 0.045;
      const dw = W * 0.94, dh = dw * (s[3] / s[2]);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(sky, s[0], s[1], s[2], s[3], (W - dw) / 2 - par * 0.6, -26 + parY, dw, dh);
      ctx.restore();
      // 上暗下透的渐变，压住天际线的上边缘 + 保证 HUD 可读
      if (ctx.createLinearGradient) {
        const g2 = ctx.createLinearGradient(0, 0, 0, 340);
        g2.addColorStop(0, 'rgba(4,6,16,0.80)');
        g2.addColorStop(0.55, 'rgba(4,6,16,0.34)');
        g2.addColorStop(1, 'rgba(4,6,16,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, W, 340);
      }
    }

    // 蛐蛐罐地面：把 arena.png 的椭圆内容框映射到世界平面 x∈[0,1200] z∈[0,700]
    drawWorldPlate(ctx, 'arena', 'floor', 0, 0, 1200, 700, { alpha: 0.96 });
    // 罐口环（后半圈，先画 → 单位站在环内）
    drawWorldPlate(ctx, 'jar_top', 'ring', -46, -34, 1292, 768, { alpha: 0.95 });
    // 罐内中心光晕
    const cen = Sp.project(600, 350, 0);
    if (ctx.createRadialGradient) {
      const rg = ctx.createRadialGradient(cen.sx, cen.sy, 10, cen.sx, cen.sy, 430);
      rg.addColorStop(0, 'rgba(90,140,255,0.16)');
      rg.addColorStop(1, 'rgba(90,140,255,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawWorldPlate(ctx, key, boxName, wx0, wz0, wx1, wz1, opt) {
    const A = CC.assets, Sp = CC.sprites;
    if (!A || !A.texture || !Sp) return false;
    const img = A.texture(key);
    if (!img) return false;
    const meta = A.bgMeta && A.bgMeta[key] ? A.bgMeta[key] : null;
    const box = (meta && meta[boxName]) || [0, 0, (img.width || 1), (img.height || 1)];
    const p0 = Sp.project(wx0, wz0, 0);
    const p1 = Sp.project(wx1, wz1, 0);
    const o = opt || {};
    ctx.save();
    if (o.alpha !== undefined && typeof ctx.globalAlpha === 'number') ctx.globalAlpha = o.alpha;
    ctx.drawImage(img, box[0], box[1], box[2] - box[0], box[3] - box[1], p0.sx, p0.sy, p1.sx - p0.sx, p1.sy - p0.sy);
    ctx.restore();
    return true;
  }

  function drawJarFront(ctx) {
    const A = CC.assets, Sp = CC.sprites;
    if (!A || !A.texture || !Sp) return;
    const img = A.texture('jar_top');
    if (!img) return;
    const meta = A.bgMeta && A.bgMeta.jar_top ? A.bgMeta.jar_top : null;
    const box = (meta && meta.ring) || [0, 133, 1280, 719];
    const p0 = Sp.project(-46, -34, 0);
    const p1 = Sp.project(1246, 734, 0);
    const destH = p1.sy - p0.sy;
    const srcH = box[3] - box[1];
    // 只取椭圆环的下缘（前唇），画在单位之后 → 蛐蛐站在罐里的纵深
    const takeFrom = 0.74;
    const srcY0 = box[1] + srcH * takeFrom;
    const partH = (box[3] - srcY0) / srcH;
    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.drawImage(img, box[0], srcY0, box[2] - box[0], box[3] - srcY0,
      p0.sx, p0.sy + destH * takeFrom, p1.sx - p0.sx, destH * partH);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 场地元素
  function drawZones(ctx, st) {
    const zones = st && Array.isArray(st.zones) ? st.zones : null;
    const Sp = CC.sprites, A = CC.assets;
    const live = {};
    const recs = R.zoneSeen || (R.zoneSeen = {});
    if (!zones || !zones.length) {
      Object.keys(recs).forEach((k) => { delete recs[k]; });
      return;
    }
    for (let i = 0; i < zones.length; i++) {
      const zn = zones[i];
      if (!zn || typeof zn.x !== 'number' || typeof zn.z !== 'number') continue;
      const radius = zn.radius || zn.r || 120;
      const key = Math.round(zn.x) + ':' + Math.round(zn.z) + ':' + Math.round(radius);
      live[key] = true;
      let rec = recs[key];
      if (!rec) {
        rec = { t: 0 };
        recs[key] = rec;
        if (CC.assets && CC.assets.play) CC.assets.play('aoe_warn', { vol: 0.5 });
      }
      rec.t += R.dt;
      const warnTotal = (zn.warn !== undefined ? zn.warn : (zn.warnT !== undefined ? zn.warnT : 0.7)) || 0.7;
      const elapsed = (zn.t !== undefined ? zn.t : rec.t);
      const prog = clamp(elapsed / Math.max(0.05, warnTotal), 0, 1);
      const p = Sp.project(zn.x, zn.z, 0);
      const rx = Sp.scaleX(radius), ry = Sp.scaleZ(radius);
      ctx.save();
      const pulse = 0.30 + 0.22 * Math.abs(Math.sin(R.t * 9));
      if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = clamp(0.35 + 0.5 * prog, 0, 1);
      const img = A && A.texture ? A.texture('aoe_warn') : null;
      if (img) ctx.drawImage(img, p.sx - rx, p.sy - ry, rx * 2, ry * 2);
      else {
        ctx.strokeStyle = 'rgba(255,86,214,' + pulse.toFixed(2) + ')';
        ctx.lineWidth = 2;
        Sp.ellipsePath(ctx, p.sx, p.sy, rx, ry);
        if (ctx.stroke) ctx.stroke();
      }
      // 预警期内半透明填充（进度环）
      ctx.fillStyle = 'rgba(255,86,214,' + (0.10 + 0.22 * prog).toFixed(3) + ')';
      Sp.ellipsePath(ctx, p.sx, p.sy, rx * prog, ry * prog);
      ctx.fill();
      // 外圈描边
      ctx.strokeStyle = 'rgba(255,120,225,' + (0.35 + 0.4 * pulse).toFixed(2) + ')';
      ctx.lineWidth = 2;
      Sp.ellipsePath(ctx, p.sx, p.sy, rx, ry);
      if (ctx.stroke) ctx.stroke();
      ctx.restore();
    }
    // 清掉本帧已消失的预警（下一波重新播音）
    Object.keys(recs).forEach((k) => { if (!live[k]) delete recs[k]; });
  }

  function drawPlacingSlots(ctx, slots, hover) {
    const Sp = CC.sprites;
    const colA = 'rgba(127,227,255,', colB = 'rgba(255,86,214,';
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const p = Sp.project(s.x, s.z, 0);
      const rx = 58 * Sp.VIEW.SCALE, ry = 58 * Sp.VIEW.SCALE * (Sp.VIEW.ZS / Sp.VIEW.SCALE) * 1.0;
      const isHover = hover && hover.slotIndex !== undefined && (hover.slotIndex === s.index);
      const base = s.side === 'B' ? colB : colA;
      ctx.save();
      if (isHover) {
        ctx.fillStyle = (hover.valid === false ? 'rgba(255,90,90,0.28)' : base + '0.30)');
        Sp.ellipsePath(ctx, p.sx, p.sy, rx * 1.06, ry * 1.06);
        ctx.fill();
      }
      ctx.strokeStyle = base + (s.unitId ? '0.30)' : '0.55)');
      ctx.lineWidth = s.unitId ? 1.2 : 1.6;
      if (ctx.setLineDash) ctx.setLineDash(s.unitId ? [] : [5, 5]);
      Sp.ellipsePath(ctx, p.sx, p.sy, rx, ry);
      if (ctx.stroke) ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
      if (ctx.fillText && !s.unitId) {
        ctx.font = '11px ' + FONT;
        ctx.textAlign = 'center';
        ctx.fillStyle = base + '0.8)';
        // 中立空槽标记：+ 与前后排提示（不分敌我）
        ctx.fillText('+', p.sx, p.sy - 2);
        ctx.font = '9px ' + FONT;
        ctx.fillStyle = base + '0.55)';
        ctx.fillText(s.lane === 0 ? '前' : '后', p.sx, p.sy + 10);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- 实体
  function normalizeSlots(view) {
    const Sp = CC.sprites;
    const b = view && view.board;
    let raw = null;
    if (Array.isArray(b)) raw = b;
    else if (b && typeof b.slots === 'function') {
      try { raw = b.slots(); } catch (e) { raw = null; }
    } else if (b && Array.isArray(b.slots)) raw = b.slots;
    else if (b && (Array.isArray(b.A) || Array.isArray(b.B))) {
      raw = [];
      if (Array.isArray(b.A)) raw = raw.concat(b.A);
      if (Array.isArray(b.B)) raw = raw.concat(b.B);
    }
    const out = [];
    if (raw) {
      for (let i = 0; i < raw.length; i++) {
        const s = raw[i];
        if (!s) continue;
        let x, z;
        if (Array.isArray(s.pos)) { x = s.pos[0]; z = s.pos[1]; }
        else { x = s.x; z = s.z; }
        if (typeof x !== 'number' || typeof z !== 'number') continue;
        out.push({
          index: (s.index === undefined ? i : s.index),
          side: s.side || (x < 600 ? 'A' : 'B'),
          lane: s.lane === undefined ? (x > 690 || x < 510 ? 1 : 0) : s.lane,
          col: s.col, row: s.row,
          x: x, z: z, unitId: s.unitId || null,
        });
      }
      if (out.length) return out;
    }
    // 兜底：契约里的 3 列 × 2 排镜像布局
    const zs = [150, 350, 550];
    for (let lane = 0; lane < 2; lane++) {
      for (let col = 0; col < 3; col++) {
        out.push({ index: out.length, side: 'A', lane: lane, col: col, x: lane === 0 ? 424 : 206, z: zs[col], unitId: null });
        out.push({ index: out.length, side: 'B', lane: lane, col: col, x: lane === 0 ? 776 : 994, z: zs[col], unitId: null });
      }
    }
    return out;
  }

  function ghostEntity(unitId, x, z, side) {
    const f = CC.fighters;
    const u = f && f.get ? f.get(unitId) : null;
    return {
      id: 'ghost:' + unitId, side: side || 'A', unitId: unitId, unit: u, slot: 0,
      x: x, z: z, h: 0, facing: (side === 'B' ? -1 : 1), alive: true,
      hp: u && u.stats ? u.stats.hp : 100, maxHp: u && u.stats ? u.stats.hp : 100,
      shield: 0, energy: 0, state: 'idle', stateT: 0, buffs: [], combo: 0,
    };
  }

  // 存活召唤物统计（只算当前存活：isMinion && alive && ownerId === 该单位 id）
  function indexMinions(st) {
    const map = {};
    if (!st) return map;
    // 引擎把召唤物放在 A/B 里（battle[m.side].push），这里也兼容独立的 minions 数组
    const groups = [st.A, st.B, st.minions];
    for (let g = 0; g < groups.length; g++) {
      const arr = groups[g];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!e || !e.isMinion || e.alive === false) continue;
        const own = e.ownerId;
        if (own === undefined || own === null) continue;
        map[own] = (map[own] || 0) + 1;
      }
    }
    return map;
  }

  function drawEntities(ctx, st, view, phase) {
    const Sp = CC.sprites;
    const units = [];
    const projs = [];
    const push = (arr) => {
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) if (arr[i] && typeof arr[i].x === 'number') units.push(arr[i]);
    };
    if (st) {
      push(st.A); push(st.B); push(st.minions);
      if (Array.isArray(st.projectiles)) {
        for (let i = 0; i < st.projectiles.length; i++) {
          const p = st.projectiles[i];
          if (p && typeof p.x === 'number') projs.push(p);
        }
      }
    }
    const ghosts = [];
    let slots = null;
    if (phase === 'placing') {
      slots = normalizeSlots(view);
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (!s.unitId) continue;
        ghosts.push(ghostEntity(s.unitId, s.x, s.z, s.side));
      }
      const hover = view && view.hover;
      if (hover && hover.unitId && slots.length) {
        let hs = null;
        if (hover.slotIndex !== undefined) {
          for (let i = 0; i < slots.length; i++) if (slots[i].index === hover.slotIndex) hs = slots[i];
        }
        const hx = hs ? hs.x : (typeof hover.wx === 'number' ? hover.wx : slots[0].x);
        const hz = hs ? hs.z : (typeof hover.wz === 'number' ? hover.wz : slots[0].z);
        const g = ghostEntity(hover.unitId, hx, hz, hs ? hs.side : 'A');
        g.ghost = true;
        ghosts.push(g);
      }
    }
    // 深度排序：先画 z 小的（远），后画 z 大的（近）
    const items = [];
    for (let i = 0; i < units.length; i++) items.push({ z: units[i].z, kind: 'u', e: units[i] });
    for (let i = 0; i < projs.length; i++) items.push({ z: projs[i].z, kind: 'p', e: projs[i] });
    for (let i = 0; i < ghosts.length; i++) items.push({ z: ghosts[i].z, kind: 'u', e: ghosts[i] });
    items.sort(function (a, b) { return a.z === b.z ? 0 : (a.z < b.z ? -1 : 1); });

    // 影子（全部先画，压在地面上）
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== 'u' || it.e.ghost) continue;
      Sp.drawShadow(ctx, it.e, {});
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'p') { drawProjectile(ctx, it.e); continue; }
      const e = it.e;
      const opt = { t: R.t, alpha: 1 };
      if (e.ghost) opt.alpha = 0.72;
      // 只统计当前存活的分身（不是累计召唤次数）
      if (e.isMinion) opt.showBars = false;
      else if (e.id !== undefined && R.minionsByOwner[e.id]) opt.minionCount = R.minionsByOwner[e.id];
      Sp.drawUnit(ctx, e, opt);
    }
    return { slots: slots, count: items.length };
  }

  function drawProjectile(ctx, p) {
    const Sp = CC.sprites, A = CC.assets;
    const size = (p.scale || 1) * 48;
    const pt = Sp.project(p.x, p.z, (p.h || 0));
    const ang = Math.atan2(((p.vz || 0)) * Sp.VIEW.ZS, ((p.vx || 0)) * Sp.VIEW.SCALE) || 0;
    const key = p.sprite || 'spark';
    // 拖尾
    const tailLen = size * 2.2;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(pt.sx, pt.sy);
    ctx.rotate(ang);
    const img = A && A.texture ? A.texture(key) : null;
    if (img) ctx.drawImage(img, -tailLen * 0.5 - size * 0.2, -size * 0.5, tailLen, size);
    ctx.restore();
    Sp.drawSprite(ctx, key, pt.sx, pt.sy, size, size, { rot: ang, blend: 'lighter' });
    // 弹体核心
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    Sp.ellipsePath(ctx, pt.sx, pt.sy, size * 0.16, size * 0.16);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles(ctx, layer) {
    const Sp = CC.sprites, A = CC.assets;
    for (let i = 0; i < R.parts.length; i++) {
      const p = R.parts[i];
      if (p.layer !== layer) continue;
      const k = clamp(p.t / Math.max(0.01, p.life), 0, 1);
      const alpha = p.alpha * (1 - k);
      if (alpha <= 0.02) continue;
      if (p.delay && p.t < p.delay) continue;      // 延迟出场（落地那一瞬）
      // 连线（偷怒气）
      if (p.kind === 'link') {
        const a = Sp.project(p.x, p.z, p.h);
        const b = Sp.project(p.tx === undefined ? p.x : p.tx, p.tz === undefined ? p.z : p.tz, p.th === undefined ? p.h : p.th);
        ctx.save();
        ctx.globalAlpha = alpha;
        if ('globalCompositeOperation' in ctx && p.blend) ctx.globalCompositeOperation = p.blend;
        ctx.strokeStyle = p.color || '#ffe066';
        ctx.lineWidth = (p.width || 3) * (1 - k * 0.6);
        if (ctx.beginPath) {
          ctx.beginPath();
          if (ctx.moveTo) ctx.moveTo(a.sx, a.sy);
          if (ctx.quadraticCurveTo) {
            const mx = (a.sx + b.sx) / 2, my = Math.min(a.sy, b.sy) - 40 - 20 * (1 - k);
            ctx.quadraticCurveTo(mx, my, b.sx, b.sy);
          } else if (ctx.lineTo) ctx.lineTo(b.sx, b.sy);
          if (ctx.stroke) ctx.stroke();
        }
        // 移动的能量球
        const t = clamp(p.t / p.life, 0, 1);
        const ox = lerp(a.sx, b.sx, t), oy = lerp(a.sy, b.sy, t) - 30 * Math.sin(Math.PI * t);
        ctx.fillStyle = '#fffbe0';
        Sp.ellipsePath(ctx, ox, oy, 4.5, 4.5);
        ctx.fill();
        ctx.restore();
        continue;
      }
      // 飞行中的石头
      if (p.kind === 'stone_fall') {
        // 从天而降：本体 + 随高度缩小的落点阴影
        const pt = Sp.project(p.x, p.z, p.h);
        const ground = Sp.project(p.x, p.z, 0);
        const kk = clamp(1 - p.h / 340, 0.15, 1);
        ctx.save();
        if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = 0.45 * (1 - k * 0.4);
        ctx.fillStyle = 'rgba(3,6,16,0.85)';
        Sp.ellipsePath(ctx, ground.sx, ground.sy, 11 * kk, 5 * kk);
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(pt.sx, pt.sy);
        if (p.rot && ctx.rotate) ctx.rotate(p.rot);
        Sp.drawStone(ctx, 0, 0, p.size * 0.8, 7, false);
        ctx.restore();
        continue;
      }
      if (p.kind === 'stone_fly') {
        const pt = Sp.project(p.x, p.z, p.h);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(pt.sx, pt.sy);
        if (p.rot && ctx.rotate) ctx.rotate(p.rot);
        Sp.drawStone(ctx, 0, 0, p.size * 0.7, 11, false);
        ctx.restore();
        continue;
      }
      // 打断碎片：小矩形碎片旋转飞散
      if (p.kind === 'shard') {
        const pt = Sp.project(p.x, p.z, p.h);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(pt.sx, pt.sy);
        if (p.rot && ctx.rotate) ctx.rotate(p.rot);
        ctx.fillStyle = p.color || '#9fe8ff';
        ctx.fillRect(-p.size * 0.35, -p.size * 0.16, p.size * 0.7, p.size * 0.32);
        if (ctx.stroke) {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 1;
          ctx.strokeRect(-p.size * 0.35, -p.size * 0.16, p.size * 0.7, p.size * 0.32);
        }
        ctx.restore();
        continue;
      }
      const size = p.size * (1 + p.grow * k);
      if (size <= 0.3) continue;
      const pt = Sp.project(p.x, p.z, p.h);
      const img = A && A.texture ? A.texture(p.sprite) : null;
      ctx.save();
      ctx.globalAlpha = alpha;
      if ('globalCompositeOperation' in ctx && p.blend) ctx.globalCompositeOperation = p.blend;
      if (img && p.kind !== 'vortex') {
        ctx.translate(pt.sx, pt.sy);
        if (p.rot && ctx.rotate) ctx.rotate(p.rot);
        // 特效在斜角视图里也做 z 压缩
        const zs = layer === 'ground' ? (Sp.VIEW.ZS / Sp.VIEW.SCALE) : 1;
        ctx.drawImage(img, -size * 0.5, -size * 0.5 * zs, size, size * zs);
      } else {
        ctx.fillStyle = p.color || 'rgba(255,220,140,0.9)';
        Sp.ellipsePath(ctx, pt.sx, pt.sy, Math.max(0.5, size * 0.3), Math.max(0.5, size * 0.3));
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // 必杀前摇预警圈（地面层，画在单位与影子之前）
  function drawChargeWarns(ctx, st) {
    if (!st) return;
    const Sp = CC.sprites;
    const groups = [st.A, st.B];
    for (let g = 0; g < groups.length; g++) {
      const arr = groups[g];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!e || !e.cast || !e.cast.charging || e.alive === false) continue;
        Sp.drawChargeWarn(ctx, e, { t: R.t });
      }
    }
  }

  // 落石雨雨区：淡淡的范围提示 + 飘落轨迹（正在下的雨）
  function drawRains(ctx, st) {
    const rains = st && Array.isArray(st.rains) ? st.rains : null;
    if (!rains || !rains.length) return;
    const Sp = CC.sprites;
    for (let i = 0; i < rains.length; i++) {
      const r = rains[i];
      if (!r || typeof r.x !== 'number') continue;
      const left = r.left === undefined ? 1 : r.left;
      const radius = r.radius || 200;
      const p = Sp.project(r.x, r.z, 0);
      const rx = Sp.scaleX(radius), ry = Sp.scaleZ(radius);
      const total = Math.max(1, r.total || left);
      const prog = clamp(1 - left / total, 0, 1);
      ctx.save();
      if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = left > 0 ? 1 : 0.4;
      // 雨区淡圈
      ctx.fillStyle = 'rgba(120,150,200,' + (0.05 + 0.05 * prog).toFixed(3) + ')';
      Sp.ellipsePath(ctx, p.sx, p.sy, rx, ry);
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,205,235,0.28)';
      ctx.lineWidth = 1.4;
      if (ctx.setLineDash) ctx.setLineDash([6, 8]);
      Sp.ellipsePath(ctx, p.sx, p.sy, rx, ry);
      if (ctx.stroke) ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
      // 还有几块没落下
      if (left > 0 && ctx.fillText) {
        ctx.font = 'bold 11px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(226,240,255,0.85)';
        ctx.fillText('落石雨 · 剩 ' + left, p.sx, p.sy - ry - 6);
      }
      ctx.restore();
      // 飘落的轨迹（装饰：几条下落虚线）
      if (left > 0 && Sp.VIEW) {
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = 'rgba(210,228,255,0.9)';
        ctx.lineWidth = 1.2;
        for (let k = 0; k < 7; k++) {
          const seed = (r.id || 1) * 31 + k * 17;
          const a = (seed % 360) * Math.PI / 180;
          const rad = (((seed * 7919) % 100) / 100) * radius * 0.9;
          const fx2 = r.x + Math.cos(a) * rad, fz2 = r.z + Math.sin(a) * rad;
          const top = Sp.project(fx2, fz2, 300);
          const bot = Sp.project(fx2, fz2, 40 + ((R.t * 260 + k * 40) % 240));
          if (ctx.beginPath) {
            ctx.beginPath();
            if (ctx.moveTo) ctx.moveTo(top.sx, top.sy + ((R.t * 300 + k * 60) % 260));
            if (ctx.lineTo) ctx.lineTo(bot.sx, bot.sy + 26);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
  }

  // 地上可拾取资源（石头）：影子 + 浮动 + 消失前 3 秒淡出
  function drawPickups(ctx, st) {
    const list = st && Array.isArray(st.pickups) ? st.pickups : null;
    if (!list || !list.length) return;
    const Sp = CC.sprites;
    for (let i = 0; i < list.length; i++) {
      const pk = list[i];
      if (!pk || typeof pk.x !== 'number') continue;
      Sp.drawPickup(ctx, pk, { t: R.t });
    }
  }

  // ---------------------------------------------------------------- 飘字/横幅
  function drawTexts(ctx) {
    if (!ctx.fillText) return;
    for (let i = 0; i < R.texts.length; i++) {
      const f = R.texts[i];
      const k = clamp(f.t / Math.max(0.01, f.life), 0, 1);
      const pt = CC.sprites.project(f.x, f.z, f.h);
      const pop = f.crit ? (1 + 0.3 * Math.max(0, 1 - f.t * 7)) : 1;
      const size = (f.size || (f.crit ? 23 : 15)) * pop;
      const alpha = 1 - k * k;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = (f.crit ? 'bold ' : 'bold ') + size.toFixed(0) + 'px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (ctx.strokeText && f.crit) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(60,10,0,0.85)';
        ctx.strokeText(f.s, pt.sx, pt.sy);
      }
      ctx.fillStyle = f.color || (f.crit ? (k < 0.35 ? '#fff2c8' : C.crit) : 'rgba(255,255,255,0.96)');
      ctx.fillText(f.s, pt.sx, pt.sy);
      if (f.crit && ctx.strokeText) {
        ctx.globalAlpha = alpha * 0.8;
        ctx.font = 'bold ' + (size * 0.44).toFixed(0) + 'px ' + FONT;
        ctx.fillStyle = C.critHot;
        ctx.fillText('暴击', pt.sx, pt.sy - size * 0.78);
      }
      ctx.restore();
    }
  }

  // 技能名小气泡（贴着施法者，不与 HUD 的最高连击同排）
  function drawCallouts(ctx) {
    if (!ctx.fillText || !R.callouts.length) return;
    const Sp = CC.sprites;
    for (let i = 0; i < R.callouts.length; i++) {
      const c = R.callouts[i];
      const k = clamp(c.t / c.life, 0, 1);
      const alpha = k < 0.12 ? k / 0.12 : (1 - Math.max(0, (k - 0.55) / 0.45));
      const p = Sp.project(c.x, c.z, c.h + 92);
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.font = 'bold 13px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = (ctx.measureText ? ctx.measureText(c.s).width : c.s.length * 8) + 18;
      ctx.fillStyle = 'rgba(6,10,20,0.72)';
      Sp.roundRect(ctx, p.sx - w / 2, p.sy - 11, w, 22, 6);
      ctx.fill();
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1;
      Sp.roundRect(ctx, p.sx - w / 2 + 0.5, p.sy - 10.5, w - 1, 21, 6);
      if (ctx.stroke) ctx.stroke();
      ctx.fillStyle = c.color;
      ctx.fillText(c.s, p.sx, p.sy + 0.5);
      // 指向施法者的小尖
      ctx.beginPath();
      if (ctx.moveTo) {
        ctx.moveTo(p.sx - 5, p.sy + 11);
        ctx.lineTo(p.sx + 5, p.sy + 11);
        ctx.lineTo(p.sx, p.sy + 17);
      }
      if (ctx.closePath) ctx.closePath();
      ctx.fillStyle = 'rgba(6,10,20,0.72)';
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBanners(ctx) {
    if (!ctx.fillText) return;
    for (let i = 0; i < R.banners.length; i++) {
      const b = R.banners[i];
      const k = clamp(b.t / b.life, 0, 1);
      const y = 132 + i * 30;
      const alpha = k < 0.15 ? k / 0.15 : (1 - Math.max(0, (k - 0.55) / 0.45));
      ctx.save();
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.font = 'bold 22px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const wob = Math.sin(k * 22) * (1 - k) * 4;
      if (ctx.strokeText) { ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(4,6,16,0.9)'; ctx.strokeText(b.s, 480, y + wob); }
      ctx.fillStyle = b.color;
      ctx.fillText(b.s, 480, y + wob);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- 单位附加信息
  function drawComboTags(ctx, st) {
    if (!ctx.fillText || !st) return;
    const groups = [st.A, st.B];
    const Sp = CC.sprites;
    for (let g = 0; g < groups.length; g++) {
      const arr = groups[g];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!e || !e.combo) continue;
        const c = e.combo | 0;
        if (c < 2) continue;
        if (c > (R.comboPeak[e.id] || 0)) R.comboPeak[e.id] = c;
        if (c > R.maxCombo) R.maxCombo = c;
        const s = Sp.unitScreen(e, {});
        const pulse = 1 + 0.12 * Math.sin(R.t * 12);
        ctx.save();
        ctx.font = 'bold ' + (15 * pulse).toFixed(1) + 'px ' + FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tx = s.x + s.w * 0.5 + 6;
        const ty = s.top + 10;
        if (ctx.strokeText) { ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(4,6,16,0.9)'; ctx.strokeText('x' + c, tx, ty); }
        ctx.fillStyle = c >= 6 ? C.critHot : (c >= 4 ? C.crit : C.ink);
        ctx.fillText('x' + c, tx, ty);
        ctx.restore();
      }
    }
  }

  // ---------------------------------------------------------------- HUD
  function teamStats(st, side) {
    const arr = st && (side === 'B' ? st.B : st.A);
    const list = Array.isArray(arr) ? arr : [];
    let hp = 0, max = 0, alive = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      const m = Math.max(1, e.maxHp || 1);
      max += m;
      hp += Math.max(0, e.hp === undefined ? m : e.hp);
      if (e.alive !== false) alive++;
    }
    return { hp: hp, max: Math.max(1, max), alive: alive, n: list.length, list: list };
  }

  function drawThumb(ctx, unitId, x, y, size, alpha) {
    const A = CC.assets, Sp = CC.sprites;
    ctx.save();
    if (typeof ctx.globalAlpha === 'number') ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(4,8,18,0.72)';
    Sp.roundRect(ctx, x, y, size, size, 4);
    ctx.fill();
    const img = A && A.texture ? A.texture(unitId) : null;
    if (img) {
      const box = A.contentBox ? A.contentBox(unitId) : null;
      const bw = box && box.x1 !== undefined ? (box.x1 - box.x0 + 1) : (img.width || size);
      const bh = box && box.y1 !== undefined ? (box.y1 - box.y0 + 1) : (img.height || size);
      const sc = Math.min(size / Math.max(1, bw), size / Math.max(1, bh)) * 0.92;
      const dw = bw * sc, dh = bh * sc;
      ctx.drawImage(img, box ? box.x0 : 0, box ? box.y0 : 0, bw, bh, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    } else if (A && A.placeholder) {
      const ph = A.placeholder(unitId);
      if (ph) ctx.drawImage(ph, x, y, size, size);
      else {
        ctx.fillStyle = '#7fe3ff';
        ctx.fillRect(x, y, size, size);
      }
    } else {
      ctx.fillStyle = '#7fe3ff';
      ctx.fillRect(x, y, size, size);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    Sp.roundRect(ctx, x + 0.5, y + 0.5, size - 1, size - 1, 4);
    if (ctx.stroke) ctx.stroke();
    ctx.restore();
  }

  function bar(ctx, x, y, w, h, ratio, col1, col2) {
    const Sp = CC.sprites;
    ctx.save();
    ctx.fillStyle = 'rgba(4,8,18,0.8)';
    Sp.roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 3); ctx.fill();
    if (ctx.createLinearGradient) {
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, col1); g.addColorStop(1, col2);
      ctx.fillStyle = g;
    } else ctx.fillStyle = col1;
    Sp.roundRect(ctx, x, y, Math.max(1, w * clamp(ratio, 0, 1)), h, 2.5); ctx.fill();
    ctx.restore();
  }

  function drawHud(ctx, st, match, view) {
    if (!ctx.fillText) return;
    const A = st ? teamStats(st, 'A') : null;
    const B = st ? teamStats(st, 'B') : null;
    const phase = R.phase;

    // 双方队牌
    const drawTeam = (side, stats, x, flip) => {
      const w = 264, h = 66, y = 12;
      ctx.save();
      ctx.fillStyle = C.panel;
      CC.sprites.roundRect(ctx, x, y, w, h, 8); ctx.fill();
      ctx.strokeStyle = side === 'B' ? 'rgba(255,86,214,0.5)' : 'rgba(127,227,255,0.5)';
      ctx.lineWidth = 1.2;
      CC.sprites.roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8);
      if (ctx.stroke) ctx.stroke();
      const label = side === 'B' ? '右方' : '左方';
      ctx.font = 'bold 12px ' + FONT;
      ctx.textAlign = flip ? 'right' : 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = side === 'B' ? '#ffc8ec' : '#cdf0ff';
      ctx.fillText(label, flip ? x + w - 10 : x + 10, y + 18);
      const ratio = stats && stats.max ? stats.hp / stats.max : 0;
      const bx = x + 10, bw = w - 20;
      bar(ctx, bx, y + 24, bw, 8, ratio, side === 'B' ? '#ff7ce0' : '#7dff9b', side === 'B' ? '#7a1050' : '#0f5a2c');
      ctx.font = '11px ' + MONO;
      ctx.fillStyle = C.dim;
      ctx.textAlign = flip ? 'left' : 'right';
      ctx.fillText(Math.round(ratio * 100) + '%  ' + (stats ? stats.alive : 0) + '/' + (stats ? stats.n : 0), flip ? x + 10 : x + w - 10, y + 47);
      // 6 个缩略 + 微血条
      const list = stats ? stats.list : [];
      const n = Math.max(1, Math.min(6, list.length));
      const size = 26, gap = 4;
      const totalW = n * size + (n - 1) * gap;
      const startX = flip ? (x + w - 10 - totalW) : (x + 10);
      for (let i = 0; i < n; i++) {
        const e = list[i];
        if (!e) continue;
        const cx = startX + i * (size + gap);
        const dead = e.alive === false;
        drawThumb(ctx, e.unitId || e.id, cx, y + 34, size, dead ? 0.28 : 1);
        const r2 = dead ? 0 : clamp((e.hp === undefined ? 1 : e.hp) / Math.max(1, e.maxHp || 1), 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(cx, y + 60, size, 3);
        ctx.fillStyle = dead ? '#444' : (r2 > 0.5 ? '#7dff9b' : r2 > 0.25 ? '#ffd166' : '#ff5f6d');
        ctx.fillRect(cx, y + 60, size * r2, 3);
      }
      ctx.restore();
    };
    if (hasTeams(st)) {
      drawTeam('A', A, 12, false);
      drawTeam('B', B, W - 12 - 264, true);
    }

    // 中央计时 + 连击
    if (st && phase === 'fighting') {
      const time = typeof st.time === 'number' ? st.time : 0;
      const timeLeft = st.timeLimit !== undefined ? Math.max(0, st.timeLimit - time) : null;
      ctx.save();
      ctx.font = 'bold 22px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = timeLeft !== null && timeLeft < 15 ? '#ff8080' : C.ink;
      ctx.fillText(timeLeft !== null ? mmss(timeLeft) : mmss(time), 480, 30);
      ctx.font = '11px ' + FONT;
      ctx.fillStyle = C.dim;
      ctx.fillText('TICK ' + (st.tick === undefined ? R.frame : st.tick), 480, 46);
      if (R.maxCombo >= 2) {
        ctx.font = 'bold 15px ' + FONT;
        ctx.fillStyle = R.maxCombo >= 6 ? C.critHot : C.crit;
        ctx.fillText('本场最高连击 x' + R.maxCombo, 480, 66);
      }
      ctx.restore();
    }

    // Boss 分段血条（放在双方队牌下方，避免压住队牌）
    const bossEnt = findBoss(st);
    if (bossEnt) {
      const w = 360, x = (W - w) / 2, y = 98;
      const ratio = clamp((bossEnt.hp === undefined ? 1 : bossEnt.hp) / Math.max(1, bossEnt.maxHp || 1), 0, 1);
      ctx.save();
      ctx.font = 'bold 12px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffbfe8';
      ctx.fillText(((bossEnt.unit && bossEnt.unit.name) || 'BOSS') + ' · 隐藏 Boss', 480, y - 4);
      bar(ctx, x, y, w, 12, ratio, '#ff7ce0', '#ff2f6d');
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const gx = x + (w / 8) * i;
        ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + 12); if (ctx.stroke) ctx.stroke();
      }
      ctx.restore();
    }
  }

  function hasTeams(st) {
    return !!(st && ((Array.isArray(st.A) && st.A.length) || (Array.isArray(st.B) && st.B.length)));
  }

  function findBoss(st) {
    if (!st) return null;
    const groups = [st.A, st.B];
    for (let g = 0; g < groups.length; g++) {
      const arr = groups[g];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (e && e.unit && e.unit.role === 'boss' && e.alive !== false) return e;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 必杀特写
  function drawUltFocus(ctx) {
    if (R.ult.t <= 0) return;
    // 每帧按 id 重新取实体：实体可能已被引擎移除（不缓存引用，避免"残留尸体"）
    const ent = (R.ult.id !== null && R.ult.id !== undefined && R.by) ? R.by[R.ult.id] : null;
    if (!ent || ent.alive === false || typeof ent.x !== 'number') { R.ult.t = 0; return; }
    const Sp = CC.sprites;
    const k = 1 - R.ult.t / Math.max(0.01, R.ult.dur);   // 0 → 1
    const p = Sp.project(ent.x, ent.z, ent.h || 0);
    ctx.save();
    // 压暗 + 放射线
    ctx.fillStyle = 'rgba(4,6,16,' + (0.5 * (1 - k)).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const rays = 12;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + R.t * 0.6;
      ctx.save();
      ctx.translate(p.sx, p.sy - 40);
      ctx.rotate(a);
      ctx.fillStyle = 'rgba(255,180,90,' + (0.10 * (1 - k)).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(240, -18);
      ctx.lineTo(240, 18);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
    // 特写光柱
    if (ctx.createRadialGradient) {
      const rg = ctx.createRadialGradient(p.sx, p.sy - 40, 6, p.sx, p.sy - 40, 200);
      rg.addColorStop(0, 'rgba(255,210,140,' + (0.32 * (1 - k)).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(255,210,140,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, W, H);
    }
    const scale = 1 + 0.55 * Math.min(1, k * 2.2);
    Sp.drawUnit(ctx, ent, { t: R.t, scale: scale, showBars: false, alpha: 1, flash: 0.25 });
    ctx.restore();
  }

  // ---------------------------------------------------------------- 遮罩层
  // 归属：战报 / 暂停的文字面板归 DOM（ui.js），canvas 只留「很轻」的视觉提示
  function drawPaused(ctx) {
    ctx.save();
    // 四角暗角（不遮住中间：DOM 的暂停面板在中间）
    if (ctx.createRadialGradient) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.86);
      g.addColorStop(0, 'rgba(4,8,18,0)');
      g.addColorStop(1, 'rgba(4,8,18,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = 'rgba(4,8,18,0.22)';
      ctx.fillRect(0, 0, W, H);
    }
    // 左下角小角标
    const A = CC.assets, Sp = CC.sprites;
    const img = (A && A.texture) ? (A.texture('paused') || null) : null;
    const x = 16, y = H - 46;
    ctx.fillStyle = 'rgba(6,10,20,0.72)';
    Sp.roundRect(ctx, x, y, 132, 30, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(127,227,255,0.45)';
    ctx.lineWidth = 1;
    Sp.roundRect(ctx, x + 0.5, y + 0.5, 131, 29, 7);
    if (ctx.stroke) ctx.stroke();
    if (img) {                       // 用 paused.png 当小图标
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(img, x + 6, y + 5, 34, 20);
      ctx.restore();
    }
    if (ctx.fillText) {
      ctx.font = 'bold 13px ' + FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#cdf0ff';
      ctx.fillText('已暂停', x + 46, y + 16);
    }
    ctx.restore();
  }

  // 战报：只在顶部中间留一个小角标（其余交给 DOM 战报面板）
  function reportTitleOf(rep, view) {
    const w = (rep && rep.winner) || null;
    const label = (rep && rep.winnerLabel) || (view && view.winnerLabel) || null;
    if (label) return label === '双方同归于尽' ? label : (label + '胜');
    if (w === 'A') return '左方胜';
    if (w === 'B') return '右方胜';
    return '双方同归于尽';
  }

  function drawReport(ctx, match, view) {
    const rep = (view && view.report) ? view.report : (match && typeof match.report === 'function' ? safeReport(match) : null);
    const Sp = CC.sprites;
    const text = '本场结束 · ' + reportTitleOf(rep, view);
    ctx.save();
    // 只压一点点暗，让中间交给 DOM 面板
    ctx.fillStyle = 'rgba(4,6,16,0.22)';
    ctx.fillRect(0, 0, W, H);
    const pw = Math.max(180, (ctx.measureText && ctx.fillText ? 0 : 0) + 200), x = (W - pw) / 2, y = 84;
    ctx.fillStyle = 'rgba(8,13,26,0.86)';
    Sp.roundRect(ctx, x, y, pw, 32, 8); ctx.fill();
    const isDraw = /同归于尽/.test(text);
    ctx.strokeStyle = isDraw ? 'rgba(255,209,102,0.65)' : 'rgba(127,227,255,0.6)';
    ctx.lineWidth = 1.4;
    Sp.roundRect(ctx, x + 0.5, y + 0.5, pw - 1, 31, 8);
    if (ctx.stroke) ctx.stroke();
    if (ctx.fillText) {
      ctx.font = 'bold 15px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isDraw ? '#ffe066' : '#dff4ff';
      ctx.fillText(text, x + pw / 2, y + 17);
    }
    ctx.restore();
  }

  function safeReport(match) {
    try { return match.report(); } catch (e) { return null; }
  }

  function sideCount(obj, side) {
    // 兼容 {A,B} / {a,b} / {left,right} / 数字 多种形状
    if (obj === undefined || obj === null) return null;
    if (typeof obj === 'number') return obj;
    const keys = side === 'B' ? ['B', 'b', 'right', 'B方', '右'] : ['A', 'a', 'left', 'A方', '左'];
    for (let i = 0; i < keys.length; i++) {
      const v = obj[keys[i]];
      if (typeof v === 'number') return v;
      if (Array.isArray(v)) return v.length;
    }
    return null;
  }

  function drawPlacingHints(ctx, view, slots) {
    if (!ctx.fillText) return;
    const bench = view && view.bench;
    const n = Array.isArray(bench) ? bench.length : 0;
    const b = view && view.board;
    let auto = '';
    if (b && typeof b.autoStartIn === 'function') {
      try { auto = ' · ' + Math.max(0, Math.ceil(b.autoStartIn())) + 's 后自动开战'; } catch (e) { auto = ''; }
    }
    // 两侧上阵数：优先用外壳给的 view.placed / view.sizes，其次按槽位统计
    let placedA = null, placedB = null;
    const vp = view && view.placed;
    placedA = sideCount(vp, 'A');
    placedB = sideCount(vp, 'B');
    if (placedA === null || placedB === null) {
      let ca = 0, cb = 0;
      if (slots) {
        for (let i = 0; i < slots.length; i++) {
          if (!slots[i].unitId) continue;
          if (slots[i].side === 'B') cb++; else ca++;
        }
      }
      if (placedA === null) placedA = ca;
      if (placedB === null) placedB = cb;
    }
    const vs = view && view.sizes;
    let sizeA = sideCount(vs, 'A'), sizeB = sideCount(vs, 'B');
    if (sizeA === null) sizeA = 6;
    if (sizeB === null) sizeB = 6;
    const text = '摆阵 · 左 ' + placedA + '/' + sizeA + ' · 右 ' + placedB + '/' + sizeB +
      (n ? ' · 待放置 ' + n : '') + auto;
    const w = Math.max(300, (ctx.measureText ? ctx.measureText(text).width : text.length * 9) + 40);
    ctx.save();
    ctx.font = 'bold 15px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(4,8,18,0.62)';
    CC.sprites.roundRect(ctx, W / 2 - w / 2, H - 52, w, 34, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(127,227,255,0.35)';
    ctx.lineWidth = 1;
    CC.sprites.roundRect(ctx, W / 2 - w / 2, H - 52, w, 34, 8);
    if (ctx.stroke) ctx.stroke();
    ctx.fillStyle = '#d8f4ff';
    ctx.fillText(text, W / 2, H - 34);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 故障位移
  function glitchBlit(mainCtx) {
    const k = clamp(R.glitchT / 0.16, 0, 1) * R.glitchAmp;
    if (!R.bufOK || !R.buf || k <= 0.02) return false;
    try {
      const slices = 18;
      const sh = H / slices;
      mainCtx.save();
      for (let i = 0; i < slices; i++) {
        const off = (rnd() - 0.5) * 26 * k * (i % 3 === 0 ? 1.6 : 1);
        mainCtx.drawImage(R.buf, 0, i * sh, W, sh, off, i * sh, W, sh);
      }
      mainCtx.restore();
      const A = CC.assets;
      const gl = A && A.texture ? A.texture('glitch') : null;
      if (gl) {
        mainCtx.save();
        mainCtx.globalAlpha = 0.26 * k;
        if ('globalCompositeOperation' in mainCtx) mainCtx.globalCompositeOperation = 'lighter';
        mainCtx.drawImage(gl, 0, -30 + rnd() * 60, W, H * 0.46);
        mainCtx.restore();
      }
      return true;
    } catch (e) { return false; }
  }

  function drawVignette(ctx) {
    if (!ctx.createRadialGradient) return;
    ctx.save();
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, H * 0.92);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(2,3,10,0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 主绘制
  function renderScene(ctx, match, view, st, phase, paused) {
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    drawBackground(ctx, phase);
    drawZones(ctx, st);
    drawChargeWarns(ctx, st);
    drawRains(ctx, st);
    drawPickups(ctx, st);
    let slots = null;
    if (phase === 'placing') {
      slots = normalizeSlots(view);
      drawPlacingSlots(ctx, slots, view && view.hover);
    }
    drawParticles(ctx, 'ground');
    const entRes = drawEntities(ctx, st, view, phase);
    slots = entRes.slots || slots;
    drawParticles(ctx, 'air');
    drawJarFront(ctx);
    drawComboTags(ctx, st);
    drawUltFocus(ctx);
    drawParticles(ctx, 'front');
    drawTexts(ctx);
    drawCallouts(ctx);
    drawBanners(ctx);
    drawHud(ctx, st, match, view);
    if (phase === 'placing') drawPlacingHints(ctx, view, slots);
    drawVignette(ctx);
    ctx.restore();
  }

  function draw(match, view) {
    const v = view || {};
    const canvas = (v.canvas) || R.canvas;
    const top = ensureCtx(canvas);
    if (!top) return null;
    // match 可能是 match（含 battle）也可能是裸 battle
    let battle = null;
    if (match) {
      if (match.battle && match.battle.state) battle = match.battle;
      else if (match.state && (Array.isArray(match.state.A) || Array.isArray(match.state.B) || match.state.over !== undefined)) battle = match;
    }
    const st = battle && battle.state ? battle.state : null;
    const phase = v.phase || ((match && match.state === 'report') ? 'report' : 'fighting');
    // 战报阶段不再叠暂停遮罩（否则战报卡被盖住）
    const paused = phase !== 'report' && !!(v.paused || (match && match.paused));
    R.phase = phase;
    R.paused = paused;

    // ---- 时钟（暂停 = 真冻结，动画与特效一起停）----
    const simT = st && typeof st.time === 'number' ? st.time : 0;
    let dt;
    if (phase === 'fighting' && st) {
      dt = clamp(simT - R.lastSimT, 0, 0.1);
      if (paused) dt = 0;
      R.lastSimT = simT;
    } else {
      dt = paused ? 0 : 1 / 60;
      if (phase === 'placing') R.lastSimT = simT;
    }
    R.simT = simT;
    R.dt = dt;
    R.t += dt;
    R.frame++;

    const stopped = R.hitstopT > 0;
    R.by = indexEntities(st);
    R.minionsByOwner = indexMinions(st);
    updateTimers(dt, dt * (stopped ? 0.12 : 1));
    if (st && battle) consumeEvents(battle, st, dt);
    updateCamera(st, phase, dt);

    // ---- 绘制（故障时先画到离屏，再切片错位）----
    let ctx = top;
    if (R.glitchT > 0 && R.bufOK && R.bufCtx) ctx = R.bufCtx;
    renderScene(ctx, match, v, st, phase, paused);
    if (ctx !== top) {
      const ok = glitchBlit(top);
      if (!ok) top.drawImage(R.buf, 0, 0);
    }
    // 暂停 / 战报 角标永远画在故障位移之上，保证可读
    if (phase === 'report') drawReport(top, match, v);
    if (paused) drawPaused(top);
    return { phase: phase, paused: paused, dt: dt, hitstop: stopped };
  }

  function hitstop() { return R.hitstopT > 0; }

  function reset() {
    R.parts.length = 0; R.texts.length = 0; R.banners.length = 0;
    R.hitstopT = 0; R.glitchT = 0; R.glitchAmp = 0; R.shake = { amp: 0, t: 0, dur: 1, x: 0, y: 0 };
    R.frame = 0; R.t = 0; R.lastSimT = 0; R.simT = 0;
    R.maxCombo = 0; R.combo = {}; R.comboPeak = {}; R.zoneSeen = {}; R.by = {};
    R.ult = { id: null, t: 0, dur: 0, name: '', caster: null };
    R.charging = {};
    R.counts = { drawImage: 0, fillRect: 0, fillText: 0, ops: 0 };
    R.kills = 0; R.hits = 0; R.crits = 0; R.maxParts = 0;
    if (CC.sprites && CC.sprites.setShake) CC.sprites.setShake(0, 0);
  }

  CC.render = {
    init: init,
    draw: draw,
    hitstop: hitstop,
    reset: reset,
    state: R,
    W: W, H: H,
    counts: function () { return { drawImage: R.counts.drawImage, fillRect: R.counts.fillRect, fillText: R.counts.fillText, ops: R.counts.ops }; },
    arrays: function () {
      return { parts: R.parts.length, texts: R.texts.length, banners: R.banners.length, maxParts: R.maxParts, comboKeys: Object.keys(R.combo).length };
    },
    debug: function () { return R; },
    // 渲染层需要的 view 字段（供 shell-ui 对齐）
    viewFields: ['phase', 'paused', 'board', 'hover', 'bench', 'report', 'canvas'],
  };
})();
