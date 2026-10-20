/* ===========================================================
   赛博斗蛐蛐 · 单位 AI
   —— 决策频率 0.25s；技能按 unit.policy 的条件 DSL 释放
   —— 目标评分保留锁定；按有效射程与资源择机施法，避免空挥和浪费防御技
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util;

  function foesOf(battle, e) { return battle.foes(e).filter((o) => o.alive); }
  function alliesOf(battle, e) { return battle.allies(e).filter((o) => o.alive); }

  function nearest(battle, e, list) {
    let best = null, bd = Infinity;
    for (const o of list) {
      const d = U.dist2(e.x, e.z, o.x, o.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  // 面板 range 兼用于旧普攻；弹道主攻角色应按主攻技能的安全距离站位。
  // 刺客与召唤物继续沿用自身定位，混合近战连段也不会被误判成远程。
  function targetRange(e) {
    const base = e.unit.stats.range;
    if (e.isMinion || e.unit.role === 'assassin') return base;
    const firstHit = e.unit.s1 && e.unit.s1.steps.find((s) => s.dmg > 0);
    if (!firstHit || firstHit.kind !== 'projectile') return base;
    const policy = e.unit.policy && e.unit.policy.s1;
    const reach = policy && policy.when === 'enemyInRange' ? policy.range || 200
      : (firstHit.speed || 430) * (firstHit.life || 2);
    return Math.max(base, Math.min(460, reach * 0.75));
  }

  function hasBuff(e, kind) {
    return (kind === 'superArmor' && !!e.su7) || e.buffs.some((b) => b.kind === kind && b.t < b.dur);
  }

  function commitTarget(e, target) {
    if (!target) return;
    e.targetId = target.id;
    if (e.plan) e.plan.targetId = target.id;
  }

  // 只用已经公开的蓄力和距离估计音波到达时间，不预测闪避或随机命中。
  function interruptTarget(battle, e) {
    const sk = e.unit.s1, policy = e.unit.policy && e.unit.policy.s1;
    if (!sk || !policy || e.cds.s1 > 0 || e.energy < (sk.cost || 0)) return null;
    const step = sk.steps.find((s) => s.kind === 'projectile' && s.interrupt);
    if (!step) return null;
    const speed = step.speed || 430;
    const reach = Math.min(speed * (step.life || 2) * 0.8,
      policy.when === 'enemyInRange' ? policy.range || 200 : Math.max(targetRange(e), 420));
    let best = null, bestSlack = Infinity;
    for (const o of foesOf(battle, e)) {
      const c = o.cast;
      if (!c || !c.charging || hasBuff(o, 'invuln') || hasBuff(o, 'superArmor')
          || (c.skill && c.skill.uninterruptible)) continue;
      const distance = U.dist(e.x, e.z, o.x, o.z);
      if (distance > reach + o.unit.radius * 0.5 - 4) continue;
      const flight = Math.max(0, distance - 20 - (step.radius || 24) - o.unit.radius * 0.6) / speed;
      const arrival = (sk.cast == null ? 0.5 : sk.cast) + (step.t || 0) + flight + 2 / 60;
      const slack = c.chargeDur - c.chargeT - arrival;
      if (slack > 0 && slack < bestSlack) { best = o; bestSlack = slack; }
    }
    return best;
  }

  function readyBubbleBurst(battle, e, sk) {
    // 泡泡属于整队共享资源：队友的爆破尚未执行时，先让其结算，避免同时空交怒气。
    if (alliesOf(battle, e).some((ally) => {
      const cast = ally !== e && ally.cast;
      if (!cast || !Array.isArray(cast.steps)) return false;
      return cast.steps.slice(cast.charging ? 0 : (cast.idx || 0)).some((s) => s.kind === 'bubble_burst');
    })) return false;
    const step = sk.steps.find((s) => s.kind === 'bubble_burst');
    const arrival = (sk.cast == null ? 1.4 : sk.cast) + (step.t || 0) + 2 / 60;
    const marks = [];
    for (const o of foesOf(battle, e)) {
      if (hasBuff(o, 'invuln')) continue;
      const b = o.buffs.find((v) => v.kind === 'bubble' && v.mag > 0 && v.dur - v.t > arrival);
      if (b) {
        if (o.hp / o.maxHp <= 0.2) return true;
        marks.push(b);
      }
    }
    if (!marks.length) return false;
    if (marks.length >= 2 || marks.some((b) => b.mag >= 2)) return true;
    const threat = nearest(battle, e, foesOf(battle, e));
    const danger = e.hp / e.maxHp <= 0.35 || (e.hp / e.maxHp <= 0.55
      && threat && U.dist(e.x, e.z, threat.x, threat.z) < 160);
    return danger || marks.some((b) => b.dur - b.t <= arrival + 1 || b.t >= 2);
  }

  /** 距离为主，角色偏好为辅；保留当前目标，避免每次决策都来回换人。 */
  function selectTarget(battle, e, list) {
    let best = null, bestScore = Infinity;
    const allies = alliesOf(battle, e);
    const available = list.filter((o) => o.alive && !hasBuff(o, 'invuln'));
    for (const o of available.length ? available : list.filter((o) => o.alive)) {
      const d = U.dist(e.x, e.z, o.x, o.z);
      let score = d;
      if (e.unit.role === 'assassin') score -= o.lane === 1 ? 110 : 0;
      else if (e.unit.role === 'tank') score -= o.lane === 0 ? 35 : 0;
      score -= (1 - o.hp / o.maxHp) * 85;
      if (o.id === e.targetId) score -= 45;
      if (hasBuff(o, 'invuln')) score += 280;
      if (o.isMinion) score += 65;
      if (o.isDecoy && d < 320) score -= 190;
      // 就近协同收割，不为集火横穿整个场地。
      if (d < targetRange(e) + 120) {
        score -= Math.min(2, allies.filter((a) => a !== e && a.targetId === o.id).length) * 18;
      }
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  function remainingSteps(ally) {
    const c = ally.cast;
    if (!c || !Array.isArray(c.steps)) return [];
    const charge = c.charging ? Math.max(0, c.chargeDur - c.chargeT) : 0;
    return c.steps.slice(c.charging ? 0 : (c.idx || 0)).map((step) => ({
      step, eta: charge + Math.max(0, (step.t || 0) - (c.charging ? 0 : c.t || 0)),
    }));
  }

  function controlRemaining(e) {
    let duration = Math.max(e.hitstun || 0, e.bubbleCageT || 0);
    for (const b of e.buffs) if (b.kind === 'stun') duration = Math.max(duration, b.dur - b.t);
    return duration;
  }

  function reservedControl(battle, e, target, arrival) {
    let duration = controlRemaining(target);
    const allies = alliesOf(battle, e).filter((a) => a !== e);
    for (const ally of allies) {
      for (const next of remainingSteps(ally)) {
        const step = next.step;
        const center = step.at === 'self' ? ally
          : foesOf(battle, e).find((o) => o.id === ally.cast.targetId);
        if (!center || U.dist(target.x, target.z, center.x, center.z) > (step.radius || 95)) continue;
        const stun = (step.effects || []).find((b) => b.kind === 'stun');
        const land = next.eta + (step.kind === 'bubble_trap' ? step.arm || 0.4 : step.warn || 0);
        if (land > arrival || (!stun && step.kind !== 'bubble_trap')) continue;
        duration = Math.max(duration, land + (stun ? stun.dur || 1 : 0.8));
      }
    }
    for (const trap of battle.bubbleTraps || []) {
      if (!allies.some((a) => a.id === trap.ownerId)
          || U.dist(target.x, target.z, trap.x, trap.z) > trap.radius) continue;
      const land = Math.max(0, trap.arm - trap.t);
      if (land <= arrival && trap.life - trap.t > land) duration = Math.max(duration, land + 0.8);
    }
    return duration;
  }

  // 聚敌、陷阱、落石和弹射各自挑选作用中心，普通单体技保留当前锁定。
  // 只看当前公开位置与队友已开始的聚敌，不读取未来随机数或敌方决策。
  function skillTarget(battle, e, sk, policy, fallback) {
    const steps = sk.steps || [];
    const area = steps.find((s) => (s.kind === 'aoe' && s.at === 'target')
      || s.kind === 'stone_rain' || s.kind === 'throw_stones' || s.kind === 'bubble_trap'
      || (s.kind === 'projectile' && s.phone));
    if (!area) return fallback;
    const foes = foesOf(battle, e).filter((o) => !hasBuff(o, 'invuln'));
    const radius = area.kind === 'bubble_trap' ? area.radius || 95
      : area.kind === 'projectile' ? area.bounceRange || 360
      : area.spread || area.radius || 150;
    const globalRain = area.kind === 'stone_rain' || area.kind === 'throw_stones';
    const reach = globalRain ? Infinity : policy.when === 'enemyInRange' ? policy.range || 200
      : Math.max(targetRange(e), 300);
    const pull = steps.find((s) => s.kind === 'pull');
    const allies = alliesOf(battle, e);
    const pendingPulls = [];
    for (const ally of allies) {
      if (ally === e) continue;
      const target = foes.find((o) => o.id === (ally.cast && ally.cast.targetId));
      if (!target) continue;
      for (const next of remainingSteps(ally)) {
        if (next.step.kind === 'pull' && next.eta <= 1.5) pendingPulls.push({ target, ...next });
      }
    }
    let best = fallback, bestScore = -Infinity;
    for (const candidate of foes) {
      const distance = U.dist(e.x, e.z, candidate.x, candidate.z);
      if (distance > reach + candidate.unit.radius * 0.5 - 4) continue;
      let score = (candidate.id === e.targetId ? 8 : 0) - distance * 0.035;
      let count = 0;
      for (const o of foes) {
        const gap = U.dist(candidate.x, candidate.z, o.x, o.z);
        if (gap <= radius) {
          count += 1;
          if (area.kind === 'bubble_trap') {
            const bubble = o.buffs.find((b) => b.kind === 'bubble' && b.t < b.dur);
            score += (!bubble || bubble.mag < 3 ? 9 : 0)
              - Math.min(24, reservedControl(battle, e, o, (sk.cast || 0.65) + (area.arm || 0.4)) * 20);
          }
          if (area.effects && area.effects.some((b) => b.kind === 'marked')) {
            score += hasBuff(o, 'marked') ? 0 : 10;
          }
        } else if (pull && gap <= (pull.radius || 280)) count += 0.5;
      }
      score += Math.min(4, count) * 32;
      // 落石/陷阱瞄准已经开始的聚敌中心，而不是把范围技分散到远处。
      for (const pending of pendingPulls) {
        if (U.dist(candidate.x, candidate.z, pending.target.x, pending.target.z) <= radius * 0.6) score += 18;
      }
      score += (1 - candidate.hp / candidate.maxHp) * 12;
      if (candidate.isMinion) score -= 12;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  }

  // 只在队友固定预警即将命中、该击退确实可能推出范围时稍等。
  // 预警过期便自动放行；危急或五秒无输出也放行，不积累隐藏等待状态。
  function disruptsAllyZone(battle, e, sk, target) {
    if (!target || target.su7 || e.hp / e.maxHp <= 0.3 || (e.noDmgT || 0) >= 5) return false;
    const knock = sk.steps.find((s) => (s.kind === 'dash' || s.kind === 'melee') && s.dmg > 0 && s.knock > 0);
    if (!knock) return false;
    const arrival = (sk.cast == null ? 0.6 : sk.cast) + (knock.t || 0)
      + (knock.kind === 'dash' ? (knock.dur || 0.3) * 0.5 : 0);
    const allies = alliesOf(battle, e).filter((a) => a !== e);
    const weight = Math.max(0.3, target.unit.stats.weight || 1);
    const travel = Math.pow(knock.knock / weight, 2) / 2800;
    const dx = target.x - e.x, dz = target.z - e.z, length = Math.hypot(dx, dz) || 1;
    for (const zone of battle.zones || []) {
      if (zone.done || !allies.some((a) => a.id === zone.ownerId)) continue;
      const eta = zone.warn - zone.t;
      if (eta < arrival || eta > 0.95) continue;
      const gap = U.dist(target.x, target.z, zone.x, zone.z);
      const after = U.dist(target.x + dx / length * travel, target.z + dz / length * travel, zone.x, zone.z);
      if (gap < zone.radius && after > zone.radius && after > gap + 2) return true;
    }
    return false;
  }

  // 有效技能均有基础收益；机会加减分不改变数值，也不会为等连招永久扣住技能。
  function opportunityScore(battle, e, sk, key, target, interrupt) {
    if (key === 's1' && interrupt && target === interrupt) return 1000;
    let score = key === 'ult' ? 110 : key === 's2' ? 60 : key === 's3' ? 45 : 35;
    const steps = sk.steps || [];
    if (steps.some((s) => s.kind === 'heal')) score += (1 - e.hp / e.maxHp) * 100;
    if (!target) return score;
    const arrival = (sk.cast == null ? 0.6 : sk.cast) + 0.2;
    const control = steps.some((s) => s.kind === 'bubble_trap' || (s.effects || []).some((b) => b.kind === 'stun'));
    if (control && reservedControl(battle, e, target, arrival) > arrival + 0.25) score -= 45;
    if (target.hp / target.maxHp < 0.2 && steps.some((s) => s.dmg > 0)) score += 18;
    if (steps.some((s) => s.kind === 'bubble_trap')) {
      const mark = target.buffs.find((b) => b.kind === 'bubble' && b.t < b.dur);
      if (mark && mark.mag >= 3 && mark.dur - mark.t > 3) score -= 20;
    }
    return score;
  }

  /** 只有能打到人、补到血或收集到资源时才交技能；纯防御不在开局空放。 */
  function usefulSkill(battle, e, sk, c, targetOverride) {
    const foes = foesOf(battle, e).filter((o) => !hasBuff(o, 'invuln'));
    const target = targetOverride && foes.includes(targetOverride) ? targetOverride
      : foes.find((o) => o.id === e.targetId) || nearest(battle, e, foes);
    const steps = sk.steps || [];
    let offensive = false;
    for (const step of steps) {
      if (step.kind === 'decoy') return !!target && U.dist(e.x, e.z, target.x, target.z) <= (c.range || 240);
      if (step.kind === 'run_lap') return !!target && U.dist(e.x, e.z, target.x, target.z) <= 400;
      if (step.kind === 'bubble_trap') return !!target && U.dist(e.x, e.z, target.x, target.z) <= 340;
      if (step.kind === 'bubble_burst') return readyBubbleBurst(battle, e, sk);
      if (step.kind === 'su7_drive') return !e.su7 && !!target;
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
      return recipients.some((a) => a.maxHp - a.hp >= Math.max(1, a.maxHp * (heal.amount || 0.12) * 0.5));
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
      case 'enemyBubbled': return foesOf(battle, e).some((o) => hasBuff(o, 'bubble'));
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
    if (e.cast || e.dash || e.run || e.su7 || hasBuff(e, 'seal')) return null;
    const p = e.unit.policy || {};
    const foes = foesOf(battle, e);
    const current = foes.find((o) => o.id === e.targetId && !hasBuff(o, 'invuln'));
    const target = current || selectTarget(battle, e, foes.filter((o) => !hasBuff(o, 'invuln')));
    const interrupt = interruptTarget(battle, e);
    let best = null;
    for (const key of ['ult', 's2', 's3', 's1']) {
      const sk = e.unit[key];
      if (!sk) continue;
      if (key === 'ult' && e.energy < 100) continue;
      if (key !== 'ult' && ((e.cds[key] || 0) > 0 || e.energy < (sk.cost || 0))) continue;
      const c = p[key];
      if (!c) continue;
      const chosenTarget = key === 's1' && interrupt ? interrupt : skillTarget(battle, e, sk, c, target);
      if (cond(battle, e, c) && usefulSkill(battle, e, sk, c, chosenTarget)
          && !disruptsAllyZone(battle, e, sk, chosenTarget)) {
        const score = opportunityScore(battle, e, sk, key, chosenTarget, interrupt);
        if (!best || score > best.score) best = { key, target: chosenTarget, score };
      }
    }
    if (best) { commitTarget(e, best.target); return best.key; }
    // 取消平A后，基础近战技仍要能主动出击（如王境泽的护盾+斩击）。
    // 不绕过治疗、防御技或石头库存条件，也不拿空挥代替移动。
    const basic = e.unit.s1;
    if (basic && e.cds.s1 <= 0 && p.s1 && p.s1.when === 'selfHpBelow'
        && basic.steps.some((s) => s.kind === 'melee' && s.dmg > 0)
        && usefulSkill(battle, e, basic, p.s1, target)) { commitTarget(e, target); return 's1'; }
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

    const target = interruptTarget(battle, e) || selectTarget(battle, e, foes);
    const threat = nearest(battle, e, foes);
    const threatDistance = U.dist(e.x, e.z, threat.x, threat.z);

    // 真远程受近身威胁才后撤；近战辅助残血也要进技能范围，而不是逃到打不到人。
    if (hpRatio < 0.32 && targetRange(e) > 150
        && threatDistance < targetRange(e) * 0.85 && (e.noDmgT || 0) < 5) {
      return { mode: 'retreat', targetId: target.id, threatId: threat.id, wantRange: targetRange(e),
        ranged: true, attackRange: targetRange(e) };
    }

    // 绕后：刺客优先切后排
    if (role === 'assassin') {
      return { mode: 'flank', targetId: target.id, wantRange: targetRange(e) };
    }

    // 远程/辅助：只有真远程才拉距离风筝；近战范围的辅助（如张维为）必须贴上去打
    if (targetRange(e) > 150) {
      return { mode: 'kite', targetId: target.id, threatId: threat.id,
        wantRange: Math.max(140, targetRange(e) * 0.85), ranged: true, attackRange: targetRange(e) };
    }

    // 坦克/近战：先咬最近的目标，优先前排
    return { mode: 'approach', targetId: target.id, wantRange: targetRange(e) };
  }

  CC.ai = { decide, wantSkill, cond, _foesOf: foesOf, _alliesOf: alliesOf };
})();
