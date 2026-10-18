/* ===========================================================
   赛博斗蛐蛐 · 单位 AI
   —— 决策频率 0.25s；技能按 unit.policy 的条件 DSL 释放
   —— 目标：会走位、会风筝、会绕后、会躲预警区，绝不站桩
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util;

  function foesOf(battle, e) { return (e.side === 'A' ? battle.B : battle.A).filter((o) => o.alive); }
  function alliesOf(battle, e) { return (e.side === 'A' ? battle.A : battle.B).filter((o) => o.alive); }

  function nearest(battle, e, list) {
    let best = null, bd = Infinity;
    for (const o of list) {
      const d = U.dist2(e.x, e.z, o.x, o.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  function targetRange(e) { return e.unit.stats.range; }

  /** 条件 DSL 求值 */
  function cond(battle, e, c) {
    if (!c) return false;
    const when = c.when || 'always';
    switch (when) {
      case 'always': return true;
      case 'energyFull': return e.energy >= 100;
      case 'selfHpBelow': return e.hp / e.maxHp <= (c.v == null ? 0.5 : c.v);
      case 'selfHpAbove': return e.hp / e.maxHp >= (c.v == null ? 0.7 : c.v);
      case 'alliesBelow': return alliesOf(battle, e).length <= (c.n == null ? 3 : c.n);
      case 'enemiesAbove': return foesOf(battle, e).length >= (c.n == null ? 1 : c.n);
      // 收集型资源（例如凑企鹅的石头）
      case 'stacksAbove': {
        const k = c.kind || (e.trait && e.trait.collect) || 'stone';
        return (e.stacks[k] || 0) >= (c.n == null ? 1 : c.n);
      }
      case 'stacksBelow': {
        const k = c.kind || (e.trait && e.trait.collect) || 'stone';
        return (e.stacks[k] || 0) <= (c.n == null ? 0 : c.n);
      }
      case 'enemyMarked': {
        const list = foesOf(battle, e);
        return list.some((o) => {
          for (const b of o.buffs) if (b.kind === 'marked' && b.t < b.dur) return true;
          return false;
        });
      }
      case 'enemyInRange': {
        const t = nearest(battle, e, foesOf(battle, e));
        if (!t) return false;
        return U.dist(e.x, e.z, t.x, t.z) <= (c.range == null ? 200 : c.range);
      }
      case 'enemyStunned': {
        const list = foesOf(battle, e);
        return list.some((o) => o.hitstun > 0 || o.state === 'stun');
      }
      case 'lowestAllyHpBelow': {
        const list = alliesOf(battle, e);
        if (!list.length) return false;
        let lo = 1;
        for (const a of list) lo = Math.min(lo, a.hp / a.maxHp);
        return lo <= (c.v == null ? 0.5 : c.v);
      }
      default:
        return false;
    }
  }

  /** 返回本 tick 想放的技能 key（引擎会再做一次 canCast 硬校验） */
  function wantSkill(battle, e) {
    if (e.isMinion) return null;
    if (e.cast || e.dash) return null;
    const p = e.unit.policy || {};
    const order = ['ult', 's2', 's1'];
    for (const key of order) {
      const sk = e.unit[key];
      if (!sk) continue;
      if (key === 'ult' && e.energy < 100) continue;
      if (key === 's2' && e.cds.s2 > 0) continue;
      if (key === 's2' && e.energy < (sk.cost || 0)) continue;
      if (key === 's1' && e.cds.s1 > 0) continue;
      const c = p[key];
      if (!c) continue;
      if (cond(battle, e, c)) return key;
    }
    // 兜底：取消平A后，技能就是唯一的输出手段 —— 条件没满足也要放，绝不允许站着不动
    for (const key of ['s1', 's2']) {
      const sk = e.unit[key];
      if (!sk) continue;
      if (key === 's1' && e.cds.s1 > 0) continue;
      if (key === 's2' && (e.cds.s2 > 0 || e.energy < (sk.cost || 0))) continue;
      return key;
    }
    return null;
  }

  /** 走位与目标选择 */
  function decide(battle, e) {
    const foes = foesOf(battle, e);
    if (!foes.length) return { mode: 'idle', targetId: 0, wantRange: targetRange(e) };

    const role = e.unit.role;
    const hpRatio = e.hp / e.maxHp;

    // 收集型单位：优先去捡（凑企鹅捡石头）——只有敌人贴脸或自己快死了才先打架
    const tr = e.trait;
    if (tr && tr.collect && battle.pickups && battle.pickups.length) {
      const have = e.stacks[tr.collect] || 0;
      const max = tr.max == null ? 10 : tr.max;
      const nearestFoeD = foes.length
        ? Math.min.apply(null, foes.map((o) => U.dist(e.x, e.z, o.x, o.z))) : 1e9;
      const tooClose = nearestFoeD < 70;                 // 贴脸才放弃捡
      const lowHp = hpRatio < 0.3;                       // 血量过低时先自保
      const starved = (e.noDmgT || 0) > 6;               // 6 秒没打出伤害就先去打人，别一直捡
      if (have < max && !tooClose && !lowHp && !starved) {
        // 挑石头要挑"安全"的：距离近 + 远离敌人
        let best = null, bestScore = Infinity;
        for (const p of battle.pickups) {
          if (p.kind !== tr.collect) continue;
          const d = U.dist(e.x, e.z, p.x, p.z);
          let danger = 0;
          for (const o of foes) {
            const dp = U.dist(p.x, p.z, o.x, o.z);
            if (dp < 260) danger += (260 - dp) / 260;
          }
          const score = d * 0.5 + danger * 420;
          if (score < bestScore) { bestScore = score; best = p; }
        }
        if (best) {
          const t = nearest(battle, e, foes);
          return { mode: 'collect', targetId: t ? t.id : 0, pickupId: best.id, wantRange: targetRange(e) };
        }
      }
    }

    // 低血：远程/辅助/刺客后撤，坦克继续顶
    if (hpRatio < 0.32 && (role === 'ranged' || role === 'support')) {
      const t = nearest(battle, e, foes);
      return { mode: 'retreat', targetId: t ? t.id : 0, wantRange: targetRange(e) };
    }

    // 绕后：刺客优先切后排
    if (role === 'assassin') {
      const back = foes.filter((o) => o.lane === 1);
      const t = back.length ? nearest(battle, e, back) : nearest(battle, e, foes);
      return { mode: 'flank', targetId: t ? t.id : 0, wantRange: targetRange(e) };
    }

    // 远程/辅助：只有真远程才拉距离风筝；近战范围的辅助（如张维为）必须贴上去打
    const meleeReach = targetRange(e) + e.unit.radius * 0.5 + 8;
    if (role === 'ranged' && targetRange(e) > 150) {
      const t = nearest(battle, e, foes);
      return { mode: 'kite', targetId: t ? t.id : 0, wantRange: Math.max(140, targetRange(e) * 0.7) };
    }
    if (role === 'support' && targetRange(e) > 150) {
      const t = nearest(battle, e, foes);
      return { mode: 'kite', targetId: t ? t.id : 0, wantRange: Math.max(140, targetRange(e) * 0.7) };
    }

    // 坦克/近战：先咬最近的目标，优先前排
    const front = foes.filter((o) => o.lane === 0);
    const t = (front.length ? nearest(battle, e, front) : nearest(battle, e, foes));
    const mode = hpRatio < 0.2 && role === 'bruiser' ? 'kite' : 'approach';
    return { mode, targetId: t ? t.id : 0, wantRange: targetRange(e) };
  }

  CC.ai = { decide, wantSkill, cond, _foesOf: foesOf, _alliesOf: alliesOf };
})();
