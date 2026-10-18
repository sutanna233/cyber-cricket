/* ===========================================================
   服务端模拟宿主（lib/simhost.js）
   -----------------------------------------------------------
   把浏览器用的那套游戏代码（util/fighters/waves/engine/ai/battle）
   原样加载进 Node，用同一份实现做两件事：
     1) 生成"第 N 场"的种子与双方阵容（可复现）
     2) 无头跑完这一场，算出它会在第几秒结束（用于排下一场的开始时刻）

   关键前提：引擎是确定性模拟（同种子 + 同阵容 → 同一结果，replay-test 守着），
   所以客户端拿同样的种子/阵容本地重放，看到的画面与服务端一模一样。
   =========================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MODULES = ['util', 'fighters', 'waves', 'engine', 'ai', 'battle'];

function loadEngine() {
  const sandbox = { console, Math, Date, JSON, Object, Array, Number, String, Boolean, Error, isFinite, parseInt, parseFloat };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const m of MODULES) {
    const p = path.join(ROOT, 'js', m + '.js');
    if (!fs.existsSync(p)) throw new Error('缺少模块 ' + m + '.js');
    vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: 'js/' + m + '.js' });
  }
  return sandbox.CC;
}

const CC = loadEngine();
const U = CC.util;

/** 用种子确定性地造一套双方阵容（两侧人数可配） */
function makeLineup(seed, sizeA, sizeB) {
  const rng = U.RNG(seed ^ 0x9e3779b9);
  const pool = CC.fighters.playable().map((u) => u.id);
  const pick = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ id: pool[rng.int(0, pool.length - 1)], slot: i, lane: i % 2 });
    return out;
  };
  const a = Math.max(1, Math.min(6, sizeA || 6));
  const b = Math.max(1, Math.min(6, sizeB || 6));
  return { A: pick(a), B: pick(b) };
}

/** 无头跑完一场，返回时长与结果（用于排下一场时间） */
function simulateRound(seed, lineup, capSeconds) {
  const m = CC.battle.createMatch({ seed, lineup });
  const cap = Math.round(60 * (capSeconds || 300));
  let n = 0;
  while (!m.battle.over && n++ < cap) m.battle.step();
  const b = m.battle;
  return {
    duration: b.time,
    over: b.over,
    result: b.result,
    reason: b.endReason,
    hash: b.hash(),
    survivors: { A: b.A.filter((e) => e.alive).length, B: b.B.filter((e) => e.alive).length },
  };
}

/** 校验：给定种子/阵容/目标 tick，本地重放到该 tick 的 hash（客户端同步用同一逻辑） */
function hashAtTick(seed, lineup, tick) {
  const m = CC.battle.createMatch({ seed, lineup });
  for (let i = 0; i < tick && !m.battle.over; i++) m.battle.step();
  return m.battle.hash();
}

module.exports = { loadEngine, makeLineup, simulateRound, hashAtTick, CC, TICK: CC.engine.TICK };
