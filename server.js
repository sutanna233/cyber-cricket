// 赛博斗蛐蛐 · 静态服务器 + 账号系统（开发/生产两用）
// ==================================================================
// 角色与权限：
//   游客（未登录）   只能看：自动随机开打、自动连场
//   注册用户（登录） 可以自己布阵玩自己那一局（各自独立，互不影响）
//   管理员           额外可以管理用户（查看/封禁/删除）
//
// 本地开发（本机免登录直接是管理员）：
//     node server.js
// 公网部署：
//     node server.js --host 0.0.0.0 --mode view \
//         --admin-user admin --admin-pass '你的强密码' --secret "$(openssl rand -hex 24)"
// 账号页： /account.html     管理员用户页： /account.html#admin
//
// 参数（也可用同名环境变量）：
//   --port N              端口，默认 8130（占用自动 +1）        [PORT]
//   --host H              绑定地址，默认 127.0.0.1              [HOST]
//   --mode view|pause|play 游客默认权限，默认 view              [CC_MODE]
//   --admin-user NAME     管理员用户名，默认 admin              [CC_ADMIN_USER]
//   --admin-pass PASS     管理员密码；不设则没有管理员账号       [CC_ADMIN_PASS]
//   --secret STR          Cookie 签名密钥；不设则每次启动随机    [CC_SECRET]
//   --session-days N      登录有效期，默认 7                    [CC_SESSION_DAYS]
//   --no-register         关闭注册（只保留已存在的账号）
//   --sync                开启"全员同步观战"（默认关：各自玩各自的）
//   --data-dir PATH       用户数据目录，默认 ./data             [CC_DATA_DIR]
//   --quiet               不打访问日志
//
// 说明：游戏是纯前端模拟，登录决定"谁拿到操作面板"；
//       服务端只存账号，不存对局（每个人的对局都在自己浏览器里）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const root = __dirname;

// 本地账号配置不进入版本控制；显式环境变量优先。
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.indexOf('--' + n) >= 0;

const startPort = Number(arg('port', process.env.PORT || 8130));
const HOST = arg('host', process.env.HOST || '127.0.0.1');
const DEFAULT_MODE = (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1') ? 'play' : 'view';
const PUBLIC_MODE = arg('mode', process.env.CC_MODE || DEFAULT_MODE);
const ADMIN_USER = arg('admin-user', process.env.CC_ADMIN_USER || 'admin');
const ADMIN_PASS = arg('admin-pass', process.env.CC_ADMIN_PASS || '');
const SECRET = arg('secret', process.env.CC_SECRET || crypto.randomBytes(24).toString('hex'));
const SESSION_DAYS = Number(arg('session-days', process.env.CC_SESSION_DAYS || 7));
const ALLOW_REGISTER = !has('no-register') && process.env.CC_NO_REGISTER !== '1';
const QUIET = has('quiet');

const users = require('./lib/users');

const COOKIE = 'cc_session';

const MIME = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  ico: 'image/x-icon', svg: 'image/svg+xml', map: 'application/json; charset=utf-8',
};
const TEXTY = new Set(['html', 'css', 'js', 'json', 'md', 'txt', 'svg', 'map']);

// ---------------- 会话（无状态 HMAC 签名 token） ----------------
function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'); }

function makeToken(user) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const payload = Buffer.from(JSON.stringify({ uid: user.id, n: user.name, r: user.role, exp })).toString('base64url');
  return payload + '.' + sign(payload);
}

function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = sign(payload);
  if (!sig || sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) { return null; }
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

/** 返回 'admin' | 'user' | 'view' —— 每次请求都回查用户库，保证封禁立即生效 */
function roleOf(req) {
  const data = verifyToken(parseCookies(req)[COOKIE]);
  if (!data) return 'view';
  const rec = users.findById(data.uid);
  if (!rec || rec.banned) return 'view';
  return rec.role === 'admin' ? 'admin' : 'user';
}

function userOf(req) {
  const data = verifyToken(parseCookies(req)[COOKIE]);
  if (!data) return null;
  const rec = users.findById(data.uid);
  if (!rec || rec.banned) return null;
  return users.publicView(rec);
}

// ---------------- 限流 ----------------
function makeLimiter(max) {
  const map = new Map();
  return {
    hit(ip) {
      const now = Date.now();
      const rec = map.get(ip) || { n: 0, until: now + 10 * 60 * 1000 };
      if (now > rec.until) { rec.n = 0; rec.until = now + 10 * 60 * 1000; }
      rec.n++;
      map.set(ip, rec);
      if (map.size > 5000) map.clear();
      return rec.n <= max;
    },
    clear(ip) { map.delete(ip); },
    blocked(ip) {
      const rec = map.get(ip);
      if (!rec) return false;
      if (Date.now() > rec.until) { map.delete(ip); return false; }
      return rec.n >= max;
    },
  };
}
const loginLimiter = makeLimiter(8);      // 10 分钟 8 次
const registerLimiter = makeLimiter(5);   // 10 分钟 5 次

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// ---------------- 同步观战（可选，默认关） ----------------
let simhost = null;
try { simhost = require('./lib/simhost'); } catch (e) { simhost = null; }
const REPORT_MS = Number(arg('report-ms', process.env.CC_REPORT_MS || 4000));
const ROUND_SIZE = Math.max(1, Math.min(6, Number(arg('round-size', process.env.CC_ROUND_SIZE || 6))));
const BASE_SEED = Number(arg('seed', process.env.CC_SEED || Math.floor(Math.random() * 1e9)));
const roundState = {
  enabled: (has('sync') || process.env.CC_SYNC === '1') && !!simhost,
  round: 0, seed: 0, lineup: null, startedAt: 0, duration: 0, endsAt: 0, nextAt: 0,
};

