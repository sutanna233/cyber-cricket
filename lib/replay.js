'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function makeConfig(input, host) {
  const seed = input.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('种子必须为0～4294967295之间的整数');
  const fallback = host.makeLineup(seed, input.size && input.size.A, input.size && input.size.B);
  const lineup = { A: [], B: [] };
  for (const side of ['A', 'B']) {
    const entries = input.lineup && input.lineup[side];
    if (entries !== undefined && !Array.isArray(entries)) throw new Error('阵容格式错误');
    if (entries && entries.length > 6) throw new Error('每侧最多6个角色');
    const list = entries && entries.length ? entries : fallback[side];
    lineup[side] = list.map((entry, i) => {
      const unit = host.CC.fighters.get(entry.id);
      if (!unit) throw new Error('未知角色');
      const spec = { id: unit.id, slot: Number.isInteger(entry.slot) && entry.slot >= 0 && entry.slot < 12 ? entry.slot : i, lane: entry.lane === 1 ? 1 : 0 };
      if (entry.pos !== undefined) {
        if (!Array.isArray(entry.pos) || entry.pos.length !== 2 || !entry.pos.every(Number.isFinite)) throw new Error('站位格式错误');
        spec.pos = [Math.max(55, Math.min(1145, entry.pos[0])), Math.max(65, Math.min(635, entry.pos[1]))];
      }
      return spec;
    });
  }
  const mode = input.mode === 'brawl' ? 'brawl' : lineup.A.length > 1 || lineup.B.length > 1 ? 'team' : 'solo';
  const digest = crypto.createHash('sha256');
  for (const name of ['util', 'fighters', 'engine', 'ai', 'battle']) digest.update(fs.readFileSync(path.join(__dirname, '../js', name + '.js')));
  return { format: 'cyber-cricket-replay-v1', simulationVersion: digest.digest('hex').slice(0, 16), seed, mode, lineup, tickRate: 60, fps: 30 };
}

module.exports = { makeConfig };
