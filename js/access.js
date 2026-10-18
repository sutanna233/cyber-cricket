/* ===========================================================
   赛博斗蛐蛐 · 访问权限闸门（access）
   -----------------------------------------------------------
   给"部署到公网只让别人看"用的最小权限层：
     view  只看（默认给公网访客）：布阵 / 人数 / 重开 / 暂停全部禁用，自动随机开打并自动连场
     pause 只看 + 暂停继续（适合直播/演示）
     play  完整操作（布阵 / 人数 / 暂停 / 重开）—— 仅本机，或带对了 key

   判定顺序：
     1) URL 参数 ?mode=view|pause|play
     2) 服务端注入的 window.__CC_MODE__（server.js --mode 指定）
     3) 本机（localhost/127.0.0.1/file://）→ play，其它一律 view

   play 在非本机需要授权：server.js 启动时带 --access-key XXX，
   访客用 ?mode=play&key=XXX 才能拿到完整操作。
   =========================================================== */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});
  const q = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(''); } })();

  const host = (() => { try { return location.hostname || ''; } catch (e) { return ''; } })();
  const isLocal = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host === '[::1]' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  const isFile = (() => { try { return location.protocol === 'file:'; } catch (e) { return false; } })();

  const injected = globalThis.__CC_MODE__ || '';
  const serverRole = globalThis.__CC_ROLE__ || '';   // 'admin' | 'user' | 'view'（server.js 按登录态注入）
  const registerEnabled = globalThis.__CC_REGISTER__ !== false;
  const syncEnabled = globalThis.__CC_SYNC__ === true;
  const needKey = globalThis.__CC_ACCESS_KEY__ || '';
  const urlKey = q.get('key') || '';

  const signedIn = serverRole === 'admin' || serverRole === 'user';
  let mode;
  if (signedIn) {
    mode = 'play';                                   // 登录用户 / 管理员 → 完整操作
  } else if (q.get('mode')) {
    mode = q.get('mode');
  } else if (injected) {
    mode = injected;
  } else {
    mode = (isLocal || isFile) ? 'play' : 'view';
  }
  if (['view', 'pause', 'play'].indexOf(mode) < 0) mode = 'view';
  let downgraded = null;
  if (mode === 'play' && !isLocal && !isFile && !signedIn) {
    if (!needKey || urlKey !== needKey) { mode = 'view'; downgraded = 'play-needs-auth'; }
  }

  const caps = {
    place: mode === 'play',      // 布阵（拖放/点击放置）
    size: mode === 'play',       // 每侧上场人数
    restart: mode === 'play',    // 重新开始
    pause: mode === 'play' || mode === 'pause',
    speed: false,
  };

  // ---------- 默认演示阵容：凑企鹅 大战 许家印（1v1）----------
  // 只在"场地空着 + 还在布阵阶段"时预置；玩家自己摆过就不动。
  // 可用 ?demo=tomori,xujiayin 换人，?demo=off 关闭。
  const DEMO = (() => {
    const raw = q.get('demo');
    if (raw === 'off' || raw === '0' || raw === 'none') return null;
    if (raw) {
      const parts = raw.split(/[,:]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) return { A: parts[0], B: parts[1] };
    }
    return { A: 'tomori', B: 'xujiayin' };
  })();

  let demoApplied = false;
  function isDemo(lu) {
    if (!DEMO) return false;
    const a = (lu.A && lu.A[0]) ? lu.A[0].id : null;
    const b = (lu.B && lu.B[0]) ? lu.B[0].id : null;
    return lu.A && lu.B && lu.A.length === 1 && lu.B.length === 1 && a === DEMO.A && b === DEMO.B;
  }

  function applyDemoLineup(force) {
    try {
      if (!DEMO || !CC.board || !CC.main) return false;
      const st = CC.main.state;
      if (!st) return false;
      if (st.phase && st.phase !== 'placing') return false;   // 只有摆阵阶段才动阵容
      const lu = CC.board.lineup();
      if (isDemo(lu)) { demoApplied = true; return true; }
      // 观战/限权模式下场上一定是"自动随机满编"，可以直接换掉；
      // 完整操作模式下只有在空场时才预置，避免覆盖用户自己的摆阵
      const canReplace = (mode !== 'play') || !(lu.A.length + lu.B.length);
      if (!canReplace && !force) return false;
      if (typeof CC.board.clear === 'function') CC.board.clear();
      if (typeof CC.board.setSize === 'function') {
        CC.board.setSize('A', 1);
        CC.board.setSize('B', 1);
      }
      const okA = CC.board.place(DEMO.A, 0);      // 左方第一槽
      const okB = CC.board.place(DEMO.B, 6);      // 右方第一槽（全局索引从 6 起）
      demoApplied = !!(okA || okB);
      return demoApplied;
    } catch (e) { return false; }
  }

  /** 摆阵阶段持续盯着：被自动满编了就换回演示阵容（每 400ms 检查，最多 60 秒） */
  function watchDemo() {
    if (!DEMO) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (n > 150) { clearInterval(t); return; }
      if (applyDemoLineup()) { /* 已生效 */ }
    }, 400);
  }

  function injectStyle() {
    if (document.getElementById('cc-access-style')) return;
    const css = [
      // 只看模式：布阵面板 / 人数控件 / 重新开始 / 暂停 全部隐藏
      'body.cc-mode-view #bench, body.cc-mode-view .cc-bench, body.cc-mode-view #bench-panel, body.cc-mode-view .bench-panel { display:none !important; }',
      'body.cc-mode-view .cc-size, body.cc-mode-view #size-controls, body.cc-mode-view .size-controls { display:none !important; }',
      'body.cc-mode-view #btn-restart, body.cc-mode-view .restart-btn { display:none !important; }',
      'body.cc-mode-view #btn-pause, body.cc-mode-view .pause-btn { display:none !important; }',
      'body.cc-mode-view #status { display:none !important; }',
      // 可暂停模式：只留暂停
      'body.cc-mode-pause #bench, body.cc-mode-pause .cc-bench, body.cc-mode-pause .cc-size, body.cc-mode-pause #btn-restart { display:none !important; }',
      '#cc-access-badge{position:fixed;right:8px;bottom:6px;z-index:99;font:11px/1.5 Consolas,monospace;color:#7fe3ff;opacity:.72}',
      '#cc-access-badge a{color:#7fe3ff}',
    ].join('\n');
    const st = document.createElement('style');
    st.id = 'cc-access-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function badge() {
    const old = document.getElementById('cc-access-badge');
    if (old) old.remove();
    const d = document.createElement('div');
    d.id = 'cc-access-badge';
    const who = serverRole === 'admin' ? '管理员' : serverRole === 'user' ? '已登录' : '游客';
    d.innerHTML = '模式 ' + mode + (caps.place ? '（可布阵）' : caps.pause ? '（可暂停）' : '（仅观看）')
      + ' · ' + who
      + ' · <a id="cc-account-link" href="/account.html">' + (serverRole === 'admin' ? '用户管理' : serverRole === 'user' ? '我的账号' : (registerEnabled ? '登录 / 注册' : '登录')) + '</a>';
    document.body.appendChild(d);

    // 登录后把用户名显示出来（顺带确认会话真的有效）
    if (serverRole === 'admin' || serverRole === 'user') {
      fetch('/api/session', { credentials: 'same-origin' })
        .then((r) => r.json())
        .then((s) => {
          if (s && s.user) {
            d.innerHTML = '模式 ' + mode + '（可布阵） · ' + s.user.name
              + '（' + (s.role === 'admin' ? '管理员' : '用户') + '）'
              + ' · <a href="/account.html">' + (s.role === 'admin' ? '用户管理' : '我的账号') + '</a>';
          }
        })
        .catch(() => {});
    }
  }

  /** 把被禁用的写操作原地包一层（不替换模块对象，避免破坏主程序持有的引用） */
  function harden() {
    try {
      const B = CC.board;
      const M = CC.main;
      if (!B && !M) return false;

      if (B && !B.__ccGuarded) {
        const wrap = (name, allowed) => {
          if (typeof B[name] !== 'function') return;
          const orig = B[name];
          B[name] = function () {
            if (!allowed) return false;
            return orig.apply(B, arguments);
          };
        };
        wrap('place', caps.place);
        wrap('remove', caps.place);
        wrap('clear', caps.place);
        wrap('setSize', caps.size);
        wrap('noteActivity', caps.place);
        B.__ccGuarded = true;
      }

      if (M && !M.__ccGuarded) {
        const wrapM = (name, allowed) => {
          if (typeof M[name] !== 'function') return;
          const orig = M[name];
          M[name] = function () {
            if (!allowed) return false;
            return orig.apply(M, arguments);
          };
        };
        wrapM('restart', caps.restart);
        wrapM('setPaused', caps.pause);
        wrapM('togglePause', caps.pause);
        M.__ccGuarded = true;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function applyDom() {
    try {
      document.body.classList.add('cc-mode-' + mode);
      injectStyle();
      badge();
      // 兜底：把常见的控件 id/类直接隐藏（不同版本命名可能有差异）
      if (!caps.place) {
        document.querySelectorAll('#bench,.cc-bench,#bench-panel,.unit-pool,.bench-panel').forEach((el) => { el.style.display = 'none'; });
      }
      if (!caps.restart) {
        document.querySelectorAll('#btn-restart,#restart-btn,.restart-btn,#btnRestart').forEach((el) => { el.style.display = 'none'; });
      }
      if (!caps.pause) {
        document.querySelectorAll('#btn-pause,#pause-btn,.pause-btn,#btnPause').forEach((el) => { el.style.display = 'none'; });
      }
      if (!caps.size) {
        document.querySelectorAll('.cc-size,#size-controls,.size-controls,.side-size').forEach((el) => { el.style.display = 'none'; });
      }
      if (!caps.place) {
        // 操作提示在只看/限权模式下是误导信息，一并隐藏
        document.querySelectorAll('#status,.cc-status').forEach((el) => { el.style.display = 'none'; });
      }
    } catch (e) { /* DOM 未就绪时忽略 */ }
  }

  function install() {
    applyDemoLineup();      // 先预置演示阵容（此时 place 还没被锁）
    const ok = harden();    // 再上锁，保证游客改不动
    applyDom();
    return ok;
  }
  CC.access = {
    mode, caps, isLocal, downgraded, needKeyConfigured: !!needKey,
    demo: DEMO,
    harden: install,
    applyDemoLineup,
    /** 给测试用的纯函数版判定 */
    resolveMode: function (opts) {
      const o = opts || {};
      let m = o.urlMode || o.injected || ((o.isLocal || o.isFile) ? 'play' : 'view');
      if (['view', 'pause', 'play'].indexOf(m) < 0) m = 'view';
      if (m === 'play' && !(o.isLocal || o.isFile)) {
        if (!o.needKey || o.urlKey !== o.needKey) m = 'view';
      }
      return m;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
  // 主程序 boot 是异步的，稍后再拧一次保险
  setTimeout(install, 300);
  setTimeout(install, 1500);
})();
