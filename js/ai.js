/* ===========================================================
   赛博斗蛐蛐 · 单位 AI
   —— 决策频率 0.25s；技能按 unit.policy 的条件 DSL 释放
   —— 目标评分保留锁定；按有效射程与资源择机施法，避免空挥和浪费防御技
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

  function hasBuff(e, kind) { return e.buffs.some((b) => b.kind === kind && b.t < b.dur); }

  /** 距离为主，角色偏好为辅；保留当前目标，避免每次决策都来回换人。 */
  function selectTarget(battle, e, list) {
    let best = null, bestScore = Infinity;
    const allies = alliesOf(battle, e);
    for (const o of list) {
      const d = U.dist(e.x, e.z, o.x, o.z);
      let score = d;
      if (e.unit.role === 'assassin') score -= o.lane === 1 ? 110 : 0;
      else if (e.unit.role === 'tank') score -= o.lane === 0 ? 35 : 0;
      score -= (1 - o.hp / o.maxHp) * 85;
      if (o.id === e.targetId) score -= 45;
      if (hasBuff(o, 'invuln')) score += 280;
      if (o.isMinion) score += 65;
      // 就近协同收割，不为集火横穿整个场地。
      if (d < targetRange(e) + 120) {
        score -= Math.min(2, allies.filter((a) => a !== e && a.targetId === o.id).length) * 18;
      }
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  /** 只有能打到人、补到血或收集到资源时才交技能；纯防御不在开局空放。 */
  function usefulSkill(battle, e, sk, c) {
    const foes = foesOf(battle, e);
    const target = foes.find((o) => o.id === e.targetId) || nearest(battle, e, foes);
    const steps = sk.steps || [];
    let offensive = false;
    for (const step of steps) {
      if (step.kind === 'magnet' && e.trait) {
        const kind = step.kindOf || e.trait.collect;
        if ((e.stacks[kind] || 0) < (e.trait.max || 10) && battle.pickups.some((p) =>
          p.kind === kind && U.dist(e.x, e.z, p.x, p.z) <= (step.range || 300))) return true;
      }
      if (step.kind === 'stone_rain' || step.kind === 'throw_stones') return foes.length > 0;
      if (step.kind === 'detonate') {
        offensive = true;
        if (foes.some((o) => hasBuff(o, 'marked') && U.dist(e.x, e.z, o.x, o.z) <= (step.radius || 240))) return true;
      }
      if (!(step.dmg > 0) && step.kind !== 'steal_energy') continue;
      offensive = true;
      let reach = 0;
      let targets = foes;
      switch (step.kind) {
        case 'melee': reach = step.range || 82; break;
        case 'dash': {
          reach = (step.dist || 220) + (step.radius || 46) - 12;
          const back = step.preferBack ? foes.filter((o) => o.lane === 1) : [];
          targets = back.length && (!target || target.lane !== 1)
            ? [nearest(battle, e, back)] : target ? [target] : [];
          break;
        }
        case 'projectile':
          targets = target ? [target] : [];
          reach = Math.min((step.speed || 430) * (step.life || 2) * 0.8,
            c && c.when === 'enemyInRange' ? c.range || 200 : Math.max(targetRange(e), 420));
          break;
        case 'aoe':
          if (step.at === 'target') targets = target ? [target] : [];
          reach = step.at === 'target'
            ? (c && c.when === 'enemyInRange' ? c.range || 200 : Math.max(targetRange(e), 300))
            : step.radius || 150;
          break;
        case 'delayed': reach = step.radius || 90; break;
        case 'steal_energy': reach = step.radius || 260; break;
      }
      if (reach > 0 && targets.some((o) => U.dist(e.x, e.z, o.x, o.z) <= reach + o.unit.radius * 0.5 - 4)) return true;
    }
    if (offensive) return false;
    if (steps.some((s) => s.kind === 'summon')) return foes.length > 0;
    const heal = steps.find((s) => s.kind === 'heal');
    if (heal) {
      const recipients = heal.at === 'allies' ? alliesOf(battle, e) : [e];
      return recipients.some((a) => a.hp / a.maxHp < 0.9);
    }
    const foe = nearest(battle, e, foes);
    return !!foe && U.dist(e.x, e.z, foe.x, foe.z) < Math.max(180, targetRange(e));
  }

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
    if (e.cast || e.dash || hasBuff(e, 'seal')) return null;
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
      if (cond(battle, e, c) && usefulSkill(battle, e, sk, c)) return key;
    }
    // 取消平A后，基础近战技仍要能主动出击（如王境泽的护盾+斩击）。
    // 不绕过治疗、防御技或石头库存条件，也不拿空挥代替移动。
    const basic = e.unit.s1;
    if (basic && e.cds.s1 <= 0 && p.s1 && p.s1.when === 'selfHpBelow'
        && basic.steps.some((s) => s.kind === 'melee' && s.dmg > 0)
        && usefulSkill(battle, e, basic, p.s1)) return 's1';
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
      const readyToThrow = have >= 4 && (e.cds.s2 <= 0 || e.energy >= 100);
      if (have < max && !readyToThrow && !tooClose && !lowHp && !starved) {
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

    const target = selectTarget(battle, e, foes);
    const threat = nearest(battle, e, foes);
    const threatDistance = U.dist(e.x, e.z, threat.x, threat.z);

    // 真远程受近身威胁才后撤；近战辅助残血也要进技能范围，而不是逃到打不到人。
    if (hpRatio < 0.32 && targetRange(e) > 150 && (role === 'ranged' || role === 'support')
        && threatDistance < targetRange(e) * 0.85 && (e.noDmgT || 0) < 5) {
      return { mode: 'retreat', targetId: target.id, threatId: threat.id, wantRange: targetRange(e) };
    }

    // 绕后：刺客优先切后排
    if (role === 'assassin') {
      return { mode: 'flank', targetId: target.id, wantRange: targetRange(e) };
    }

    // 远程/辅助：只有真远程才拉距离风筝；近战范围的辅助（如张维为）必须贴上去打
    if ((role === 'ranged' || role === 'support') && targetRange(e) > 150) {
      return { mode: 'kite', targetId: target.id, threatId: threat.id, wantRange: Math.max(140, targetRange(e) * 0.7) };
    }

    // 坦克/近战：先咬最近的目标，优先前排
    return { mode: 'approach', targetId: target.id, wantRange: targetRange(e) };
  }

  CC.ai = { decide, wantSkill, cond, _foesOf: foesOf, _alliesOf: alliesOf };
})();
