/* ===========================================================
   赛博斗蛐蛐 · 主装配与主循环（main）—— 上帝视角观赛/摆阵
   阶段状态机：摆阵(placing) → 对战(fighting) → 战报(report) → 自动重开一场
   玩家可做的：给左右任一侧摆阵（含人数 1~6）、暂停/继续（空格或按钮）、重新开始
   —— 无倍速、无跳过、无应援、无装备/掉落/成长
   截图钩子（仅 ?shot= 时生效）：?shot=placing|fighting|paused|report&seed=123&speed=4
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});

  const SAVE_KEY = 'cyber-cricket-save-v1';
  const SAVE_VERSION = 3;

  const CONFIG = {
    countdownSeconds: 5,     // 停手自动开打
    reportSeconds: 3,        // 战报停留
    maxFrameDt: 0.05,
    debugSpeedMax: 16,
    placeShotCount: 3,       // ?shot=placing 时每侧预置的单位数（便于截图看清布阵）
    defaultSize: 6,
  };

  const TIPS = '左 / 右任一侧都能摆阵（拖放或点击放置，可拖回单位池） · 人数可用 ± 调整 · 空格 或 按钮 暂停/继续 · 重新开始 · 停手 5 秒自动开打';

  const state = {
    booted: false,
    phase: 'placing',      // placing | fighting | report
    paused: false,
    running: false,
    manual: false,
    round: 0,              // 已打场数（内部计数 + 对局等级曲线）
    level: 1,              // 中立对局等级
    match: null,
    report: null,
    reportTimer: 0,
    winner: null,
    seed: 0,
    seedBase: 2026,
    battleClock: 0,
    query: {},
    shot: '',
    shotFreeze: false,
    fastForward: false,
    ffTick: 0,
    speed: 1,
    error: null,
    saveCorrupted: false,
    fallbackBattle: false,
    hudSig: '',
  };

  let canvas = null;
  let rafId = 0;
  let prevTs = 0;
  let loopStarted = false;

  // ---------- 基础设施（全部判空，Node 打桩 DOM 下可跑） ----------
  function number(v, d) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : d;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function board() { return CC.board || null; }
  function waves() { return CC.waves || null; }
  function ui() { return CC.ui || null; }
  function byId(id) {
    if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') return null;
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function mmss(sec) {
    const U = CC.util;
    if (U && typeof U.mmss === 'function') return U.mmss(sec);
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ---------- 错误捕获：红屏面板，不白屏 ----------
  function stackLines(err) {
    let s = '';
    try {
      if (err && err.stack) s = String(err.stack);
      else if (err && err.message) s = String(err.message);
    } catch (e) { s = ''; }
    return s.split('\n').slice(0, 6).map((l) => l.replace(/\s+$/, ''));
  }

  let lastErrMsg = '';
  function fail(err, source, lineno) {
    const msg = (err && err.message) ? String(err.message)
      : (err === undefined || err === null) ? '未知错误'
        : (typeof err === 'string' ? err : String(err));
    const full = source ? (msg + ' @ ' + source + (lineno ? ':' + lineno : '')) : msg;
    if (full === lastErrMsg) return state.error;      // 同一条错误不重复刷屏
    lastErrMsg = full;
    state.error = full;
    const lines = stackLines(err);
    try { if (ui() && ui().showError) ui().showError(full, lines); } catch (e) { /* ignore */ }
    try { if (typeof console !== 'undefined' && console && console.error) console.error('[CC]', full, lines.join('\n')); } catch (e) { /* ignore */ }
    return state.error;
  }

  function safe(fn, label) {
    try { return fn(); } catch (e) { fail(e, label ? ('main.' + label) : 'main'); return null; }
  }

  function installErrorHooks() {
    const handler = function (message, source, lineno, colno, error) {
      fail(error || message, source, lineno);
      return true;    // 已显示红屏，阻止默认白屏行为
    };
    try { globalThis.onerror = handler; } catch (e) { /* ignore */ }
    if (typeof globalThis.addEventListener === 'function') {
      try {
        globalThis.addEventListener('error', function (e) {
          fail(e && (e.error || e.message), e && e.filename, e && e.lineno);
        });
      } catch (e) { /* ignore */ }
      try {
        globalThis.addEventListener('unhandledrejection', function (e) {
          fail(e && e.reason, 'unhandledrejection');
        });
      } catch (e) { /* ignore */ }
    }
  }

  // ---------- 存档 ----------
  function storage() {
    try {
      const ls = globalThis.localStorage;
      if (!ls) return null;
      if (typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
      return ls;
    } catch (e) { return null; }
  }

  function size2(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return CONFIG.defaultSize;
    return clamp(Math.round(n), 1, 6);
  }

  function validateSave(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const out = { round: 0, level: 1, sizes: { A: CONFIG.defaultSize, B: CONFIG.defaultSize }, lineup: { A: [], B: [] } };
    let corrupt = false;
    if (d.round !== undefined && d.round !== null) {
      if (typeof d.round !== 'number' || !isFinite(d.round)) return null;   // 结构损坏
      out.round = Math.max(0, d.round);
    }
    const sz = d.size || d.sizes;
    if (sz !== undefined && sz !== null) {
      if (typeof sz !== 'object' || Array.isArray(sz)) return null;         // 结构损坏
      ['A', 'B'].forEach((k) => {
        if (sz[k] === undefined || sz[k] === null) return;
        if (typeof sz[k] !== 'number' || !isFinite(sz[k])) { corrupt = true; return; }
        out.sizes[k] = size2(sz[k]);
      });
      if (corrupt) return null;
    }
    const lu = d.lineup !== undefined ? d.lineup : null;
    if (lu !== undefined && lu !== null) {
      if (Array.isArray(lu)) {                       // 旧格式：只有一侧的数组
        out.lineup.A = lu.slice(0, 6).map(strOrNull);
      } else if (typeof lu === 'object') {
        if (lu.A !== undefined && lu.A !== null && !Array.isArray(lu.A)) return null;   // 结构损坏
        if (lu.B !== undefined && lu.B !== null && !Array.isArray(lu.B)) return null;   // 结构损坏
        out.lineup.A = Array.isArray(lu.A) ? lu.A.slice(0, 6).map(strOrNull) : [];
        out.lineup.B = Array.isArray(lu.B) ? lu.B.slice(0, 6).map(strOrNull) : [];
      } else return null;                            // 结构损坏
    }
    out.level = (waves() && waves().nextDifficulty) ? waves().nextDifficulty(out.round) : 1;
    return out;
  }

  function strOrNull(v) {
    return (v === null || v === undefined || v === '') ? null : String(v);
  }

  function loadSave() {
    const s = storage();
    if (!s) return { ok: false, corrupted: false, missing: true, data: null };
    let raw = null;
    try { raw = s.getItem(SAVE_KEY); } catch (e) { return { ok: false, corrupted: false, missing: true, data: null }; }
    if (raw === null || raw === undefined || raw === '') return { ok: false, corrupted: false, missing: true, data: null };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = undefined; }
    const norm = parsed === undefined ? null : validateSave(parsed);
    if (!norm) {
      try { if (typeof s.removeItem === 'function') s.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
      return { ok: false, corrupted: true, missing: false, data: null };
    }
    return { ok: true, corrupted: false, missing: false, data: norm };
  }

  function saveNow() {
    const s = storage();
    if (!s) return false;
    const B = board();
    const data = {
      version: SAVE_VERSION,
      round: state.round,
      size: (B && B.sizes) ? B.sizes() : { A: CONFIG.defaultSize, B: CONFIG.defaultSize },
      lineup: (B && B.rawSlots) ? B.rawSlots() : { A: [], B: [] },
    };
    try { s.setItem(SAVE_KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
  }

  // ---------- 种子（确定性，不用 Date.now 作为模拟输入） ----------
  function hashParts(parts) {
    const U = CC.util;
    if (U && typeof U.hashParts === 'function') {
      try { return U.hashParts(parts) >>> 0; } catch (e) { /* fallthrough */ }
    }
    let h = 2166136261 >>> 0;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  function boardSig() {
    const B = board();
    if (!B || typeof B.rawSlots !== 'function') return '';
    try {
      const r = B.rawSlots();
      return (r.A || []).join(',') + '|' + (r.B || []).join(',');
    } catch (e) { return ''; }
  }

  function nextSeed(tag) {
    return hashParts(['cc', tag || 'x', state.seedBase >>> 0, state.round,
      Math.round(state.level * 100), boardSig()]) >>> 0;
  }

  // ---------- 降级对战（仅当 CC.battle 未交付时兜底，保证外壳可独立运行） ----------
  function fallbackMatch(seed, lineupA, lineupB) {
    state.fallbackBattle = true;
    let rand = 0.6;
    const U = CC.util;
    if (U && typeof U.RNG === 'function') rand = U.RNG((seed >>> 0) || 1).next();
    else rand = ((seed >>> 0) % 1000) / 1000;
    const winA = rand > 0.45;
    const limit = 10 + Math.floor(rand * 8);
    const m = {
      state: 'fighting',
      paused: false,
      speed: 1,
      battle: { time: 0, over: false, result: null, ramp: 1, A: [], B: [] },
      t: 0,
      seed: seed,
      lineup: { A: lineupA, B: lineupB },
      tick(dt) {
        if (m.paused) return 0;
        m.t += Math.max(0, number(dt, 0));
        m.battle.time = m.t;
        if (m.t >= limit) {
          m.state = 'report';
          m.battle.over = true;
          m.battle.result = winA ? 'A' : 'B';
        }
        return 1;
      },
      pause() { m.paused = true; return true; },
      resume() { m.paused = false; return true; },
      togglePause() { m.paused = !m.paused; return m.paused; },
      skipToEnd() { m.t = limit; m.state = 'report'; m.battle.over = true; m.battle.time = limit; return true; },
      restart(seed2) { m.t = 0; m.state = 'fighting'; m.seed = seed2 || seed; return m; },
      done() { return m.state === 'report'; },
      over() { return m.state === 'report'; },
      report() {
        const winner = m.battle.result;
        const total = Math.max(lineupA.length, lineupB.length) || 1;
        return {
          winner: winner === 'draw' ? null : winner,
          result: winner,
          reason: winner ? 'wipe' : 'double-ko',
          winnerLabel: winner === 'A' ? '左方' : winner === 'B' ? '右方' : '双方同归于尽',
          duration: m.t,
          seconds: mmss(m.t),
          dmgByUnit: {},
          killsByUnit: {},
          maxCombo: 7,
          mvp: (lineupA[0] && lineupA[0].id) || null,
          mvpDmg: 0,
          grade: 'B',
          survivors: winner ? total - Math.floor(rand * 3) : 0,
          totalUnits: total,
          picked: {},
          fallback: true,
        };
      },
    };
    return m;
  }

  // ---------- 阶段流转 ----------
  function phaseText() {
    const base = state.phase === 'fighting' ? '对战' : state.phase === 'report' ? '战报' : '摆阵';
    return state.paused ? (base + ' · 暂停') : base;
  }

  function countAlive(list) {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e && (e.alive === undefined ? true : e.alive)) n++;
    }
    return n;
  }

  function aliveCounts() {
    const m = state.match;
    const b = m && m.battle;
    if (b) {
      if (typeof b.aliveCount === 'function') {
        try { return { a: b.aliveCount('A'), b: b.aliveCount('B') }; } catch (e) { /* fallthrough */ }
      }
      if (Array.isArray(b.A) && Array.isArray(b.B)) {
        return { a: countAlive(b.A), b: countAlive(b.B) };
      }
    }
    if (state.phase === 'report' && state.report) {
      const rep = state.report;
      if (typeof rep.survivors === 'number') {
        if (rep.winner === 'A') return { a: rep.survivors, b: 0 };
        if (rep.winner === 'B') return { a: 0, b: rep.survivors };
        return { a: 0, b: 0 };
      }
    }
    const B = board();
    if (!B) return { a: 0, b: 0 };
    const c = B.countAll();
    return { a: c.A, b: c.B };
  }

  function matchTime() {
    const m = state.match;
    if (state.phase === 'placing') return 0;
    if (m && m.battle && typeof m.battle.time === 'number') return m.battle.time;
    return state.battleClock;
  }

  function placingHint() {
    const B = board();
    if (!B || state.phase !== 'placing') return '';
    const sz = B.sizes();
    const c = B.countAll();
    return '左方已上阵 ' + c.A + ' / ' + sz.A + ' · 右方已上阵 ' + c.B + ' / ' + sz.B +
      '（空的一侧会自动随机满编）';
  }

  function updateHud() {
    const B = board();
    if (!B) return;
    const countdown = state.phase === 'placing' ? B.autoStartIn() : 0;
    const side = B.activeSide();
    const alive = aliveCounts();
    const hint = placingHint();
    const time = mmss(matchTime());
    const bench = B.benchIds(side).length;
    const pool = B.poolIds().length;
    const sz = B.sizes();
    const sig = [state.phase, state.paused ? 1 : 0, state.round, state.level, side, sz.A, sz.B,
      countdown.toFixed(1), bench, pool, alive.a, alive.b, time, state.shot, hint].join('|');
    if (sig === state.hudSig) return;
    state.hudSig = sig;
    try {
      ui().setStats({
        aliveA: alive.a, aliveB: alive.b, time: time,
        countdown: countdown, bench: bench, pool: pool,
        placingHint: hint, level: state.level, round: state.round,
        sizes: { A: sz.A, B: sz.B },
      });
      ui().setPhase(phaseText());
      ui().setSide(side);
    } catch (e) { fail(e, 'updateHud'); }
  }

  function render() {
    const R = CC.render;
    if (!R || typeof R.draw !== 'function') return;
    const B = board();
    const I = CC.input && CC.input.state ? CC.input.state : null;
    const side = B ? B.activeSide() : 'A';
    const sz = B ? B.sizes() : { A: 6, B: 6 };
    const c = B ? B.countAll() : { A: 0, B: 0 };
    const view = {
      board: B ? B.allSlots() : [],          // 两侧启用中的槽位（index 全局唯一）
      phase: state.phase,
      paused: state.paused,
      hover: I ? I.hover : null,
      bench: B ? B.benchIds(side) : [],
      report: state.report,                  // render.js 的 viewFields：让它拿真实战报
      canvas: canvas,
      selection: I ? I.selected : null,
      side: side,                            // 当前摆阵侧
      countdown: state.phase === 'placing' && B ? B.autoStartIn() : 0,
      sizes: { A: sz.A, B: sz.B },           // 两侧上场人数
      placed: { A: c.A, B: c.B },            // 两侧已上阵数（渲染层提示文案可用）
      level: state.level,
      round: state.round,
      alive: aliveCounts(),
    };
    safe(() => R.draw(state.match, view), 'render');
  }

  function syncMatchPause() {
    const m = state.match;
    if (m) {
      try {
        if (state.paused && typeof m.pause === 'function') m.pause();
        else if (!state.paused && typeof m.resume === 'function') m.resume();
        else if (typeof m.togglePause === 'function' && !!(m.paused) !== state.paused) m.togglePause();
      } catch (e) { fail(e, 'pause'); }
    }
    const A = CC.assets;
    if (A) {
      try {
        if (state.paused && typeof A.pauseAll === 'function') A.pauseAll();
        else if (!state.paused && typeof A.resumeAll === 'function') A.resumeAll();
      } catch (e) { /* 音频降级，忽略 */ }
    }
  }

  function setPaused(on) {
    const v = !!on;
    if (state.paused === v) { syncMatchPause(); return state.paused; }   // 幂等
    state.paused = v;
    syncMatchPause();
    if (ui() && ui().setPaused) safe(() => ui().setPaused(v), 'setPaused');
    state.hudSig = '';
    updateHud();
    return state.paused;
  }

  function togglePause() { return setPaused(!state.paused); }

  // 空着的一侧按它的人数上限自动随机满编（两侧都兜底）
  function fillEmptySides(seed) {
    const B = board();
    if (!B) return { A: 0, B: 0 };
    const out = { A: 0, B: 0 };
    const sz = B.sizes();
    ['A', 'B'].forEach((sd, k) => {
      if (B.filledCount(sd) > 0) return;
      const need = sz[sd];
      const sv = (seed === undefined || seed === null) ? null : ((seed + k * 7919) >>> 0);
      const W = waves();
      let n = 0;
      if (W && typeof W.enemySquad === 'function') {
        const squad = W.enemySquad({ count: need, difficulty: state.level, seed: sv === null ? nextSeed('fill' + sd) : sv, exclude: [] });
        n = B.applySquad(squad, sd);
      }
      if (n < need) n += B.autoFill(sd, sv === null ? nextSeed('fill' + sd) : sv);
      out[sd] = n;
    });
    return out;
  }

  function startFight() {
    const B = board();
    if (!B) return null;
    fillEmptySides(nextSeed('fill'));
    const seed = nextSeed('battle');
    const lu = B.lineup();
    let m = null;
    const BT = CC.battle;
    if (BT && typeof BT.createMatch === 'function') {
      try { m = BT.createMatch({ seed: seed, lineup: { A: lu.A, B: lu.B } }); } catch (e) { fail(e, 'battle.createMatch'); m = null; }
    }
    if (!m) m = fallbackMatch(seed, lu.A, lu.B);

    state.match = m;
    state.seed = seed;
    state.phase = 'fighting';
    state.battleClock = 0;
    state.report = null;
    state.reportTimer = 0;
    if (state.paused) syncMatchPause();
    try { ui().hideReport(); } catch (e) { /* ignore */ }
    try { ui().setPhase(phaseText()); } catch (e) { /* ignore */ }
    const A = CC.assets;
    if (A && typeof A.music === 'function') safe(() => A.music('bgm_battle_loop'), 'assets.music');
    state.hudSig = '';
    updateHud();
    return m;
  }

  function matchOver(m) {
    if (!m) return true;
    if (m.state === 'report' || m.state === 'over' || m.state === 'done') return true;
    if (typeof m.done === 'function') {
      try { if (m.done()) return true; } catch (e) { /* ignore */ }
    }
    if (typeof m.over === 'function') {
      try { if (m.over()) return true; } catch (e) { /* ignore */ }
    }
    if (m.battle && m.battle.over) return true;
    return false;
  }

  function enterReport() {
    const m = state.match;
    let rep = null;
    if (m && typeof m.report === 'function') safe(() => { rep = m.report(); }, 'report');
    if (!rep || typeof rep !== 'object') {
      rep = {
        winner: null, reason: 'double-ko', winnerLabel: '双方同归于尽',
        duration: state.battleClock, dmgByUnit: {}, killsByUnit: {},
        maxCombo: 0, mvp: null, grade: '—', picked: {},
      };
    }
    const winner = (rep.winner === 'A' || rep.winner === 'B') ? rep.winner : null;
    state.report = rep;
    state.winner = winner;
    state.round += 1;
    const W = waves();
    state.level = (W && typeof W.nextDifficulty === 'function') ? W.nextDifficulty(state.round) : 1;
    state.phase = 'report';
    state.reportTimer = CONFIG.reportSeconds;
    state.hudSig = '';
    safe(() => ui().showReport(rep), 'showReport');
    safe(() => ui().setPhase(phaseText()), 'setPhase');
    updateHud();
    saveNow();
    return rep;
  }

  function toPlacing() {
    state.match = null;
    state.report = null;
    state.reportTimer = 0;
    state.battleClock = 0;
    state.winner = null;
    state.phase = 'placing';
    const B = board();
    if (B) B.setAutoStart(CONFIG.countdownSeconds);
    safe(() => ui().hideReport(), 'hideReport');
    safe(() => ui().setPhase(phaseText()), 'setPhase');
    safe(() => ui().setStatus(TIPS), 'setStatus');
    const A = CC.assets;
    if (A && typeof A.music === 'function') safe(() => A.music('bgm_menu_loop'), 'assets.music');
    saveNow();
    state.hudSig = '';
    updateHud();
    return state.phase;
  }

  // 战报 3 秒后：自动重开一场（沿用左右双方布阵）
  function advanceFromReport() {
    safe(() => ui().hideReport(), 'hideReport');
    state.report = null;
    state.winner = null;
    state.match = null;
    startFight();
  }

  // ---------- 帧推进 ----------
  function enter(dt) {
    if (state.phase === 'placing') {
      const B = board();
      if (!B) return;
      B.tick(dt);
      if (B.shouldStart()) startFight();
      return;
    }
    if (state.phase === 'fighting') {
      const m = state.match;
      if (!m) { toPlacing(); return; }
      state.battleClock += dt;
      if (typeof m.tick === 'function') m.tick(dt);
      if (matchOver(m)) enterReport();
      return;
    }
    if (state.phase === 'report') {
      state.reportTimer -= dt;
      if (state.reportTimer <= 0) advanceFromReport();
    }
  }

  function tickCore(dt) {
    if (!state.booted) return state.phase;
    if (state.shotFreeze) {                        // 截图冻结：任何东西都不推进
      if (!state.fastForward) { updateHud(); render(); }
      return state.phase;
    }
    if (state.paused) {                            // 暂停：冻结倒计时与对局
      if (!state.fastForward) { updateHud(); render(); }
      return state.phase;
    }
    const speed = state.shot ? clamp(number(state.speed, 1), 1, CONFIG.debugSpeedMax) : 1;
    const d = clamp(number(dt, 0), 0, CONFIG.maxFrameDt) * speed;
    if (d > 0) enter(d);
    if (state.fastForward) {
      state.ffTick += 1;
      if (state.ffTick % 30 === 0) { updateHud(); render(); }
    } else {
      updateHud();
      render();
    }
    return state.phase;
  }

  function tick(dt) {
    return safe(() => tickCore(dt), 'tick');
  }

  function step(seconds, dtStep) {
    const total = Math.max(0, number(seconds, 0));
    const h = clamp(number(dtStep, 1 / 60), 1 / 240, 0.05);
    let acc = 0;
    let guard = Math.ceil(total / h) + 2;
    while (acc < total - 1e-9 && guard-- > 0) {
      tick(h);
      acc += h;
    }
    return { phase: state.phase, advanced: acc };
  }

  function startLoop() {
    if (loopStarted) return false;
    loopStarted = true;
    state.running = true;
    if (typeof requestAnimationFrame === 'function' &&
      typeof performance !== 'undefined' && typeof performance.now === 'function') {
      prevTs = performance.now();
      const frame = function (ts) {
        if (!state.running) return;
        const d = (number(ts, prevTs) - prevTs) / 1000;
        prevTs = number(ts, prevTs);
        tick(d);
        if (state.running) {
          try { rafId = requestAnimationFrame(frame); } catch (e) { state.manual = true; }
        }
      };
      try { rafId = requestAnimationFrame(frame); } catch (e) { state.manual = true; }
    } else {
      state.manual = true;    // 无头环境：外部调用 CC.main.tick(dt)
    }
    return true;
  }

  function stopLoop() {
    state.running = false;
    if (rafId && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(rafId); } catch (e) { /* ignore */ }
    }
    rafId = 0;
    loopStarted = false;
    return true;
  }

  // ---------- 玩家操作（唯一入口，供 ui/input 调用） ----------
  function handlePlace(unitId, slotIndex) {
    if (state.phase !== 'placing') return false;
    const B = board();
    if (!B) return false;
    const ok = safe(() => B.place(unitId, slotIndex), 'place');
    if (ok) {
      safe(() => ui().renderBench(B.benchIds(B.activeSide())), 'renderBench');
      saveNow();
      state.hudSig = '';
      updateHud();
    }
    return !!ok;
  }

  function handleRemove(slotIndex) {
    if (state.phase !== 'placing') return false;
    const B = board();
    if (!B) return false;
    const id = safe(() => B.remove(slotIndex), 'remove');
    if (id) {
      safe(() => ui().renderBench(B.benchIds(B.activeSide())), 'renderBench');
      saveNow();
      state.hudSig = '';
      updateHud();
    }
    return !!id;
  }

  function handleSide(side) {
    const B = board();
    if (!B) return B;
    B.setActiveSide(side);
    safe(() => ui().setSide(B.activeSide()), 'setSide');
    safe(() => ui().renderBench(B.benchIds(B.activeSide()), true), 'renderBench');
    state.hudSig = '';
    updateHud();
    render();
    return B.activeSide();
  }

  // 人数 ±：越界 clamp 到 1~6；超出的单位退回池并提示
  function handleSize(side, delta) {
    const B = board();
    if (!B) return 0;
    const next = B.setSize(side, B.size(side) + number(delta, 0));
    const chg = B.lastSizeChange ? B.lastSizeChange() : { returned: [] };
    safe(() => ui().setSideSize(side, next), 'setSideSize');
    safe(() => ui().renderBench(B.benchIds(B.activeSide()), true), 'renderBench');
    if (chg && chg.returned && chg.returned.length) {
      safe(() => ui().notice((side === 'A' ? '左方' : '右方') + '改为 ' + next + ' 人，' +
        chg.returned.length + ' 个单位已退回单位池'), 'notice');
    } else {
      safe(() => ui().notice(''), 'notice');
    }
    saveNow();
    state.hudSig = '';
    updateHud();
    render();
    return next;
  }

  function restart() {
    state.match = null;
    state.report = null;
    state.reportTimer = 0;
    state.battleClock = 0;
    state.round = 0;
    state.winner = null;
    state.shotFreeze = false;
    const W = waves();
    state.level = (W && typeof W.nextDifficulty === 'function') ? W.nextDifficulty(0) : 1;
    setPaused(false);
    state.phase = 'placing';
    safe(() => ui().hideReport(), 'hideReport');
    safe(() => ui().notice(''), 'notice');
    const B = board();
    if (B) B.setAutoStart(CONFIG.countdownSeconds);   // 两侧布阵与人数都保留
    safe(() => ui().setPhase(phaseText()), 'setPhase');
    safe(() => ui().setStatus(TIPS), 'setStatus');
    saveNow();
    state.hudSig = '';
    updateHud();
    render();
    return state.phase;
  }

  // 摆阵阶段（且该侧该槽启用、目标为空或就是自己）才允许放
  function canPlace(unitId, slotIndex) {
    if (state.phase !== 'placing') return false;
    if (unitId === undefined || unitId === null || slotIndex === undefined || slotIndex === null) return true;
    const B = board();
    if (!B) return false;
    const i = number(slotIndex, -1);
    if (i < 0 || i >= B.SLOT_COUNT * 2) return false;
    const sd = (i >= B.SLOT_COUNT) ? 'B' : 'A';
    const list = B.slots(sd);
    const s = list.filter((x) => x.index === i)[0];
    if (!s) return false;                                   // 该槽未启用
    if (s.unitId === unitId) return true;
    if (s.unitId) return false;
    return B.benchIds(sd).indexOf(unitId) >= 0;
  }

  // ---------- 截图钩子（仅 ?shot= 生效，不引入玩家可见按钮） ----------
  function readQuery() {
    const q = {};
    try {
      const loc = (typeof location !== 'undefined' && location) ? location : globalThis.location;
      const search = (loc && loc.search) ? String(loc.search) : '';
      if (search) {
        search.replace(/^\?/, '').split('&').forEach(function (kv) {
          if (!kv) return;
          const eq = kv.indexOf('=');
          const k = decodeURIComponent(eq < 0 ? kv : kv.slice(0, eq));
          const v = eq < 0 ? '1' : decodeURIComponent(kv.slice(eq + 1).replace(/\+/g, ' '));
          if (k) q[k] = v;
        });
      }
    } catch (e) { /* 忽略 */ }
    return q;
  }

  function normQuery(src) {
    const q = {};
    if (!src) return q;
    Object.keys(src).forEach(function (k) { q[String(k)] = src[k] === true ? '1' : String(src[k]); });
    return q;
  }

  function shotSeed() { return ((state.seedBase >>> 0) ^ 0x5f3759df) >>> 0; }

  // 两侧各预置几个（各自不超过人数上限），便于截图看清上帝视角
  function placeShotLineup() {
    const B = board();
    if (!B) return 0;
    let n = 0;
    ['A', 'B'].forEach((sd, k) => {
      const sz = B.sizes()[sd];
      const want = Math.min(CONFIG.placeShotCount, sz);
      const bench = B.benchIds(sd);
      if (!bench.length) return;
      const U = CC.util;
      const rng = (U && U.RNG) ? U.RNG((shotSeed() + k * 7919) >>> 0) : null;
      const order = bench.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng ? rng.int(0, i) : ((i * 7 + 3) % (i + 1));
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
      const targets = [0, 1, 5].slice(0, want);
      for (let i = 0; i < targets.length && i < order.length; i++) {
        if (B.place(order[i], B.toGlobal(sd, targets[i]))) n++;
      }
    });
    return n;
  }

  function runSeconds(seconds) {
    const h = 1 / 60;
    const dtEff = clamp(h, 0, CONFIG.maxFrameDt) *
      clamp(state.shot ? number(state.speed, 1) : 1, 1, CONFIG.debugSpeedMax);
    const steps = Math.max(1, Math.round(number(seconds, 0) / dtEff));
    state.fastForward = true;
    state.ffTick = 0;
    try {
      for (let i = 0; i < steps; i++) {
        if (state.phase !== 'fighting') break;
        safe(() => tickCore(h), 'shot');
      }
    } finally {
      state.fastForward = false;
    }
    return state.battleClock;
  }

  function runToEnd() {
    const m = state.match;
    if (m && typeof m.skipToEnd === 'function') safe(() => m.skipToEnd(), 'skipToEnd');
    const h = 1 / 60;
    const guard = 60 * 180;
    let i = 0;
    state.fastForward = true;
    state.ffTick = 0;
    try {
      while (state.phase === 'fighting' && i++ < guard) {
        safe(() => tickCore(h), 'shot');
      }
    } finally {
      state.fastForward = false;
    }
    if (state.phase !== 'report') {
      if (state.match) state.match.state = 'report';
      enterReport();
    }
    return state.phase;
  }

  function runBattleShot(seconds) {
    runSeconds(seconds);
    if (state.phase !== 'fighting') {
      state.match = null;
      state.phase = 'placing';
      startFight();
      runSeconds(Math.max(1, Math.min(4, number(seconds, 8) / 2)));
    }
    if (state.phase !== 'fighting') {
      state.phase = 'fighting';
      if (state.match) state.match.state = 'fighting';
    }
    return state.phase;
  }

  function applyShot() {
    const shot = String(state.query.shot || '').toLowerCase();
    if (!shot) { state.shot = ''; return false; }
    state.shot = shot;
    state.speed = clamp(number(state.query.speed, 1), 1, CONFIG.debugSpeedMax);
    if (state.query.seed !== undefined) {
      state.seedBase = Math.abs(Math.floor(number(state.query.seed, state.seedBase))) >>> 0;
    }

    // 截图模式回到确定性起点（不写存档）
    state.round = 0;
    const W = waves();
    state.level = (W && typeof W.nextDifficulty === 'function') ? W.nextDifficulty(0) : 1;
    state.match = null;
    state.report = null;
    state.winner = null;
    state.battleClock = 0;
    state.paused = false;
    state.shotFreeze = false;
    state.hudSig = '';
    safe(() => ui().setPaused(false), 'shot');
    safe(() => ui().hideReport(), 'shot');

    const B = board();
    if (B) {
      B.setSize('A', Number(state.query.left || 6));
      B.setSize('B', Number(state.query.right || 6));
      B.clear();
      B.setActiveSide('A');
      safe(() => ui().setSide('A'), 'shot');
    }

    if (shot === 'placing') {
      placeShotLineup();
      state.phase = 'placing';
      if (B) B.setAutoStart(CONFIG.countdownSeconds);
      safe(() => ui().setPhase(phaseText()), 'shot');
      safe(() => ui().setStatus('截图模式 ?shot=placing：摆阵阶段（倒计时冻结）'), 'shot');
      freezeShot();
      return true;
    }

    startFight();
    if (shot === 'report') {
      runToEnd();
      safe(() => ui().setPhase(phaseText()), 'shot');
      safe(() => ui().setStatus('截图模式 ?shot=report：战报面板（冻结）'), 'shot');
      freezeShot();
      return true;
    }
    runBattleShot(8);
    if (shot === 'paused') {
      setPaused(true);
      safe(() => ui().setStatus('截图模式 ?shot=paused：对战中 · 暂停遮罩'), 'shot');
    } else {
      safe(() => ui().setStatus('截图模式 ?shot=fighting：对战中'), 'shot');
    }
    freezeShot();
    return true;
  }

  // 同步推进结束：停住一切，画最后一帧，通知外部可以截图（不再进 rAF）
  function freezeShot() {
    state.shotFreeze = true;
    state.running = false;
    updateHud();
    render();
    try { if (typeof document !== 'undefined' && document) document.title = 'READY'; } catch (e) { /* ignore */ }
    try { globalThis.__CC_READY__ = true; } catch (e) { /* ignore */ }
    return state.phase;
  }

  // ---------- 调试出口 ----------
  function defineDebug() {
    const dbg = {};
    const g = function (name, getter) {
      try { Object.defineProperty(dbg, name, { get: getter, enumerable: true }); }
      catch (e) { dbg[name] = null; }
    };
    g('phase', function () { return state.phase; });
    g('round', function () { return state.round; });
    g('level', function () { return state.level; });
    g('paused', function () { return state.paused; });
    g('shot', function () { return state.shot; });
    g('shotFreeze', function () { return state.shotFreeze; });
    g('seed', function () { return state.seed; });
    g('fallback', function () { return state.fallbackBattle; });
    g('error', function () { return state.error; });
    g('report', function () { return state.report; });
    g('winner', function () { return state.report ? state.report.winner : null; });
    g('winnerLabel', function () { return state.report ? state.report.winnerLabel : null; });
    g('reason', function () { return state.report ? state.report.reason : null; });
    g('grade', function () { return state.report ? state.report.grade : null; });
    g('match', function () { return state.match; });
    g('alive', function () { return aliveCounts(); });
    g('board', function () { return board(); });
    g('ui', function () { return ui(); });
    g('input', function () { return (CC.input && CC.input.state) || null; });
    g('state', function () { return state; });
    g('save', function () {
      const B = board();
      return {
        round: state.round,
        size: (B && B.sizes) ? B.sizes() : null,
        lineup: (B && B.rawSlots) ? B.rawSlots() : null,
      };
    });
    dbg.version = 3;
    try { globalThis.__CC_DEBUG__ = dbg; } catch (e) { /* ignore */ }
    return dbg;
  }

  // ---------- 启动 ----------
  function boot(opts) {
    const o = opts || {};
    if (state.booted) return CC.main;
    state.booted = true;

    installErrorHooks();
    state.query = o.query ? normQuery(o.query) : readQuery();

    const F = CC.fighters;
    const pool = (F && typeof F.playable === 'function') ? F.playable().map((u) => u.id) : [];
    safe(() => board().init(pool), 'board.init');

    safe(() => ui().init({
      onPlace: handlePlace,
      onRemove: handleRemove,
      onPause: togglePause,
      onRestart: restart,
      onSide: handleSide,
      onSize: handleSize,
      onPickBench: function (id) { if (CC.input && CC.input.selectBench) CC.input.selectBench(id); },
    }), 'ui.init');

    // 存档：两侧布阵 + 人数 + 场数；损坏则回退默认并提示
    const save = loadSave();
    state.saveCorrupted = !!save.corrupted;
    if (save.data) {
      state.round = save.data.round || 0;
      const W0 = waves();
      state.level = (W0 && typeof W0.nextDifficulty === 'function') ? W0.nextDifficulty(state.round) : 1;
      const B0 = board();
      if (B0) {
        if (save.data.sizes) { B0.setSize('A', save.data.sizes.A); B0.setSize('B', save.data.sizes.B); }
        safe(() => B0.applyRawSlots({ size: save.data.sizes, lineup: save.data.lineup }), 'applyRawSlots');
        safe(() => ui().setSideSize('A', B0.size('A')), 'ui');
        safe(() => ui().setSideSize('B', B0.size('B')), 'ui');
      }
    } else {
      const W0 = waves();
      state.level = (W0 && typeof W0.nextDifficulty === 'function') ? W0.nextDifficulty(0) : 1;
    }

    const B1 = board();
    safe(() => ui().renderBench(B1 ? B1.benchIds(B1.activeSide()) : [], true), 'renderBench');

    canvas = o.canvas || (CC.ui && CC.ui.els && CC.ui.els.stage) || byId('stage');
    if (CC.render && typeof CC.render.init === 'function') safe(() => CC.render.init(canvas), 'render.init');
    if (CC.input && typeof CC.input.init === 'function') safe(() => CC.input.init(canvas), 'input.init');

    if (CC.assets) {
      if (typeof CC.assets.load === 'function') {
        safe(() => {
          const p = CC.assets.load();
          if (p && typeof p.then === 'function') p.then(function () { onAssetsReady(); })['catch'](function () { onAssetsReady(); });
        }, 'assets.load');
      }
      if (typeof CC.assets.music === 'function') safe(() => CC.assets.music('bgm_menu_loop'), 'assets.music');
    }

    state.phase = 'placing';
    if (B1) B1.setAutoStart(CONFIG.countdownSeconds);
    safe(() => ui().setPhase(phaseText()), 'setPhase');
    const notes = [];
    if (state.saveCorrupted) notes.push('存档损坏，已回退默认（场数 / 布阵 / 人数已重置）');
    if (!CC.battle) notes.push('对战模块未就绪：暂用内置降级对战');
    if (!CC.render) notes.push('渲染模块未就绪：仅逻辑运行');
    safe(() => ui().setStatus(notes.length ? notes.join(' · ') : TIPS), 'setStatus');
    if (notes.length) safe(() => ui().notice(notes.join(' · ')), 'notice');

    defineDebug();
    updateHud();
    render();

    // 截图钩子：同步推进到目标状态后立刻停住，绝不进入 rAF（无头浏览器虚拟时间才能跑完）
    if (state.query.shot) {
      safe(() => applyShot(), 'applyShot');
      state.manual = true;
      return CC.main;
    }

    const auto = (o.autoLoop === undefined) ? true : !!o.autoLoop;
    if (auto) startLoop(); else state.manual = true;

    return CC.main;
  }

  function onAssetsReady() {
    const B = board();
    safe(() => ui().renderBench(B ? B.benchIds(B.activeSide()) : [], true), 'renderBench');
    if (state.query.shot) {
      safe(() => applyShot(), 'applyShot');
      state.shotFreeze = true;
      state.running = false;
      try { if (typeof document !== 'undefined' && document) document.title = 'READY'; } catch (e) { /* ignore */ }
      try { globalThis.__CC_READY__ = true; } catch (e) { /* ignore */ }
    }
    render();
  }

  // ---------- 导出 ----------
  CC.main = {
    CONFIG, SAVE_KEY, TIPS,
    boot, tick, step,
    startLoop, stopLoop,
    setPaused, togglePause, restart,
    startFight, toPlacing, enterReport, advanceFromReport, fillEmptySides,
    handlePlace, handleRemove, handleSide, handleSize,
    canPlace, saveNow, loadSave, save: () => saveNow(),
    applyShot, defineDebug, fail,
    state,
  };
})();
