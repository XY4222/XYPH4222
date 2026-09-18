#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-log-detail-verify-'));
fs.cpSync(PROJECT, staged, {
  recursive: true,
  filter(source) {
    const top = path.relative(PROJECT, source).split(path.sep)[0];
    return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git');
  }
});
fs.mkdirSync(path.join(staged, 'data'), { recursive: true });
const logId = 'log-detail-sensitive';
fs.writeFileSync(path.join(staged, 'data', 'logs.jsonl'), JSON.stringify({
  id: logId, at: new Date().toISOString(), ok: false, code: 'INVALID_MODEL_SCHEMA',
  error: 'raw upstream secret: jd=JD_SECRET resume=RESUME_SECRET', model: 'test-model',
  modelReturned: 'test-model', role: '产品经理', prompts: ['JD 分析'],
  promptVersions: [{ name: 'JD 分析', version: 'v1.2' }], latencyMs: 1234, attempts: 2,
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, cost: 0.003,
  inputChars: 88, truncated: [{ name: '简历' }], dropped: [{ name: 'JD' }],
  validationErrors: ['score'], riskHits: ['phone'], jd: 'JD_SECRET', resume: 'RESUME_SECRET',
  resumeText: 'RESUME_TEXT_SECRET', promptContent: 'PROMPT_SECRET'
}) + '\n', 'utf8');

const port = 6700 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
const users = [{ username: 'viewer-test', password: 'Viewer-test-615!', role: 'viewer' }];
const server = spawn(process.execPath, ['server.js'], {
  cwd: staged,
  env: { ...process.env, PORT: String(port), ADMIN_USERS_JSON: JSON.stringify(users), ADMIN_SESSION_SECRET: 'log-detail-verify-session-secret-at-least-32-chars' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0; let failed = 0;
function check(label, condition) { if (condition) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function request(url, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, payload: await response.json().catch(() => ({})), setCookie: response.headers.get('set-cookie') || '' };
}
async function main() {
  try {
    let ready = false;
    for (let i = 0; i < 30; i++) { await wait(100); try { if ((await request('/api/health')).status === 200) { ready = true; break; } } catch {} }
    if (!ready) throw new Error(serverLog || '服务启动失败');
    check('匿名用户不能读取日志详情', (await request(`/api/logs/${logId}`)).status === 401);
    const login = await request('/api/auth/login', { method: 'POST', body: { username: 'viewer-test', password: 'Viewer-test-615!' } });
    const cookie = login.setCookie.split(';')[0];
    check('查看者登录成功', login.status === 200 && !!cookie);
    const list = await request('/api/logs?days=1&limit=20', { cookie });
    const listText = JSON.stringify(list.payload);
    if (!(list.status === 200 && !listText.includes('JD_SECRET') && !listText.includes('RESUME_SECRET') && !listText.includes('PROMPT_SECRET'))) console.log('    列表诊断:', list.status, listText);
    check('日志列表可读取且不泄露正文', list.status === 200 && !listText.includes('JD_SECRET') && !listText.includes('RESUME_SECRET') && !listText.includes('PROMPT_SECRET'));
    const detail = await request(`/api/logs/${logId}`, { cookie });
    const detailText = JSON.stringify(detail.payload);
    check('详情返回安全元数据', detail.status === 200 && detail.payload.item?.status === 'failed' && detail.payload.item?.code === 'INVALID_MODEL_SCHEMA');
    check('详情不包含 JD、简历或 Prompt 正文', !detailText.includes('JD_SECRET') && !detailText.includes('RESUME_SECRET') && !detailText.includes('RESUME_TEXT_SECRET') && !detailText.includes('PROMPT_SECRET'));
    check('详情不包含原始上游错误', !detailText.includes('raw upstream secret'));
    check('详情保留运营诊断字段', detail.payload.item?.truncatedCount === 1 && detail.payload.item?.droppedCount === 1 && detail.payload.item?.schemaErrors?.includes('score'));
    const missing = await request('/api/logs/not-found', { cookie });
    check('不存在日志返回明确 404', missing.status === 404 && missing.payload.code === 'LOG_NOT_FOUND');
    const source = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8');
    check('日志表格提供详情入口', source.includes('data-log-detail') && source.includes('async function openLogDetail'));
  } finally {
    server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n──────── 运行日志详情通过 ${passed} · 失败 ${failed} ────────`);
  process.exit(failed ? 1 : 0);
}
main().catch(error => { console.error(error); if (serverLog) console.error(serverLog); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
