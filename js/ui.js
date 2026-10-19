/* ===========================================================
   赛博斗蛐蛐 · 界面层（ui）—— 上帝视角（左方 / 右方，不站边）
   契约：CC.ui.init(handlers) / renderBench(list) / showReport(report)
        hideReport() / setPhase(text) / setPaused(bool) / setStatus(text)
   全部 DOM 访问判空；无 document 时只记录状态（无头自测用 CC.ui.state 断言）
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});

  const els = {};
  let handlers = {};
  let benchSig = '';
  let mounted = false;

  const SIDE_LABEL = { A: '左方', B: '右方' };

  const state = {
    phase: '',
    status: '',
    paused: false,
    side: 'A',
    report: null,
    errors: [],
    stats: {
      aliveA: 0, aliveB: 0, time: '0:00', countdown: 0, bench: 0, pool: 0,
      placingHint: '', level: 1, round: 0, sizes: { A: 6, B: 6 },
    },
    benchIds: [],
    notice: '',
  };

  function doc() {
    return (typeof document !== 'undefined' && document) ? document : null;
  }
  function byId(id) {
    const d = doc();
    if (!d || typeof d.getElementById !== 'function') return null;
    try { return d.getElementById(id); } catch (e) { return null; }
  }
  function setText(el, text) {
    if (!el) return;
    const v = String(text == null ? '' : text);
    if (el.textContent !== v) {
      try { el.textContent = v; } catch (e) { /* ignore */ }
    }
  }
  function show(el, on) {
    if (!el) return;
    const list = el.classList;
    if (list && typeof list.toggle === 'function') {
      try { list.toggle('hidden', !on); return; } catch (e) { /* fallthrough */ }
    }
    try { el.style.display = on ? '' : 'none'; } catch (e) { /* ignore */ }
  }
  function el(tag, cls, text) {
    const d = doc();
    if (!d || typeof d.createElement !== 'function') return null;
    const node = d.createElement(tag);
    if (cls && node.className !== undefined) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function clear(node) {
    if (!node) return;
    if (typeof node.replaceChildren === 'function') { try { node.replaceChildren(); return; } catch (e) { /* fallthrough */ } }
    try { node.innerHTML = ''; } catch (e) { /* ignore */ }
    if (Array.isArray(node.children)) node.children.length = 0;
  }
  function append(parent, child) {
    if (!parent || !child) return;
    if (typeof parent.appendChild === 'function') { try { parent.appendChild(child); return; } catch (e) { /* fallthrough */ } }
    if (Array.isArray(parent.children)) parent.children.push(child);
  }
  function mmss(sec) {
    const U = CC.util;
    if (U && typeof U.mmss === 'function') return U.mmss(sec);
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function unitName(id) {
    const F = CC.fighters;
    const u = (F && typeof F.get === 'function') ? F.get(id) : null;
    return (u && (u.name || u.title)) || (id ? String(id) : '—');
  }
  function sideOf(id) {
    const m = CC.main && CC.main.state ? CC.main.state.match : null;
    const lu = m && m.lineup;
    if (!lu) return '';
    const inA = (lu.A || []).some((e) => e && e.id === id);
    const inB = (lu.B || []).some((e) => e && e.id === id);
    if (inA && inB) return '左右·';
    if (inA) return '左·';
    if (inB) return '右·';
    return '';
  }

  // ---------- 贴图缩略图（缺失一律降级成渐变块 + 名字首字） ----------
  function thumbFor(unit) {
    const box = el('div', 'cc-thumb');
    if (!box) return null;
    const pal = (unit && unit.palette) || ['#7fe3ff', '#12232e'];
    try {
      if (box.style) box.style.background = 'linear-gradient(160deg,' + pal[0] + ',' + pal[1] + ')';
    } catch (e) { /* ignore */ }
    let src = '';
    const key = (unit && unit.texture && unit.texture.key) || (unit && unit.id) || '';
    const A = CC.assets;
    if (A && typeof A.texture === 'function' && key) {
      try {
        const tex = A.texture(key);
        if (tex) src = tex.src || tex.currentSrc || '';
      } catch (e) { /* ignore */ }
    }
    if (!src && A && typeof A.textureInfo === 'function' && key) {
      try {
        const info = A.textureInfo(key);
        if (info && info.usedPath) src = info.usedPath;
      } catch (e) { /* ignore */ }
    }
    if (src) {
      const img = el('img', 'cc-thumb-img');
      if (img) {
        try { img.src = src; img.alt = (unit && unit.name) || ''; } catch (e) { /* ignore */ }
        append(box, img);
        return box;
      }
    }
    append(box, el('span', 'cc-thumb-ch', ((unit && unit.name) || key || '?').slice(0, 1)));
    return box;
  }

  // ---------- 单位池卡片 ----------
  function normalize(list) {
    const F = CC.fighters;
    const out = [];
    const src = Array.isArray(list) ? list : [];
    src.forEach((it) => {
      if (!it) return;
      const id = (typeof it === 'string') ? it : it.id;
      if (!id) return;
      let unit = null;
      if (F && typeof F.get === 'function') unit = F.get(id);
      if (!unit && typeof it === 'object') unit = it;
      out.push({
        id: id,
        unit: unit || { id: id, name: String(id), title: '', role: '', pos: 'front', palette: ['#7fe3ff', '#12232e'], texture: { key: id } },
      });
    });
    return out;
  }

  function cardFor(entry) {
    const unit = entry.unit;
    const card = el('div', 'cc-card');
    if (!card) return null;
    card.setAttribute('draggable', 'true');
    if (card.dataset) card.dataset.unitId = entry.id;
    card.setAttribute('data-unit', entry.id);
    card.setAttribute('tabindex', '-1');
    card.setAttribute('title', (unit.name || entry.id) + ' · ' + (unit.title || '') + ' · ' +
      (unit.pos === 'back' ? '建议后排' : '建议前排') + '\n' +
      ['s1', 's2', 's3', 'ult'].filter((key) => unit[key]).map((key) => unit[key].name + '：' + unit[key].desc).join('\n'));

    append(card, thumbFor(unit));
    append(card, el('div', 'cc-name', unit.name || entry.id));
    append(card, el('div', 'cc-meta', (unit.title || unit.role || '')));
    append(card, el('div', 'cc-pos' + (unit.pos === 'back' ? ' back' : ' front'),
      unit.pos === 'back' ? '后排' : '前排'));
    return card;
  }

  function renderBench(list, force) {
    const rows = normalize(list);
    state.benchIds = rows.map((r) => r.id);
    const sig = state.side + '|' + rows.map((r) => r.id).join(',');
    const host = els.benchList;
    if (!host || typeof host.appendChild !== 'function') { benchSig = sig; return state.benchIds; }
    if (!force && sig === benchSig && host.__ccSig === sig) return state.benchIds;
    clear(host);
    rows.forEach((entry) => append(host, cardFor(entry)));
    try { host.__ccSig = sig; } catch (e) { /* ignore */ }
    benchSig = sig;
    return state.benchIds;
  }

  // ---------- 战报 ----------
  function reasonText(reason) {
    if (reason === 'last-standing') return '最后存活者';
    if (reason === 'wipe') return '一方全灭';
    if (reason === 'double-ko') return '同归于尽';
    return reason ? String(reason) : '';
  }

  function reportRows(report) {
    const rep = report || {};
    const rows = [];
    const total = Math.max(1, Math.round(Number(rep.totalUnits) || 6));
    const sideTotal = (side) => {
      const value = rep.totalUnitsBySide && rep.totalUnitsBySide[side];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : total;
    };
    const surv = Math.max(0, Math.round(Number(rep.survivors) || 0));
    const leftAlive = rep.winner === 'A' ? surv : 0;
    const rightAlive = rep.winner === 'B' ? surv : 0;
    if (rep.mode === 'brawl') rows.push(['乱斗结果', rep.champion || '同归于尽']);
    else rows.push(['存活', '左 ' + leftAlive + ' / ' + sideTotal('A') + '　右 ' + rightAlive + ' / ' + sideTotal('B')]);

    const dmg = rep.dmgByUnit || {};
    const ids = Object.keys(dmg).sort((a, b) => (Number(dmg[b]) || 0) - (Number(dmg[a]) || 0));
    const top = ids.slice(0, 4);
    if (top.length) {
      rows.push(['伤害分布', top.map((id) => sideOf(id) + unitName(id) + ' ' + Math.round(Number(dmg[id]) || 0)).join(' / ')]);
    }
    const kills = rep.killsByUnit || {};
    const known = (id) => {
      const F = CC.fighters;
      return !!(F && typeof F.get === 'function' && F.get(id));
    };
    const kIds = Object.keys(kills)
      .filter((k) => (Number(kills[k]) || 0) > 0 && known(k))
      .sort((a, b) => (Number(kills[b]) || 0) - (Number(kills[a]) || 0));
    if (kIds.length) {
      rows.push(['击杀', kIds.map((id) => sideOf(id) + unitName(id) + '×' + (Number(kills[id]) || 0)).join(' / ')]);
    }
    if (rep.mvp) {
      rows.push(['最高伤害', sideOf(rep.mvp) + unitName(rep.mvp) +
        (Number(rep.mvpDmg) > 0 ? '（' + Math.round(Number(rep.mvpDmg)) + '）' : '')]);
    }
    rows.push(['最长连击', String(Math.round(Number(rep.maxCombo) || 0))]);
    const picked = rep.picked || {};
    const pKeys = Object.keys(picked).filter((k) => (Number(picked[k]) || 0) > 0);
    if (pKeys.length) {
      const totalPicked = pKeys.reduce((s, k) => s + (Number(picked[k]) || 0), 0);
      rows.push(['拾取', totalPicked + ' 次（' +
        pKeys.slice(0, 3).map((k) => unitName(k) + '×' + (Number(picked[k]) || 0)).join(' / ') + '）']);
    }
    if (rep.grade) rows.push(['战况评分', String(rep.grade)]);
    return rows;
  }

  function winnerLabelOf(rep) {
    if (rep && rep.winnerLabel) return String(rep.winnerLabel);
    if (rep && rep.winner === 'A') return '左方';
    if (rep && rep.winner === 'B') return '右方';
    return '双方同归于尽';
  }

  function showReport(report) {
    state.report = report || null;
    const rep = report || {};
    const winner = rep.winner === 'A' || rep.winner === 'B' ? rep.winner : null;
    const panel = els.report;
    // 只说哪一边赢了：左方胜 / 右方胜 / 双方同归于尽
    setText(els.repTitle, winnerLabelOf(rep) + (rep.mode === 'brawl' && rep.champion ? ' · 乱斗冠军' : winner ? ' 胜' : ''));
    if (els.repTitle && els.repTitle.classList) {
      try {
        els.repTitle.classList.toggle('win', winner === 'A');
        els.repTitle.classList.toggle('lose', winner === 'B');
      } catch (e) { /* ignore */ }
    }
    const used = rep.seconds || mmss(Number(rep.duration) || 0);
    const reason = reasonText(rep.reason);
    setText(els.repSub, (state.stats.round ? ('第 ' + state.stats.round + ' 场 · ') : '') +
      '对局等级 ' + (Number(state.stats.level) || 1).toFixed(1) +
      ' · 用时 ' + used + (reason ? ' · ' + reason : ''));
    const lines = els.repLines;
    if (lines) {
      clear(lines);
      reportRows(rep).forEach((pair) => {
        const row = el('div', 'cc-rep-row');
        if (!row) return;
        append(row, el('span', 'k', pair[0]));
        append(row, el('span', 'v', pair[1]));
        append(lines, row);
      });
    }
    syncReportActions();
    show(panel, true);
    scrollReportHeading();
    return state.report;
  }

  function syncReportActions() {
    const M = CC.main;
    const canControl = !CC.access || !!(CC.access.caps && CC.access.caps.place);
    const automatic = M && typeof M.reportAutoAdvances === 'function' ? M.reportAutoAdvances()
      : !!(M && M.state && M.state.autoStart) || !canControl;
    setText(els.repFoot, automatic ? '3 秒后自动重开一场（沿用当前布阵）'
      : '战报会保留，查看完可返回布阵或再来一局。');
    show(els.reportActions, canControl && !!state.report);
    if (els.reportBack) els.reportBack.disabled = !canControl || !state.report;
    if (els.reportRematch) els.reportRematch.disabled = !canControl || !state.report;
    return { automatic, canControl };
  }

  function scrollReportHeading() {
    const M = CC.main, s = M && M.state;
    if (!s || s.autoStart || (CC.access && !(CC.access.caps && CC.access.caps.place))
        || s.shot || s.fastForward || (s.query && s.query.shot)) return;
    const width = Number(globalThis.innerWidth), height = Number(globalThis.innerHeight);
    if (!(width > 0 && height > 0 && (width <= 900 || (width <= 1000 && height <= 520 && width > height)))) return;
    const heading = els.repTitle || els.report;
    if (!heading || typeof heading.scrollIntoView !== 'function') return;
    try {
      const rect = typeof heading.getBoundingClientRect === 'function' ? heading.getBoundingClientRect() : null;
      if (rect && rect.top >= 0 && rect.bottom <= height) return;
      heading.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    } catch (e) { /* older browsers may not support the options object */ }
  }

  function hideReport() {
    show(els.report, false);
    state.report = null;
    syncReportActions();
  }

  // ---------- 状态栏 ----------
  function setPhase(text) {
    state.phase = String(text == null ? '' : text);
    setText(els.phase, state.phase);
    return state.phase;
  }

  function setStatus(text) {
    state.status = String(text == null ? '' : text);
    setText(els.status, state.status);
    return state.status;
  }

  function setSide(s) {
    state.side = String(s || 'A').toUpperCase() === 'B' ? 'B' : 'A';
    setText(els.benchSide, '双方共用 · 可重复部署');
    if (els.sideA && els.sideA.classList) {
      try { els.sideA.classList.toggle('on', state.side === 'A'); } catch (e) { /* ignore */ }
    }
    if (els.sideB && els.sideB.classList) {
      try { els.sideB.classList.toggle('on', state.side === 'B'); } catch (e) { /* ignore */ }
    }
    benchSig = '';     // 换侧后单位池必须重画
    return state.side;
  }

  // 某侧上场人数读数（1~6）
  function setSideSize(s, n) {
    const sd = String(s || 'A').toUpperCase() === 'B' ? 'B' : 'A';
    const v = Math.max(1, Math.min(6, Math.round(Number(n) || 1)));
    state.stats.sizes[sd] = v;
    setText(sd === 'A' ? els.sizeAVal : els.sizeBVal, v);
    return v;
  }

  function setStats(next) {
    const s = next || {};
    if (s.aliveA !== undefined) state.stats.aliveA = Number(s.aliveA) || 0;
    if (s.aliveB !== undefined) state.stats.aliveB = Number(s.aliveB) || 0;
    if (s.time !== undefined) state.stats.time = String(s.time);
    if (s.countdown !== undefined) state.stats.countdown = Number(s.countdown) || 0;
    if (s.bench !== undefined) state.stats.bench = Number(s.bench) || 0;
    if (s.pool !== undefined) state.stats.pool = Number(s.pool) || 0;
    if (s.placingHint !== undefined) state.stats.placingHint = String(s.placingHint);
    if (s.level !== undefined) state.stats.level = Number(s.level) || 1;
    if (s.round !== undefined) state.stats.round = Number(s.round) || 0;
    if (s.sizes !== undefined && s.sizes) {
      if (s.sizes.A !== undefined) setSideSize('A', s.sizes.A);
      if (s.sizes.B !== undefined) setSideSize('B', s.sizes.B);
    }

    setText(els.aliveA, state.stats.aliveA);
    setText(els.aliveB, state.stats.aliveB);
    setText(els.matchTime, state.stats.time);
    setText(els.autostart, state.stats.countdown.toFixed(1));
    setText(els.benchCount, state.stats.bench + '/' + state.stats.pool);
    setText(els.placingHint, state.stats.placingHint);
    show(els.placingHint, !!state.stats.placingHint);
    show(els.autostartWrap, state.stats.countdown > 0);
    return state.stats;
  }

  function setPaused(on) {
    state.paused = !!on;
    show(els.pausedMask, state.paused);
    setText(els.pausedText, state.paused ? '按空格继续' : '');
    setText(els.btnPause, state.paused ? '继续' : '暂停');
    if (els.btnPause && els.btnPause.classList) {
      try { els.btnPause.classList.toggle('on', state.paused); } catch (e) { /* ignore */ }
    }
    return state.paused;
  }

  function notice(text) {
    state.notice = String(text == null ? '' : text);
    setText(els.noticeLine, state.notice);
    show(els.noticeLine, !!state.notice);
    if (state.notice) setStatus(state.notice);
    return state.notice;
  }

  // ---------- 全局错误面板（红屏） ----------
  function showError(message, stack) {
    const msg = String(message == null ? '未知错误' : message);
    const lines = Array.isArray(stack) ? stack : String(stack || '').split('\n');
    const trimmed = lines.slice(0, 6);
    state.errors.push({ message: msg, stack: trimmed.join('\n') });
    setText(els.errMsg, msg);
    const host = els.errStack;
    if (host) {
      clear(host);
      trimmed.forEach((line) => append(host, el('div', 'cc-err-line', line)));
    }
    show(els.errorPanel, true);
    return state.errors[state.errors.length - 1];
  }

  function hideError() {
    show(els.errorPanel, false);
    return true;
  }

  // ---------- 初始化与事件绑定 ----------
  function on(node, type, fn) {
    if (node && typeof node.addEventListener === 'function') {
      try { node.addEventListener(type, fn); return true; } catch (e) { /* ignore */ }
    }
    return false;
  }

  function init(h) {
    handlers = h || {};
    els.app = byId('app');
    els.stage = byId('stage');
    els.phase = byId('phase');
    els.aliveA = byId('alive-a');
    els.aliveB = byId('alive-b');
    els.matchTime = byId('match-time');
    els.autostart = byId('autostart');
    els.autostartWrap = byId('autostart-wrap');
    els.benchCount = byId('bench-count');
    els.status = byId('status');
    els.noticeLine = byId('notice');
    els.btnPause = byId('btn-pause');
    els.btnRestart = byId('btn-restart');
    els.btnMode = byId('btn-mode');
    on(byId('btn-start'), 'click', () => { if (handlers.onStart) handlers.onStart(); });
    on(byId('btn-export'), 'click', () => { if (handlers.onExport) handlers.onExport(); });
    on(byId('auto-start'), 'change', (ev) => { if (handlers.onAutoStart) handlers.onAutoStart(ev.target.checked); });
    const exportPanel = byId('export-controls');
    if (exportPanel && globalThis.__CC_ROLE__ === 'admin') exportPanel.classList.remove('hidden');
    els.bench = byId('bench');
    els.benchList = byId('benchList');
    els.benchSide = byId('bench-side');
    els.placingHint = byId('placing-hint');
    els.sideA = byId('side-A');
    els.sideB = byId('side-B');
    els.sizeAVal = byId('size-A-val');
    els.sizeBVal = byId('size-B-val');
    els.report = byId('report');
    els.repTitle = byId('rep-title');
    els.repSub = byId('rep-sub');
    els.repLines = byId('rep-lines');
    els.repFoot = byId('rep-foot');
    els.reportActions = byId('report-actions');
    els.reportBack = byId('btn-report-back');
    els.reportRematch = byId('btn-report-rematch');
    els.errorPanel = byId('errorPanel');
    els.errMsg = byId('err-msg');
    els.errStack = byId('err-stack');
    els.pausedMask = byId('pausedMask');
    els.pausedText = byId('paused-text');

    on(els.btnPause, 'click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof handlers.onPause === 'function') handlers.onPause();
    });
    on(els.btnRestart, 'click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof handlers.onRestart === 'function') handlers.onRestart();
    });
    on(els.reportBack, 'click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof handlers.onReportBack === 'function') handlers.onReportBack();
    });
    on(els.reportRematch, 'click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof handlers.onReportRematch === 'function') handlers.onReportRematch();
    });
    on(els.btnMode, 'click', () => {
      if (typeof handlers.onMode === 'function') handlers.onMode();
    });
    on(els.sideA, 'click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof handlers.onSide === 'function') handlers.onSide('A');
    });
    on(els.sideB, 'click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof handlers.onSide === 'function') handlers.onSide('B');
    });
    [['A', 'size-A-minus', -1], ['A', 'size-A-plus', +1],
      ['B', 'size-B-minus', -1], ['B', 'size-B-plus', +1]].forEach((cfg) => {
      const node = byId(cfg[1]);
      on(node, 'click', (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof handlers.onSize === 'function') handlers.onSize(cfg[0], cfg[2]);
      });
    });
    on(els.benchList, 'click', (ev) => {
      const id = cardIdFromEvent(ev);
      if (!id) return;
      if (typeof handlers.onPickBench === 'function') handlers.onPickBench(id);
    });

    show(els.report, false);
    show(els.errorPanel, false);
    show(els.pausedMask, false);
    show(els.noticeLine, false);
    mounted = true;
    setPaused(false);
    setSide('A');
    setSideSize('A', 6);
    setSideSize('B', 6);
    setStats({});
    return CC.ui;
  }

  function cardIdFromEvent(ev) {
    let node = ev && (ev.target || ev.srcElement);
    let guard = 0;
    while (node && guard++ < 6) {
      if (node.dataset && node.dataset.unitId) return node.dataset.unitId;
      if (typeof node.getAttribute === 'function') {
        const a = node.getAttribute('data-unit');
        if (a) return a;
      }
      node = node.parentNode || node.parentElement || null;
    }
    return null;
  }

  CC.ui = {
    init, renderBench, showReport, hideReport, syncReportActions,
    setPhase, setStatus, setPaused, setStats, setSide, setSideSize, notice,
    showError, hideError,
    els, state, cardIdFromEvent, SIDE_LABEL,
    isMounted: () => mounted,
    handlers: () => handlers,
  };
})();
