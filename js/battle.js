/* ===========================================================
   赛博斗蛐蛐 · 对局运行器
   —— 固定步长累加器 + 真正的暂停（dt 不累积、不做补偿）
   —— 支持整场快进、战报统计、换种子重开
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util;

  const STEP = CC.engine ? CC.engine.TICK : 1 / 60;
  const MAX_CATCHUP = 5;          // 单帧最多补 5 步，防 spiral of death

  function normalizedLineup(lineup) {
    const out = { A: [], B: [] };
    for (const side of ['A', 'B']) {
      const arr = (lineup && lineup[side]) || [];
      arr.forEach((it, i) => {
        if (typeof it === 'string') out[side].push({ id: it, slot: i });
        else if (it && it.id) out[side].push({
          id: it.id, slot: it.slot == null ? i : it.slot, lane: it.lane, pos: it.pos,
          // 透传可选的开局参数（测试/特殊模式会用到）
          energy: it.energy, hpMul: it.hpMul, atkMul: it.atkMul,
        });
      });
    }
    return out;
  }

  function createMatch(opts) {
    opts = opts || {};
    const lu = normalizedLineup(opts.lineup);
    const match = {
      mode: opts.mode || ((lu.A.length > 1 || lu.B.length > 1) ? 'team' : 'solo'),
      seed: opts.seed == null ? 1 : opts.seed,
      lineup: lu,
      paused: false,
      speed: opts.speed || 1,
      acc: 0,
      frames: 0,
      state: 'fighting',
      reportVisible: false,
      reportT: 0,
      battle: null,
      startedAtFrame: 0,
      _steps: 0,
    };

    function build(seed) {
      match.battle = CC.engine.createBattle({
        seed, teamA: lu.A, teamB: lu.B,
        mode: match.mode,
      });
      match.state = 'fighting';
      match.reportVisible = false;
      match.reportT = 0;
      match.acc = 0;
      match._steps = 0;
      return match.battle;
    }
    build(match.seed);

    /** 外部每帧调用；返回本帧消费的模拟步数 */
    match.tick = function (dt) {
      if (match.paused) return 0;              // 暂停：不做任何累积
      if (match.state === 'report') { match.reportT += dt; return 0; }
      if (dt == null || !(dt > 0)) dt = STEP;
      if (dt > 0.25) dt = 0.25;
      match.acc += dt * match.speed;
      let steps = 0;
      while (match.acc >= STEP && steps < MAX_CATCHUP) {
        if (match.battle.over) break;
        match.battle.step();
        match.acc -= STEP;
        steps++;
        match._steps++;
      }
      if (match.battle.over) {
        match.state = 'report';
        match.reportVisible = true;
        match.reportT = 0;
      }
      match.frames++;
      return steps;
    };

    match.pause = function () { if (match.state === 'report') return false; match.paused = true; return true; };
    match.resume = function () { match.paused = false; return true; };
    match.togglePause = function () { match.paused = !match.paused; return match.paused; };

    /** 毫秒级跑完（跳过看结果 / 测试用）；无时间上限，安全阀只防死循环 */
    match.skipToEnd = function (maxTicks) {
      const limit = maxTicks || Math.round(60 * (CC.engine.SAFETY_TIME || 600));
      let n = 0;
      match.paused = false;
      while (!match.battle.over && n < limit) { match.battle.step(); n++; match._steps++; }
      if (match.battle.over) { match.state = 'report'; match.reportVisible = true; match.reportT = 0; }
      return { steps: n, hash: match.battle.hash(), over: match.battle.over, result: match.battle.result };
    };

    match.restart = function (seed) {
      match.seed = seed == null ? (match.seed + 1) : seed;
      match.paused = false;
      build(match.seed);
      return match.battle;
    };

    match.setLineup = function (lineup) {
      const n = normalizedLineup(lineup);
      lu.A = n.A; lu.B = n.B;
      match.lineup = lu;
      return match;
    };

    match.hash = function () { return match.battle.hash(); };
    match.time = function () { return match.battle.time; };
    match.over = function () { return match.battle.over; };

    match.report = function () {
      const b = match.battle;
      const dmg = Object.assign({}, b.stats.dmgByUnit);
      let mvp = null, best = -1;
      for (const id in dmg) if (dmg[id] > best) { best = dmg[id]; mvp = id; }
      const duration = b.stats.duration || b.time;
      // 上帝视角：只有"哪一方赢了"，没有玩家的输赢
      const winner = b.result === 'A' || b.result === 'B' ? b.result : null;      // 'A' | 'B' | null
      // 战场数组会移除尸体；人数与评分始终依据原始参赛者，排除召唤物和诱饵。
      const participants = (b.participants || b.A.concat(b.B)).filter((e) => !e.isMinion && !e.isDecoy);
      const byEntity = {};
      const entities = participants.map((entity) => {
        const original = b.stats.byEntity && b.stats.byEntity[entity.id] || {};
        const name = entity.unit && entity.unit.name || entity.unitId;
        const finite = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
        const row = Object.assign({}, original, {
          id: entity.id, unitId: entity.unitId, side: entity.side, slot: entity.slot,
          name, label: (b.mode === 'brawl' ? '' : entity.side === 'A' ? '左·' : '右·') + name + ' ' + entity.id + '号',
          alive: !!entity.alive,
          skillDamage: Object.assign({}, original.skillDamage || {}),
        });
        ['damage', 'damageTaken', 'healing', 'shielding', 'controlSeconds', 'interrupts', 'kills', 'casts', 'hits', 'aliveSeconds']
          .forEach((key) => { row[key] = finite(original[key]); });
        byEntity[row.id] = row;
        return row;
      }).sort((a, z) => z.damage - a.damage || z.kills - a.kills || a.id - z.id);
      const hasEntityStats = !!b.stats.byEntity;
      const mvpEntity = hasEntityStats && entities.find((entity) => entity.damage > 0);
      const totalUnitsBySide = { A: participants.filter((e) => e.side === 'A').length,
        B: participants.filter((e) => e.side === 'B').length };
      const survivors = winner ? participants.filter((e) => e.side === winner && e.alive).length : 0;
      const loser = winner === 'A' ? 'B' : winner === 'B' ? 'A' : null;
      const loserTotal = loser ? totalUnitsBySide[loser] : 0;
      // 战况评分：赢得越干净越高
      let grade = 'C';
      if (winner) {
        const ratio = survivors / Math.max(1, survivors + loserTotal);
        const s = ratio * 2 + (duration < 30 ? 0.5 : 0) + (duration > 90 ? -0.3 : 0);
        grade = s > 1.4 ? 'S' : s > 0.95 ? 'A' : s > 0.55 ? 'B' : 'C';
      } else grade = 'B';
      const champion = b.mode === 'brawl' && participants.find((e) => e.id === b.winnerId);
      return {
        mode: b.mode, winnerId: b.winnerId || null,
        champion: champion ? champion.unit.name + ' #' + champion.id : null,
        winner,                       // 'A' | 'B' | null（中立）
        result: b.result, reason: b.endReason,
        winnerLabel: champion ? champion.unit.name + ' #' + champion.id : winner === 'A' ? '左方' : winner === 'B' ? '右方' : '双方同归于尽',
        duration: U.round2(duration), seconds: U.mmss(duration),
        dmgByUnit: dmg, killsByUnit: Object.assign({}, b.stats.killsByUnit),
        dmgBySideUnit: Object.assign({}, b.stats.dmgBySideUnit),
        killsBySideUnit: Object.assign({}, b.stats.killsBySideUnit),
        byEntity: hasEntityStats ? byEntity : {}, entities: hasEntityStats ? entities : [],
        mvpEntityId: mvpEntity ? mvpEntity.id : null,
        mvpEntityLabel: mvpEntity ? mvpEntity.label : null,
        maxCombo: b.stats.maxCombo, casts: b.stats.casts.slice(0, 40),
        picked: Object.assign({}, b.stats.picked),
        mvp, mvpDmg: best > 0 ? best : 0, grade,
        survivors: champion ? 1 : survivors, totalUnitsBySide,
        totalUnits: Math.max(totalUnitsBySide.A, totalUnitsBySide.B) || 1,
        hash: match.hash(),
      };
    };

    return match;
  }

  CC.battle = { createMatch, STEP, MAX_CATCHUP };
})();
