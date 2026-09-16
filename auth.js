'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'resume_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };

function clip(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readUsers() {
  if (process.env.ADMIN_USERS_JSON) {
    let parsed;
    try { parsed = JSON.parse(process.env.ADMIN_USERS_JSON); }
    catch { throw new Error('ADMIN_USERS_JSON 不是合法 JSON'); }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('ADMIN_USERS_JSON 至少需要一个用户');
    return parsed.map((user, index) => {
      const username = clip(user.username, 80).trim();
      const password = String(user.password || '');
      const role = ROLE_LEVEL[user.role] ? user.role : 'viewer';
      if (!username || password.length < 10) throw new Error(`ADMIN_USERS_JSON 第 ${index + 1} 个用户无效：用户名必填，密码至少 10 位`);
      return { username, password, role };
    });
  }

  if (process.env.ADMIN_PASSWORD) {
    if (String(process.env.ADMIN_PASSWORD).length < 10) throw new Error('ADMIN_PASSWORD 至少需要 10 位');
    return [{
      username: clip(process.env.ADMIN_USERNAME || 'admin', 80).trim() || 'admin',
      password: String(process.env.ADMIN_PASSWORD),
      role: 'admin'
    }];
  }

  if (process.env.ADMIN_DEV_AUTO_CREDENTIALS === 'true' && process.env.NODE_ENV !== 'production') {
    const generated = crypto.randomBytes(12).toString('base64url');
    console.warn(`[auth] 本地开发临时账号已生成：admin / ${generated}`);
    return [{ username: 'admin', password: generated, role: 'admin' }];
  }
  throw new Error('未配置后台账号：请设置 ADMIN_PASSWORD 或 ADMIN_USERS_JSON');
}

function createAuth() {
  const disabled = process.env.ADMIN_AUTH_DISABLED === 'true';
  if (disabled && process.env.NODE_ENV !== 'test') {
    throw new Error('ADMIN_AUTH_DISABLED 只能在 NODE_ENV=test 时使用');
  }
  const users = disabled ? [] : readUsers();
  const secret = process.env.ADMIN_SESSION_SECRET
    || crypto.createHash('sha256').update(users.map(user => `${user.username}:${user.password}`).join('|')).digest('hex');

  function sign(encoded) {
    return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  }

  function issue(user) {
    const payload = Buffer.from(JSON.stringify({
      username: user.username,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  const revoked = new Set();

  function verify(token) {
    if (disabled) return { username: 'auth-disabled', role: 'admin' };
    if (revoked.has(String(token || ''))) return null;
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!session.username || !ROLE_LEVEL[session.role] || Number(session.exp) <= Date.now() / 1000) return null;
      if (!users.some(user => user.username === session.username && user.role === session.role)) return null;
      return { username: session.username, role: session.role };
    } catch { return null; }
  }

  function parseCookies(req) {
    const cookies = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      try { cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); }
      catch { /* 畸形 Cookie 按不存在处理，不能让请求进程异常 */ }
    }
    return cookies;
  }

  function current(req) {
    return verify(parseCookies(req)[COOKIE_NAME]);
  }

  function revoke(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) revoked.add(token);
  }

  function login(username, password) {
    const user = users.find(item => item.username === String(username || '').trim());
    if (!user || !safeEqual(user.password, password || '')) return null;
    return { user: { username: user.username, role: user.role }, token: issue(user) };
  }

  function cookie(token, req, maxAge = SESSION_TTL_SECONDS) {
    const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `${COOKIE_NAME}=${encodeURIComponent(token || '')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  function hasRole(user, required) {
    return !!user && ROLE_LEVEL[user.role] >= ROLE_LEVEL[required];
  }

  return { disabled, current, revoke, login, cookie, hasRole };
}

module.exports = { createAuth, ROLE_LEVEL };
