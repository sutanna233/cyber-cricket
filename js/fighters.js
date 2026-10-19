/* ===========================================================
   赛博斗蛐蛐 · 单位数据层
   —— 两位角色的属性 / 技能 / 释放策略 / 台词 / 贴图键
   —— 贴图：优先 assets/units/meme/<id>.png（真实 meme 抠图），
            缺图时回退 assets/units/<id>.png
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});

  // ---------- 技能步骤速写 ----------
  // melee: 近身判定  projectile: 弹道  dash: 突进  aoe: 范围  buff/debuff  heal  summon  delayed
  const melee = (o) => Object.assign(
    { kind: 'melee', dmg: 0.5, range: 82, arc: 110, knock: 90, hitstun: 0.18, hits: 1 }, o);
  const proj = (o) => Object.assign(
    { kind: 'projectile', dmg: 0.45, speed: 430, life: 2.2, radius: 26, pierce: false,
      sprite: 'spark', scale: 0.9, arcH: 60 }, o);
  const dash = (o) => Object.assign(
    { kind: 'dash', dist: 220, dur: 0.3, dmg: 0.5, radius: 46, knock: 160, hitstun: 0.2 }, o);
  const aoe = (o) => Object.assign(
    { kind: 'aoe', radius: 150, dmg: 0.8, warn: 0.7, knock: 120, sprite: 'boom',
      at: 'self', effects: [] }, o);
  const buff = (o) => Object.assign({ kind: 'buff', at: 'self', effects: [] }, o);
  const heal = (o) => Object.assign({ kind: 'heal', amount: 0.12 }, o);
  const summon = (o) => Object.assign({ kind: 'summon', count: 2, life: 8 }, o);
  const delayed = (o) => Object.assign({ kind: 'delayed', delay: 0.9, radius: 90, dmg: 0.7 }, o);

  // ---------- 单位表 ----------
  // role: tank/bruiser/assassin/ranged/support/boss ｜ pos: 建议站位 front/back
  const RAW = [
    {
      id: 'tomori', name: '凑企鹅', title: '高松灯企鹅',
      role: 'tank', pos: 'front', palette: ['#7fe3ff', '#12232e'],
      // 收集型：场上散落石头，走过去自动捡；捡满 10 块可以一次性全丢出去
      trait: { collect: 'stone', max: 10, radius: 54 },
      stats: { hp: 1320, atk: 86, def: 60, spd: 168, crit: 0.06, critDmg: 1.6, weight: 1.45, range: 84, atkInterval: 0.66 },
      skills: [
        {
          key: 's1', name: '企鹅拾荒', desc: '磁吸周围的石头（最多囤 10 块），顺手拍开挡路的', cd: 5, cost: 0,
          steps: [{ kind: 'magnet', range: 340, t: 0.25 },
            melee({ dmg: 0.55, range: 96, arc: 140, knock: 90, hitstun: 0.2, t: 0.5 })],
          line: '……（低头捡石头）',
        },
        {
          key: 's2', name: '丢石头', desc: '把石头一块一块砸过去：攒得越多，落石越密', cd: 8, cost: 0,
          steps: [{ kind: 'stone_rain', minCount: 2, maxDrops: 10, interval: 0.13, spread: 190,
            dropRadius: 58, dmg: 0.14, knock: 80, warn: 0.22, t: 0.45 }],
          line: '（一块、一块、全砸下去）',
        },
        {
          key: 's3', name: '企鹅飞踢', desc: '跃起飞踢目标，命中造成伤害、击退和短暂硬直', cd: 9, cost: 0, cast: 0.4,
          steps: [dash({ dist: 260, dur: 0.36, dmg: 0.65, radius: 54, knock: 210,
            hitstun: 0.35, up: 100, jumpHeight: 65, stopAtTarget: true })],
          line: '（企鹅飞踢！）',
        },
      ],
      ult: {
        key: 'ult', name: '乱石雨', desc: '必杀：先把石头吸光，再全图落石',
        cd: 0, cost: 100,
        steps: [{ kind: 'magnet', range: 430, t: 0.15 },
          { kind: 'stone_rain', minCount: 6, maxDrops: 14, interval: 0.1, spread: 340,
            dropRadius: 72, dmg: 0.26, knock: 150, warn: 0.3,
            effects: [{ kind: 'speedDown', dur: 4, mag: 0.3 }], t: 0.7 }],
        line: '（天上开始掉石头）',
      },
      lines: ['企鹅不会后退。', '……', '石头，都归我。'], barks: { hit: '咕', taken: '……', cast: '嘎！' },
      policy: { s1: { when: 'stacksBelow', n: 7 }, s2: { when: 'stacksAbove', n: 4 },
        s3: { when: 'enemyInRange', range: 260 },
        ult: { when: 'stacksAbove', n: 7 } },
      texture: { key: 'tomori', scale: 1.06 },
    },
    {
      id: 'xujiayin', name: '许家印', title: '恒大·两万亿',
      role: 'bruiser', pos: 'back', palette: ['#ffd166', '#2a1608'],
      stats: { hp: 1120, atk: 108, def: 44, spd: 196, crit: 0.16, critDmg: 1.9, weight: 1.0, range: 92, atkInterval: 0.58 },
      skills: [
        {
          key: 's1', name: '指点江山', desc: '抬手一指，射出金色指光', cd: 5, cost: 0,
          steps: [proj({ dmg: 0.55, speed: 520, sprite: 'star', scale: 1.0, radius: 24 })],
          line: '看这里，看这里！',
        },
        {
          key: 's2', name: '债务标记', desc: '给敌人挂上「负债」：受到的伤害 +30%，可被引爆', cd: 10, cost: 25,
          steps: [aoe({ radius: 175, dmg: 0.45, warn: 0.6, at: 'target', sprite: 'impact',
            effects: [{ kind: 'marked', dur: 8, mag: 0.3 }, { kind: 'speedDown', dur: 4, mag: 0.25 }] })],
          line: '这笔账，先记上。',
        },
        {
          key: 's3', name: '空城计', desc: '留下空楼诱饵并后撤；诱饵被击破或到时爆开，给附近敌人挂债务',
          cd: 14, cost: 20, cast: 0.55,
          steps: [{ kind: 'decoy', life: 3, hpRatio: 0.25, radius: 155, dmg: 0.35,
            effects: [{ kind: 'marked', dur: 6, mag: 0.3 }] },
          dash({ dist: 180, dur: 0.28, dmg: 0, away: true, t: 0.05 })],
          line: '城里没人，账倒不少。',
        },
      ],
      ult: {
        key: 'ult', name: '两万亿', desc: '必杀：先把所有人拽过来，再连本带利结算', cd: 0, cost: 100,
        steps: [ { kind: 'pull', radius: 320, dist: 150, at: 'target', t: 0.25 },
          { kind: 'aoe', radius: 220, dmg: 1.6, warn: 0.7, at: 'target', sprite: 'boom', knock: 200,
            effects: [{ kind: 'stun', dur: 1.0, mag: 1 }] },
          { kind: 'detonate', radius: 320, perMark: 0.8, t: 0.9 } ],
        line: '两万亿，连本带利。',
      },
      lines: ['都别慌，稳住。', '有钱一起赚。', '握手言和？'], barks: { hit: '哈！', taken: '唔', cast: '看好了！' },
      policy: { s1: { when: 'enemyInRange', range: 420 }, s2: { when: 'enemyInRange', range: 300 },
        s3: { when: 'enemyInRange', range: 240 },
        ult: { when: 'energyFull' } },
      texture: { key: 'xujiayin', scale: 1.0 },
    },
    {
      id: 'zhangxuefeng', name: '张雪峰', title: '跑步 · 雪碧巧乐兹',
      role: 'bruiser', pos: 'front', palette: ['#75e6a2', '#132d28'],
      stats: { hp: 1280, atk: 100, def: 52, spd: 235, crit: 0.1, critDmg: 1.7,
        weight: 1.0, range: 86, atkInterval: 0.6 },
      skills: [
        { key: 's1', name: '跑步', desc: '加速冲向目标，沿途撞击并短暂提高移动速度', cd: 6, cost: 0, cast: 0.35,
          steps: [buff({ effects: [{ kind: 'speedUp', dur: 3, mag: 0.25 }] }),
            dash({ dist: 300, dur: 0.42, dmg: 0.65, radius: 56, knock: 160, hitstun: 0.25, stopAtTarget: true, t: 0.05 })],
          line: '跑起来！' },
        { key: 's2', name: '雪碧巧乐兹', desc: '喝雪碧、吃巧乐兹，恢复生命并获得短暂护盾与续航', cd: 12, cost: 20, cast: 0.65,
          steps: [heal({ amount: 0.1 }), buff({ effects: [{ kind: 'shield', dur: 4, mag: 0.1 },
            { kind: 'regen', dur: 4, mag: 0.012 }] })], line: '来口雪碧，再来根巧乐兹。' },
      ],
      ult: { key: 'ult', name: '全力跑步', desc: '全力冲刺撞开对手，获得短暂霸体', cost: 100, cd: 0, cast: 0.85,
        steps: [buff({ effects: [{ kind: 'superArmor', dur: 1.5, mag: 1 }] }),
          dash({ dist: 420, dur: 0.45, dmg: 1.35, radius: 56, knock: 270, hitstun: 0.5, stopAtTarget: true, t: 0.05 })],
        line: '最后一圈，全力跑！' },
      policy: { s1: { when: 'enemyInRange', range: 300 }, s2: { when: 'selfHpBelow', v: 0.65 },
        ult: { when: 'energyFull' } },
      lines: ['跑步。', '雪碧巧乐兹。'], barks: { hit: '走！', taken: '呼', cast: '跑起来！' },
      texture: { key: 'zhangxuefeng', scale: 1.0 },
    },
  ];

  // ---------- 平衡覆盖表 ----------
  // 依据 tools/_simcheck/balance.js 的实测对位胜率调整（目标：每人 45%~55%）
  // 规律：胜率 ≈ 输出能力，坦克血多但打不动 → 补攻；高速输出手太强 → 削血削攻
  const BALANCE = {
    tomori: { hp: 1700, atk: 124, def: 88 },
    xujiayin: { hp: 1160, atk: 110, def: 44 },
  };

  // ---------- 手感调参表 ----------
  // 每个角色的冷却(cd)与蓄力前摇(cast)按定位区分，避免所有人手感一样：
  //   刺客/快攻 → 短 CD + 极短前摇（0.2~0.35s，不容易被打断）
  //   坦克/重装 → 长 CD + 长前摇（1.0~1.6s，威力大但可被抢断）
  //   远程/辅助 → 中等
  // policy 里只覆盖需要改的键（例如把卡太死的必杀条件放宽）
  const TUNE = {
    tomori: { s1: { cd: 5, cast: 0.7 }, s2: { cd: 8, cast: 1.0 }, ult: { cast: 1.6 },
      policy: { ult: { when: 'stacksAbove', n: 3 } } },
    xujiayin: { s1: { cd: 6, cast: 0.5 }, s2: { cd: 10, cast: 0.85 }, ult: { cast: 1.4 } },
  };

  // ---------- 组装 ----------
  const DAMAGE_BASE = 1.0;          // 伤害基数（配合 coef/atk/def 计算）
  const TEAM_HP_SCALE = 1.0;        // 团战模式血量缩放（1.0 = 与单挑同血量，避免集火秒人）

  const byId = {};
  const units = RAW.map((r) => {
    const skills = {};
    (r.skills || []).forEach((s) => { skills[s.key] = s; });
    // 套用手感调参（冷却 / 蓄力前摇 / 条件覆盖）
    const tune = TUNE[r.id] || {};
    ['s1', 's2', 's3'].forEach((k) => {
      const sk = skills[k], tk = tune[k];
      if (sk && tk) {
        if (tk.cd != null) sk.cd = tk.cd;
        if (tk.cast != null) sk.cast = tk.cast;
      }
    });
    if (r.ult && tune.ult && tune.ult.cast != null) r.ult.cast = tune.ult.cast;
    const policy = Object.assign({}, r.policy || {}, (tune.policy || {}));
    const u = {
      id: r.id, name: r.name, title: r.title, role: r.role, pos: r.pos,
      palette: r.palette, hidden: !!r.hidden,
      trait: r.trait || null,                    // 收集型单位的拾取特性（例如凑企鹅捡石头）
      stats: Object.assign({
        hp: 1000, atk: 90, def: 40, spd: 200, crit: 0.1, critDmg: 1.7,
        weight: 1, range: 80, atkInterval: 0.6,
      }, r.stats, BALANCE[r.id] || {}),
      radius: r.radius || 34,
      height: r.height || 78,
      s1: skills.s1, s2: skills.s2, s3: skills.s3, ult: r.ult,
      policy,
      chargeTune: tune,
      lines: r.lines || [], barks: r.barks || {},
      texture: r.texture || { key: r.id, scale: 1 },
    };
    byId[u.id] = u;
    return u;
  });

  function get(id) { return byId[id] || null; }
  function all() { return units.slice(); }
  function playable() { return units.filter((u) => !u.hidden); }
  function ids() { return units.map((u) => u.id); }

  // 基础攻击的时间轴（所有单位共用，数值由 stats 决定）
  function basicAttackTimeline(u) {
    const range = u.stats.range;
    const t = Math.max(0.18, u.stats.atkInterval * 0.42);
    if (u.role === 'ranged') {
      return [{ t, kind: 'projectile', dmg: 0.20, speed: 560, life: 1.6, radius: 20,
        sprite: 'spark', scale: 0.7, arcH: 50 }];
    }
    return [{ t, kind: 'melee', dmg: 0.22, range: range + 10, arc: 110, knock: 50, hitstun: 0.12, hits: 1 }];
  }

  CC.fighters = {
    units, byId, get, all, playable, ids,
    basicAttackTimeline,
    consts: { DAMAGE_BASE, TEAM_HP_SCALE },
  };
})();
