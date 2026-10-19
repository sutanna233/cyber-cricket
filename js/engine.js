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
  const CHARGE = { s1: 0.5, s2: 0.8, ult: 1.4 };
  const INTERRUPT_CD = 0.4;         // 被打断后进入的短冷却比例
  const INTERRUPT_MIN_RATIO = 0.015; // 只有"有效伤害"（≥1.5% 最大生命）才能打断，避免被蹭一下就断
  const SUSTAIN_SCALE = 0.72;        // 全局续航系数（回血/护盾/吸血统一压一档，防止打不死的僵局）
  const PICKUP_TTL = 90;            // 地上物件存活时间
  const PICKUP_RESPAWN = 1.6;       // 物件补充间隔
  const PICKUP_MAX = 10;            // 场上同时存在的物件上限
  const W = 1200, D = 700;          // 擂台平面尺寸
  const DODGE_CD = 0.9;

  const NEGATIVE = { stun: 1, blind: 1, poison: 1, speedDown: 1, atkDown: 1, seal: 1 };

  function buffMag(e, kind) {
    let m = 0;
    for (let i = 0; i < e.buffs.length; i++) if (e.buffs[i].kind === kind) m += e.buffs[i].mag;
    return m;
  }
  function hasBuff(e, kind) {
    for (let i = 0; i < e.buffs.length; i++) if (e.buffs[i].kind === kind && e.buffs[i].t < e.buffs[i].dur) return true;
    return false;
  }
  function addBuff(e, kind, dur, mag) {
    if (!kind) return;
    if (kind === 'cleanse') {
      e.buffs = e.buffs.filter((b) => !NEGATIVE[b.kind]);
      return;
    }
    if (kind === 'regen' || kind === 'shield' || kind === 'lifesteal') mag *= SUSTAIN_SCALE;
    // 同类叠加取更强的一条，避免无限堆叠
    for (let i = 0; i < e.buffs.length; i++) {
      const b = e.buffs[i];
      if (b.kind === kind && b.t < b.dur) {
        if (mag >= b.mag) { b.mag = mag; b.dur = Math.max(b.dur, dur); b.t = 0; }
        else b.dur = Math.max(b.dur, dur);
        return;
      }
    }
    e.buffs.push({ kind, dur, mag, t: 0 });
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
    const hpScale = mode === 'team' ? CC.fighters.consts.TEAM_HP_SCALE : 1;

    const battle = {
      mode, seed: opts.seed == null ? 1 : opts.seed,
      rng: U.RNG(opts.seed == null ? 1 : opts.seed),
      time: 0, tick: 0, over: false, result: null, endReason: null,
      A: [], B: [], projectiles: [], zones: [], pickups: [], rains: [],
      events: [], fxSeq: 0,
      stats: { dmgByUnit: {}, dmgBySideUnit: {}, killsByUnit: {}, killsBySideUnit: {}, maxCombo: 0, casts: [], duration: 0, picked: {} },
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
      const hp = Math.max(1, Math.round(unit.stats.hp * hpScale * (spec.hpMul || 1)));
      const e = {
        id: battle._eid++, side, unitId: unit.id, unit, slot: spec.slot == null ? idx : spec.slot, lane,
        x: pos[0], z: pos[1], h: 0, vx: 0, vz: 0, vh: 0,
        facing: side === 'A' ? 1 : -1, alive: true,
        hp, maxHp: hp, shield: 0, energy: spec.energy || 0,
        state: 'idle', stateT: 0, atkCd: 0, cds: { s1: 0, s2: 0, ult: 0 },
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
    battle.ramp = 1;
    battle.dbg = { kite: 0, retreat: 0, approach: 0, attack: 0, idle: 0, early: {} };
    function dbg(k) { battle.dbg.early[k] = (battle.dbg.early[k] || 0) + 1; }
    // 开局在场上撒一批可拾取物（凑企鹅这类"收集型"单位的资源）
    spawnPickup('stone', 8);

    const all = () => battle.A.concat(battle.B);
    const foes = (e) => (e.side === 'A' ? battle.B : battle.A).filter((o) => o.alive);
    const allies = (e) => (e.side === 'A' ? battle.A : battle.B).filter((o) => o.alive);

    function push(ev) {
      ev.seq = ++battle.fxSeq;
      ev.t = U.round2(battle.time);
      battle.events.push(ev);
      return ev;
    }

    // ---------- 伤害 ----------
    function applyDamage(src, dst, coef, opt) {
      opt = opt || {};
      if (!dst || !dst.alive || !src) return 0;
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

      // 护盾先吃
      if (dst.shield > 0) {
        const use = Math.min(dst.shield, dmg);
        dst.shield = U.round2(dst.shield - use);
        dmg -= use;
      }
      if (dmg > 0) dst.hp = U.clamp(dst.hp - dmg, 0, dst.maxHp);

      // 反伤
      const refl = buffMag(dst, 'reflect');
      if (refl > 0) {
        const back = Math.max(1, Math.round((dmg + (opt.rawDmg || 0)) * refl * 0.5));
        src.hp = U.clamp(src.hp - back, 0, src.maxHp);
        push({ type: 'reflect', unitId: dst.id, targetId: src.id, dmg: back, x: src.x, z: src.z, h: src.h });
        if (src.hp <= 0) kill(src, dst);
      }
      // 吸血
      const ls = buffMag(src, 'lifesteal');
      if (ls > 0 && dmg > 0) {
        const healV = Math.round(dmg * ls);
        src.hp = U.clamp(src.hp + healV, 0, src.maxHp);
        push({ type: 'heal', unitId: src.id, amount: healV, x: src.x, z: src.z, h: src.h });
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
          && dmg >= Math.max(1, dst.maxHp * INTERRUPT_MIN_RATIO)) {
        const key = dst.cast.key;
        const sk = dst.cast.skill || {};
        dst.cast = null;
        dst.state = 'hurt';
        dst.stateT = 0;
        dst.hitstun = Math.max(dst.hitstun, 0.35);
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
      e.state = 'ko';
      e.stateT = 0;
      e.cast = null;
      e.buffs = [];
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
        addBuff(self, ef.kind, ef.dur == null ? 1 : ef.dur, ef.mag == null ? 1 : ef.mag);
        if (ef.kind === 'stun') { self.hitstun = Math.max(self.hitstun, ef.dur || 1); self.state = 'stun'; self.stateT = 0; }
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
            dmg: step.dmg, life: step.life || 2, radius: step.radius || 24,
            sprite: step.sprite || 'spark', scale: step.scale || 0.9,
            pierce: !!step.pierce, bounces: step.bounces || 0, effects: step.effects || [], hits: 0, arcH: step.arcH || 60,
          });
          push({ type: 'cast_fx', unitId: src.id, at: 'proj', x: src.x, z: src.z, h: src.h + 34 });
          break;
        }
        case 'dash': {
          const target = castTarget(src, step.preferBack);
          const dx = target ? target.x - src.x : src.facing;
          const dz = target ? target.z - src.z : 0;
          const len = Math.hypot(dx, dz) || 1;
          src.state = 'dash';
          src.stateT = 0;
          src.dash = { dir: dx / len, dirZ: dz / len, dur: step.dur || 0.3, t: 0, step };
          push({ type: 'dash', unitId: src.id, x: src.x, z: src.z, h: src.h });
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
              addBuff(tgt, ef.kind, ef.dur == null ? 3 : ef.dur, ef.mag == null ? 1 : ef.mag);
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
            tgt.hp = U.clamp(tgt.hp + v, 0, tgt.maxHp);
            push({ type: 'heal', unitId: tgt.id, amount: v, x: tgt.x, z: tgt.z, h: tgt.h + 40 });
          }
          break;
        }
        case 'summon': {
          const count = step.count || 1;
          for (let i = 0; i < count; i++) {
            const m = {
              id: battle._eid++, side: src.side, unitId: 'minion_' + src.unitId, unit: minionUnit(src, step),
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
            if (!hasBuff(o, 'superArmor')) { o.hitstun = Math.max(o.hitstun, 0.25); o.state = 'hurt'; }
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
            addBuff(o, 'atkDown', step.debuffDur || 3, step.debuffMag || 0.15);
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
          if (zone.side === e.side || zone.done) continue;
          const margin = U.dist(x, z, zone.x, zone.z) - zone.radius - e.unit.radius * 0.5;
          score += Math.min(0, margin) * 5;
        }
        // 同时比较两侧，别从一个弹道闪进另一个弹道。
        for (const p of battle.projectiles) {
          if (p.side === e.side || p.lob) continue;
          const gap = U.dist(x, z, p.x + p.vx * duration, p.z + p.vz * duration);
          score -= Math.max(0, (p.radius || 24) + e.unit.radius - gap) * 3;
        }
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
      const dx = dst.x - src.x, dz = dst.z - src.z;
      const len = Math.hypot(dx, dz) || 1;
      const k = 1 / Math.max(0.3, dst.unit.stats.weight);
      dst.vx += (dx / len) * mag * k;
      dst.vz += (dz / len) * mag * k;
      if (up) dst.vh += up * k;
    }

    // ---------- 施法 ----------
    function canCast(e, key) {
      if (!e.unit[key] || hasBuff(e, 'seal')) return false;
      const sk = e.unit[key];
      if (key === 'ult') return e.energy >= (sk.cost || 100);
      if (key === 's2') return e.cds.s2 <= 0 && e.energy >= (sk.cost || 0);
      return e.cds.s1 <= 0;
    }

    function startCast(e, key) {
      const sk = e.unit[key];
      if (!sk) return false;
      if (!canCast(e, key)) return false;
      if (key === 'ult') e.energy = U.clamp(e.energy - (sk.cost || 100), 0, 100);
      else if (key === 's2') { e.energy = U.clamp(e.energy - (sk.cost || 0), 0, 100); e.cds.s2 = (sk.cd || 8) * CD_SCALE; }
      else e.cds.s1 = (sk.cd || 6) * CD_SCALE;
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

    // ---------- 实体更新 ----------
    function updateEntity(e, dt) {
      if (!e.alive) return;

      // 计时器
      e.stateT += dt;
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
          e.hp = U.clamp(e.hp - e.maxHp * b.mag * dt, 0, e.maxHp);
          if (e.hp <= 0) { kill(e, null); return; }
        } else if (b.kind === 'regen') {
          e.hp = U.clamp(e.hp + e.maxHp * b.mag * dt, 0, e.maxHp);
        }
        if (b.t >= b.dur) e.buffs.splice(i, 1);
      }

      // 召唤物寿命
      if (e.isMinion) {
        e.life -= dt;
        if (e.life <= 0) { kill(e, null); return; }
      }

      // 冲刺
      if (e.state === 'dash' && e.dash) {
        dbg('dash');
        const d = e.dash;
        d.t += dt;
        const sp = (d.step.dist / Math.max(0.05, d.dur));
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
              applyDamage(e, o, d.step.dmg, { skill: e.cast ? e.cast.key : 's1', melee: true,
                armorPierce: d.step.pierceArmor ? 0.4 : (d.step.armorPierce || 0),
                lowHpBonus: d.step.lowHpBonus });
              if (d.step.knock && o.alive) knockback(e, o, d.step.knock, d.step.up);
              if (d.step.hitstun && o.alive && !hasBuff(o, 'superArmor')) { o.hitstun = d.step.hitstun; o.state = 'hurt'; }
              if (d.step.grab && o.alive) { o.x = e.x + e.facing * 30; o.h = 16; }
            }
          }
        }
        if (d.t >= d.dur) { e.dash = null; e.state = 'idle'; }
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
          if (c.t >= dur) { e.cast = null; e.state = 'idle'; }
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
          if (z.side === e.side || z.done) continue;
          if (U.dist(e.x, e.z, z.x, z.z) < z.radius + e.unit.radius * 0.5) {
            dbg('dodge');
            const dx = e.x - z.x, dz = e.z - z.z;
            if (startDodge(e, dx || (dz ? 0 : e.facing), dz, 190, 0.22, 'zone')) return;
          }
        }
        for (const p of battle.projectiles) {
          if (p.side === e.side || p.lob) continue;
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
            e.x += (dx / l) * speedOf(e) * dt;
            e.z += (dz / l) * speedOf(e) * dt;
            e.state = 'walk';
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

      // 反僵死：远程适度缩短距离寻找命中机会，不能退化为按旧普攻范围贴脸。
      if ((e.stuck > 2.5 && e.plan.mode !== 'approach') || e.noDmgT > 5) {
        const ranged = !!e.plan.ranged;
        const reach = e.plan.attackRange || rangeOf(e);
        e.plan = { mode: 'approach', targetId: tgt.id, ranged, attackRange: reach,
          wantRange: ranged ? Math.max(140, reach * 0.65) : rangeOf(e) };
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
        e.x += fleeX * sp * dt;                    // 远离最近的威胁，不是背对锁定目标乱退
        e.z += fleeZ * sp * dt;
        e.state = 'walk';
        battle.dbg.kite++;
      } else if (e._fleeing && hasSpace) {
        e.x += fleeX * sp * dt;
        e.z += fleeZ * sp * dt;
        e.state = 'walk';
        battle.dbg.retreat++;
      } else if (d > atkRange) {
        e.x += mx * sp * dt;                       // 够不着就贴上去
        e.z += mz * sp * dt;
        e.state = 'walk';
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
        e.x += px * e._orbitDir * drift * dt;
        e.z += pz * e._orbitDir * drift * dt;
        // 贴太近再慢慢拉开（阈值远低于接近阈值，不会来回抖）
        if (d < atkRange * 0.6) {
          e.x -= mx * drift * dt;
          e.z -= mz * drift * dt;
        }
        e.state = 'walk';
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
      for (let i = 0; i < (count || 1); i++) {
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
      // 场上保持一定数量，捡完会补
      battle._pickupT += dt;
      if (battle._pickupT >= PICKUP_RESPAWN) {
        battle._pickupT = 0;
        // 地面持续刷新石头：不够时一次补 2 个，保证"捡石头"的玩法一直有货
        const need = PICKUP_MAX - battle.pickups.length;
        if (need > 0) spawnPickup('stone', need >= 4 ? 2 : 1);
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
        const enemySide = p.side === 'A' ? battle.B : battle.A;
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
          let near = enemySide.find((o) => o.alive && o.id === p.targetId && o._projIgnore !== p.id);
          let bd = Infinity;
          for (const o of near ? [] : enemySide) {
            if (!o.alive) continue;
            if (o._projIgnore === p.id) continue;
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
          if (o._projIgnore === p.id) continue;
          if (U.dist(p.x, p.z, o.x, o.z) < p.radius + o.unit.radius * 0.6) {
            applyDamage(owner, o, p.dmg, { skill: p.skill, knock: 40 });
            applyEffects(owner, o, p.effects, p);
            p.hits++;
            let consumed = !p.pierce;
            // 弹跳：命中后找一个新目标继续飞（孙笑川的「表情包连弹」）
            if (p.bounces > 0) {
              p.bounces--;
              const next = enemySide.find((x) => x.alive && x !== o && x._projIgnore !== p.id);
              if (next) {
                p.targetId = next.id;
                const dx = next.x - p.x, dz = next.z - p.z;
                const l = Math.hypot(dx, dz) || 1;
                p.vx = (dx / l) * p.speed;
                p.vz = (dz / l) * p.speed;
                p.homing = true;
                p.life = Math.max(p.life, 1.2);
                o._projIgnore = p.id;
                consumed = false;
                push({ type: 'bounce', unitId: p.ownerId, x: p.x, z: p.z, to: next.id, left: p.bounces });
              }
            }
            if (consumed) hit = true;
            if (hit) break;
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
      const side = p.side;
      const enemySide = side === 'A' ? battle.B : battle.A;
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
              for (const o of (z.side === 'A' ? battle.B : battle.A)) {
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
      const aAlive = battle.A.filter((e) => e.alive).length;
      const bAlive = battle.B.filter((e) => e.alive).length;
      if (aAlive === 0 && bAlive === 0) { battle.over = true; battle.result = 'draw'; battle.endReason = 'double-ko'; return; }
      if (aAlive === 0) { battle.over = true; battle.result = 'B'; battle.endReason = 'wipe'; return; }
      if (bAlive === 0) { battle.over = true; battle.result = 'A'; battle.endReason = 'wipe'; return; }
      // 无时间上限：只以一方全灭结束（决胜期伤害递增保证必然收敛）
    }

    battle.step = function () {
      if (battle.over) return;
      battle.events.length = 0;
      const dt = TICK;
      battle.time = U.round2(battle.time + dt);
      battle.tick++;
      const list = all();
      for (const e of list) updateEntity(e, dt);
      // 单位互斥：不让两个单位叠在一起（简单的两两分离松弛）
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          if (!b.alive) continue;
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
        e.x = U.clamp(e.x, 50, W - 50);
        e.z = U.clamp(e.z, 60, D - 60);
      }
      updateProjectiles(dt);
      updateZones(dt);
      updateRains(dt);
      updatePickups(dt);
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
      if (battle.over) battle.stats.duration = battle.time;
    };

    battle.hash = function () {
      const parts = [battle.tick, battle.time, battle.over ? battle.result || '-' : '-', battle.rng.snapshot()];
      for (const e of all()) {
        parts.push(e.id, Math.round(e.x * 50), Math.round(e.z * 50), Math.round(e.h * 50),
          e.alive ? Math.round(e.hp) : -1, Math.round(e.energy), e.state,
          Math.round(e.cds.s1 * 50), Math.round(e.cds.s2 * 50), e.buffs.length);
      }
      parts.push(battle.projectiles.length, battle.zones.length);
      return U.hex8(U.hashParts(parts));
    };

    battle.aliveCount = (side) => battle[side].filter((e) => e.alive).length;
    battle.entities = all;

    // 契约要求的 state 视图（getter 零拷贝，渲染层按 st.A / st.B / st.time 读取）
    battle.state = {
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
      get pickups() { return battle.pickups; },
      get minions() { return battle.minions; },
      get stats() { return battle.stats; },
    };
    return battle;
  }

  CC.engine = { createBattle, TICK, SAFETY_TIME, W, D };
})();