function startRound(n) {
  if (!roundState.enabled) return;
  const seed = (BASE_SEED + n * 7919) >>> 0;
  const lineup = simhost.makeLineup(seed, ROUND_SIZE, ROUND_SIZE);
  const sim = simhost.simulateRound(seed, lineup, 300);
  Object.assign(roundState, {
    round: n, seed, lineup, startedAt: Date.now(),
    duration: sim.duration,
    endsAt: Date.now() + Math.round(sim.duration * 1000),
    nextAt: Date.now() + Math.round(sim.duration * 1000) + REPORT_MS,
  });
}
function roundInfo() {
  const now = Date.now();
  return {
    enabled: roundState.enabled, serverNow: now, round: roundState.round, seed: roundState.seed,
    lineup: roundState.lineup, startedAt: roundState.startedAt, duration: roundState.duration,
    endsAt: roundState.endsAt, nextAt: roundState.nextAt, reportMs: REPORT_MS, size: ROUND_SIZE,
  };
}
if (roundState.enabled) { startRound(1); setInterval(() => { if (Date.now() >= roundState.nextAt) startRound(roundState.round + 1); }, 500); }

// ---------------- 静态文件 ----------------
const PUBLIC_ROOT_FILES = new Set(['index.html', 'admin.html', 'account.html', 'sim-watch.html', 'replay-export.html', 'styles.css', 'favicon.ico']);
const PUBLIC_DIRS = ['js/', 'assets/'];

function isPublic(rel) {
  const r = rel.replace(/\\/g, '/');
  if (r.indexOf('\0') >= 0) return false;
  const base = r.split('/').pop() || '';
  if (base.startsWith('.')) return false;
  if (PUBLIC_ROOT_FILES.has(r)) return true;
  return PUBLIC_DIRS.some((d) => r.startsWith(d));
}

function safeResolve(urlPath) {
  const clean = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]);
  const rel = path.normalize(clean).replace(/^([\\/]*\.\.([\\/]|$))+/, '').replace(/^[\\/]+/, '');
  const full = path.resolve(root, rel);
  if (!full.startsWith(root)) return null;
  if (!isPublic(rel)) return null;
  return full;
}

function injectBoot(html, role) {
  if (html.indexOf('__CC_ROLE__') >= 0) return html;
  const mode = role === 'view' ? PUBLIC_MODE : 'play';
  const tag = '<script>window.__CC_ROLE__=' + JSON.stringify(role)
    + ';window.__CC_MODE__=' + JSON.stringify(mode)
    + ';window.__CC_REGISTER__=' + JSON.stringify(ALLOW_REGISTER)
    + ';window.__CC_SYNC__=' + JSON.stringify(roundState.enabled) + ';</script>';
  return html.replace(/<head([^>]*)>/i, (m) => m + '\n' + tag);
}

function sendJson(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers || {}));
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n <= (limit || 4096)) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function setCookieHeader(token) {
  const maxAge = SESSION_DAYS * 86400;
  return COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge;
}

