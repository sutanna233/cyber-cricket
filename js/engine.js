/* ===========================================================
   赛博斗蛐蛐 · 战斗引擎（纯逻辑，可无头运行）
   —— 固定步长 1/60；全部随机走 battle.rng；不读时钟；不碰 DOM
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util;

  const TICK = 1 / 60;
  const SAFETY_TIME = 600;          // 安全阀（仅用于测试/快进的死循环保护，不是玩法上限）
  const DMG_SCALE = 0.72;           // 全局伤害系数（整体放慢节奏的旋钮）
  const CD_SCALE = 1.0;             // 技能冷却倍率（按需求保持原冷却，不缩短）
  const SKILL_DMG_SCALE = 5.3;      // 技能伤害补偿（没有平A，单次技能必须够痛）
  const CORPSE_FADE = 1.4;          // 尸体淡出时长（秒），之后从战场移除
  // 蓄力（前摇）默认时长：蓄力中可被打断
  const CHARGE = { s1: 0.5, s2: 0.8, s3: 0.4, ult: 1.4 };
  const INTERRUPT_CD = 0.4;         // 被打断后进入的短冷却比例
  const INTERRUPT_MIN_RATIO = 0.015; // 只有"有效伤害"（≥1.5% 最大生命）才能打断，避免被蹭一下就断
  const SUSTAIN_SCALE = 0.72;        // 全局续航系数（回血/护盾/吸血统一压一档，防止打不死的僵局）
  const PICKUP_TTL = 90;            // 地上物件存活时间
  const PICKUP_RESPAWN = 1.6;       // 物件补充间隔
  const STONES_INITIAL = 8;         // 每只存活凑企鹅的开局石头数
  const STONES_TARGET = 10;         // 每只存活凑企鹅的地面石头补充目标
  const STONES_REFILL = 2;          // 每次补充时，每只存活凑企鹅最多刷新两块
  const W = 1200, D = 700;          // 擂台平面尺寸
  const DODGE_CD = 0.9;

  const NEGATIVE = { stun: 1, blind: 1, poison: 1, speedDown: 1, atkDown: 1, seal: 1 };

  function buffMag(e, kind) {
    let m = 0;
    for (let i = 0; i < e.buffs.length; i++) if (e.buffs[i].kind === kind) m += e.buffs[i].mag;
    return m;
  }
  function hasBuff(e, kind) {
    if (kind === 'superArmor' && e.su7) return true;
    for (let i = 0; i < e.buffs.length; i++) if (e.buffs[i].kind === kind && e.buffs[i].t < e.buffs[i].dur) return true;
    return false;
  }
  function addBuff(e, kind, dur, mag, src) {
    if (!kind) return;
    if (kind === 'cleanse') {
      e.buffs = e.buffs.filter((b) => !NEGATIVE[b.kind]);
      return;
    }
    if (kind === 'regen' || kind === 'shield' || kind === 'lifesteal') mag *= SUSTAIN_SCALE;
    if (kind === 'shield') {
      const capacity = Math.round(e.maxHp * mag);
      if (capacity > (e.shield || 0)) { e.shield = capacity; e.shieldOwnerId = src ? src.id : e.id; }
    }
    // 同类叠加取更强的一条，避免无限堆叠
    for (let i = 0; i < e.buffs.length; i++) {
      const b = e.buffs[i];
      if (b.kind === kind && b.t < b.dur) {
        if (kind === 'bubble') { b.mag = Math.min(3, b.mag + mag); b.t = 0; b.dur = dur; return; }
        if (mag >= b.mag) { b.mag = mag; b.dur = Math.max(b.dur, dur); b.t = 0; b.ownerId = src ? src.id : e.id; }
        else b.dur = Math.max(b.dur, dur);
        return;
      }
    }
    e.buffs.push({ kind, dur, mag, t: 0, ownerId: src ? src.id : e.id });
  }
  function speedOf(e) {
    const s = e.unit.stats.spd * (1 + buffMag(e, 'speedUp') - buffMag(e, 'speedDown'));
    return Math.max(40, s) * (e.isMinion ? 1.1 : 1);
  }
  function rangeOf(e) {
    const r = e.unit.stats.range;
    return e.unit.role === 'ranged' ? r : r;
  }

  function createBattle(opts) {
    opts = opts || {};
    const teamA = opts.teamA || [];
    const teamB = opts.teamB || [];
    const mode = opts.mode || ((teamA.length > 1 || teamB.length > 1) ? 'team' : 'solo');

    const battle = {
      mode, seed: opts.seed == null ? 1 : opts.seed,
      rng: U.RNG(opts.seed == null ? 1 : opts.seed),
      time: 0, tick: 0, over: false, result: null, endReason: null,
      A: [], B: [], projectiles: [], zones: [], pickups: [], rains: [], tracks: [], bubbleTraps: [],
      events: [], fxSeq: 0,
      stats: { dmgByUnit: {}, dmgBySideUnit: {}, killsByUnit: {}, killsBySideUnit: {}, byEntity: {}, maxCombo: 0, casts: [], duration: 0, picked: {} },
      _eid: 1, _pickupT: 0,
    };

    function spawn(side, spec, idx) {
      const unit = CC.fighters.get(spec.id);
      if (!unit) return null;
      const lane = spec.lane == null ? (unit.pos === 'back' ? 1 : 0) : spec.lane;
      // 默认站位与 board.js 的 LAYOUT 对齐（前排距中线 400 / 后排 480），保证开局有距离
      const defX = side === 'A' ? (lane === 0 ? 200 : 120) : (lane === 0 ? 1000 : 1080);
      const defZ = 200 + (idx % 3) * 150;
      const pos = spec.pos || [defX, defZ];
      const hp = Math.max(1, Math.round(unit.stats.hp * (spec.hpMul || 1)));
      const e = {
        id: battle._eid++, side, team: spec.team || side, unitId: unit.id, unit, slot: spec.slot == null ? idx : spec.slot, lane,
        x: pos[0], z: pos[1], h: 0, vx: 0, vz: 0, vh: 0,
        facing: side === 'A' ? 1 : -1, alive: true,
        hp, maxHp: hp, shield: 0, energy: spec.energy || 0,
        state: 'idle', stateT: 0, atkCd: 0, cds: { s1: 0, s2: 0, s3: 0, ult: 0 },
        buffs: [], targetId: 0, combo: 0, comboT: 0,
        cast: null, hitstun: 0, deciding: 0, plan: null, dodgeCd: 0, stuck: 0, lastX: pos[0], lastZ: pos[1],
        isMinion: !!spec.isMinion, ownerId: spec.ownerId || 0, life: spec.life || 0,
        atkMul: spec.atkMul || 1,
        stacks: {},                 // 可拾取资源计数（例如 stone）
        trait: unit.trait || null,
        deadT: 0,
      };
      battle[side].push(e);
      return e;
    }

    teamA.forEach((s, i) => spawn('A', s, i));
    teamB.forEach((s, i) => spawn('B', s, i));
    battle.participants = battle.A.concat(battle.B).slice();
    if (mode === 'brawl') {
      const rotation = battle.rng.next() * Math.PI * 2;
      battle.participants.forEach((e, i, list) => {
        e.team = 'fighter-' + e.id; e.brawl = true;
        const angle = rotation + i * Math.PI * 2 / list.length;
        e.x = 600 + Math.cos(angle) * 340; e.z = 350 + Math.sin(angle) * 230;
        e.lastX = e.x; e.lastZ = e.z; e.facing = e.x < 600 ? 1 : -1;
      });
    }
    // 原始参赛者永久留在统计表；尸体移除、诱饵消失后仍可查到贡献归属。
    for (const e of battle.participants) {
      battle.stats.byEntity[e.id] = { id: e.id, unitId: e.unitId, side: e.side, slot: e.slot,
        damage: 0, damageTaken: 0, healing: 0, shielding: 0, controlSeconds: 0,
        interrupts: 0, kills: 0, casts: 0, hits: 0, aliveSeconds: 0, skillDamage: {} };
    }
    const ownership = new Map(battle.participants.map((e) => [e.id, e.id]));
    battle.ramp = 1;
    battle.dbg = { kite: 0, retreat: 0, approach: 0, attack: 0, idle: 0, early: {} };
    function dbg(k) { battle.dbg.early[k] = (battle.dbg.early[k] || 0) + 1; }
    // 双方/乱斗统一按存活参战企鹅供给石头，召唤物不增加资源。
    function stoneCollectors() {
      return battle.participants.filter((e) => e.alive && !e.isMinion && e.unitId === 'tomori').length;
    }
    spawnPickup('stone', STONES_INITIAL * stoneCollectors());

    const all = () => battle.A.concat(battle.B);
    const foes = (e) => all().filter((o) => o.alive && o.team !== e.team);
    const allies = (e) => all().filter((o) => o.alive && o.team === e.team);
    const friendlyEffect = (effect, e) => {
      const owner = all().find((o) => o.id === effect.ownerId);
      return owner ? owner.team === e.team : mode !== 'brawl' && effect.side === e.side;
    };
    battle.foes = foes; battle.allies = allies;

    function contribution(e) {
      const id = typeof e === 'number' ? e : e && e.id;
      return battle.stats.byEntity[ownership.get(id) || id] || null;
    }

    function recordDamage(src, dst, amount, skill, detail) {
      const from = contribution(src), to = contribution(dst);
      if (from) {
        from.damage += amount;
        from.hits++;
        const key = skill || 'basic';
        from.skillDamage[key] = (from.skillDamage[key] || 0) + amount;
        if (detail && detail !== key) from.skillDamage[detail] = (from.skillDamage[detail] || 0) + amount;
      }
      if (to) to.damageTaken += amount;
    }

    function restoreHealth(src, dst, amount) {
      const effective = Math.max(0, Math.min(amount, dst.maxHp - dst.hp));
      dst.hp = U.clamp(dst.hp + amount, 0, dst.maxHp);
      const row = contribution(src);
      if (row) row.healing += effective;
      return effective;
    }

    // 记录控制的实际占用时间，而非把多个重叠的标称持续时间相加。
    function creditControl(src, dst, duration) {
      if (!src || !dst.alive || dst.isDecoy || src.team === dst.team || duration <= 0) return;
      const end = battle.tick + Math.ceil(duration / TICK - 1e-9);
      if (!dst.controlCredit || end > dst.controlCredit.end) {
        dst.controlCredit = { ownerId: ownership.get(src.id) || src.id, end };
      }
    }

    function push(ev) {
      ev.seq = ++battle.fxSeq;
      ev.t = U.round2(battle.time);
      battle.events.push(ev);
      return ev;
    }

    // ---------- 伤害 ----------
    function applyDamage(src, dst, coef, opt) {
      opt = opt || {};
      if (!dst || !dst.alive || !src || src.team === dst.team) return 0;
      if (hasBuff(dst, 'invuln')) {
        push({ type: 'miss', unitId: src.id, targetId: dst.id, reason: 'invuln', x: dst.x, z: dst.z, h: dst.h });
        return 0;
      }
      const blind = buffMag(src, 'blind');
      if (blind > 0 && battle.rng.next() < blind) {
        push({ type: 'miss', unitId: src.id, targetId: dst.id, reason: 'blind', x: dst.x, z: dst.z, h: dst.h });
        return 0;
      }
      const sa = src.unit.stats;
      let atk = sa.atk * src.atkMul * (1 + buffMag(src, 'atkUp') - buffMag(src, 'atkDown'));
      atk = Math.max(1, atk);
      const def = Math.max(0, dst.unit.stats.def) * (1 - Math.min(0.8, opt.armorPierce || 0));
      let dmg = coef * atk * (100 / (100 + def * 1.2));
      dmg *= 1 + buffMag(dst, 'marked');                   // 被标记（传票）时承受更多伤害
      // 反差机制：对手血量比例比自己高时打得更痛（熊猫头「无情铁拳」）
      if (opt.highHpBonus && dst.hp / dst.maxHp > src.hp / src.maxHp + 0.05) dmg *= 1 + opt.highHpBonus;
      if (src.lane === 1) dmg *= 1.15;                     // 后排输出加成
      if (opt.melee && dst.lane === 1) dmg *= 1.3;         // 近战打后排更痛
      if (opt.lowHpBonus) dmg *= 1 + (1 - src.hp / src.maxHp) * 1.2;
      const guaranteed = hasBuff(src, 'guaranteedCrit');
      const crit = guaranteed || battle.rng.next() < sa.crit;
      if (crit) dmg *= sa.critDmg;
      dmg *= 0.95 + battle.rng.next() * 0.1;
      // 取消平A后：技能伤害整体补偿；非技能来源（毒/反伤等）不吃这份补偿
      if (opt.skill && opt.skill !== 'basic') dmg *= SKILL_DMG_SCALE;
      dmg *= DMG_SCALE;
      dmg = Math.max(1, Math.round(dmg));

      const beforeHp = dst.hp;
      // 护盾先吃；只把实际吸收计入贡献，而不是把生成的护盾算成收益。
      if (dst.shield > 0) {
        const use = Math.min(dst.shield, dmg);
        dst.shield = U.round2(dst.shield - use);
        dmg -= use;
        const shieldRow = contribution(dst.shieldOwnerId || dst.id);
        if (shieldRow) shieldRow.shielding += use;
      }
      if (dmg > 0) dst.hp = U.clamp(dst.hp - dmg, 0, dst.maxHp);

      // 反伤
      const refl = buffMag(dst, 'reflect');
      if (refl > 0) {
        const back = Math.max(1, Math.round((dmg + (opt.rawDmg || 0)) * refl * 0.5));
        const actual = Math.min(src.hp, back);
        src.hp = U.clamp(src.hp - back, 0, src.maxHp);
        recordDamage(dst, src, actual, 'reflect');
        push({ type: 'reflect', unitId: dst.id, targetId: src.id, dmg: back, x: src.x, z: src.z, h: src.h });
        if (src.hp <= 0) kill(src, dst);
      }
      // 吸血
      const ls = buffMag(src, 'lifesteal');
      if (ls > 0 && dmg > 0) {
        const healV = Math.round(dmg * ls);
        const actual = restoreHealth(src, src, healV);
        push({ type: 'heal', unitId: src.id, amount: actual, x: src.x, z: src.z, h: src.h });
      }
      // 怒气：命中 +4 / 受击 +6 / 被动 +3 每秒（保证必杀大约 20~30 秒能出一次）
      src.energy = U.clamp(src.energy + 4, 0, 100);
      dst.energy = U.clamp(dst.energy + 6, 0, 100);
      if (src.energy >= 100) push({ type: 'energy_full', unitId: src.id });

      // 连击
      src.combo = (src.comboT > 0 ? src.combo : 0) + 1;
      src.comboT = 2.0;
      src.noDmgT = 0;
      if (src.combo > battle.stats.maxCombo) battle.stats.maxCombo = src.combo;

      battle.stats.dmgByUnit[src.unitId] = (battle.stats.dmgByUnit[src.unitId] || 0) + dmg;
      // 两侧可能出现同一只单位，按「侧:unitId」再记一份，战报可区分左右
      const sideKey = src.side + ':' + src.unitId;
      battle.stats.dmgBySideUnit[sideKey] = (battle.stats.dmgBySideUnit[sideKey] || 0) + dmg;
      recordDamage(src, dst, Math.min(beforeHp, dmg), opt.skill, opt.detail);

      push({
        type: 'hit', unitId: src.id, targetId: dst.id, dmg, crit,
        skill: opt.skill || 'basic', x: dst.x, z: dst.z, h: dst.h + 40,
        side: dst.side, combo: src.combo, shieldUsed: (opt.rawDmg || 0) > 0,
      });
      push({ type: 'shake', mag: crit ? 6 : 3 });
      push({ type: 'hitstop', dur: crit ? 0.09 : 0.06 });

      if (dst.hp <= 0) kill(dst, src);

      // 打断：蓄力中的单位被打到就会被打断（霸体 / uninterruptible 技能不受影响）
      const skNow = dst.cast && dst.cast.skill;
      const immune = hasBuff(dst, 'superArmor') || (skNow && skNow.uninterruptible);
      if (dmg > 0 && dst.cast && dst.cast.charging && !immune
          && (opt.interrupt || dmg >= Math.max(1, dst.maxHp * INTERRUPT_MIN_RATIO))) {
        const key = dst.cast.key;
        const sk = dst.cast.skill || {};
        dst.cast = null;
        dst.state = 'hurt';
        dst.stateT = 0;
        dst.hitstun = Math.max(dst.hitstun, 0.35);
        creditControl(src, dst, 0.35);
        const interrupter = contribution(src);
        if (interrupter) interrupter.interrupts++;
        if (key === 'ult') {
          dst.energy = Math.max(0, dst.energy - 60);      // 必杀被打断：掉大半怒气
        } else {
          dst.cds[key] = Math.max(dst.cds[key] || 0, (sk.cd || 6) * INTERRUPT_CD);
        }
        push({ type: 'interrupt', unitId: dst.id, by: src ? src.id : null, key,
          name: sk.name || '', x: dst.x, z: dst.z, h: dst.h + 50, ult: key === 'ult' });
      }
      return dmg;
    }

    function kill(e, killer) {
      if (!e.alive) return;
      e.alive = false;
      if (e.su7) finishSu7(e, 'ko');
      e.state = 'ko';
      e.stateT = 0;
      if (e.dash && e.dash.step.jumpHeight) { e.h = 0; e.vh = 0; }
      e.dash = null;
      e.run = null;
      e.cast = null;
      e.buffs = [];
      if (e.isDecoy) {
        push({ type: 'decoy_break', unitId: e.id, x: e.x, z: e.z, h: 0, radius: e.decoyStep.radius });
        const owner = all().find((o) => o.id === e.ownerId && o.alive);
        if (owner) {
          for (const o of foes(e)) {
            if (!owner.alive || U.dist(e.x, e.z, o.x, o.z) > e.decoyStep.radius + o.unit.radius * 0.5) continue;
            applyDamage(owner, o, e.decoyStep.dmg, { skill: 's3' });
            if (o.alive) applyEffects(owner, o, e.decoyStep.effects, e.decoyStep);
          }
        }
        return;
      }
      const creditedKiller = contribution(killer);
      if (creditedKiller && !e.isMinion) creditedKiller.kills++;
      battle.stats.killsByUnit[killer ? killer.unitId : 'none'] =
        (battle.stats.killsByUnit[killer ? killer.unitId : 'none'] || 0) + 1;
      if (killer) {
        const kk = killer.side + ':' + killer.unitId;
        battle.stats.killsBySideUnit[kk] = (battle.stats.killsBySideUnit[kk] || 0) + 1;
      }
      push({ type: 'ko', unitId: e.id, x: e.x, z: e.z, h: e.h, by: killer ? killer.unitId : null });
    }

    function applyEffects(src, dst, effects, opt) {
      if (!effects || !effects.length) return;
      for (const ef of effects) {
        if (ef.chance != null && battle.rng.next() > ef.chance) continue;
        const self = ef.target === 'self' ? src : dst;
        if (ef.kind === 'stun' && self.su7) continue;
        addBuff(self, ef.kind, ef.dur == null ? 1 : ef.dur, ef.mag == null ? 1 : ef.mag, src);
        if (ef.kind === 'stun') {
          self.hitstun = Math.max(self.hitstun, ef.dur || 1); self.state = 'stun'; self.stateT = 0;
          creditControl(src, self, ef.dur || 1);
        }
        push({ type: 'buff', kind: ef.kind, unitId: self.id, dur: ef.dur, mag: ef.mag,
          x: self.x, z: self.z, h: self.h + 60 });
      }
    }

    function inArc(src, dst, range, arcDeg) {
      const dx = dst.x - src.x, dz = dst.z - src.z;
      if (Math.hypot(dx, dz) > range + dst.unit.radius * 0.5) return false;
      if (arcDeg >= 360) return true;
      const ang = (Math.atan2(dz, dx) * 180) / Math.PI;
      const fang = src.facing > 0 ? 0 : 180;
      // 蓄力/绕圈环境下朝向会漂，弧判定给足容差（否则近战会互相空挥）
      return Math.abs(U.angleDelta(ang, fang)) <= arcDeg / 2 + 50;
    }

    function pickTargets(src, step, opt) {
      const list = foes(src).slice();
      if (!list.length) return [];
      const wantBack = step.preferBack || (src.unit.role === 'assassin' && (opt && opt.flank));
      const target = castTarget(src);
      const targetInArc = target && inArc(src, target, step.range || rangeOf(src), step.arc || 110);
      list.sort((a, b) => {
        // 先命中 AI 正在追的目标，其余敌人仍参与范围判定。
        if (targetInArc) {
          if (a === target) return -1;
          if (b === target) return 1;
        }
        const da = U.dist(src.x, src.z, a.x, a.z) + (a.lane === (wantBack ? 1 : 0) ? -60 : 60);
        const db = U.dist(src.x, src.z, b.x, b.z) + (b.lane === (wantBack ? 1 : 0) ? -60 : 60);
        return da - db;
      });
      return list;
    }

    // ---------- 技能步骤执行 ----------
    function runStep(src, step, opt) {
      opt = opt || {};
      const dmgMul = 1;
      switch (step.kind) {
        case 'melee': {
          const targets = pickTargets(src, step, opt);
          let hitAny = false;
          let n = 0;
          for (const dst of targets) {
            if (n >= (step.hits > 1 ? 1 : (step.arc >= 360 ? 6 : 2))) break;
            if (!inArc(src, dst, step.range, step.arc || 110)) continue;
            let hits = step.hits || 1;
            for (let i = 0; i < hits; i++) {
              const r = applyDamage(src, dst, step.dmg, {
                skill: opt.skillKey, melee: true, knock: step.knock, hitstun: step.hitstun,
                armorPierce: step.armorPierce, lowHpBonus: step.lowHpBonus,
                highHpBonus: step.highHpBonus,
              });
              n++;
            }
            applyEffects(src, dst, step.effects, step);
            if (step.knock && dst.alive) knockback(src, dst, step.knock, step.up);
            if (step.hitstun && dst.alive) {
              dst.hitstun = Math.max(dst.hitstun, step.hitstun * (hasBuff(dst, 'superArmor') ? 0.2 : 1));
              creditControl(src, dst, step.hitstun * (hasBuff(dst, 'superArmor') ? 0.2 : 1));
              if (!hasBuff(dst, 'superArmor')) { dst.state = 'hurt'; dst.stateT = 0; }
            }
            hitAny = true;
          }
          hitAny = hitAny || n > 0;
          push({ type: 'swing', unitId: src.id, x: src.x, z: src.z, h: src.h + 30,
            sprite: opt.sprite || 'slash_arc', facing: src.facing, range: step.range, hit: hitAny });
          if (!hitAny) push({ type: 'whiff', unitId: src.id });
          break;
        }
        case 'projectile': {
          // 朝目标方向发射（含 z 轴分量）+ 轻微追踪，否则目标错位就永远打不中
          const t = castTarget(src);
          let dx = src.facing, dz = 0;
          if (t) {
            const tdx = t.x - src.x, tdz = t.z - src.z;
            const l = Math.hypot(tdx, tdz) || 1;
            dx = tdx / l; dz = tdz / l;
          }
          const sp = step.speed || 430;
          battle.projectiles.push({
            id: battle._eid++, ownerId: src.id, side: src.side, skill: opt.skillKey || 'basic',
            x: src.x + dx * 20, z: src.z + dz * 20, h: src.h + 34,
            vx: dx * sp, vz: dz * sp, speed: sp, vh: 0, homing: !!t,
            targetId: t ? t.id : 0,
            bubble: !!step.bubble,
            sonic: !!step.sonic, interrupt: !!step.interrupt,
            phone: !!step.phone, hitIds: step.phone ? [] : null, bounceRange: step.bounceRange || 360,
            dmg: step.dmg, life: step.life || 2, radius: step.radius || 24,
            sprite: step.sprite || 'spark', scale: step.scale || 0.9,
            pierce: !!step.pierce, bounces: step.bounces || 0, effects: step.effects || [], hits: 0, arcH: step.arcH || 60,
          });
          push({ type: 'cast_fx', unitId: src.id, at: 'proj', x: src.x, z: src.z, h: src.h + 34 });
          if (step.sonic) push({ type: 'leijunSonic', unitId: src.id, x: src.x, z: src.z,
            h: src.h + 34, radius: step.radius || 24 });
          break;
        }
        case 'su7_drive': {
          const target = castTarget(src);
          if (!target || src.su7) break;
          const dx = target.x - src.x, dz = target.z - src.z;
          const len = Math.hypot(dx, dz);
          src.su7 = {
            t: 0, dur: Math.max(0.5, step.dur || 4), speed: step.speed || 650, radius: step.radius || 62,
            dx: len > 0.001 ? dx / len : src.facing, dz: len > 0.001 ? dz / len : 0,
            targetId: target.id, lastHit: {}, retargetT: 0, skidT: 0,
            trailX: src.x, trailZ: src.z, step, skill: opt.skillKey || 'ult',
            hitTicks: Math.max(1, Math.ceil((step.hitCd || 0.65) / TICK - 1e-9)),
          };
          src.dash = null; src.run = null; src.hitstun = 0;
          src.h = 0; src.vx = 0; src.vz = 0; src.vh = 0;
          src.state = 'su7'; src.stateT = 0;
          push({ type: 'su7Start', unitId: src.id, x: src.x, z: src.z, h: 0,
            dx: src.su7.dx, dz: src.su7.dz, dur: src.su7.dur });
          break;
        }
        case 'bubble_trap': {
          const target = castTarget(src);
          if (!target) break;
          battle.bubbleTraps.push({ id: battle._eid++, ownerId: src.id, side: src.side,
            x: target.x, z: target.z, radius: step.radius, arm: step.arm, life: step.life, t: 0, dmg: step.dmg });
          push({ type: 'bubble_trap', unitId: src.id, x: target.x, z: target.z });
          break;
        }
        case 'bubble_burst': {
          const targets = foes(src).filter((o) => buffMag(o, 'bubble') > 0);
          const hitCounts = {};
          for (const target of targets) {
            const stacks = buffMag(target, 'bubble');
            target.buffs = target.buffs.filter((b) => b.kind !== 'bubble');
            push({ type: 'bubble_burst', unitId: src.id, x: target.x, z: target.z, stacks });
            for (const o of foes(src)) {
              if (U.dist(o.x, o.z, target.x, target.z) > step.radius || (hitCounts[o.id] || 0) >= 2) continue;
              hitCounts[o.id] = (hitCounts[o.id] || 0) + 1;
              applyDamage(src, o, step.dmg + stacks * step.perBubble, { skill: opt.skillKey });
              if (o.alive) {
                knockback(target, o, 100); o.hitstun = Math.max(o.hitstun, 0.25);
                creditControl(src, o, 0.25);
              }
            }
          }
          break;
        }
        case 'pace_boost': {
          src.stacks.paceBoost = Math.min(2, step.stacks || 2);
          push({ type: 'pace_boost', unitId: src.id, x: src.x, z: src.z, stacks: src.stacks.paceBoost });
          break;
        }
        case 'run_lap': {
          const target = castTarget(src);
          if (!target) break;
          const route = chooseRunRoute(src, target, step);
          const cx = route.cx, cz = route.cz;
          const bonus = src.stacks.paceBoost || 0;
          src.stacks.paceBoost = 0; src.stacks.pace = bonus;
          src.run = { t: 0, step, cx, cz, angle: route.angle,
            direction: route.direction, targetId: target.id, distance: 0, bonus, pace: bonus,
            lastX: src.x, lastZ: src.z, marked: {}, skill: opt.skillKey };
          src.state = 'run'; src.stateT = 0;
          push({ type: 'run_start', unitId: src.id, x: src.x, z: src.z, cx, cz, radius: step.radius,
            trailLife: step.trailLife, ult: opt.skillKey === 'ult' });
          break;
        }
        case 'dash': {
          const target = castTarget(src, step.preferBack);
          const dx = target ? target.x - src.x : src.facing;
          const dz = target ? target.z - src.z : 0;
          const len = Math.hypot(dx, dz) || 1;
          src.state = 'dash';
          src.stateT = 0;
          const direction = step.away ? -1 : 1;
          src.dash = { dir: dx / len * direction, dirZ: dz / len * direction, dur: step.dur || 0.3, t: 0, step };
          if (step.stopAtTarget && target) {
            src.dash.dist = Math.min(step.dist, Math.max(0, len - (src.unit.radius + target.unit.radius) * 0.8));
          }
          push({ type: 'dash', unitId: src.id, x: src.x, z: src.z, h: src.h, flyingKick: !!step.jumpHeight });
          break;
        }
        case 'aoe': {
          const at = step.at === 'target' ? (castTarget(src) || src) : src;
          const zone = {
            id: battle._eid++, ownerId: src.id, side: src.side, skill: opt.skillKey || 'ult',
            x: at.x, z: at.z, radius: step.radius, dmg: step.dmg, sprite: step.sprite || 'boom',
            warn: step.warn == null ? 0.7 : step.warn, t: 0, done: false,
            effects: step.effects || [], knock: step.knock || 0, armorPierce: step.armorPierce,
            repeat: step.repeat || 1, repeatGap: step.repeatGap || 0.4, fired: 0, nextFire: 0,
          };
          battle.zones.push(zone);
          push({ type: 'zone', unitId: src.id, x: zone.x, z: zone.z, radius: zone.radius, warn: zone.warn });
          break;
        }
        case 'buff': {
          const list = step.at === 'allies' ? allies(src) : step.at === 'enemies' ? foes(src) : [src];
          for (const tgt of list) {
            for (const ef of step.effects || []) {
              addBuff(tgt, ef.kind, ef.dur == null ? 3 : ef.dur, ef.mag == null ? 1 : ef.mag, src);
              push({ type: 'buff', kind: ef.kind, unitId: tgt.id, dur: ef.dur, mag: ef.mag,
                x: tgt.x, z: tgt.z, h: tgt.h + 60 });
            }
          }
          break;
        }
        case 'heal': {
          const list = (step.at === 'allies') ? allies(src) : [src];
          const amt = (step.amount || 0.12) * SUSTAIN_SCALE;
          for (const tgt of list) {
            const v = Math.round(tgt.maxHp * amt);
            const actual = restoreHealth(src, tgt, v);
            push({ type: 'heal', unitId: tgt.id, amount: actual, x: tgt.x, z: tgt.z, h: tgt.h + 40 });
          }
          break;
        }
        case 'decoy': {
          const e = spawn(src.side, { id: src.unitId, pos: [src.x, src.z], lane: src.lane,
            team: src.team, isMinion: true, ownerId: src.id, life: step.life || 3, hpMul: step.hpRatio || 0.25 }, 0);
          if (!e) break;
          ownership.set(e.id, ownership.get(src.id) || src.id);
          e.isDecoy = true; e.decoyStep = step; e.unitId = 'decoy_' + src.unitId;
          e.unit = Object.assign({}, src.unit, { id: e.unitId, name: '空楼', radius: 30, height: 70,
            stats: Object.assign({}, src.unit.stats, { spd: 0, weight: 4 }),
            s1: null, s2: null, s3: null, ult: null, policy: {} });
          push({ type: 'decoy_spawn', unitId: e.id, x: e.x, z: e.z, h: 0 });
          break;
        }
        case 'summon': {
          const count = step.count || 1;
          for (let i = 0; i < count; i++) {
            const m = {
              id: battle._eid++, side: src.side, team: src.team, unitId: 'minion_' + src.unitId, unit: minionUnit(src, step),
              slot: -1, lane: src.lane,
              x: U.clamp(src.x + (i - (count - 1) / 2) * 60, 40, W - 40), z: src.z, h: 0,
              vx: 0, vz: 0, vh: 0, facing: src.facing, alive: true,
              hp: Math.round(src.maxHp * 0.18), maxHp: Math.round(src.maxHp * 0.18), shield: 0, energy: 0,
              state: 'idle', stateT: 0, atkCd: 0, cds: { s1: 0, s2: 0, ult: 0 }, buffs: [],
              targetId: 0, combo: 0, comboT: 0, cast: null, hitstun: 0, deciding: 0, plan: null,
              dodgeCd: 0, stuck: 0, lastX: 0, lastZ: 0, atkMul: 0.6,
              isMinion: true, ownerId: src.id, life: step.life || 10,
              stacks: {}, trait: null, deadT: 0,
            };
            battle[m.side].push(m);
            ownership.set(m.id, ownership.get(src.id) || src.id);
            push({ type: 'spawn', unitId: m.id, of: src.unitId, x: m.x, z: m.z, h: 0 });
          }
          break;
        }
        case 'delayed': {
          battle.zones.push({
            id: battle._eid++, ownerId: src.id, side: src.side, skill: opt.skillKey || 's1',
            x: src.x, z: src.z, radius: step.radius || 90, dmg: step.dmg || 0.7,
            sprite: 'boom', warn: step.delay || 0.9, t: 0, done: false, effects: [], knock: 60,
            repeat: 1, repeatGap: 0, fired: 0, nextFire: 0,
          });
          break;
        }
        case 'magnet': {
          // 磁吸：把范围内的物件直接收走（凑企鹅「拾荒」）
          const kind = step.kindOf || (src.trait && src.trait.collect) || 'stone';
          const range = step.range || 300;
          const max = (src.trait && src.trait.max) || 10;
          let got = 0;
          for (let i = battle.pickups.length - 1; i >= 0; i--) {
            const p = battle.pickups[i];
            if (p.kind !== kind) continue;
            if (U.dist(src.x, src.z, p.x, p.z) > range) continue;
            if ((src.stacks[kind] || 0) >= max) break;
            battle.pickups.splice(i, 1);
            src.stacks[kind] = (src.stacks[kind] || 0) + 1;
            got++;
            push({ type: 'pickup', unitId: src.id, kind, count: src.stacks[kind], max,
              x: p.x, z: p.z, h: 20, magnet: true });
          }
          if (got) push({ type: 'shake', mag: 2 });
          break;
        }
        case 'stone_rain': {
          // 落石雨：把收集到的石头按间隔一块一块砸下来（像下雨，不是一次性全丢）
          const kind = step.kindOf || (src.trait && src.trait.collect) || 'stone';
          const have = src.stacks[kind] || 0;
          const n = Math.max(step.minCount || 1, Math.min(have, step.maxDrops || 12));
          src.stacks[kind] = 0;
          const foe = castTarget(src);
          const cx = foe ? foe.x : src.x, cz = foe ? foe.z : src.z;
          battle.rains.push({
            id: battle._eid++, ownerId: src.id, side: src.side, skill: opt.skillKey || 's2',
            x: cx, z: cz, radius: step.spread || 200, left: n, total: n,
            interval: step.interval || 0.14, t: 0, nextAt: 0,
            dmg: step.dmg || 0.22, dropRadius: step.dropRadius || 55,
            warn: step.warn == null ? 0.22 : step.warn, knock: step.knock || 90,
            effects: step.effects || [], sprite: step.sprite || 'star',
          });
          push({ type: 'stone_rain', unitId: src.id, count: n, x: cx, z: cz, radius: step.spread || 200 });
          break;
        }
        case 'throw_stones': {                 // 兼容旧名：等价于落石雨（数量少时就是几块）
          const st = Object.assign({}, step, { kind: 'stone_rain' });
          return runStep(src, st, opt);
        }
        case 'pull': {
          // 引力拖拽：把范围内的敌人朝一点拽过去（许家印「两万亿」的起手）
          const center = step.at === 'target' ? (castTarget(src) || src) : src;
          const cx = center.x, cz = center.z;
          const radius = step.radius || 280;
          let pulled = 0;
          for (const o of foes(src)) {
            if (!o.alive) continue;
            if (U.dist(o.x, o.z, cx, cz) > radius) continue;
            const dx = cx - o.x, dz = cz - o.z;
            const l = Math.hypot(dx, dz) || 1;
            const k = 1 / Math.max(0.4, o.unit.stats.weight);
            o.x += (dx / l) * (step.dist || 120) * k;
            o.z += (dz / l) * (step.dist || 120) * k;
            o.vx = 0; o.vz = 0;
            if (!hasBuff(o, 'superArmor')) {
              o.hitstun = Math.max(o.hitstun, 0.25); o.state = 'hurt'; creditControl(src, o, 0.25);
            }
            pulled++;
          }
          push({ type: 'pull', unitId: src.id, x: cx, z: cz, radius, count: pulled });
          break;
        }
        case 'detonate': {
          // 引爆标记：把敌人身上的 marked（传票/债务）一次性结算成爆发伤害
          const radius = step.radius || 240;
          for (const o of foes(src)) {
            if (!o.alive) continue;
            if (U.dist(o.x, o.z, src.x, src.z) > radius) continue;
            const m = buffMag(o, 'marked');
            if (m <= 0) continue;
            applyDamage(src, o, (step.perMark || 0.9) * (1 + m), { skill: opt.skillKey, armorPierce: 0.3 });
            o.buffs = o.buffs.filter((b) => b.kind !== 'marked');
            push({ type: 'detonate', unitId: src.id, targetId: o.id, x: o.x, z: o.z, h: o.h + 30, marks: U.round2(m) });
          }
          break;
        }
        case 'steal_energy': {
          // 窃取怒气（陈睿「限流」这类）
          const radius = step.radius || 260;
          let got = 0;
          for (const o of foes(src)) {
            if (!o.alive) continue;
            if (U.dist(o.x, o.z, src.x, src.z) > radius) continue;
            const take = Math.min(o.energy, step.amount || 25);
            o.energy = U.clamp(o.energy - take, 0, 100);
            got += take;
            addBuff(o, 'atkDown', step.debuffDur || 3, step.debuffMag || 0.15, src);
            push({ type: 'steal', unitId: src.id, targetId: o.id, amount: take, x: o.x, z: o.z, h: o.h + 30 });
          }
          src.energy = U.clamp(src.energy + got, 0, 100);
          break;
        }
        default:
          if (typeof console !== 'undefined') console.warn('[engine] 未知 step.kind:', step.kind);
      }
    }

    function minionUnit(src, step) {
      return {
        id: 'minion_' + src.unitId, name: src.unit.name + '的分身', role: 'bruiser',
        palette: src.unit.palette, radius: 24, height: 48,
        stats: { hp: 1, atk: src.unit.stats.atk * 0.72, def: src.unit.stats.def * 0.5, spd: src.unit.stats.spd * 1.1,
          crit: 0.05, critDmg: 1.5, weight: 0.6, range: step.ranged ? 260 : 70, atkInterval: 0.7 },
        texture: { key: src.unit.texture.key, scale: 0.55 },
        lines: [], barks: {}, policy: {},
        s1: null, s2: null, ult: null,
      };
    }

    function nearestFoe(e) {
      let best = null, bd = Infinity;
      for (const o of foes(e)) {
        const d = U.dist2(e.x, e.z, o.x, o.z);
        if (d < bd) { bd = d; best = o; }
      }
      return best;
    }

    function castTarget(e, preferBack) {
      const list = foes(e);
      const id = (e.cast && e.cast.targetId) || e.targetId;
      const selected = list.find((o) => o.id === id);
      if (selected && (!preferBack || selected.lane === 1)) return selected;
      const back = preferBack ? list.filter((o) => o.lane === 1) : [];
      const pool = back.length ? back : list;
      return pool.sort((a, b) => U.dist2(e.x, e.z, a.x, a.z) - U.dist2(e.x, e.z, b.x, b.z))[0] || null;
    }

    // 只外推已经观察到的短时移动。把敌人放在跑道附近，而不是空心圆中央。
    // 施放时选定整圈路线，之后不吸附敌人，也不改变跑速或跑道寿命。
    function chooseRunRoute(src, target, step) {
      const radius = step.radius || 105;
      const predict = (o, t) => ({ x: U.clamp(o.x + (o.moveVX || 0) * t, 55, W - 55),
        z: U.clamp(o.z + (o.moveVZ || 0) * t, 65, D - 65) });
      const lead = predict(target, 0.45);
      const enemies = foes(src);
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < 9; i++) {
        const offset = i === 8 ? 0 : radius * 0.85;
        const cx = U.clamp(lead.x + Math.cos(i * Math.PI / 4) * offset, radius + 60, W - radius - 60);
        const cz = U.clamp(lead.z + Math.sin(i * Math.PI / 4) * offset, radius + 70, D - radius - 70);
        const angle = Math.atan2(src.z - cz, src.x - cx);
        for (const direction of [src.id % 2 ? 1 : -1, src.id % 2 ? -1 : 1]) {
          let score = -Math.abs(U.dist(src.x, src.z, cx, cz) - radius) * 0.18;
          for (const o of enemies) {
            for (const t of [0, 0.45, 0.9]) {
              const p = predict(o, t);
              const gap = Math.abs(U.dist(p.x, p.z, cx, cz) - radius);
              score += Math.max(0, 90 - gap) * (o === target ? 1 : 0.65);
            }
          }
          // 选择先经过目标的方向，减少绕完空的一半才接触敌人的情况。
          const first = angle + direction * Math.PI * 0.6;
          score -= U.dist(cx + Math.cos(first) * radius, cz + Math.sin(first) * radius, lead.x, lead.z) * 0.2;
          if (score > bestScore) { bestScore = score; best = { cx, cz, angle, direction }; }
        }
      }
      return best;
    }

    function segmentDistance(x, z, x1, z1, x2, z2) {
      const dx = x2 - x1, dz = z2 - z1;
      const t = U.clamp(((x - x1) * dx + (z - z1) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      return U.dist(x, z, x1 + dx * t, z1 + dz * t);
    }

    // 每个决策周期快照一次公开的持久危险；同一跑道的许多线段不会重复叠加评分。
    function persistentHazards(e) {
      if (e.hazardTick != null && battle.tick - e.hazardTick < 12) return e.hazards;
      e.hazardTick = battle.tick;
      e.hazards = [];
      const owners = new Map(all().map((o) => [o.id, o]));
      for (const track of battle.tracks) {
        const owner = owners.get(track.ownerId);
        if (track.finish || !(track.dmg > 0) || !owner || !owner.alive || owner.team === e.team
            || track.life - track.t < 0.2) continue;
        e.hazards.push({ ownerId: owner.id, track, radius: 30 + e.unit.radius * 0.5 });
      }
      for (const trap of battle.bubbleTraps) {
        const owner = owners.get(trap.ownerId);
        if (!owner || !owner.alive || owner.team === e.team || trap.life - trap.t < 0.2) continue;
        e.hazards.push({ ownerId: owner.id, trap, radius: trap.radius });
      }
      return e.hazards;
    }

    function hazardCost(e, hazards, x, z, arrival) {
      const costs = {};
      for (const hazard of hazards) {
        const effect = hazard.track || hazard.trap;
        if (effect.t + arrival >= effect.life) continue;
        const gap = hazard.track ? segmentDistance(x, z, effect.x1, effect.z1, effect.x2, effect.z2)
          : U.dist(x, z, effect.x, effect.z);
        const margin = hazard.radius + 24;
        const risk = Math.max(0, 1 - gap / margin);
        // 陷阱尚未激活且来得及走出时不把整片区域当墙。
        const weight = hazard.trap ? (effect.t + arrival < effect.arm ? 0.35 : 1.35) : 1;
        costs[hazard.ownerId] = Math.max(costs[hazard.ownerId] || 0, risk * weight);
      }
      return Object.values(costs).reduce((sum, cost) => sum + cost, 0);
    }

    function walkSafely(e, dx, dz, speed, dt) {
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const hazards = persistentHazards(e);
      if (hazards.length) {
        const heading = Math.atan2(dz, dx);
        if (!e.steer || battle.tick >= e.steer.until
            || e.steer.dx * dx + e.steer.dz * dz < 0.5) {
          let best = { dx, dz }, bestScore = -Infinity;
          for (const offset of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.7, -1.7, Math.PI]) {
            const ux = Math.cos(heading + offset), uz = Math.sin(heading + offset);
            let cost = 0;
            for (const t of [0.25, 0.55, 0.85]) {
              const x = U.clamp(e.x + ux * speed * t, 55, W - 55);
              const z = U.clamp(e.z + uz * speed * t, 65, D - 65);
              cost += hazardCost(e, hazards, x, z, t) / 3;
            }
            const x = e.x + ux * speed * 0.55, z = e.z + uz * speed * 0.55;
            const wall = Math.max(0, 65 - x, x - W + 65, 75 - z, z - D + 75);
            // 长时间没有收益时仍允许冒险接敌，不能被跑道永远隔在外面。
            const penalty = e.noDmgT > 9 ? 85 : 210;
            const score = (ux * dx + uz * dz) * 65 - cost * penalty - wall * 2;
            if (score > bestScore) { bestScore = score; best = { dx: ux, dz: uz }; }
          }
          e.steer = { dx: best.dx, dz: best.dz, until: battle.tick + 9 };
        }
        dx = e.steer.dx; dz = e.steer.dz;
      }
      e.x = U.clamp(e.x + dx * speed * dt, 50, W - 50);
      e.z = U.clamp(e.z + dz * speed * dt, 60, D - 60);
      e.state = 'walk';
    }

    /** 在场地内选择闪避落点，惩罚仍在敌方预警范围内的方向。 */
    function startDodge(e, dx, dz, distance, duration, kind) {
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < 16; i++) {
        const angle = i * Math.PI / 8;
        const ux = Math.cos(angle), uz = Math.sin(angle);
        const x = U.clamp(e.x + ux * distance, 60, W - 60);
        const z = U.clamp(e.z + uz * distance, 70, D - 70);
        const travel = U.dist(e.x, e.z, x, z);
        if (travel < distance * 0.5) continue;
        let score = (ux * dx + uz * dz) * 35 + travel * 0.1;
        for (const zone of battle.zones) {
          if (friendlyEffect(zone, e) || zone.done) continue;
          const margin = U.dist(x, z, zone.x, zone.z) - zone.radius - e.unit.radius * 0.5;
          score += Math.min(0, margin) * 5;
        }
        // 同时比较两侧，别从一个弹道闪进另一个弹道。
        for (const p of battle.projectiles) {
          if (friendlyEffect(p, e) || p.lob) continue;
          const gap = U.dist(x, z, p.x + p.vx * duration, p.z + p.vz * duration);
          score -= Math.max(0, (p.radius || 24) + e.unit.radius - gap) * 3;
        }
        score -= hazardCost(e, persistentHazards(e), x, z, duration) * 180;
        if (score > bestScore) { bestScore = score; best = { x, z }; }
      }
      if (!best) return false;
      const x = best.x - e.x, z = best.z - e.z;
      const travel = Math.hypot(x, z);
      e.state = 'dash';
      e.dash = { dir: x / travel, dirZ: z / travel, dur: duration, t: 0,
        step: { dist: travel, dmg: 0, radius: 10 } };
      e.dodgeCd = DODGE_CD;
      push({ type: 'dodge', unitId: e.id, x: e.x, z: e.z, kind });
      return true;
    }

    function knockback(src, dst, mag, up) {
      if (dst.su7) return;
      const dx = dst.x - src.x, dz = dst.z - src.z;
      const len = Math.hypot(dx, dz) || 1;
      const k = 1 / Math.max(0.3, dst.unit.stats.weight);
      dst.vx += (dx / len) * mag * k;
      dst.vz += (dz / len) * mag * k;
      if (up) dst.vh += up * k;
    }

    // ---------- 施法 ----------
    function canCast(e, key) {
      if (!e.unit[key] || e.su7 || hasBuff(e, 'seal')) return false;
      const sk = e.unit[key];
      if (key === 'ult') return e.energy >= (sk.cost || 100);
      return (e.cds[key] || 0) <= 0 && e.energy >= (sk.cost || 0);
    }

    function startCast(e, key) {
      const sk = e.unit[key];
      if (!sk) return false;
      if (!canCast(e, key)) return false;
      const row = contribution(e);
      if (row) row.casts++;
      if (key === 'ult') e.energy = U.clamp(e.energy - (sk.cost || 100), 0, 100);
      else {
        e.energy = U.clamp(e.energy - (sk.cost || 0), 0, 100);
        e.cds[key] = (sk.cd || (key === 's1' ? 6 : 8)) * CD_SCALE;
      }
      // 蓄力前摇：蓄力期间站桩可被打断（霸体 / uninterruptible 除外）
      const charge = sk.cast != null ? sk.cast : (CHARGE[key] || 0.6);
      // 代价型技能：施放时先付出自身血量（王境泽「真香」：先嘴硬，再真香）
      if (sk.hpCost && e.hp > 1) {
        const cost = Math.max(1, Math.round(e.hp * sk.hpCost));
        e.hp = Math.max(1, e.hp - cost);
        push({ type: 'self_cost', unitId: e.id, amount: cost, x: e.x, z: e.z, h: e.h + 40 });
      }
      e.cast = {
        key, skill: sk, steps: (sk.steps || []).slice(), idx: 0, t: 0,
        targetId: e.targetId,
        charging: charge > 0, chargeT: 0, chargeDur: charge,
      };
      e.state = charge > 0 ? 'charge' : (key === 'ult' ? 'ult' : 'cast');
      e.stateT = 0;
      push({ type: 'charge_start', unitId: e.id, of: e.unitId, key, name: sk.name,
        dur: U.round2(charge), x: e.x, z: e.z, h: e.h + 40, ult: key === 'ult' });
      if (key === 'ult') push({ type: 'shake', mag: 6 });
      if (!e.unit[key] || key !== 'basic') {
        battle.stats.casts.push({ t: U.round2(battle.time), unitId: e.unitId, skill: key, name: sk.name });
      }
      push({ type: 'cast', unitId: e.id, of: e.unitId, key, name: sk.name, line: sk.line || '',
        x: e.x, z: e.z, h: e.h + 40, ult: key === 'ult' });
      if (key === 'ult') push({ type: 'shake', mag: 9 });
      return true;
    }

    function startBasic(e) {
      const tl = CC.fighters.basicAttackTimeline(e.unit);
      if (e.isMinion && e.unit.role !== 'ranged') {
        tl[0].dmg = 0.34;
      }
      e.cast = { key: 'basic', skill: { name: '普通攻击' }, steps: tl, idx: 0, t: 0 };
      e.state = 'attack';
      e.stateT = 0;
      e.atkCd = e.unit.stats.atkInterval;
    }

    function finishSu7(e, reason) {
      const d = e.su7;
      if (!d) return;
      e.su7 = null; e.cast = null; e.plan = null; e.deciding = 0;
      e.h = 0; e.vx = 0; e.vz = 0; e.vh = 0; e.hitstun = 0; e.bubbleCageT = 0;
      e.state = e.alive ? 'idle' : 'ko'; e.stateT = 0;
      e.lastX = e.x; e.lastZ = e.z; e.stuck = 0;
      push({ type: 'su7End', unitId: e.id, x: e.x, z: e.z, h: 0, dx: d.dx, dz: d.dz, reason });
    }

    function updateSu7(e, dt) {
      const d = e.su7;
      d.t += dt; d.retargetT -= dt; d.skidT += dt;
      const targets = foes(e);
      if (!targets.length) { finishSu7(e, 'no-target'); return; }
      if (d.t >= d.dur - 1e-9) { finishSu7(e, 'timeout'); return; }
      e.state = 'su7'; e.hitstun = 0; e.bubbleCageT = 0;
      e.h = 0; e.vx = 0; e.vz = 0; e.vh = 0;
      if (d.retargetT <= 0 || !targets.some((o) => o.id === d.targetId)) {
        const ready = targets.filter((o) => d.lastHit[o.id] == null || battle.tick - d.lastHit[o.id] >= d.hitTicks);
        ready.sort((a, b) => U.dist2(e.x, e.z, a.x, a.z) - U.dist2(e.x, e.z, b.x, b.z) || a.id - b.id);
        d.targetId = ready.length ? ready[0].id : 0;
        d.retargetT = 0.2;
      }
      const target = targets.find((o) => o.id === d.targetId);
      if (target) {
        const angle = Math.atan2(d.dz, d.dx);
        const want = Math.atan2(target.z - e.z, target.x - e.x);
        const delta = Math.atan2(Math.sin(want - angle), Math.cos(want - angle));
        const turn = (d.step.turnRate || 5.5) * dt;
        const heading = angle + U.clamp(delta, -turn, turn);
        d.dx = Math.cos(heading); d.dz = Math.sin(heading);
      }
      const oldX = e.x, oldZ = e.z, travel = d.speed * dt;
      const marginX = Math.max(80, d.radius), marginZ = Math.max(90, d.radius);
      let nx = e.x + d.dx * travel, nz = e.z + d.dz * travel;
      if (nx < marginX) { nx = marginX * 2 - nx; d.dx = Math.abs(d.dx); }
      if (nx > W - marginX) { nx = (W - marginX) * 2 - nx; d.dx = -Math.abs(d.dx); }
      if (nz < marginZ) { nz = marginZ * 2 - nz; d.dz = Math.abs(d.dz); }
      if (nz > D - marginZ) { nz = (D - marginZ) * 2 - nz; d.dz = -Math.abs(d.dz); }
      e.x = U.clamp(nx, marginX, W - marginX); e.z = U.clamp(nz, marginZ, D - marginZ);
      e.facing = d.dx >= 0 ? 1 : -1;
      const sx = e.x - oldX, sz = e.z - oldZ, length2 = sx * sx + sz * sz;
      for (const o of targets) {
        if (!o.alive || (d.lastHit[o.id] != null && battle.tick - d.lastHit[o.id] < d.hitTicks)) continue;
        const along = length2 > 0 ? U.clamp(((o.x - oldX) * sx + (o.z - oldZ) * sz) / length2, 0, 1) : 0;
        if (U.dist(oldX + sx * along, oldZ + sz * along, o.x, o.z) > d.radius + o.unit.radius * 0.6) continue;
        d.lastHit[o.id] = battle.tick; d.retargetT = 0;
        const dmg = applyDamage(e, o, d.step.dmg || 0.42, { skill: d.skill, melee: true });
        if (dmg > 0) push({ type: 'su7Hit', unitId: e.id, targetId: o.id, x: o.x, z: o.z,
          h: o.h + 25, dx: d.dx, dz: d.dz, dmg });
        if (!e.alive) return;
        if (dmg > 0 && o.alive) {
          knockback({ x: o.x - d.dx * 20, z: o.z - d.dz * 20 }, o, d.step.knock || 210);
          if (!hasBuff(o, 'superArmor')) {
            o.hitstun = Math.max(o.hitstun, d.step.hitstun || 0.3); o.state = 'hurt'; o.stateT = 0;
            creditControl(e, o, d.step.hitstun || 0.3);
          }
        }
      }
      if (!foes(e).length) { finishSu7(e, 'no-target'); return; }
      if (d.skidT >= 0.08) {
        d.skidT -= 0.08;
        push({ type: 'su7Skid', unitId: e.id, x1: d.trailX, z1: d.trailZ, x2: e.x, z2: e.z,
          x: e.x, z: e.z, dx: d.dx, dz: d.dz });
        d.trailX = e.x; d.trailZ = e.z;
      }
    }

    function finishRun(e) {
      const r = e.run;
      e.run = null;
      const target = all().find((o) => o.id === r.targetId && o.alive) || castTarget(e);
      if (!target) { e.stacks.pace = 0; e.state = 'idle'; return; }
      const dx = target.x - e.x, dz = target.z - e.z, len = Math.hypot(dx, dz) || 1;
      const dist = Math.min(r.step.finishDist || 520, len + 45);
      e.state = 'dash'; e.stateT = 0; e.facing = dx >= 0 ? 1 : -1;
      e.dash = { dir: dx / len, dirZ: dz / len, t: 0, dur: 0.38, skill: r.skill,
        step: { dist, dmg: r.step.dmg + r.pace * r.step.perPace, radius: 78,
          knock: r.step.knock, hitstun: 0.4, finish: true, pace: r.pace, marked: r.marked } };
      battle.tracks.push({ id: battle._eid++, ownerId: e.id, side: e.side, finish: true,
        x1: target.x - dz / len * 85, z1: target.z + dx / len * 85,
        x2: target.x + dz / len * 85, z2: target.z - dx / len * 85, t: 0, life: 1.5 });
      push({ type: 'run_finish', unitId: e.id, x: e.x, z: e.z, pace: r.pace, distance: r.distance,
        trackHits: Object.keys(r.marked).length });
    }

    function updateRun(e, dt) {
      const r = e.run, step = r.step;
      r.t += dt;
      if (e.hitstun <= 0) {
        const angle = r.angle + r.direction * Math.PI * 2 * Math.min(1, r.t / step.dur);
        const tx = r.cx + Math.cos(angle) * step.radius, tz = r.cz + Math.sin(angle) * step.radius;
        const dx = tx - e.x, dz = tz - e.z, len = Math.hypot(dx, dz) || 1;
        const travel = Math.min(len, (step.speed || 510) * dt);
        e.x = U.clamp(e.x + dx / len * travel, 55, W - 55);
        e.z = U.clamp(e.z + dz / len * travel, 65, D - 65);
        r.distance += travel; e.facing = dx >= 0 ? 1 : -1; e.state = 'run';
        const pace = Math.min(5, r.bonus + Math.floor(r.distance / 135));
        if (pace > r.pace) {
          r.pace = pace; e.stacks.pace = pace;
          push({ type: 'run_pace', unitId: e.id, x: e.x, z: e.z, pace });
        }
        if (battle.tick % 6 === 0 && U.dist(r.lastX, r.lastZ, e.x, e.z) > 2) {
          battle.tracks.push({ id: battle._eid++, ownerId: e.id, side: e.side,
            x1: r.lastX, z1: r.lastZ, x2: e.x, z2: e.z, t: 0, life: step.trailLife,
            dmg: step.trailDmg, skill: r.skill, marked: r.marked });
          r.lastX = e.x; r.lastZ = e.z;
        }
      } else e.state = 'hurt';
      if (r.t >= step.dur) finishRun(e);
    }

    function updateTracks(dt) {
      for (let i = battle.tracks.length - 1; i >= 0; i--) {
        const track = battle.tracks[i]; track.t += dt;
        const owner = all().find((o) => o.id === track.ownerId && o.alive);
        if (!owner || track.t >= track.life) { battle.tracks.splice(i, 1); continue; }
        if (track.finish) continue;
        const dx = track.x2 - track.x1, dz = track.z2 - track.z1;
        const len2 = dx * dx + dz * dz || 1;
        for (const o of foes(owner)) {
          const t = U.clamp(((o.x - track.x1) * dx + (o.z - track.z1) * dz) / len2, 0, 1);
          if (U.dist(o.x, o.z, track.x1 + dx * t, track.z1 + dz * t) > 30 + o.unit.radius * 0.5) continue;
          o.trackCd = o.trackCd || {};
          if ((o.trackCd[owner.id] || 0) > battle.tick) continue;
          o.trackCd[owner.id] = battle.tick + 24;
          track.marked[o.id] = true;
          applyDamage(owner, o, track.dmg, { skill: track.skill, detail: 'track' });
          if (o.alive) addBuff(o, 'speedDown', 0.7, 0.22, owner);
        }
      }
    }

    function updateBubbleTraps(dt) {
      for (let i = battle.bubbleTraps.length - 1; i >= 0; i--) {
        const trap = battle.bubbleTraps[i]; trap.t += dt;
        const owner = all().find((o) => o.id === trap.ownerId && o.alive);
        if (!owner || trap.t >= trap.life) { battle.bubbleTraps.splice(i, 1); continue; }
        if (trap.t < trap.arm) continue;
        const targets = foes(owner).filter((o) => U.dist(o.x, o.z, trap.x, trap.z) < trap.radius);
        if (!targets.length) continue;
        for (const o of targets.slice(0, 2)) {
          applyDamage(owner, o, trap.dmg, { skill: 's2', detail: 'trap' });
          if (!o.alive) continue;
          addBuff(o, 'bubble', 8, 2, owner);
          o.hitstun = Math.max(o.hitstun, 0.8); o.state = 'stun'; o.bubbleCageT = 0.8;
          creditControl(owner, o, 0.8);
          push({ type: 'bubble_cage', unitId: o.id, x: o.x, z: o.z });
        }
        battle.bubbleTraps.splice(i, 1);
      }
    }

    // ---------- 实体更新 ----------
    function updateEntity(e, dt) {
      if (!e.alive) return;
      const row = !e.isMinion && contribution(e);
      if (row) row.aliveSeconds += dt;
      const control = e.controlCredit;
      if (control && control.end >= battle.tick && !e.su7) {
        const controller = contribution(control.ownerId);
        if (controller) controller.controlSeconds += Math.min(dt, Math.max(e.hitstun, e.bubbleCageT || 0));
      }

      // 计时器
      e.stateT += dt;
      e.bubbleCageT = Math.max(0, (e.bubbleCageT || 0) - dt);
      e.atkCd = Math.max(0, e.atkCd - dt);
      e.deciding = Math.max(0, e.deciding - dt);
      e.dodgeCd = Math.max(0, e.dodgeCd - dt);
      e.hitstun = Math.max(0, e.hitstun - dt);
      e.comboT = Math.max(0, e.comboT - dt);
      e.noDmgT = (e.noDmgT || 0) + dt;          // 距上次打出伤害的时间（反僵死用）
      if (e.comboT <= 0) e.combo = 0;
      for (const k in e.cds) e.cds[k] = Math.max(0, e.cds[k] - dt);
      e.energy = U.clamp(e.energy + 3 * dt, 0, 100);

      // buff 计时与持续效果
      for (let i = e.buffs.length - 1; i >= 0; i--) {
        const b = e.buffs[i];
        b.t += dt;
        if (b.kind === 'poison') {
          const damage = Math.min(e.hp, e.maxHp * b.mag * dt);
          e.hp = U.clamp(e.hp - damage, 0, e.maxHp);
          recordDamage(b.ownerId, e, damage, 'poison');
          if (e.hp <= 0) { kill(e, all().find((o) => o.id === b.ownerId) || null); return; }
        } else if (b.kind === 'regen') {
          restoreHealth(b.ownerId || e.id, e, e.maxHp * b.mag * dt);
        }
        if (b.t >= b.dur) {
          if (b.kind === 'shield') e.shield = 0;
          e.buffs.splice(i, 1);
        }
      }

      // 召唤物寿命
      if (e.isMinion) {
        e.life -= dt;
        const ownerGone = e.isDecoy && !all().some((o) => o.id === e.ownerId && o.alive);
        if (e.life <= 0 || ownerGone) { kill(e, null); return; }
      }
      if (e.isDecoy) return;

      if (e.su7) { updateSu7(e, dt); return; }
      if (e.run) { updateRun(e, dt); return; }

      // 冲刺
      if (e.dash && e.state !== 'dash') {
        // 受击中止突进时清理状态，避免残留 dash 永久阻止后续施法。
        if (e.dash.step.jumpHeight) { e.h = 0; e.vh = 0; }
        e.dash = null;
      }
      if (e.state === 'dash' && e.dash) {
        dbg('dash');
        const d = e.dash;
        d.t += dt;
        const sp = ((d.dist == null ? d.step.dist : d.dist) / Math.max(0.05, d.dur));
        if (d.step.jumpHeight) e.h = Math.sin(Math.PI * Math.min(1, d.t / d.dur)) * d.step.jumpHeight;
        e.x += d.dir * sp * dt;
        e.z += (d.dirZ || 0) * sp * dt;
        e.x = U.clamp(e.x, 60, W - 60);
        e.z = U.clamp(e.z, 70, D - 70);
        // 路径伤害
        for (const o of d.step.dmg > 0 ? foes(e) : []) {
          if (!o.alive) continue;
          if (U.dist(e.x, e.z, o.x, o.z) < (d.step.radius || 46) + o.unit.radius * 0.5) {
            if (!(o._dashHit && o._dashHit === d)) {
              o._dashHit = d;
              const coef = d.step.dmg + (d.step.finish && d.step.marked[o.id] ? 0.3 : 0);
              applyDamage(e, o, coef, { skill: d.skill || (e.cast ? e.cast.key : 's1'), detail: d.step.finish ? 'run_finish' : null, melee: true,
                armorPierce: d.step.pierceArmor ? 0.4 : (d.step.armorPierce || 0),
                lowHpBonus: d.step.lowHpBonus });
              if (d.step.knock && o.alive) knockback(e, o, d.step.knock, d.step.up);
              if (d.step.hitstun && o.alive && !hasBuff(o, 'superArmor')) {
                o.hitstun = d.step.hitstun; o.state = 'hurt'; creditControl(e, o, d.step.hitstun);
              }
              if (d.step.grab && o.alive) { o.x = e.x + e.facing * 30; o.h = 16; }
            }
          }
        }
        if (d.t >= d.dur) {
          if (d.step.jumpHeight) {
            e.h = 0; e.vh = 0;
            push({ type: 'kick_land', unitId: e.id, x: e.x, z: e.z, h: 0 });
          }
          if (d.step.finish) e.stacks.pace = 0;
          e.dash = null; e.state = 'idle';
        }
        return;
      }

      // 施法时间轴（含蓄力前摇）
      if (e.cast) {
        dbg('cast');
        const c = e.cast;
        // 蓄力/施法期间持续转向目标（否则对手绕圈就会导致整段前摇空掉）
        const liveFoe = castTarget(e);
        if (liveFoe) e.facing = liveFoe.x >= e.x ? 1 : -1;
        if (c.charging) {
          c.chargeT += dt;
          e.state = 'charge';
          if (c.chargeT < c.chargeDur) return;        // 蓄力未完成：不动、不出招
          c.charging = false;
          e.state = c.key === 'ult' ? 'ult' : 'cast';
          push({ type: 'charge_done', unitId: e.id, key: c.key, x: e.x, z: e.z, h: e.h + 40 });
        }
        c.t += dt;
        while (c.idx < c.steps.length && c.t >= (c.steps[c.idx].t || 0)) {
          runStep(e, c.steps[c.idx], { skillKey: c.key });
          c.idx++;
        }
        if (c.idx >= c.steps.length) {
          const dur = c.skill && c.key !== 'basic' ? 0.55 : 0.25;
          if (c.t >= dur && !e.run && !e.dash && !e.su7) { e.cast = null; e.state = 'idle'; }
        }
        return;
      }

      // 受击硬直
      if (e.hitstun > 0) { dbg('hitstun'); e.state = 'hurt'; return; }

      // 物理
      e.x += e.vx * dt;
      e.z += e.vz * dt;
      e.h += e.vh * dt;
      if (e.h > 0) e.vh -= 900 * dt;
      if (e.h <= 0) { e.h = 0; e.vh = 0; }
      e.vx = U.approach(e.vx, 0, 1400 * dt);
      e.vz = U.approach(e.vz, 0, 1400 * dt);
      e.x = U.clamp(e.x, 50, W - 50);
      e.z = U.clamp(e.z, 60, D - 60);

      // 卡住检测（兜底，绝不允许站桩）
      if (U.dist2(e.x, e.z, e.lastX, e.lastZ) < 4) e.stuck += dt; else { e.stuck = 0; e.lastX = e.x; e.lastZ = e.z; }

      // AI 决策
      const deadTarget = e.plan && e.plan.targetId && !foes(e).some((o) => o.id === e.plan.targetId);
      if ((e.deciding <= 0 || deadTarget) && CC.ai) {
        e.deciding = 0.25;
        e.plan = CC.ai.decide(battle, e);
      }
      if (!e.plan) e.plan = { mode: 'approach', targetId: 0, wantRange: rangeOf(e) };

      // 目标
      let tgt = null;
      if (e.plan.targetId) tgt = all().find((o) => o.id === e.plan.targetId && o.alive);
      if (!tgt) tgt = nearestFoe(e);
      if (!tgt) return;
      e.targetId = tgt.id;
      e.facing = tgt.x >= e.x ? 1 : -1;

      // 躲避：先躲 AOE 预警圈，再预判侧闪飞行道具（捡石头途中同样会闪）
      if (e.dodgeCd <= 0 && !hasBuff(e, 'invuln')) {
        for (const z of battle.zones) {
          if (friendlyEffect(z, e) || z.done) continue;
          if (U.dist(e.x, e.z, z.x, z.z) < z.radius + e.unit.radius * 0.5) {
            dbg('dodge');
            const dx = e.x - z.x, dz = e.z - z.z;
            if (startDodge(e, dx || (dz ? 0 : e.facing), dz, 190, 0.22, 'zone')) return;
          }
        }
        for (const p of battle.projectiles) {
          if (friendlyEffect(p, e) || p.lob) continue;
          const d = U.dist(p.x, p.z, e.x, e.z);
          if (d > 230) continue;
          const dx = e.x - p.x, dz = e.z - p.z;
          const speed2 = p.vx * p.vx + p.vz * p.vz;
          if (speed2 <= 0) continue;
          const impactT = (dx * p.vx + dz * p.vz) / speed2;
          if (impactT <= 0 || impactT > 0.35 || impactT > p.life) continue;
          const miss = U.dist(p.x + p.vx * impactT, p.z + p.vz * impactT, e.x, e.z);
          if (miss > (p.radius || 24) + e.unit.radius * 0.6 + 12) continue;
          if (startDodge(e, -p.vz, p.vx, 180, 0.2, 'projectile')) return;
        }
      }

      // 有反应时间才能走开；蓄力/受控中的角色仍会踩陷阱，不获得免费无敌闪避。
      const hazards = persistentHazards(e);
      if (hazards.length && e.noDmgT < 8 && hazardCost(e, hazards, e.x, e.z, 0.2) > 0.6) {
        walkSafely(e, tgt.x - e.x, tgt.z - e.z, speedOf(e), dt);
        battle.dbg.avoid = (battle.dbg.avoid || 0) + 1;
        return;
      }

      // 技能释放（AI 决定 + 硬校验）
      if (CC.ai && CC.ai.wantSkill) {
        const key = CC.ai.wantSkill(battle, e);
        if (key && canCast(e, key)) {
          dbg('skill:' + key);
          startCast(e, key);
          return;
        }
      }

      // 收集模式：跑向最近的物件（凑企鹅捡石头）
      if (e.plan.mode === 'collect' && e.plan.pickupId && battle.pickups.length) {
        const pk = battle.pickups.find((p) => p.id === e.plan.pickupId);
        if (pk) {
          const dx = pk.x - e.x, dz = pk.z - e.z;
          const l = Math.hypot(dx, dz) || 1;
          if (l > 12) {
            walkSafely(e, dx / l, dz / l, speedOf(e), dt);
            e.facing = dx >= 0 ? 1 : -1;
            e.x = U.clamp(e.x, 50, W - 50);
            e.z = U.clamp(e.z, 60, D - 60);
            battle.dbg.approach++;
            return;
          }
        }
      }

      // 移动与普攻
      const d = U.dist(e.x, e.z, tgt.x, tgt.z);
      const sp = speedOf(e) * (e.stuck > 1.2 ? 1.8 : 1);
      const dx = tgt.x - e.x, dz = tgt.z - e.z;
      const len = Math.hypot(dx, dz) || 1;
      const mx = dx / len, mz = dz / len;

      // 等冷却时侧移找角度；只有进攻技能快准备好时才略微缩短交战距离。
      if ((e.stuck > 2.5 && e.plan.mode !== 'approach') || e.noDmgT > 5) {
        const ranged = !!e.plan.ranged;
        const reach = e.plan.attackRange || rangeOf(e);
        const ready = ['s1', 's2'].some((key) => e.unit[key] && e.cds[key] <= 0.8);
        e.plan = { mode: ranged ? 'kite' : 'approach', targetId: tgt.id, threatId: e.plan.threatId,
          ranged, attackRange: reach, wantRange: ranged ? Math.max(160, reach * (ready ? 0.75 : 0.9)) : rangeOf(e) };
        e.stuck = 0;
        e._fleeing = false;
        e._kiting = false;
      }

      const want = e.plan.wantRange || rangeOf(e);
      // 远程按战术距离停步，近战则必须进入实际攻击范围。
      const atkRange = e.plan.ranged ? want : Math.max(20, e.unit.stats.range + tgt.unit.radius * 0.5 - 6);

      // 后撤/风筝必须有空间，否则会被夹在墙角永远出不来
      const threat = foes(e).find((o) => o.id === e.plan.threatId) || tgt;
      const threatD = U.dist(e.x, e.z, threat.x, threat.z);
      const fleeX = (e.x - threat.x) / (threatD || 1), fleeZ = (e.z - threat.z) / (threatD || 1);
      const backX = e.x + fleeX * 90, backZ = e.z + fleeZ * 90;
      const hasSpace = backX > 60 && backX < W - 60 && backZ > 70 && backZ < D - 70;

      // —— 用迟滞开关代替"逐帧比大小"，否则会在阈值上来回抖动导致原地不动 ——
      if (e.plan.mode === 'kite') {
        if (threatD < want * 0.7) e._kiting = true;
        if (threatD > want * 1.15) e._kiting = false;
      } else e._kiting = false;
      if (e.plan.mode === 'retreat') {
        if (threatD < want * 0.85) e._fleeing = true;
        if (threatD > want * 1.15 || e.noDmgT > 5) e._fleeing = false;
      } else e._fleeing = false;

      if (e._kiting && hasSpace) {
        walkSafely(e, fleeX, fleeZ, sp, dt);
        battle.dbg.kite++;
      } else if (e._fleeing && hasSpace) {
        walkSafely(e, fleeX, fleeZ, sp, dt);
        battle.dbg.retreat++;
      } else if (d > atkRange) {
        walkSafely(e, mx, mz, sp, dt);
        battle.dbg.approach++;
      } else {
        // 等技能时不要呆立：保持间距 + 缓慢侧移绕圈（看上去像在找出手机会）
        if (e.isMinion && e.atkCd <= 0) {
          startBasic(e);
          battle.dbg.attack++;
          return;
        }
        if (e._orbitDir === undefined) e._orbitDir = (e.id % 2 === 0) ? 1 : -1;
        // 靠墙时反转绕圈方向，避免两个近战互相绕到墙角卡死
        const px = -mz, pz = mx;                    // 垂直于"我→目标"的方向
        const clearance = (sign) => Math.min(e.x + px * sign * 80 - 50,
          W - 50 - (e.x + px * sign * 80), e.z + pz * sign * 80 - 60,
          D - 60 - (e.z + pz * sign * 80));
        if (clearance(e._orbitDir) < 60 && clearance(-e._orbitDir) > clearance(e._orbitDir) + 10) {
          e._orbitDir = -e._orbitDir;
        }
        const drift = speedOf(e) * 0.33;
        let ox = px * e._orbitDir, oz = pz * e._orbitDir;
        // 贴太近再慢慢拉开（阈值远低于接近阈值，不会来回抖）
        if (d < atkRange * 0.6) {
          ox -= mx; oz -= mz;
        }
        walkSafely(e, ox, oz, drift * Math.hypot(ox, oz), dt);
        battle.dbg.orbit = (battle.dbg.orbit || 0) + 1;
      }

      // 场地边缘软排斥：绝不把单位留在墙角（否则近战会互相堵死）
      const MARGIN = 170;
      if (e.x < MARGIN) e.x += (MARGIN - e.x) * 0.16;
      else if (e.x > W - MARGIN) e.x -= (e.x - (W - MARGIN)) * 0.16;
      if (e.z < MARGIN) e.z += (MARGIN - e.z) * 0.16;
      else if (e.z > D - MARGIN) e.z -= (e.z - (D - MARGIN)) * 0.16;
      e.x = U.clamp(e.x, 50, W - 50);
      e.z = U.clamp(e.z, 60, D - 60);
    }

    // ---------- 地上可拾取物件（凑企鹅捡石头这类机制） ----------
    function spawnPickup(kind, count) {
      for (let i = 0; i < (count == null ? 1 : count); i++) {
        const p = {
          id: battle._eid++, kind: kind || 'stone',
          x: battle.rng.range(110, W - 110), z: battle.rng.range(90, D - 90), h: 0,
          t: 0, ttl: PICKUP_TTL, born: battle.time,
        };
        battle.pickups.push(p);
        push({ type: 'pickup_spawn', kind: p.kind, x: p.x, z: p.z, count: battle.pickups.length });
      }
    }

    function tryCollect(e) {
      const tr = e.trait;
      if (!tr || !tr.collect) return;
      const want = tr.max == null ? 10 : tr.max;
      const have = e.stacks[tr.collect] || 0;
      if (have >= want) return;
      const rad = tr.radius || 46;
      for (let i = battle.pickups.length - 1; i >= 0; i--) {
        const p = battle.pickups[i];
        if (p.kind !== tr.collect) continue;
        if (U.dist(e.x, e.z, p.x, p.z) > rad) continue;
        battle.pickups.splice(i, 1);
        e.stacks[tr.collect] = (e.stacks[tr.collect] || 0) + 1;
        battle.stats.picked[tr.collect] = (battle.stats.picked[tr.collect] || 0) + 1;
        push({ type: 'pickup', unitId: e.id, kind: tr.collect, count: e.stacks[tr.collect],
          max: want, x: p.x, z: p.z, h: 20 });
        break;
      }
    }

    function updatePickups(dt) {
      for (let i = battle.pickups.length - 1; i >= 0; i--) {
        const p = battle.pickups[i];
        p.t += dt;
        if (p.t > p.ttl) battle.pickups.splice(i, 1);
      }
      // 每只存活企鹅提供相同资源预算；阵亡后保留地上存量，只降低后续补充目标。
      battle._pickupT += dt;
      if (battle._pickupT >= PICKUP_RESPAWN - 1e-9) {
        battle._pickupT = 0;
        const collectors = stoneCollectors();
        const stones = battle.pickups.filter((p) => p.kind === 'stone').length;
        const need = STONES_TARGET * collectors - stones;
        if (need > 0) spawnPickup('stone', Math.min(need, STONES_REFILL * collectors));
      }
      for (const e of all()) if (e.alive) tryCollect(e);
    }

    // ---------- 投射物 / 区域 ----------
    function updateProjectiles(dt) {
      for (let i = battle.projectiles.length - 1; i >= 0; i--) {
        const p = battle.projectiles[i];
        p.life -= dt;
        const owner = all().find((o) => o.id === p.ownerId);
        if (!owner) { battle.projectiles.splice(i, 1); continue; }
        const enemySide = foes(owner);
        // 抛物线落石：不参与普通碰撞，落地即范围结算
        if (p.lob) {
          p.t += dt;
          p.x += p.vx * dt;
          p.z += p.vz * dt;
          p.vh -= 900 * dt;
          p.h += p.vh * dt;
          if (p.t >= p.flightT || p.h <= 0) {
            landStone(p);
            battle.projectiles.splice(i, 1);
          }
          continue;
        }
        // 追踪 AI 锁定目标；目标死亡后再就近重选，弹跳时保留新的目标。
        if (p.homing) {
          const ignored = (o) => p.phone ? p.hitIds.includes(o.id) : o._projIgnore === p.id;
          let near = enemySide.find((o) => o.alive && o.id === p.targetId && !ignored(o));
          let bd = Infinity;
          for (const o of near ? [] : enemySide) {
            if (!o.alive) continue;
            if (ignored(o)) continue;
            const d2 = U.dist2(p.x, p.z, o.x, o.z);
            if (d2 < bd) { bd = d2; near = o; }
          }
          if (near) {
            const dx = near.x - p.x, dz = near.z - p.z;
            const l = Math.hypot(dx, dz) || 1;
            const tx = (dx / l) * p.speed, tz = (dz / l) * p.speed;
            const turn = 0.30;                       // 每帧最多转 30% 朝目标
            p.vx += (tx - p.vx) * turn;
            p.vz += (tz - p.vz) * turn;
            const sp = Math.hypot(p.vx, p.vz) || 1;
            p.vx = (p.vx / sp) * p.speed;
            p.vz = (p.vz / sp) * p.speed;
          }
        }
        p.x += p.vx * dt;
        p.z += p.vz * dt;
        let hit = false;
        for (const o of enemySide) {
          if (!o.alive) continue;
          if (p.phone ? p.hitIds.includes(o.id) : o._projIgnore === p.id) continue;
          if (U.dist(p.x, p.z, o.x, o.z) < p.radius + o.unit.radius * 0.6) {
            if (p.phone) p.hitIds.push(o.id);
            applyDamage(owner, o, p.dmg, { skill: p.skill, knock: 40, interrupt: p.interrupt });
            applyEffects(owner, o, p.effects, p);
            p.hits++;
            let consumed = !p.pierce;
            // 弹跳：命中后找一个新目标继续飞（孙笑川的「表情包连弹」）
            if (p.bounces > 0) {
              p.bounces--;
              const next = p.phone ? enemySide.filter((x) => x.alive && !p.hitIds.includes(x.id)
                && U.dist(p.x, p.z, x.x, x.z) <= p.bounceRange)
                .sort((a, b) => U.dist2(p.x, p.z, a.x, a.z) - U.dist2(p.x, p.z, b.x, b.z) || a.id - b.id)[0]
                : enemySide.find((x) => x.alive && x !== o && x._projIgnore !== p.id);
              if (next) {
                p.targetId = next.id;
                const dx = next.x - p.x, dz = next.z - p.z;
                const l = Math.hypot(dx, dz) || 1;
                p.vx = (dx / l) * p.speed;
                p.vz = (dz / l) * p.speed;
                p.homing = true;
                p.life = Math.max(p.life, 1.2);
                if (!p.phone) o._projIgnore = p.id;
                consumed = false;
                push({ type: 'bounce', unitId: p.ownerId, x: p.x, z: p.z, to: next.id, left: p.bounces, phone: !!p.phone });
              }
            }
            if (consumed) hit = true;
            if (hit || p.phone) break;
          }
        }
        if (hit || p.life <= 0 || p.x < 0 || p.x > W || p.z < 40 || p.z > D - 40) battle.projectiles.splice(i, 1);
      }
    }

    /** 落石雨的每一块石头：从投掷者手里抛出去，抛物线落到落点后范围伤害 */
    function lobStone(r) {
      const owner = all().find((o) => o.id === r.ownerId && o.alive);
      if (!owner) return false;
      const ang = battle.rng.range(0, Math.PI * 2);
      const rad = Math.sqrt(battle.rng.next()) * r.radius;
      const tx = U.clamp(r.x + Math.cos(ang) * rad, 60, W - 60);
      const tz = U.clamp(r.z + Math.sin(ang) * rad, 70, D - 70);
      const dist = U.dist(owner.x, owner.z, tx, tz);
      const flightT = U.clamp(dist / 640, 0.32, 0.95);
      battle.projectiles.push({
        id: battle._eid++, ownerId: r.ownerId, side: r.side, skill: r.skill, lob: true,
        x: owner.x, z: owner.z, h: owner.h + 56,
        vx: (tx - owner.x) / flightT, vz: (tz - owner.z) / flightT,
        vh: 0.5 * 900 * flightT,          // 抛物线初速（重力 900）
        t: 0, flightT, tx, tz,
        dmg: r.dmg, radius: r.dropRadius, effects: r.effects, knock: r.knock,
        speed: 0, life: flightT + 0.6, sprite: r.sprite || 'star', scale: 0.85,
        pierce: false, homing: false, hits: 0,
      });
      push({ type: 'stone_launch', unitId: r.ownerId, x: owner.x, z: owner.z, h: owner.h + 56,
        tx, tz, left: r.left, total: r.total });
      return true;
    }

    function landStone(p) {
      const owner = all().find((o) => o.id === p.ownerId);
      const enemySide = owner ? foes(owner) : [];
      for (const o of enemySide) {
        if (!o.alive) continue;
        if (U.dist(o.x, o.z, p.tx, p.tz) > p.radius + o.unit.radius * 0.5) continue;
        if (owner) applyDamage(owner, o, p.dmg, { skill: p.skill || 's2', knock: p.knock || 80 });
        else o.hp = U.clamp(o.hp - 1, 0, o.maxHp);
        if (owner) applyEffects(owner, o, p.effects, p);
      }
      push({ type: 'stone_drop', unitId: p.ownerId, x: p.tx, z: p.tz, left: 0, total: 0 });
      push({ type: 'shake', mag: 2 });
    }

    function updateRains(dt) {
      for (let i = battle.rains.length - 1; i >= 0; i--) {
        const r = battle.rains[i];
        r.t += dt;
        while (r.left > 0 && r.t >= r.nextAt) {
          r.left--;
          r.nextAt += r.interval;
          if (!lobStone(r)) { r.left = 0; break; }
        }
        if (r.left <= 0 && r.t >= r.nextAt + 0.5) battle.rains.splice(i, 1);
      }
    }

    function updateZones(dt) {
      for (let i = battle.zones.length - 1; i >= 0; i--) {
        const z = battle.zones[i];
        z.t += dt;
        const owner = all().find((o) => o.id === z.ownerId);
        if (z.t >= z.warn) {
          const sinceFire = z.t - z.warn;
          if (z.fired < (z.repeat || 1) && sinceFire >= z.nextFire) {
            z.fired++;
            z.nextFire += (z.repeatGap || 0.4);
            if (owner) {
              for (const o of foes(owner)) {
                if (!o.alive) continue;
                if (U.dist(o.x, o.z, z.x, z.z) < z.radius + o.unit.radius * 0.5) {
                  applyDamage(owner, o, z.dmg, { skill: z.skill, armorPierce: z.armorPierce });
                  applyEffects(owner, o, z.effects, z);
                  if (z.knock && o.alive) knockback({ x: z.x, z: z.z, unit: owner.unit }, o, z.knock, 120);
                }
              }
            }
            push({ type: 'boom', x: z.x, z: z.z, radius: z.radius, sprite: z.sprite });
            push({ type: 'shake', mag: 7 });
            z.done = z.fired >= (z.repeat || 1);
          }
          if (z.done && sinceFire > 0.25) battle.zones.splice(i, 1);
        }
      }
    }

    function checkEnd() {
      if (mode === 'brawl') {
        const survivors = battle.participants.filter((e) => e.alive);
        if (survivors.length <= 1) {
          battle.over = true; battle.winnerId = survivors.length ? survivors[0].id : null;
          battle.result = survivors.length ? 'brawl' : 'draw';
          battle.endReason = survivors.length ? 'last-standing' : 'double-ko';
        }
        return;
      }
      const aAlive = battle.A.filter((e) => e.alive && !e.isDecoy).length;
      const bAlive = battle.B.filter((e) => e.alive && !e.isDecoy).length;
      if (aAlive === 0 && bAlive === 0) { battle.over = true; battle.result = 'draw'; battle.endReason = 'double-ko'; return; }
      if (aAlive === 0) { battle.over = true; battle.result = 'B'; battle.endReason = 'wipe'; return; }
      if (bAlive === 0) { battle.over = true; battle.result = 'A'; battle.endReason = 'wipe'; return; }
      // 无时间上限：只以一方全灭结束（决胜期伤害递增保证必然收敛）
    }

    battle.step = function () {
      if (battle.over) return;
      battle.events.length = 0;
      const dt = TICK;
      battle.tick++;
      battle.time = U.round2(battle.tick * TICK);
      const list = all();
      const positions = new Map(list.map((e) => [e.id, [e.x, e.z]]));
      for (const e of list) updateEntity(e, dt);
      // 单位互斥：不让两个单位叠在一起（简单的两两分离松弛）
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (!b.alive) continue;
          // 车辆通过路径碰撞结算伤害；普通单位互斥会抵消车速并将驾驶者堵在边界。
          if (a.su7 || b.su7) continue;
          const dx = b.x - a.x, dz = b.z - a.z;
          const d = Math.hypot(dx, dz);
          const minD = (a.unit.radius + b.unit.radius) * 0.95;
          if (d >= minD) continue;
          if (d < 0.0001) {
            // 完全重合：按 id 给个确定性的错开方向
            const ang = (a.id * 2.399963) % (Math.PI * 2);
            a.x -= Math.cos(ang) * minD * 0.5;
            a.z -= Math.sin(ang) * minD * 0.5;
            b.x += Math.cos(ang) * minD * 0.5;
            b.z += Math.sin(ang) * minD * 0.5;
            continue;
          }
          const push = (minD - d) * 0.5;
          const ux = dx / d, uz = dz / d;
          a.x -= ux * push; a.z -= uz * push;
          b.x += ux * push; b.z += uz * push;
        }
      }
      for (const e of list) {
        if (!e.alive) continue;
        const marginX = e.su7 ? Math.max(80, e.su7.radius) : 50;
        const marginZ = e.su7 ? Math.max(90, e.su7.radius) : 60;
        e.x = U.clamp(e.x, marginX, W - marginX);
        e.z = U.clamp(e.z, marginZ, D - marginZ);
        const previous = positions.get(e.id);
        const limit = e.unit.stats.spd * 1.5;
        e.moveVX = (e.moveVX || 0) * 0.65 + U.clamp((e.x - previous[0]) / dt, -limit, limit) * 0.35;
        e.moveVZ = (e.moveVZ || 0) * 0.65 + U.clamp((e.z - previous[1]) / dt, -limit, limit) * 0.35;
      }
      updateProjectiles(dt);
      updateZones(dt);
      updateRains(dt);
      updatePickups(dt);
      updateTracks(dt);
      updateBubbleTraps(dt);
      // 尸体淡出后移出战场（之前尸体会永远留在场上）
      for (const side of ['A', 'B']) {
        for (let i = battle[side].length - 1; i >= 0; i--) {
          const e = battle[side][i];
          if (!e.alive) {
            e.deadT = (e.deadT || 0) + dt;
            if (e.deadT > (e.isMinion ? 0.25 : CORPSE_FADE)) battle[side].splice(i, 1);
          }
        }
      }
      checkEnd();
      if (battle.over) {
        for (const e of all()) if (e.su7) finishSu7(e, 'no-target');
        battle.stats.duration = battle.time;
      }
    };

    battle.hash = function () {
      const parts = [battle.mode, battle.winnerId || 0, battle.tick, battle.time, battle.over ? battle.result || '-' : '-', battle.rng.snapshot()];
      for (const e of all()) {
        parts.push(e.id, Math.round(e.x * 50), Math.round(e.z * 50), Math.round(e.h * 50),
          e.alive ? Math.round(e.hp) : -1, Math.round(e.energy), e.state,
          Math.round(e.cds.s1 * 50), Math.round(e.cds.s2 * 50), e.buffs.length);
        if (e.unit.s3) parts.push('s3', Math.round(e.cds.s3 * 50));
        if (e.isDecoy) parts.push('decoy', e.ownerId, Math.round(e.life * 60));
        parts.push('motion', Math.round((e.moveVX || 0) * 50), Math.round((e.moveVZ || 0) * 50));
        if (e.run) parts.push('run', Math.round(e.run.t * 60), Math.round(e.run.distance), e.run.pace,
          Math.round(e.run.cx), Math.round(e.run.cz), e.run.direction);
        if (e.su7) parts.push('su7', Math.round(e.su7.t * 60), Math.round(e.su7.dx * 10000),
          Math.round(e.su7.dz * 10000), e.su7.targetId, Math.round(e.su7.retargetT * 60),
          Object.keys(e.su7.lastHit).sort((a, b) => a - b).map((id) => id + ':' + e.su7.lastHit[id]).join(','));
        if (e.unitId === 'zhangxuefeng') parts.push(e.stacks.pace || 0, e.stacks.paceBoost || 0);
      }
      parts.push(battle.projectiles.length, battle.zones.length, battle.tracks.length, battle.bubbleTraps.length);
      for (const p of battle.projectiles) {
        if (p.phone || p.sonic) parts.push('leijunProj', p.id, p.targetId, Math.round(p.x * 50),
          Math.round(p.z * 50), Math.round(p.life * 60), p.bounces, (p.hitIds || []).join(','));
      }
      return U.hex8(U.hashParts(parts));
    };

    battle.aliveCount = (side) => battle[side].filter((e) => e.alive && !e.isDecoy).length;
    battle.entities = all;

    // 契约要求的 state 视图（getter 零拷贝，渲染层按 st.A / st.B / st.time 读取）
    battle.state = {
      get mode() { return battle.mode; },
      get time() { return battle.time; },
      get tick() { return battle.tick; },
      get over() { return battle.over; },
      get result() { return battle.result; },
      get endReason() { return battle.endReason; },
      get ramp() { return battle.ramp; },
      get A() { return battle.A; },
      get B() { return battle.B; },
      get projectiles() { return battle.projectiles; },
      get zones() { return battle.zones; },
      get rains() { return battle.rains; },
      get tracks() { return battle.tracks; },
      get bubbleTraps() { return battle.bubbleTraps; },
      get pickups() { return battle.pickups; },
      get minions() { return battle.minions; },
      get stats() { return battle.stats; },
    };
    return battle;
  }

  CC.engine = { createBattle, TICK, SAFETY_TIME, W, D };
})();
