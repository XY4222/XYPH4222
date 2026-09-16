#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-auth-verify-'));
fs.cpSync(PROJECT, staged, {
  recursive: true,
  filter(source) {
    const top = path.relative(PROJECT, source).split(path.sep)[0];
    return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
  }
});

const port = 5200 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const users = [
  { username: 'admin-test', password: 'Admin-test-937!', role: 'admin' },
  { username: 'editor-test', password: 'Editor-test-482!', role: 'editor' },
  { username: 'viewer-test', password: 'Viewer-test-615!', role: 'viewer' }
];
const server = spawn(process.execPath, ['server.js'], {
  cwd: staged,
  env: {
    ...process.env,
    PORT: String(port),
    ADMIN_USERS_JSON: JSON.stringify(users),
    ADMIN_SESSION_SECRET: 'auth-verify-session-secret-at-least-32-chars'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;

function check(label, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${extra ? `  →  ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`);
  }
}

async function request(url, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, cookie: response.headers.get('set-cookie') };
}

async function login(username, password) {
  const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  return { ...result, session: result.cookie && result.cookie.split(';')[0] };
}

async function main() {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(100);
      try {
        if ((await request('/api/health')).status === 200) { ready = true; break; }
      } catch { /* 服务仍在启动 */ }
    }
    if (!ready) throw new Error(`测试服务启动失败：${serverLog.trim() || '无日志'}`);

    check('健康检查保持公开', (await request('/api/health')).status === 200);
    check('生产 Prompt 正文不会匿名暴露', (await request('/api/prompts/active')).status === 401);
    check('用户分析入口保持公开', (await request('/api/analyze', { method: 'POST', body: {} })).status === 400);
    check('匿名用户不能读取后台列表', (await request('/api/prompts')).status === 401);
    check('畸形 Cookie 只会被拒绝，不会打崩服务', (await request('/api/prompts', {
      cookie: 'resume_admin_session=%'
    })).status === 401);
    check('畸形 Cookie 后服务仍健康', (await request('/api/health')).status === 200);
    check('错误密码不能登录', (await login('admin-test', 'wrong-password')).status === 401);

    const viewer = await login('viewer-test', 'Viewer-test-615!');
    check('查看者可以登录', viewer.status === 200 && !!viewer.session);
    check('查看者可以读取总览', (await request('/api/overview', { cookie: viewer.session })).status === 200);
    check('查看者可以读取测试记录', (await request('/api/prompt-tests', { cookie: viewer.session })).status === 200);
    check('查看者不能运行 Prompt 测试', (await request('/api/prompts/1/test', {
      cookie: viewer.session, method: 'POST', body: { role: '测试', jd: 'JD', resume: '简历' }
    })).status === 403);
    check('查看者不能修改设置', (await request('/api/settings', {
      cookie: viewer.session, method: 'PUT', body: { retries: 1 }
    })).status === 403);

    const editor = await login('editor-test', 'Editor-test-482!');
    check('编辑者可以登录', editor.status === 200 && !!editor.session);
    const list = await request('/api/prompts', { cookie: editor.session });
    const first = list.payload.items[0];
    const detail = await request(`/api/prompts/${first.id}`, { cookie: editor.session });
    const edited = await request(`/api/prompts/${first.id}`, {
      cookie: editor.session,
      method: 'PUT',
      body: { content: detail.payload.prompt.content + '\n鉴权测试草稿', actor: '伪造管理员' }
    });
    check('编辑者可以保存草稿', edited.status === 200 && edited.payload.prompt.releaseStatus === 'draft');
    const testCase = await request('/api/test-cases', {
      cookie: editor.session, method: 'POST', body: { name: '权限测试', role: '测试', jd: 'JD', resume: '简历' }
    });
    check('编辑者可以保存测试案例', testCase.status === 201 && !!testCase.payload.item.id);
    check('编辑者不能删除测试案例', (await request(`/api/test-cases/${testCase.payload.item.id}`, {
      cookie: editor.session, method: 'DELETE'
    })).status === 403);
    check('编辑者不能发布生产', (await request(`/api/prompts/${first.id}/publish`, {
      cookie: editor.session, method: 'POST', body: { actor: '伪造管理员' }
    })).status === 403);

    const changed = await request(`/api/prompts/${first.id}`, { cookie: editor.session });
    check('审计操作人来自登录身份', changed.payload.versions[0].actor === 'editor-test', changed.payload.versions[0].actor);

    const admin = await login('admin-test', 'Admin-test-937!');
    check('管理员可以登录', admin.status === 200 && !!admin.session);
    check('管理员可以修改设置', (await request('/api/settings', {
      cookie: admin.session, method: 'PUT', body: { retries: 1, actor: '伪造管理员' }
    })).status === 200);

    const logout = await request('/api/auth/logout', { cookie: admin.session, method: 'POST', body: {} });
    check('退出登录会清理会话 Cookie', logout.status === 200 && /Max-Age=0/i.test(logout.cookie || ''));
    check('退出后旧会话立即失效', (await request('/api/overview', { cookie: admin.session })).status === 401);

    let limited;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limited = await login('brute-force-user', 'wrong-password');
    }
    check('连续登录失败会触发限流', limited.status === 429, String(limited.status));
  } finally {
    server.kill('SIGKILL');
    await wait(150);
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* noop */ }
  }

  console.log(`\n────────  鉴权通过 ${passed} · 失败 ${failed}  ────────`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  if (serverLog.trim()) console.error(serverLog.trim());
  try { server.kill('SIGKILL'); } catch { /* noop */ }
  process.exit(1);
});