// ---------------- API ----------------
async function handleApi(req, res, pathname) {
  const ip = clientIp(req);
  const role = roleOf(req);

  if (pathname === '/api/admin/replay' && req.method === 'POST') {
    if (role !== 'admin') return sendJson(res, 403, { ok: false, error: '仅管理员可以导出录像' });
    try {
      if (!simhost) throw new Error('模拟模块不可用');
      const input = JSON.parse(await readBody(req, 16384));
      const config = require('./lib/replay').makeConfig(input, simhost);
      return sendJson(res, 200, Object.assign({ ok: true }, config));
    } catch (error) { return sendJson(res, 400, { ok: false, error: error.message }); }
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    return sendJson(res, 200, {
      role: role === 'admin' ? 'admin' : role === 'user' ? 'user' : 'guest',
      mode: role === 'view' ? PUBLIC_MODE : 'play',
      user: userOf(req),
      loginEnabled: users.hasBuiltinAdmin || users.count() > 0 || !!ADMIN_PASS,
      registerEnabled: ALLOW_REGISTER,
      syncEnabled: roundState.enabled,
      userCount: users.count(),
    });
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    if (!ALLOW_REGISTER) return sendJson(res, 403, { ok: false, error: '本站已关闭注册' });
    if (registerLimiter.blocked(ip)) return sendJson(res, 429, { ok: false, error: '注册太频繁了，请稍后再试' });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    registerLimiter.hit(ip);
    const r = users.create(body.user, body.pass, 'user');
    if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
    return sendJson(res, 200, { ok: true, role: 'user', user: r.user }, { 'Set-Cookie': setCookieHeader(makeToken(r.user)) });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    if (loginLimiter.blocked(ip)) return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试' });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    const r = users.auth(body.user, body.pass);
    if (!r.ok) { loginLimiter.hit(ip); return sendJson(res, 401, { ok: false, error: r.error }); }
    loginLimiter.clear(ip);
    return sendJson(res, 200, { ok: true, role: r.user.role, user: r.user }, { 'Set-Cookie': setCookieHeader(makeToken(r.user)) });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': COOKIE + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  // ---- 管理员：用户管理 ----
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    if (role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员' });
    return sendJson(res, 200, { ok: true, users: users.list() });
  }
  if (pathname === '/api/admin/ban' && req.method === 'POST') {
    if (role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员' });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    const r = users.setBanned(body.user, body.banned !== false);
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  if (pathname === '/api/admin/delete' && req.method === 'POST') {
    if (role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员' });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
    const r = users.remove(body.user);
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // ---- 同步观战（可选）----
  if (pathname === '/api/round' && req.method === 'GET') return sendJson(res, 200, roundInfo());
  if (pathname === '/api/round/next' && req.method === 'POST') {
    if (role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员' });
    startRound(roundState.round + 1);
    return sendJson(res, 200, { ok: true, ...roundInfo() });
  }

  return sendJson(res, 404, { ok: false, error: 'no such api' });
}

function serveFile(req, res, file, ext, role) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + req.url);
    }
    let body = data;
    if (ext === 'html') body = Buffer.from(injectBoot(data.toString('utf8'), role), 'utf8');
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': ext === 'html' ? 'no-store' : 'public, max-age=604800',
    };
    const accept = String(req.headers['accept-encoding'] || '');
    if (TEXTY.has(ext) && /\bgzip\b/.test(accept) && body.length > 1024) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      return zlib.gzip(body, (e, zipped) => { res.writeHead(200, headers); res.end(e ? body : zipped); });
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}

function handle(req, res) {
  let p = (req.url || '/').split('?')[0];
  const role = roleOf(req);

  if (p.startsWith('/api/')) {
    handleApi(req, res, p).catch(() => sendJson(res, 500, { ok: false, error: 'internal' }));
    return;
  }

  if (p === '/' || p === '/watch' || p === '/watch/') p = '/index.html';
  if (p === '/admin.html' || p === '/login.html') p = '/account.html';
  const file = safeResolve(p);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 ' + p);
  }
  if (file === path.join(root, 'replay-export.html') && role !== 'admin') {
    return sendJson(res, 403, { ok: false, error: '仅管理员可以导出录像' });
  }
  if (!QUIET) console.log(new Date().toISOString() + ' ' + (req.method || 'GET') + ' ' + p + ' [' + role + ']');
  serveFile(req, res, file, path.extname(file).slice(1).toLowerCase(), role);
}

// ---------------- 启动 ----------------
function bootstrapAdmin() {
  if (!ADMIN_PASS) return;
  const name = ADMIN_USER;
  const existing = users.findByName(name);
  if (!existing) {
    const r = users.create(name, ADMIN_PASS, 'admin');
    if (r.ok) console.log('已创建管理员账号：' + name);
    else console.error('创建管理员失败：' + r.error);
    return;
  }
  if (existing.role !== 'admin') existing.role = 'admin';
  // 环境变量里的密码保持权威：对不上就重置
  if (!users._verifyPassword(ADMIN_PASS, existing)) {
    const { salt, hash } = users._hashPassword(ADMIN_PASS);
    existing.salt = salt; existing.hash = hash; existing.banned = false;
    users.save();
    console.log('已按 --admin-pass 重置管理员密码');
  }
}

function listen(port, triesLeft) {
  const server = http.createServer(handle);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log('端口 ' + port + ' 被占用，尝试 ' + (port + 1));
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('启动失败: ' + e.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const shown = HOST === '0.0.0.0' ? '<本机IP或域名>' : HOST;
    console.log('赛博斗蛐蛐 running: http://' + shown + ':' + port);
    console.log('  根目录   : ' + root);
    console.log('  游客权限 : ' + PUBLIC_MODE + (PUBLIC_MODE === 'view' ? '（只能看）' : PUBLIC_MODE === 'pause' ? '（可暂停）' : '（完整操作，慎用）'));
    console.log('  注册     : ' + (ALLOW_REGISTER ? '已开启，账号页 /account.html' : '已关闭'));
    console.log('  账号总数 : ' + users.count() + '（用户库 ' + users.FILE + '）');
    if (ADMIN_PASS) console.log('  管理员   : ' + ADMIN_USER + '（/account.html 登录）');
    else console.log('  管理员   : 未设置（加 --admin-pass 你的密码 即可创建）');
    console.log('  同步观战 : ' + (roundState.enabled ? '已开启' : '未开启（各自玩各自的）'));
    console.log('  观战台   : http://' + shown + ':' + port + '/sim-watch.html');
  });
}

bootstrapAdmin();
listen(startPort, 5);
