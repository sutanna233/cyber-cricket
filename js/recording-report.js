/* 导出录像专用的 Canvas 结算卡；普通游戏仍使用原有战报面板。 */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';
  const COLORS = { A: '#88ddff', B: '#ffb5b0' };

  function number(value) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  }

  function unitName(entity) {
    const fighter = CC.fighters && CC.fighters.get && CC.fighters.get(entity.unitId);
    return entity.unit && entity.unit.name || fighter && fighter.name || entity.unitId || '未知角色';
  }

  function rounded(ctx, x, y, w, h, radius, fill, stroke) {
    ctx.fillStyle = fill;
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    } else {
      ctx.fillRect(x, y, w, h);
      if (stroke && ctx.strokeRect) { ctx.strokeStyle = stroke; ctx.strokeRect(x, y, w, h); }
    }
  }

  function text(ctx, value, x, y, size, color, align, width, bold) {
    ctx.font = (bold ? 'bold ' : '') + size + 'px ' + FONT;
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x, y, width || 800);
  }

  function summary(report, battle) {
    const participants = (battle && Array.isArray(battle.participants) ? battle.participants : [])
      .filter(entity => !entity.isMinion && !entity.isDecoy);
    const stats = battle && battle.stats || {};
    const damage = report.dmgBySideUnit || stats.dmgBySideUnit || {};
    const kills = report.killsBySideUnit || stats.killsBySideUnit || {};
    const sides = { A: { count: 0, alive: 0, rows: [] }, B: { count: 0, alive: 0, rows: [] } };
    const groups = new Map();
    const instanceRows = Array.isArray(report.entities) && report.entities.length > 0;
    const entityStats = new Map(instanceRows ? report.entities.map(row => [row.id, row]) : []);
    for (const entity of participants) {
      if (!sides[entity.side]) continue;
      const side = sides[entity.side];
      side.count++; if (entity.alive) side.alive++;
      if (instanceRows) {
        const source = entityStats.get(entity.id) || {};
        const row = Object.assign({}, source, { side: entity.side, id: entity.id, name: unitName(entity) + ' ' + entity.id + '号',
          label: source.label, count: 1, damage: number(source.damage), kills: Math.floor(number(source.kills)) });
        groups.set(entity.id, row); side.rows.push(row);
        continue;
      }
      const key = entity.side + ':' + entity.unitId;
      let row = groups.get(key);
      if (!row) {
        row = { side: entity.side, id: entity.unitId, name: unitName(entity), count: 0,
          damage: number(damage[key]), kills: Math.floor(number(kills[key])) };
        groups.set(key, row); side.rows.push(row);
      }
      row.count++;
    }
    const rank = (a, b) => b.damage - a.damage || b.kills - a.kills || a.name.localeCompare(b.name, 'zh-CN');
    for (const side of Object.values(sides)) side.rows.sort(rank);
    const ranked = Array.from(groups.values()).sort(rank);
    const totalDamage = instanceRows ? ranked.reduce((sum, row) => sum + row.damage, 0)
      : Object.values(damage).reduce((sum, value) => sum + number(value), 0);
    return { participants, sides, totalDamage, instanceRows, mvp: ranked.length && ranked[0].damage > 0 ? ranked[0] : null };
  }

  function draw(ctx, report, battle) {
    if (!ctx || typeof ctx.fillText !== 'function') return false;
    const rep = report || {};
    const data = summary(rep, battle);
    const brawl = rep.mode === 'brawl' || battle && battle.mode === 'brawl';
    const winner = rep.winner === 'A' || rep.winner === 'B' ? rep.winner : null;
    const champion = data.participants.find(entity => entity.id === rep.winnerId);
    const championLabel = rep.champion || (champion ? unitName(champion) + ' #' + champion.id : null);
    const title = brawl ? championLabel ? championLabel + ' · 乱斗冠军' : '本场平局 · 无人存活'
      : winner ? (winner === 'A' ? '左方 A 队' : '右方 B 队') + ' 获胜' : '本场平局 · 同归于尽';
    const duration = number(rep.duration === undefined ? battle && battle.time : rep.duration);
    const seconds = Math.floor(duration);
    const clock = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
    const total = data.sides.A.count + data.sides.B.count;
    const alive = data.sides.A.alive + data.sides.B.alive;
    const tint = brawl ? '#ffdc88' : winner ? COLORS[winner] : '#ffdc88';
    const reason = rep.reason === 'last-standing' ? '最后存活者' : rep.reason === 'wipe' ? '一方全灭'
      : rep.reason === 'double-ko' ? '同归于尽' : '战斗结束';

    ctx.save();
    try {
      // 底部 80 像素保留给导出字幕；结算卡和底部字幕可同时显示。
      ctx.fillStyle = 'rgba(3, 7, 18, 0.64)'; ctx.fillRect(0, 0, 960, 520);
      rounded(ctx, 54, 48, 852, 472, 18, 'rgba(10, 17, 34, 0.97)', 'rgba(147, 176, 220, 0.46)');
      ctx.fillStyle = tint; ctx.fillRect(78, 66, 4, 32);
      text(ctx, '对局结算', 94, 73, 12, '#a7b8d1', 'left', 110, true);
      text(ctx, title, 480, 83, 25, tint, 'center', 650, true);
      text(ctx, (brawl ? '自由乱斗' : '阵营对战') + ' · 对局时长 ' + clock + ' · ' + reason,
        480, 108, 13, '#a7b8d1', 'center', 750);

      const metrics = [
        { x: 78, w: 100, label: '战况评分', value: rep.grade || '—', size: 25, color: '#ffe0a0' },
        { x: 196, w: 145, label: '累计伤害', value: Math.round(data.totalDamage).toLocaleString('zh-CN'), size: 23 },
        { x: 359, w: 166, label: '存活角色 / 出场角色', value: alive + ' / ' + total, size: 23 },
        { x: 543, w: 339, label: data.instanceRows ? '最高输出 MVP（单个参赛者）' : '最高输出 MVP（同侧角色合计）',
          value: data.mvp ? (brawl ? '' : data.mvp.side === 'A' ? '左侧·' : '右侧·') + data.mvp.name +
            (data.mvp.count > 1 ? ' ×' + data.mvp.count : '') + '  ·  ' + Math.round(data.mvp.damage) + ' 伤害' : '暂无有效伤害', size: 15 }
      ];
      for (const metric of metrics) {
        rounded(ctx, metric.x, 126, metric.w, 55, 10, 'rgba(30, 44, 68, 0.78)');
        text(ctx, metric.label, metric.x + 11, 140, 11, '#99acc8', 'left', metric.w - 20);
        text(ctx, metric.value, metric.x + 11, 164, metric.size, metric.color || '#edf6ff', 'left', metric.w - 20, true);
      }

      for (const [index, sideId] of ['A', 'B'].entries()) {
        const side = data.sides[sideId], x = index ? 492 : 78, w = 390;
        const label = brawl ? (sideId === 'A' ? '左侧出场' : '右侧出场') : (sideId === 'A' ? '左方 A 队' : '右方 B 队');
        text(ctx, label + ' · 存活 ' + side.alive + ' / ' + side.count, x + 4, 198, 14, COLORS[sideId], 'left', 265, true);
        text(ctx, '伤害 / 击杀', x + w - 8, 198, 12, '#a7b8d1', 'right', 110);
        if (!side.rows.length) text(ctx, '无出场角色', x + 12, 240, 13, '#8496b2', 'left', 300);
        side.rows.slice(0, 6).forEach((row, rowIndex) => {
          const y = 219 + rowIndex * 43;
          rounded(ctx, x, y - 9, w, 41, 5, rowIndex % 2 ? 'rgba(27, 41, 62, 0.72)' : 'rgba(21, 33, 53, 0.72)');
          text(ctx, row.name + (row.count > 1 ? ' ×' + row.count + '（合计）' : ''), x + 9, y, 12, '#e1eaf6', 'left', 240);
          text(ctx, Math.round(row.damage).toLocaleString('zh-CN') + ' / ' + row.kills,
            x + w - 9, y, 12, COLORS[sideId], 'right', 120, true);
          if (data.instanceRows) {
            const n = (value) => Math.round(number(value));
            text(ctx, '承伤 ' + n(row.damageTaken) + ' · 治疗 ' + n(row.healing) + ' · 护盾吸收 ' + n(row.shielding),
              x + 9, y + 13, 10, '#b5c8df', 'left', w - 18);
            const skill = row.skillDamage || {};
            const special = [['track', '跑道'], ['trap', '陷阱'], ['run_finish', '冲线']].filter(pair => number(skill[pair[0]]) > 0)
              .map(pair => pair[1] + n(skill[pair[0]])).join(' ');
            text(ctx, '硬控 ' + number(row.controlSeconds).toFixed(1) + '秒 · 打断 ' + n(row.interrupts) + '次 · ' +
              (special || '存活 ' + number(row.aliveSeconds).toFixed(1) + '秒'),
              x + 9, y + 26, 10, '#93b2d0', 'left', w - 18);
          }
        });
      }
      text(ctx, data.instanceRows ? brawl ? '每个编号单独统计；左右仅表示出场位置，乱斗中各自为战。'
        : '每个编号单独统计；原始参赛者的分身、诱饵贡献归所属角色。' : brawl ? '同侧同名角色的数据合计；左右仅表示出场位置，乱斗中各自为战。'
        : '同侧同名角色的数据合计；人数仅统计原始参战角色，不含分身与诱饵。',
      480, 494, 11, '#91a5c1', 'center', 800);
      text(ctx, data.instanceRows ? '治疗为有效回血，护盾为实际吸收；跑道、陷阱及冲线为技能伤害的包含项。' : '伤害按游戏战报记录', 480, 510, 10, '#7188a9', 'center', 800);
    } finally { ctx.restore(); }
    return true;
  }

  CC.recordingReport = { draw, summary };
})();
