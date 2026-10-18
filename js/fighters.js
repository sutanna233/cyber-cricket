/* ===========================================================
   赛博斗蛐蛐 · 单位数据层
   —— 15 只单位的属性 / 技能 / 释放策略 / 台词 / 贴图键
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
        ult: { when: 'energyFull' } },
      texture: { key: 'xujiayin', scale: 1.0 },
    },
    {
      id: 'kun', name: '鸡哥', title: '篮球の神',
      role: 'bruiser', pos: 'front', palette: ['#ff8a3d', '#2b1a0e'],
      stats: { hp: 1050, atk: 100, def: 42, spd: 210, crit: 0.12, critDmg: 1.8, weight: 1.0, range: 76, atkInterval: 0.55 },
      skills: [
        { key: 's1', name: '唱跳rap', desc: '两段连击后收尾投出一记篮球（会弹到下一个敌人）', cd: 6, cost: 0,
          steps: [ { kind: 'melee', dmg: 0.26, range: 80, arc: 110, hits: 2, knock: 40, hitstun: 0.15, t: 0.3 },
            { kind: 'projectile', dmg: 0.45, speed: 620, life: 2.2, sprite: 'star', scale: 1.0, radius: 24,
              bounces: 2, arcH: 70, t: 0.95 } ],
          line: '你干嘛～哎哟～' },
        { key: 's2', name: '铁山靠', desc: '突进撞击，破除霸体', cd: 9, cost: 20,
          steps: [dash({ dist: 230, dmg: 0.8, knock: 240, hitstun: 0.35, pierceArmor: true })],
          line: '铁山靠！' },
      ],
      ult: { key: 'ult', name: '只因你太美', desc: '必杀：全屏音波，全场跟着一起跳（强制僵直）并持续掉血', cd: 0, cost: 100,
        steps: [aoe({ radius: 420, dmg: 1.1, warn: 0.9, at: 'self', sprite: 'ring',
          effects: [{ kind: 'stun', dur: 1.3, mag: 1 }, { kind: 'poison', dur: 6, mag: 0.05 },
            { kind: 'speedDown', dur: 6, mag: 0.3 }] })],
        line: '只因你太美～' },
      lines: ['练两年半。', '鸡你太美。', '篮球是我的信仰。'], barks: { hit: '哎哟', taken: '干嘛～', cast: '只因！' },
      policy: { s1: { when: 'enemyInRange', range: 90 }, s2: { when: 'enemyInRange', range: 240 },
        ult: { when: 'energyFull' } },
      texture: { key: 'kun', scale: 1.0 },
    },
    {
      id: 'dingzhen', name: '丁真', title: '纯真之眼',
      role: 'ranged', pos: 'back', palette: ['#7fe3ff', '#1b2a36'],
      stats: { hp: 900, atk: 104, def: 32, spd: 202, crit: 0.25, critDmg: 2.0, weight: 0.85, range: 300, atkInterval: 0.76 },
      skills: [
        { key: 's1', name: '一眼丁真', desc: '远程一眼，致盲敌人', cd: 5, cost: 0,
          steps: [proj({ dmg: 0.5, speed: 620, sprite: 'slash_arc', scale: 0.8, radius: 22,
            effects: [{ kind: 'blind', dur: 3, mag: 0.45 }] })],
          line: '一眼丁真，鉴定为强。' },
        { key: 's2', name: '电子烟', desc: '吐出一片烟雾，减速并降低命中', cd: 9, cost: 20,
          steps: [aoe({ radius: 165, dmg: 0.45, warn: 0.4, at: 'target', sprite: 'glitch',
            effects: [{ kind: 'speedDown', dur: 5, mag: 0.4 }, { kind: 'blind', dur: 4, mag: 0.4 }] })],
          line: '（吞云吐雾）' },
      ],
      ult: { key: 'ult', name: '一整个爱住', desc: '必杀：连射吸血，回补自身血量', cd: 0, cost: 100,
        steps: [melee({ dmg: 0.35, range: 320, arc: 30, hits: 5, knock: 20, t: 0.16,
          effects: [{ kind: 'lifesteal', dur: 2, mag: 0.6 }] })],
        line: '一整个爱住～' },
      lines: ['这就是山里的孩子。', '我很纯真。', '理塘的风。'], barks: { hit: '哎', taken: '额', cast: '丁真！' },
      policy: { s1: { when: 'enemyInRange', range: 460 }, s2: { when: 'enemyInRange', range: 260 },
        ult: { when: 'selfHpBelow', v: 0.65 } },
      texture: { key: 'dingzhen', scale: 0.98 },
    },
    {
      id: 'bao', name: '马保国', title: '闪电五连鞭',
      role: 'tank', pos: 'front', palette: ['#ffe066', '#3a2a10'],
      stats: { hp: 1250, atk: 84, def: 58, spd: 166, crit: 0.08, critDmg: 1.6, weight: 1.3, range: 78, atkInterval: 0.6 },
      skills: [
        { key: 's1', name: '五连鞭', desc: '五段小伤，每段都僵直', cd: 6, cost: 0,
          steps: [melee({ dmg: 0.18, range: 84, hits: 5, knock: 30, hitstun: 0.1, t: 0.2 })],
          line: '闪电五连鞭！' },
        { key: 's2', name: '接化发', desc: '1.5 秒内免伤并反弹伤害', cd: 10, cost: 25,
          steps: [buff({ effects: [{ kind: 'invuln', dur: 0.6, mag: 1 }, { kind: 'reflect', dur: 1.5, mag: 0.8 }] })],
          line: '我这一拳，你接不住。' },
      ],
      ult: { key: 'ult', name: '耗子尾汁', desc: '必杀：击飞全场并眩晕', cd: 0, cost: 100,
        steps: [aoe({ radius: 240, dmg: 1.5, warn: 0.8, at: 'self', sprite: 'impact', knock: 300,
          effects: [{ kind: 'stun', dur: 1.5, mag: 1 }] })],
        line: '耗子尾汁！' },
      lines: ['年轻人不讲武德。', '我劝你耗子尾汁。', '武术不是花架子。'], barks: { hit: '哈', taken: '哎哟', cast: '接化发！' },
      policy: { s1: { when: 'enemyInRange', range: 95 }, s2: { when: 'selfHpBelow', v: 0.5 },
        ult: { when: 'energyFull' } },
      texture: { key: 'bao', scale: 1.02 },
    },
    {
      id: 'sunge', name: '孙笑川', title: '水滴鱼の怒',
      role: 'assassin', pos: 'front', palette: ['#8affc1', '#10261c'],
      stats: { hp: 880, atk: 92, def: 34, spd: 255, crit: 0.18, critDmg: 1.9, weight: 0.8, range: 72, atkInterval: 0.38 },
      skills: [
        { key: 's1', name: '表情包连弹', desc: '丢出一张表情包，命中后弹到下一个敌人（最多弹 2 次）', cd: 5, cost: 0,
          steps: [proj({ dmg: 0.28, speed: 520, sprite: 'glitch', scale: 0.8, bounces: 2,
            effects: [{ kind: 'atkDown', dur: 3, mag: 0.1 }] })],
          line: '八百标兵奔北坡！' },
        { key: 's2', name: '你礼貌吗', desc: '短暂无敌后反打', cd: 9, cost: 20,
          steps: [buff({ effects: [{ kind: 'invuln', dur: 0.9, mag: 1 }] }), melee({ dmg: 0.9, range: 90, t: 0.95, knock: 180 })],
          line: '你礼貌吗？' },
      ],
      ult: { key: 'ult', name: '为什么追我', desc: '必杀：血量越低伤害越高', cd: 0, cost: 100,
        steps: [dash({ dist: 380, dmg: 2.2, knock: 320, hitstun: 0.5, lowHpBonus: true })],
        line: '为什么追我！！' },
      lines: ['有内鬼。', '做人要低调。', '我就说一句。'], barks: { hit: '诶', taken: '啊', cast: '哎哟喂' },
      policy: { s1: { when: 'enemyInRange', range: 85 }, s2: { when: 'selfHpBelow', v: 0.6 },
        ult: { when: 'selfHpBelow', v: 0.5 } },
      texture: { key: 'sunge', scale: 0.96 },
    },
    {
      id: 'bili', name: '陈睿', title: '叔叔的凝视',
      role: 'bruiser', pos: 'front', palette: ['#ff9ecb', '#2a1030'],
      stats: { hp: 1100, atk: 96, def: 48, spd: 196, crit: 0.1, critDmg: 1.7, weight: 1.1, range: 80, atkInterval: 0.58 },
      skills: [
        { key: 's1', name: '大会员之刃', desc: '给自己套盾再斩', cd: 6, cost: 0,
          steps: [buff({ effects: [{ kind: 'shield', dur: 5, mag: 0.12 }] }), melee({ dmg: 0.55, range: 92, t: 0.3 })],
          line: '充钱就能变强。' },
        { key: 's2', name: '404限流', desc: '偷走范围内敌人的怒气，并削弱他们的攻击；自己转化为护盾', cd: 10, cost: 0,
          steps: [ { kind: 'steal_energy', radius: 280, amount: 30, debuffDur: 4, debuffMag: 0.2, t: 0.3 },
            buff({ effects: [{ kind: 'shield', dur: 5, mag: 0.1 }, { kind: 'invuln', dur: 0.5, mag: 1 }], t: 0.35 }) ],
          line: '这个视频不存在。' },
      ],
      ult: { key: 'ult', name: '六分钟诅咒', desc: '必杀：范围内持续落雷', cd: 0, cost: 100,
        steps: [aoe({ radius: 220, dmg: 0.6, warn: 0.8, at: 'target', sprite: 'ring', repeat: 4, repeatGap: 0.4,
          effects: [{ kind: 'stun', dur: 0.4, mag: 1 }] })],
        line: '六分钟，开始。' },
      lines: ['叔叔我啊，要生气了。', '开个大会员吧。', '这就很难办了。'], barks: { hit: '嗯', taken: '啧', cast: '屏蔽！' },
      policy: { s1: { when: 'enemyInRange', range: 100 }, s2: { when: 'selfHpBelow', v: 0.55 },
        ult: { when: 'energyFull' } },
      texture: { key: 'bili', scale: 1.0 },
    },
    {
      id: 'yingma', name: '张维为', title: '赢麻了',
      role: 'support', pos: 'back', palette: ['#ff4d4d', '#2a0d0d'],
      stats: { hp: 980, atk: 82, def: 40, spd: 200, crit: 0.08, critDmg: 1.6, weight: 0.95, range: 84, atkInterval: 0.62 },
      skills: [
        { key: 's1', name: '叙事加成', desc: '嘴炮压制全场并给全队增伤加速', cd: 6, cost: 0,
          steps: [ { kind: 'aoe', radius: 200, dmg: 0.95, warn: 0.35, at: 'self', sprite: 'ring',
            knock: 60, effects: [{ kind: 'speedDown', dur: 3, mag: 0.2 }], t: 0.3 },
            buff({ at: 'allies', effects: [{ kind: 'atkUp', dur: 8, mag: 0.3 }, { kind: 'speedUp', dur: 8, mag: 0.2 }], t: 0.65 }) ],
          line: '我们要讲好中国故事。' },
        { key: 's2', name: '这就是中国', desc: '治疗全队并清除负面', cd: 12, cost: 20,
          steps: [heal({ amount: 0.05, at: 'allies' }), buff({ at: 'allies', effects: [{ kind: 'cleanse', dur: 0.1, mag: 1 }] })],
          line: '这就是中国。' },
      ],
      ult: { key: 'ult', name: '赢两次', desc: '必杀：双段双倍', cd: 0, cost: 100,
        steps: [melee({ dmg: 1.5, range: 130, arc: 200, hits: 2, t: 0.3, knock: 150 })],
        line: '一次不够，就赢两次。' },
      lines: ['永远可以相信。', '这个数据很有意思。', '赢麻了。'], barks: { hit: '对', taken: '呃', cast: '赢了！' },
      policy: { s1: { when: 'always' }, s2: { when: 'alliesBelow', n: 4 },
        ult: { when: 'energyFull' } },
      texture: { key: 'yingma', scale: 1.0 },
    },
    {
      id: 'oligei', name: '大力哥', title: '奥利给',
      role: 'tank', pos: 'front', palette: ['#ffd24d', '#331a00'],
      stats: { hp: 1300, atk: 106, def: 52, spd: 150, crit: 0.06, critDmg: 1.6, weight: 1.5, range: 84, atkInterval: 0.78 },
      skills: [
        { key: 's1', name: '奥利给咆哮', desc: '吼一嗓子，击退并减速', cd: 6, cost: 0,
          steps: [aoe({ radius: 160, dmg: 0.4, warn: 0.5, at: 'self', sprite: 'glitch', knock: 220,
            effects: [{ kind: 'speedDown', dur: 4, mag: 0.35 }] })],
          line: '奥利给！！' },
        { key: 's2', name: '大力出奇迹', desc: '蓄力重击：蓄力期间霸体不可打断，无视部分防御', cd: 9, cost: 20,
          uninterruptible: true,
          steps: [melee({ dmg: 1.35, range: 100, knock: 120, hitstun: 0.4, armorPierce: 0.5, t: 0.45 })],
          line: '大力出奇迹！' },
      ],
      ult: { key: 'ult', name: '干了', desc: '必杀：吸血霸体重击', cd: 0, cost: 100,
        steps: [buff({ effects: [{ kind: 'superArmor', dur: 1.2, mag: 1 }] }),
          melee({ dmg: 1.9, range: 120, knock: 260, t: 0.5,
            effects: [{ kind: 'lifesteal', dur: 1.5, mag: 0.5 }] })],
        line: '干了！' },
      lines: ['奥利给，干了！', '没毛病，老铁。', '大力出奇迹。'], barks: { hit: '哈！', taken: '嗷', cast: '奥利给' },
      policy: { s1: { when: 'enemyInRange', range: 150 }, s2: { when: 'enemyInRange', range: 105 },
        ult: { when: 'selfHpBelow', v: 0.6 } },
      texture: { key: 'oligei', scale: 1.04 },
    },
    {
      id: 'fawang', name: '罗翔', title: '法外狂徒',
      role: 'bruiser', pos: 'back', palette: ['#bfa4ff', '#1a1030'],
      stats: { hp: 950, atk: 108, def: 36, spd: 214, crit: 0.28, critDmg: 2.1, weight: 0.9, range: 80, atkInterval: 0.5 },
      skills: [
        { key: 's1', name: '张三判刑', desc: '射出传票：标记敌人（受伤 +25%）并封印技能', cd: 8, cost: 0,
          steps: [proj({ dmg: 0.3, speed: 560, sprite: 'star', scale: 0.9,
            effects: [{ kind: 'marked', dur: 8, mag: 0.25 }, { kind: 'seal', dur: 2.5, mag: 1 }] })],
          line: '张三，你又来了。' },
        { key: 's2', name: '法理之刃', desc: '三连斩击', cd: 6, cost: 15,
          steps: [melee({ dmg: 0.38, range: 88, hits: 3, knock: 45, t: 0.18 })],
          line: '法律，不容践踏。' },
      ],
      ult: { key: 'ult', name: '开庭', desc: '必杀：把场上所有标记一次性判完（每层标记独立结算）', cd: 0, cost: 100,
        steps: [ { kind: 'detonate', radius: 400, perMark: 1.1, t: 0.3 },
          buff({ effects: [{ kind: 'invuln', dur: 1.2, mag: 1 }, { kind: 'reflect', dur: 2, mag: 1.0 },
            { kind: 'atkUp', dur: 6, mag: 0.35 }] }) ],
        line: '现在，开庭。' },
      lines: ['我们办的不是案子，是别人的人生。', '张三已经进去了。', '学法的要善良。'],
      barks: { hit: '啪', taken: '唔', cast: '判刑！' },
      policy: { s1: { when: 'enemyInRange', range: 420 }, s2: { when: 'enemyInRange', range: 95 },
        ult: { when: 'selfHpBelow', v: 0.5 } },
      texture: { key: 'fawang', scale: 1.0 },
    },
    {
      id: 'liulaoshi', name: '六小龄童', title: '文体两开花',
      role: 'support', pos: 'back', palette: ['#ffcf6b', '#2a1806'],
      stats: { hp: 1010, atk: 88, def: 42, spd: 190, crit: 0.12, critDmg: 1.7, weight: 1.0, range: 80, atkInterval: 0.6 },
      skills: [
        { key: 's1', name: '两开花', desc: '召唤两个分身', cd: 9, cost: 0, steps: [summon({ count: 2, life: 10 })] },
        { key: 's2', name: '猴子猴孙', desc: '分身突进，本体连斩', cd: 8, cost: 20,
          steps: [dash({ dist: 260, dmg: 0.5, knock: 120 }), melee({ dmg: 0.5, range: 100, hits: 2, t: 0.34 })] },
      ],
      ult: { key: 'ult', name: '全球开花', desc: '必杀：多段范围打击', cd: 0, cost: 100,
        steps: [aoe({ radius: 230, dmg: 0.45, warn: 0.7, at: 'target', sprite: 'star', repeat: 5, repeatGap: 0.35 })],
        line: '文体两开花！' },
      lines: ['文体两开花。', '孙悟空只有一个。', '改编不是乱编。'], barks: { hit: '嘿', taken: '哎呀', cast: '开花！' },
      policy: { s1: { when: 'always' }, s2: { when: 'enemyInRange', range: 300 },
        ult: { when: 'energyFull' } },
      texture: { key: 'liulaoshi', scale: 1.0 },
    },
    {
      id: 'daxiang', name: '二仙桥大爷', title: '走成华大道',
      role: 'assassin', pos: 'front', palette: ['#9be36b', '#14240c'],
      stats: { hp: 960, atk: 98, def: 38, spd: 246, crit: 0.16, critDmg: 1.85, weight: 0.95, range: 76, atkInterval: 0.54 },
      skills: [
        { key: 's1', name: '走成华大道', desc: '超远冲撞直切后排，并在地上留下减速「路障」', cd: 7, cost: 0,
          steps: [dash({ dist: 420, dmg: 0.85, knock: 260, hitstun: 0.35, preferBack: true }),
            { kind: 'aoe', radius: 110, dmg: 0.12, warn: 0.15, at: 'self', sprite: 'ring', knock: 0,
              effects: [{ kind: 'speedDown', dur: 6, mag: 0.45 }], t: 0.5 }],
          line: '走成华大道，到二仙桥。' },
        { key: 's2', name: '腰马合一', desc: '霸体并反弹伤害', cd: 10, cost: 20,
          steps: [buff({ effects: [{ kind: 'superArmor', dur: 2, mag: 1 }, { kind: 'reflect', dur: 2, mag: 0.6 }] })],
          line: '我这两条腿，只拉货。' },
      ],
      ult: { key: 'ult', name: '拖走你', desc: '必杀：抓住对手拖行重创', cd: 0, cost: 100,
        steps: [dash({ dist: 200, dmg: 0.6, knock: 40, grab: true }),
          melee({ dmg: 1.6, range: 90, knock: 320, t: 0.5 })],
        line: '我要把你拖走！' },
      lines: ['走成华大道。', '到二仙桥。', '只能拉一点点。'], barks: { hit: '哎', taken: '嗨呀', cast: '走！' },
      policy: { s1: { when: 'enemyInRange', range: 400 }, s2: { when: 'selfHpBelow', v: 0.6 },
        ult: { when: 'energyFull' } },
      texture: { key: 'daxiang', scale: 1.0 },
    },
    {
      id: 'xiongmao', name: '熊猫头', title: '狠人',
      role: 'bruiser', pos: 'front', palette: ['#dfe6ef', '#14181f'],
      stats: { hp: 1080, atk: 98, def: 46, spd: 200, crit: 0.14, critDmg: 1.8, weight: 1.15, range: 78, atkInterval: 0.56 },
      skills: [
        { key: 's1', name: '无情铁拳', desc: '朴实的重拳 —— 但对血量比自己高的对手额外重创（专打强者）', cd: 5, cost: 0,
          steps: [melee({ dmg: 0.55, range: 88, knock: 140, hitstun: 0.28, highHpBonus: 0.85 })],
          line: '美汁汁儿。' },
        { key: 's2', name: '熊猫翻滚', desc: '翻滚撞开一条路', cd: 8, cost: 20,
          steps: [dash({ dist: 300, dmg: 0.6, knock: 200 })],
          line: '（滚）' },
      ],
      ult: { key: 'ult', name: '表情包核爆', desc: '必杀：把满屏表情包砸下去', cd: 0, cost: 100,
        steps: [aoe({ radius: 300, dmg: 2.0, warn: 1.0, at: 'self', sprite: 'boom',
          effects: [{ kind: 'stun', dur: 0.8, mag: 1 }] })],
        line: '（一张巨大的表情包）' },
      lines: ['美汁汁儿。', '我就静静看着你。', '（不说话）'], barks: { hit: '咚', taken: '噗', cast: '啊——' },
      policy: { s1: { when: 'enemyInRange', range: 95 }, s2: { when: 'enemyInRange', range: 320 },
        ult: { when: 'energyFull' } },
      texture: { key: 'xiongmao', scale: 1.0 },
    },
    {
      id: 'zhenxiang', name: '王境泽', title: '真香定律',
      role: 'tank', pos: 'front', palette: ['#ffb36b', '#2a1608'],
      stats: { hp: 1180, atk: 90, def: 54, spd: 176, crit: 0.08, critDmg: 1.6, weight: 1.25, range: 78, atkInterval: 0.62 },
      skills: [
        { key: 's1', name: '铁骨铮铮', desc: '套上护盾与反伤，并嘴硬地撞上去', cd: 8, cost: 0,
          steps: [buff({ effects: [{ kind: 'shield', dur: 5, mag: 0.14 }, { kind: 'reflect', dur: 4, mag: 0.3 }] }),
            melee({ dmg: 0.6, range: 92, knock: 120, hitstun: 0.25, t: 0.3 })],
          line: '我就是饿死，也不会吃！' },
        { key: 's2', name: '真香', desc: '先割自己 10% 血（嘴硬），换来回血与增伤（真香）', cd: 9, cost: 20,
          hpCost: 0.1,
          steps: [buff({ effects: [{ kind: 'regen', dur: 8, mag: 0.012 }, { kind: 'atkUp', dur: 8, mag: 0.35 }] })],
          line: '……真香。' },
      ],
      ult: { key: 'ult', name: '摔碗', desc: '必杀：范围核爆', cd: 0, cost: 100,
        steps: [aoe({ radius: 280, dmg: 2.1, warn: 1.0, at: 'self', sprite: 'impact', knock: 200 })],
        line: '我不吃了！！' },
      lines: ['真香。', '我为这个家付出太多了。', '一口，就一口。'], barks: { hit: '嗯', taken: '啊', cast: '真香！' },
      policy: { s1: { when: 'selfHpBelow', v: 0.75 }, s2: { when: 'selfHpBelow', v: 0.55 },
        ult: { when: 'energyFull' } },
      texture: { key: 'zhenxiang', scale: 1.02 },
    },
    {
      id: 'chongwang', name: '赛博虫王', title: '隐藏 Boss',
      role: 'boss', pos: 'front', palette: ['#7bff8a', '#06210d'], hidden: true,
      stats: { hp: 1600, atk: 118, def: 60, spd: 206, crit: 0.15, critDmg: 2.0, weight: 1.6, range: 92, atkInterval: 0.5 },
      skills: [
        { key: 's1', name: '虫鸣共振', desc: '声波穿甲，命中全队', cd: 6, cost: 0,
          steps: [aoe({ radius: 240, dmg: 0.7, warn: 0.5, at: 'self', sprite: 'ring', armorPierce: 0.4 })],
          line: '（共振）' },
        { key: 's2', name: '数据乌鸦', desc: '放出三只数据乌鸦', cd: 9, cost: 25,
          steps: [summon({ count: 3, life: 12, ranged: true })] },
      ],
      ult: { key: 'ult', name: '格式化世界', desc: '必杀：磁盘格式化，全场重创', cd: 0, cost: 100,
        steps: [aoe({ radius: 460, dmg: 2.6, warn: 1.3, at: 'self', sprite: 'glitch', knock: 240,
          effects: [{ kind: 'seal', dur: 3, mag: 1 }] })],
        line: 'FORMAT COMPLETE.' },
      lines: ['斗蛐蛐的本质是暴力。', '数据不会说谎。', '你只是一行日志。'],
      barks: { hit: '嘀', taken: '！', cast: '格式化' },
      policy: { s1: { when: 'enemyInRange', range: 200 }, s2: { when: 'always' }, ult: { when: 'energyFull' } },
      texture: { key: 'chongwang', scale: 1.1 },
    },
  ];

  // ---------- 平衡覆盖表 ----------
  // 依据 tools/_simcheck/balance.js 的实测对位胜率调整（目标：每人 45%~55%）
  // 规律：胜率 ≈ 输出能力，坦克血多但打不动 → 补攻；高速输出手太强 → 削血削攻
  const BALANCE = {
    // 偏弱 → 补强（坦克同时抬防御：def 决定减伤，血多但减伤低等于白给）
    yingma:    { hp: 1450, atk: 136, def: 54 },  // 41%
    bao:       { hp: 1560, atk: 132, def: 92 },  // 43%
    tomori:    { hp: 1700, atk: 124, def: 88 },  // 42%
    zhenxiang: { hp: 1420, atk: 120, def: 86 },  // 49%
    daxiang:   { hp: 1120, atk: 128, def: 42 },  // 44%
    oligei:    { hp: 1240, atk: 98, def: 70 },   // 47%
    // 中间微调
    liulaoshi: { hp: 1220, atk: 116, def: 48 },  // 48%
    sunge:     { hp: 820, atk: 84, def: 34 },    // 53%
    xujiayin:  { hp: 1160, atk: 110, def: 44 },  // 53%
    bili:      { hp: 1000, atk: 88, def: 46 },   // 52%
    // 偏强 → 继续削
    xiongmao:  { hp: 900, atk: 78, def: 44 },    // 48%
    dingzhen:  { hp: 760, atk: 66, def: 30, crit: 0.16 },  // 57%
    fawang:    { hp: 720, atk: 68, def: 36 },    // 49%
    kun:       { hp: 860, atk: 66, def: 42 },    // 59%
    chongwang: { hp: 1600, atk: 118, def: 60 },  // Boss 保持
  };

  // ---------- 手感调参表 ----------
  // 每个角色的冷却(cd)与蓄力前摇(cast)按定位区分，避免所有人手感一样：
  //   刺客/快攻 → 短 CD + 极短前摇（0.2~0.35s，不容易被打断）
  //   坦克/重装 → 长 CD + 长前摇（1.0~1.6s，威力大但可被抢断）
  //   远程/辅助 → 中等
  // policy 里只覆盖需要改的键（例如把卡太死的必杀条件放宽）
  const TUNE = {
    tomori:    { s1: { cd: 5, cast: 0.7 }, s2: { cd: 8, cast: 1.0 }, ult: { cast: 1.6 },
                 policy: { ult: { when: 'stacksAbove', n: 3 } } },
    xujiayin:  { s1: { cd: 6, cast: 0.5 }, s2: { cd: 10, cast: 0.85 }, ult: { cast: 1.4 } },
    kun:       { s1: { cd: 4, cast: 0.3 }, s2: { cd: 8, cast: 0.6 }, ult: { cast: 1.2 } },
    dingzhen:  { s1: { cd: 4, cast: 0.35 }, s2: { cd: 9, cast: 0.7 }, ult: { cast: 1.3 },
                 policy: { ult: { when: 'selfHpBelow', v: 0.9 } } },
    bao:       { s1: { cd: 6, cast: 0.8 }, s2: { cd: 10, cast: 1.15 }, ult: { cast: 1.75 } },
    sunge:     { s1: { cd: 3, cast: 0.2 }, s2: { cd: 8, cast: 0.5 }, ult: { cast: 1.0 },
                 policy: { ult: { when: 'selfHpBelow', v: 0.8 } } },
    bili:      { s1: { cd: 5, cast: 0.45 }, s2: { cd: 9, cast: 0.75 }, ult: { cast: 1.3 } },
    yingma:    { s1: { cd: 6, cast: 0.5 }, s2: { cd: 10, cast: 0.9 }, ult: { cast: 1.5 } },
    oligei:    { s1: { cd: 8, cast: 1.2 }, s2: { cd: 11, cast: 1.6 }, ult: { cast: 2.0 },
                 policy: { ult: { when: 'selfHpBelow', v: 0.85 } } },
    fawang:    { s1: { cd: 4, cast: 0.3 }, s2: { cd: 7, cast: 0.55 }, ult: { cast: 1.1 },
                 policy: { ult: { when: 'always' } } },
    liulaoshi: { s1: { cd: 7, cast: 0.9 }, s2: { cd: 9, cast: 0.8 }, ult: { cast: 1.5 } },
    daxiang:   { s1: { cd: 5, cast: 0.35 }, s2: { cd: 8, cast: 0.6 }, ult: { cast: 1.2 } },
    xiongmao:  { s1: { cd: 4, cast: 0.4 }, s2: { cd: 8, cast: 0.6 }, ult: { cast: 1.3 } },
    zhenxiang: { s1: { cd: 6, cast: 0.6 }, s2: { cd: 9, cast: 0.9 }, ult: { cast: 1.5 } },
    chongwang: { s1: { cd: 5, cast: 0.7 }, s2: { cd: 8, cast: 1.0 }, ult: { cast: 1.9 } },
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
    ['s1', 's2'].forEach((k) => {
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
      s1: skills.s1, s2: skills.s2, ult: r.ult,
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
