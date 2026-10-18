/* ===========================================================
   账号存储（lib/users.js）
   -----------------------------------------------------------
   零依赖用户库：JSON 文件 + 原子写，密码用 scrypt 加盐哈希。
   文件默认在 data/users.json（该目录不在静态白名单里，出不了网）。

   记录结构：
     { id, name, nameLower, role:'user'|'admin', salt, hash, createdAt, lastLoginAt, banned }
   =========================================================== */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.CC_DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'users.json');

const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/;
const PASS_MIN = 6;
const PASS_MAX = 128;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

let state = { version: 1, users: [] };
let loaded = false;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function load() {
  if (loaded) return state;
  ensureDir();
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.users)) state = data;
    }
  } catch (e) {
    console.error('[users] 读取失败，按空库启动：' + e.message);
    state = { version: 1, users: [] };
  }
  loaded = true;
  return state;
}

function save() {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);           // 原子替换，避免半截文件
}

function hashPassword(pass, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pass, s, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(pass, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const { hash } = hashPassword(pass, rec.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function findByName(name) {
  if (!name) return null;
  const lower = String(name).trim().toLowerCase();
  return load().users.find((u) => u.nameLower === lower || u.name === name) || null;
}

function findById(id) { return load().users.find((u) => u.id === id) || null; }

function validate(name, pass) {
  const n = String(name || '').trim();
  const p = String(pass || '');
  if (!NAME_RE.test(n)) return '用户名只能 2~20 位中文/字母/数字/下划线/连字符';
  if (p.length < PASS_MIN) return '密码至少 ' + PASS_MIN + ' 位';
  if (p.length > PASS_MAX) return '密码太长了';
  if (/^\d+$/.test(p)) return '密码不能全是数字';
  return null;
}

function create(name, pass, role) {
  const n = String(name).trim();
  const err = validate(n, pass);
  if (err) return { ok: false, error: err };
  load();
  if (findByName(n)) return { ok: false, error: '这个用户名已经被注册了' };
  const { salt, hash } = hashPassword(pass);
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    name: n,
    nameLower: n.toLowerCase(),
    role: role === 'admin' ? 'admin' : 'user',
    salt, hash,
    createdAt: Date.now(),
    lastLoginAt: 0,
    banned: false,
  };
  state.users.push(rec);
  save();
  return { ok: true, user: publicView(rec) };
}

function auth(name, pass) {
  const rec = findByName(name);
  if (!rec) return { ok: false, error: '用户名或密码不对' };
  if (rec.banned) return { ok: false, error: '这个账号已被封禁' };
  if (!verifyPassword(pass, rec)) return { ok: false, error: '用户名或密码不对' };
  rec.lastLoginAt = Date.now();
  save();
  return { ok: true, user: publicView(rec) };
}

function publicView(rec) {
  if (!rec) return null;
  return { id: rec.id, name: rec.name, role: rec.role, createdAt: rec.createdAt, lastLoginAt: rec.lastLoginAt, banned: !!rec.banned };
}

function list() { return load().users.map(publicView); }

function setBanned(name, banned) {
  const rec = findByName(name);
  if (!rec) return { ok: false, error: '没有这个用户' };
  if (rec.role === 'admin') return { ok: false, error: '不能封禁管理员' };
  rec.banned = !!banned;
  save();
  return { ok: true, user: publicView(rec) };
}

function remove(name) {
  load();
  const i = state.users.findIndex((u) => u.nameLower === String(name || '').toLowerCase());
  if (i < 0) return { ok: false, error: '没有这个用户' };
  if (state.users[i].role === 'admin') return { ok: false, error: '不能删除管理员' };
  state.users.splice(i, 1);
  save();
  return { ok: true };
}

function count() { return load().users.length; }

/** 首次启动时用环境变量里的管理员密码建一个管理员账号（可选） */
function ensureAdmin(name, pass) {
  if (!name || !pass) return null;
  load();
  let rec = findByName(name);
  if (rec) return publicView(rec);
  const r = create(name, pass, 'admin');
  return r.ok ? r.user : null;
}

module.exports = {
  FILE, load, save, create, auth, findByName, findById, publicView, list,
  setBanned, remove, count, ensureAdmin, validate,
  _hashPassword: hashPassword, _verifyPassword: verifyPassword,
};
