'use strict';

// Only the loopback development bootstrap enables this helper. The credential file
// is kept beside the private user store and never belongs to the static allowlist.
const fs = require('node:fs');
const path = require('node:path');

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function ensureLocalAdmin(users, options) {
  const opts = options || {};
  const name = opts.name === undefined ? 'admin' : opts.name;
  if (opts.enabled !== true) return { created: false, name };
  if (!users || typeof users.findByName !== 'function' || typeof users.create !== 'function'
      || typeof users.FILE !== 'string' || !path.isAbsolute(users.FILE)
      || typeof name !== 'string' || !name.trim()) {
    throw failure('LOCAL_ADMIN_CONFIG', '本地管理员初始化配置不正确');
  }
  const normalizedName = name.trim();
  // An existing account keeps its password, role, visibility and ban state.
  if (users.findByName(normalizedName)) return { created: false, name: normalizedName };
  const password = opts.password === undefined ? 'admin233' : opts.password;
  if (typeof password !== 'string' || password.length < 6 || password.length > 128 || /^\d+$/.test(password)) {
    throw failure('LOCAL_ADMIN_CONFIG', '本地管理员密码配置不正确');
  }
  const folder = path.dirname(users.FILE);
  const credentialPath = path.join(folder, 'local-admin.json');
  let file = null, ownsFile = false, accountCreated = false;
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Persist recoverable credentials before the account. Exclusive creation avoids
    // overwriting credentials from another install or a partially completed startup.
    file = fs.openSync(credentialPath, 'wx', 0o600);
    ownsFile = true;
    fs.writeFileSync(file, JSON.stringify({ user: normalizedName, password }, null, 2) + '\n', 'utf8');
    fs.fsyncSync(file);
    fs.closeSync(file); file = null;
    const result = users.create(normalizedName, password, 'admin');
    if (!result || !result.ok) throw failure('LOCAL_ADMIN_CREATE', '无法创建本地默认管理员，请检查账号数据');
    accountCreated = true;
    return { created: true, name: normalizedName, credentialPath };
  } catch (cause) {
    if (file !== null) { try { fs.closeSync(file); } catch (_) { /* preserve the original safe failure */ } }
    // Do not delete pre-existing files, alter another account, or attempt a password reset.
    if (ownsFile && !accountCreated) {
      try { fs.unlinkSync(credentialPath); }
      catch (_) { throw failure('LOCAL_ADMIN_CLEANUP', '本地管理员初始化失败，临时凭据未能清理，请检查私有账号目录'); }
    }
    if (cause && cause.code === 'EEXIST') {
      throw failure('LOCAL_ADMIN_CREDENTIALS_EXIST', '本地管理员凭据文件已存在但对应账号缺失，请检查私有账号数据后再启动');
    }
    if (cause && cause.code === 'LOCAL_ADMIN_CREATE') throw cause;
    throw failure('LOCAL_ADMIN_CREATE', '无法创建本地默认管理员，请检查私有账号目录及写入权限');
  }
}

module.exports = { ensureLocalAdmin };
