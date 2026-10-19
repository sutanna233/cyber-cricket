/* ===========================================================
   观战与测试台（sim-watch.html 专用，不影响正式游戏）
   —— 左侧实时渲染战斗，右侧实时事件流 + 批量测试滚动
   =========================================================== */
(function () {
  'use strict';
  const CC = globalThis.CC;
  if (!CC) { document.body.innerHTML = '<p style="color:#f88">CC 未加载：请通过 http 打开（node server.js）</p>'; return; }

  const $ = (id) => document.getElementById(id);
  const canvas = $('game');

  const S = {
    mode: 'team',
    seed: 20261019,
    speed: 1,
    playing: true,
    match: null,
    selA: [],
    selB: [],
    autoNext: false,
    nextT: 0,
    batch: null,
    lastT: 0,
    stepOnce: 0,
  };

  // ---------- 阵容选择 UI ----------
  function buildUnitPicker(host, sel, counter) {
    host.innerHTML = '';
    CC.fighters.units.forEach((u) => {
      const d = document.createElement('div');
      d.className = 'u';
      d.title = u.name + ' · 左键添加一个，右键移除一个（最多6个）';
      const img = document.createElement('img');
      const p = CC.assets && CC.assets.unitPath ? CC.assets.unitPath(u.id) : 'assets/units/meme/' + u.id + '.png';
      img.src = p;
      img.onerror = () => { img.onerror = null; img.src = 'assets/units/' + u.id + '.png'; };
      d.appendChild(img);
      const t = document.createElement('div');
      t.textContent = u.name;
      d.appendChild(t);
      const refresh = () => {
        const count = sel.filter((id) => id === u.id).length;
        d.classList.toggle('sel', count > 0);
        t.textContent = u.name + (count ? ' ×' + count : '');
        counter.textContent = sel.length;
      };
      d.onclick = () => { if (sel.length < 6) sel.push(u.id); refresh(); };
      d.oncontextmenu = (ev) => {
        ev.preventDefault();
        const index = sel.lastIndexOf(u.id); if (index >= 0) sel.splice(index, 1);
        refresh();
      };
      refresh();
      host.appendChild(d);
    });
  }
  buildUnitPicker($('units-a'), S.selA, $('cnt-a'));
  buildUnitPicker($('units-b'), S.selB, $('cnt-b'));

  // ---------- 对局 ----------
  function pickRandom(n) {
    const pool = CC.fighters.units.map((u) => u.id);
    const out = [];
    for (let i = 0; i < n; i++) out.push(pool[Math.floor(Math.random() * pool.length)]);
    return out;
  }

  function makeLineup(ids) {
    const use = ids.length ? ids.slice(0, 6) : pickRandom(6);
    return use.map((id, i) => ({ id, slot: i, lane: i % 2 }));
  }

  function startMatch(seed) {
    S.seed = seed == null ? nextSeed() : seed;
    const A = makeLineup(S.selA);
    const B = makeLineup(S.selB);
    S.match = CC.battle.createMatch({ seed: S.seed, mode: S.mode === 'brawl' ? 'brawl' : undefined, lineup: { A, B } });
    S.matchState = { board: [], phase: 'fighting', paused: false, bench: [], streak: 0, difficulty: 1, seed: S.seed };
    $('log').innerHTML = '';
    logLine('新对局 seed=' + S.seed + '  A=[' + A.map((x) => x.id).join(',') + ']  B=[' + B.map((x) => x.id).join(',') + ']', 'k');
  }
  function nextSeed() { return Math.floor(Math.random() * 1e9); }

  function logLine(txt, cls) {
    const el = $('log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = txt;
    el.appendChild(d);
    while (el.childNodes.length > 400) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  const EVENT_ZH = {
    hit: '命中', miss: '未命中', cast: '施放', ko: '击倒', heal: '回血', buff: '状态',
    reflect: '反伤', shake: '震屏', hitstop: '停顿', zoom: '镜头', boom: '爆炸', zone: '预警区',
    dodge: '闪避', spawn: '召唤', energy_full: '怒气满', swing: '挥击', whiff: '落空', dash: '突进',
  };
  function describeEvent(battle, ev) {
    const nameOf = (id) => {
      const e = battle.A.concat(battle.B).find((x) => x.id === id);
      return e ? (e.unit ? e.unit.name : e.unitId) : '#' + id;
    };
    switch (ev.type) {
      case 'hit':
        return '<span class="g">命中</span> ' + nameOf(ev.unitId) + ' → ' + nameOf(ev.targetId)
          + ' <b class="y">-' + ev.dmg + '</b>' + (ev.crit ? ' <span class="r">暴击!</span>' : '')
          + (ev.combo > 1 ? ' <span class="d">x' + ev.combo + '</span>' : '');
      case 'miss': return '<span class="d">未命中</span> ' + nameOf(ev.unitId) + ' → ' + nameOf(ev.targetId) + ' (' + ev.reason + ')';
      case 'cast': return '<span class="k">施放</span> ' + nameOf(ev.unitId) + ' · ' + ev.name + (ev.ult ? ' <span class="r">【必杀】</span>' : '');
      case 'ko': return '<span class="r">击倒</span> ' + nameOf(ev.unitId);
      case 'heal': return '<span class="g">回复</span> ' + nameOf(ev.unitId) + ' +' + ev.amount;
      case 'buff': return '<span class="d">状态</span> ' + nameOf(ev.unitId) + ' ← ' + ev.kind + ' ' + (ev.dur || '') + 's';
      case 'boom': return '<span class="y">爆炸</span> r=' + Math.round(ev.radius);
      case 'zone': return '<span class="y">预警区</span> 半径 ' + Math.round(ev.radius) + ' 预警 ' + ev.warn + 's';
      case 'spawn': return '<span class="k">召唤</span> ' + nameOf(ev.of) + ' 的分身';
      case 'dash': return '<span class="k">突进</span> ' + nameOf(ev.unitId);
      case 'dodge': return '<span class="k">闪避</span> ' + nameOf(ev.unitId);
      default: return '';
    }
  }

  const eventLogCursors = new WeakMap();
  function logEvents(battle) {
    let cursor = eventLogCursors.get(battle);
    if (!cursor) { cursor = { seq: -Infinity, objects: new WeakSet() }; eventLogCursors.set(battle, cursor); }
    for (const ev of battle.events) {
      if (!ev || typeof ev !== 'object') continue;
      if (typeof ev.seq === 'number' && Number.isFinite(ev.seq)) {
        if (ev.seq <= cursor.seq) continue;
        cursor.seq = ev.seq;
      } else {
        if (cursor.objects.has(ev)) continue;
        cursor.objects.add(ev);
      }
      const line = describeEvent(battle, ev);
      if (line) logLine(line);
    }
  }

  // ---------- 主循环 ----------
  let acc = 0;
  function frame(ts) {
    const dt = S.lastT ? Math.min(0.1, (ts - S.lastT) / 1000) : 0;
    S.lastT = ts;

    if (S.stepOnce > 0) {
      for (let i = 0; i < S.stepOnce; i++) S.match.battle.step();
      S.stepOnce = 0;
    } else if (S.playing && S.match) {
      S.match.tick(dt * S.speed);
    }

    // 事件流
    if (S.match && S.match.battle) {
      const b = S.match.battle;
      logEvents(b);
      updateStats(b);
    }

    // 自动连打
    if (S.autoNext && S.match && S.match.battle.over) {
      S.nextT += dt;
      if (S.nextT > 1.2) { S.nextT = 0; startMatch(); }
    }

    renderCanvas();
    requestAnimationFrame(frame);
  }

  function renderCanvas() {
    if (!CC.render || typeof CC.render.draw !== 'function') return;
    const view = Object.assign({}, S.matchState);
    view.phase = 'fighting';
    view.paused = !S.playing && !S.stepOnce;
    view.countdown = 0;
    try { CC.render.draw(S.match, view); } catch (e) {
      if (!renderCanvas._warned) { renderCanvas._warned = 1; logLine('渲染异常: ' + e.message, 'r'); }
    }
  }

  function updateStats(b) {
    const rows = [];
    for (const side of ['A', 'B']) {
      for (const e of b[side]) {
        if (e.isMinion) continue;
        const hpPct = Math.max(0, e.hp / e.maxHp * 100);
        const bar = '█'.repeat(Math.round(hpPct / 10)) + '░'.repeat(10 - Math.round(hpPct / 10));
        rows.push((side === 'A' ? '<span class="k">A</span>' : '<span class="r">B</span>') + ' '
          + e.unit.name.padEnd(6, '　') + ' ' + bar + ' ' + Math.round(e.hp) + '/' + e.maxHp
          + (e.alive ? '' : ' <span class="r">KO</span>')
          + ' 怒气' + Math.round(e.energy)
          + ' 技1:' + e.cds.s1.toFixed(1) + 's 技2:' + e.cds.s2.toFixed(1) + 's'
          + (e.unit.s3 ? ' ' + e.unit.s3.name + ':' + e.cds.s3.toFixed(1) + 's' : ''));
      }
    }
    $('units-hp').innerHTML = rows.join('<br>');
    $('phase-readout').textContent = 'seed=' + S.seed + '  t=' + b.time.toFixed(1) + 's  tick=' + b.tick
      + '  hash=' + b.hash() + '  ' + (b.over ? ('结束: ' + (b.mode === 'brawl' ? (S.match.report().champion || '平局') : b.result) + ' (' + b.endReason + ')') : '进行中');
    let totalA = 0, totalB = 0;
    b.A.forEach((e) => { if (e.alive) totalA += e.hp; });
    b.B.forEach((e) => { if (e.alive) totalB += e.hp; });
    $('stats').innerHTML = '存活 <span class="k">左 ' + b.aliveCount('A') + '</span> : '
      + '<span class="r">右 ' + b.aliveCount('B') + '</span>'
      + '　总血量 左 ' + Math.round(totalA) + ' / 右 ' + Math.round(totalB)
      + '<br>投射物 ' + b.projectiles.length + '　区域 ' + b.zones.length
      + '　连击峰值 ' + b.stats.maxCombo + '　关键施法 ' + b.stats.casts.length;
  }

  // ---------- 批量测试 ----------
  function batchLog(txt, cls) {
    const el = $('batlog');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = txt;
    el.appendChild(d);
    while (el.childNodes.length > 800) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function runBatch() {
    if (S.batch && S.batch.running) return;
    const n1 = parseInt($('n1').value, 10) || 0;
    const n6 = parseInt($('n6').value, 10) || 0;
    const jobs = [];
    for (let i = 0; i < n1; i++) jobs.push(1);
    for (let i = 0; i < n6; i++) jobs.push(6);
    if (!jobs.length) return;

    const pool = CC.fighters.units.map((u) => u.id);
    const R = CC.util.RNG(20261019);
    const mk = (n) => {
      const o = [];
      for (let i = 0; i < n; i++) o.push({ id: pool[R.int(0, pool.length - 1)], slot: i, lane: i % 2 });
      return o;
    };

    S.batch = {
      running: true, total: jobs.length, done: 0, t0: Date.now(), n1: n1,
      notOver: 0, badHp: 0, nan: 0, maxT: 0, sumT: 0, buckets: [0, 0, 0, 0, 0],
      wins: {}, draws: 0, hashMismatch: 0, slice: 0,
    };
    $('batlog').innerHTML = '';
    batchLog('开始批测: 1v1 × ' + n1 + ' + 6v6 × ' + n6 + ' = ' + jobs.length + ' 场', 'k');
    setTimeout(stepBatch, 20);
  }

  function stepBatch() {
    const B = S.batch;
    if (!B || !B.running) return;
    const t0 = performance.now();
    while (performance.now() - t0 < 60 && B.done < B.total) {
      const n = B.done < B.n1 ? 1 : 6;
      const A = mkLineupRand(n), C = mkLineupRand(n);
      const seed = 30000 + B.done;
      const m = CC.battle.createMatch({ seed, lineup: { A, B: C } });
      let g = 0;
      const CAP = 60 * 300;
      while (!m.battle.over && g++ < CAP) m.battle.step();
      const b = m.battle;
      B.done++;
      B.sumT += b.time;
      if (b.time > B.maxT) B.maxT = b.time;
      if (!b.over) B.notOver++;
      if (b.result === 'draw') B.draws++;
      const t = b.time;
      if (t < 20) B.buckets[0]++; else if (t < 40) B.buckets[1]++; else if (t < 60) B.buckets[2]++; else if (t < 120) B.buckets[3]++; else B.buckets[4]++;
      for (const e of b.A.concat(b.B)) {
        if (!(e.hp >= 0 && e.hp <= e.maxHp)) { B.badHp++; break; }
        if (!Number.isFinite(e.hp) || !Number.isFinite(e.x)) { B.nan++; break; }
      }
      const label = '#' + B.done + ' ' + n + 'v' + n + ' seed=' + seed
        + '  左[' + A.map((x) => x.id).join(',') + ']'
        + '  vs 右[' + C.map((x) => x.id).join(',') + ']'
        + '  → ' + (b.result === 'draw' ? '平局' : '右胜') + '  ' + b.time.toFixed(1) + 's'
        + (b.over ? '' : '  【未收敛!】');
      batchLog(label, !b.over ? 'r' : (b.result === 'A' ? 'g' : 'y'));
    }
    const pct = (B.done / B.total * 100).toFixed(0);
    $('batch-progress').textContent = pct + '%  ' + B.done + '/' + B.total
      + '  未收敛 ' + B.notOver + '  HP异常 ' + B.badHp + '  NaN ' + B.nan
      + '  平均 ' + (B.sumT / Math.max(1, B.done)).toFixed(1) + 's  最长 ' + B.maxT.toFixed(1) + 's';
    if (B.done >= B.total) {
      B.running = false;
      batchLog('—— 完成 ——', 'k');
      batchLog('场次 ' + B.total + '　未收敛 ' + B.notOver + '　平局 ' + B.draws + '　HP异常 ' + B.badHp + '　NaN ' + B.nan, B.notOver || B.badHp || B.nan ? 'r' : 'g');
      batchLog('时长分布  <20s:' + B.buckets[0] + '  20-40s:' + B.buckets[1] + '  40-60s:' + B.buckets[2]
        + '  60-120s:' + B.buckets[3] + '  >120s:' + B.buckets[4], 'd');
      batchLog('平均时长 ' + (B.sumT / B.total).toFixed(1) + 's　最长 ' + B.maxT.toFixed(1) + 's'
        + '　总耗时 ' + ((Date.now() - B.t0) / 1000).toFixed(1) + 's', 'd');
      return;
    }
    setTimeout(stepBatch, 0);
  }

  let _pool = null;
  function mkLineupRand(n) {
    if (!_pool) _pool = CC.fighters.units.map((u) => u.id);
    const o = [];
    for (let i = 0; i < n; i++) o.push({ id: _pool[Math.floor(Math.random() * _pool.length)], slot: i, lane: i % 2 });
    return o;
  }

  // ---------- 绑定 ----------
  $('battle-mode').onchange = () => { S.mode = $('battle-mode').value; startMatch(S.seed); };
  $('btn-play').onclick = () => {
    S.playing = !S.playing;
    $('btn-play').textContent = S.playing ? '暂停' : '继续';
    $('btn-play').classList.toggle('on', !S.playing);
    if (S.match) { if (S.playing) S.match.resume(); else S.match.pause(); }
  };
  $('btn-step').onclick = () => { S.playing = false; $('btn-play').textContent = '继续'; S.stepOnce = 1; };
  $('btn-step1s').onclick = () => { S.playing = false; $('btn-play').textContent = '继续'; S.stepOnce = 60; };
  document.querySelectorAll('.spd').forEach((b) => {
    b.onclick = () => {
      S.speed = parseFloat(b.dataset.spd);
      document.querySelectorAll('.spd').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  document.querySelectorAll('.spd')[0].classList.add('on');
  $('btn-restart').onclick = () => startMatch(S.seed);
  $('btn-autonext').onclick = () => {
    S.autoNext = !S.autoNext;
    $('btn-autonext').classList.toggle('on', S.autoNext);
  };
  $('seed').onchange = () => { startMatch(parseInt($('seed').value, 10) || 1); };
  $('btn-rand').onclick = () => {
    S.selA.length = 0; S.selB.length = 0;
    buildUnitPicker($('units-a'), S.selA, $('cnt-a'));
    buildUnitPicker($('units-b'), S.selB, $('cnt-b'));
    $('cnt-a').textContent = '0'; $('cnt-b').textContent = '0';
    startMatch();
  };
  $('btn-batch').onclick = runBatch;
  $('btn-batch-stop').onclick = () => { if (S.batch) { S.batch.running = false; batchLog('已手动停止', 'r'); } };

  // ---------- 启动 ----------
  function boot() {
    const q = new URLSearchParams(location.search);
    const shotMode = q.get('shot') === '1';
    const t = parseFloat(q.get('t') || '8');

    if (CC.assets && typeof CC.assets.load === 'function') {
      try { CC.assets.load(); } catch (e) { /* 资源缺失也继续 */ }
    }
    if (CC.render && typeof CC.render.init === 'function') {
      try { CC.render.init(canvas); } catch (e) { logLine('render.init 异常: ' + e.message, 'r'); }
    }
    S.mode = q.get('battle') === 'brawl' ? 'brawl' : 'team';
    $('battle-mode').value = S.mode;
    if (q.get('seed')) { S.seed = parseInt(q.get('seed'), 10) || S.seed; }
    for (const [key, selected, host, counter] of [['a', S.selA, 'units-a', 'cnt-a'], ['b', S.selB, 'units-b', 'cnt-b']]) {
      if (!q.has(key)) continue;
      const ids = q.get(key).split(',').filter((id) => !!CC.fighters.get(id)).slice(0, 6);
      selected.splice(0, selected.length, ...ids);
      buildUnitPicker($(host), selected, $(counter));
      $(counter).textContent = selected.length;
    }
    startMatch(S.seed);
    $('seed').value = S.seed;
    logLine('提示：左侧实时战斗，右侧事件流；「批量测试」会逐场滚动打印结果。', 'd');

    if (shotMode) {
      // 截图模式：等贴图就绪 → 同步推进到 t 秒 → 画一帧就停（避免 rAF 无限循环卡住无头浏览器）
      const runShot = () => {
        const ticks = Math.round(t * 60);
        for (let i = 0; i < ticks && !S.match.battle.over; i++) S.match.battle.step();
        const b = S.match.battle;
        logEvents(b);
        updateStats(b);
        renderCanvas();
        document.title = 'READY t=' + b.time.toFixed(1) + ' hash=' + b.hash();
        window.__CC_SHOT_READY__ = true;
      };
      // presentation 提醒：load() 是异步的，不等贴图就会把单位画成占位块
      const ready = CC.assets && typeof CC.assets.whenReady === 'function' ? CC.assets.whenReady() : null;
      if (ready && typeof ready.then === 'function') ready.then(runShot, runShot);
      else runShot();
      return;
    }
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 0);
  else window.addEventListener('DOMContentLoaded', boot);
})();
