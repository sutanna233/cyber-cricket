'use strict';

// Re-simulate validated replay configuration and expose facts for a language model.
// This observer never reads a clock, consumes RNG, alters battle state, or writes files.
const host = require('./simhost');
const TICK_RATE = 60;
const MAX_TICKS = 600 * TICK_RATE;
const round = (value) => Math.round(value * 100) / 100;

function boundedInt(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function buildFacts(config, options) {
  const opts = options || {};
  const cap = boundedInt(opts.maxTicks, MAX_TICKS, 1, MAX_TICKS);
  const maxFacts = boundedInt(opts.maxFacts, 120, 16, 120);
  const match = host.CC.battle.createMatch(config);
  const battle = match.battle;
  const originals = Array.from(battle.participants).filter((e) => !e.isMinion && !e.isDecoy);
  const originalIds = new Set(originals.map((e) => e.id));
  const byId = new Map(originals.map((e) => [e.id, e]));
  const damage = new Map(originals.map((e) => [e.id, { hit: 0, reflect: 0, kills: 0 }]));
  const raw = [];
  const lowHpSeen = new Set();
  const ultAt = new Map();
  const interruptAt = new Map();
  const removed = new Set();
  let firstBlood = false;
  let lastTwo = false;
  let nextSnapshot = 8 * TICK_RATE;

  function rememberEntities() {
    for (const e of battle.entities()) byId.set(e.id, e);
  }

  function ownerId(entityId) {
    let e = byId.get(entityId);
    const visited = new Set();
    while (e && !visited.has(e.id)) {
      if (originalIds.has(e.id)) return e.id;
      visited.add(e.id);
      e = e.ownerId ? byId.get(e.ownerId) : null;
    }
    return null;
  }

  function situation() {
    const alive = { A: 0, B: 0, total: 0 };
    const hp = { A: 0, B: 0 };
    const maxHp = { A: 0, B: 0 };
    for (const e of originals) {
      if (e.alive) { alive[e.side]++; alive.total++; }
      hp[e.side] += Math.max(0, e.hp);
      maxHp[e.side] += e.maxHp;
    }
    return { alive, hp: { A: round(hp.A), B: round(hp.B) }, maxHp };
  }

  function fact(type, fields, priority, mandatory) {
    raw.push(Object.assign({ tick: battle.tick, time: Math.round(battle.tick / TICK_RATE * 1000) / 1000,
      type, priority: priority || 50, _mandatory: !!mandatory, _order: raw.length }, fields));
  }

  function executedUlt(event, actor) {
    if (actor.unitId === 'tomori' && event.type === 'stone_rain') {
      const step = actor.unit.ult.steps.find((s) => s.kind === 'stone_rain');
      return step && event.radius === step.spread;
    }
    if (actor.unitId === 'xujiayin') return event.type === 'pull';
    if (actor.unitId === 'zhangxuefeng') return event.type === 'run_start' && event.ult === true;
    if (actor.unitId === 'tiansuluo') return event.type === 'bubble_burst';
    if (actor.unitId === 'leijun') return event.type === 'su7Start';
    return false;
  }

  const roster = originals.map((e) => ({
    id: e.id, unitId: e.unitId, name: e.unit.name, side: e.side, team: e.team, slot: e.slot,
    label: (battle.mode === 'brawl' ? '' : e.side + '队·') + e.unit.name + '#' + e.id,
    maxHp: e.maxHp,
  }));
  fact('opening', { mode: battle.mode, ...situation() }, 100, true);

  while (!battle.over && battle.tick < cap) {
    battle.step();
    rememberEntities();
    // Damage events precede their KO event in the engine, including reflection.
    const lastDamage = new Map();
    const tickUlts = new Map();
    for (const event of battle.events) {
      if (event.type === 'hit' || event.type === 'reflect') {
        const owner = ownerId(event.unitId);
        if (owner != null && Number.isFinite(event.dmg) && event.dmg > 0) {
          const total = damage.get(owner);
          total[event.type === 'reflect' ? 'reflect' : 'hit'] += event.dmg;
        }
        lastDamage.set(event.targetId, event);
      }
      const actor = byId.get(event.unitId);
      if (!actor || !originalIds.has(actor.id) || actor.isMinion || actor.isDecoy) continue;
      if (event.type === 'ko' && !removed.has(actor.id)) {
        removed.add(actor.id);
        const latest = lastDamage.get(actor.id);
        // Poison/expiry KOs have no killer; a preceding unrelated hit must not get credit.
        const hit = latest && event.by && byId.get(latest.unitId)
          && byId.get(latest.unitId).unitId === event.by ? latest : null;
        const killerId = hit ? ownerId(hit.unitId) : null;
        if (killerId != null && killerId !== actor.id) damage.get(killerId).kills++;
        fact('ko', { targetId: actor.id, actorId: killerId,
          killerEntityId: hit ? hit.unitId : null, skill: hit ? hit.skill || null : null,
          firstBlood: !firstBlood, ...situation() }, 100, true);
        firstBlood = true;
      }
      if (event.type === 'interrupt') {
        const key = event.by + ':' + actor.id + ':' + event.key;
        const important = event.key === 'ult' || event.ult === true;
        if (important || battle.tick - (interruptAt.get(key) == null ? -Infinity : interruptAt.get(key)) >= 180) {
          interruptAt.set(key, battle.tick);
          fact('interrupt', { actorId: ownerId(event.by), targetId: actor.id,
            skill: event.key, skillName: event.name || '', ultimate: important }, important ? 85 : 55);
        }
      }
      if (executedUlt(event, actor)) {
        // One bubble chain can have several explosion events in the same simulation tick.
        const existing = tickUlts.get(actor.id);
        if (existing) {
          if (event.type === 'bubble_burst') {
            existing.bubbleTargets++;
            existing.bubbleStacks += event.stacks || 0;
          }
        } else tickUlts.set(actor.id, {
          actorId: actor.id, skill: 'ult', skillName: actor.unit.ult.name,
          effect: event.type,
          ...(event.type === 'stone_rain' ? { stoneCount: event.count } : {}),
          ...(event.type === 'pull' ? { pulledCount: event.count } : {}),
          ...(event.type === 'bubble_burst' ? { bubbleTargets: 1, bubbleStacks: event.stacks || 0 } : {}),
          ...(event.type === 'su7Start' ? { duration: event.dur } : {}),
        });
      }
    }
    for (const [actorId, fields] of tickUlts) {
      if (battle.tick - (ultAt.get(actorId) == null ? -Infinity : ultAt.get(actorId)) >= 30) {
        ultAt.set(actorId, battle.tick);
        fact('ult', fields, 75);
      }
    }
    const alive = originals.filter((e) => e.alive);
    if (battle.mode === 'brawl' && originals.length > 2 && !lastTwo && alive.length === 2) {
      lastTwo = true;
      fact('last_two', { actorIds: alive.map((e) => e.id) }, 95, true);
    }
    for (const e of alive) {
      const ratio = e.hp / e.maxHp;
      if (ratio > 0.4) lowHpSeen.delete(e.id);
      if (ratio <= 0.25 && !lowHpSeen.has(e.id)) {
        lowHpSeen.add(e.id);
        fact('low_hp', { actorId: e.id, hp: round(e.hp), maxHp: e.maxHp,
          hpRatio: Math.round(ratio * 1000) / 1000 }, 40);
      }
    }
    if (!battle.over && battle.tick >= nextSnapshot) {
      fact('state', situation(), 20);
      nextSnapshot += 8 * TICK_RATE;
    }
  }
  if (!battle.over) throw new Error('对局未在 ' + Math.floor(cap / TICK_RATE) + ' 秒保护时限内结束，无法生成完整解说');

  const survivors = originals.filter((e) => e.alive);
  fact('result', { result: battle.result, winnerId: battle.winnerId || null,
    survivorIds: survivors.map((e) => e.id), reason: battle.endReason, ...situation() }, 100, true);

  // Keep every elimination and the result, then spread optional facts across the match.
  const mandatory = raw.filter((e) => e._mandatory);
  const selected = new Set(mandatory);
  if (mandatory.length > maxFacts) throw new Error('关键战况超过解说事实容量');
  const optional = raw.filter((e) => !e._mandatory);
  const buckets = new Map();
  for (const row of optional) {
    const key = Math.floor(row.tick / (4 * TICK_RATE));
    const list = buckets.get(key) || [];
    list.push(row); buckets.set(key, list);
  }
  for (const list of buckets.values()) list.sort((a, b) => b.priority - a.priority || a._order - b._order);
  // Spread each round over the full duration, including the ending when capacity is tight.
  const bucketLists = Array.from(buckets.values());
  let depth = 0;
  while (selected.size < maxFacts) {
    const available = bucketLists.map((list) => list[depth]).filter(Boolean);
    if (!available.length) break;
    const count = Math.min(maxFacts - selected.size, available.length);
    for (let i = 0; i < count; i++) {
      const index = count === 1 ? Math.floor((available.length - 1) / 2)
        : Math.round(i * (available.length - 1) / (count - 1));
      selected.add(available[index]);
    }
    depth++;
  }
  const facts = Array.from(selected).sort((a, b) => a.tick - b.tick || a._order - b._order)
    .map((e, i) => {
      const { _mandatory, _order, ...publicFact } = e;
      return { id: 'f' + i, ...publicFact };
    });
  const players = originals.map((e) => ({ id: e.id, alive: e.alive, hp: round(e.hp), maxHp: e.maxHp,
    damage: damage.get(e.id).hit + damage.get(e.id).reflect,
    hitDamage: damage.get(e.id).hit, reflectionDamage: damage.get(e.id).reflect, kills: damage.get(e.id).kills }));

  return {
    version: 1, seed: battle.seed, mode: battle.mode, tickRate: TICK_RATE, roster,
    durationTicks: battle.tick, durationSeconds: Math.round(battle.tick / TICK_RATE * 1000) / 1000,
    finalHash: battle.hash(), result: battle.result, winnerId: battle.winnerId || null,
    facts, summary: { players, survivorIds: survivors.map((e) => e.id),
      reason: battle.endReason, rawFactCount: raw.length, keptFactCount: facts.length,
      damageMetric: 'hit and reflection event amounts, includes owned summons and overkill' },
  };
}

module.exports = { buildFacts };
