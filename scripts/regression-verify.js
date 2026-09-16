#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-regression-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const port = 5900 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true', PROMPT_TEST_MOCK: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; });
let passed = 0; let failed = 0; const wait = ms => new Promise(r => setTimeout(r, ms));
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function call(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; }
async function main() {
  try {
    let ready = false; for (let i = 0; i < 30; i++) { await wait(100); try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {} }
    if (!ready) throw new Error(log || '服务启动失败');
    const prompts = await call('/api/prompts'); const target = prompts.body.items[0];
    const detail = await call(`/api/prompts/${target.id}`); const content = detail.body.prompt.content + '\n回归门禁草稿';
    await call(`/api/prompts/${target.id}`, 'PUT', { content });
    const saved = await call('/api/test-cases', 'POST', { promptId: target.id, name: '门禁通过案例', role: 'AI 产品经理', jd: '负责 Agent 产品', resume: '五年产品经验', minScore: 80, maxScoreDrop: 0, requiredTerms: 'draft' });
    check('测试案例绑定目标 Prompt', String(saved.body.item.promptId) === String(target.id));
    check('允许配置零分退化容忍度', saved.body.item.maxScoreDrop === 0);
    const blocked = await call(`/api/prompts/${target.id}/submit-review`, 'POST', {});
    check('未运行回归时阻止提交审核', blocked.status === 409 && blocked.body.code === 'REGRESSION_GATE_FAILED');
    const run = await call(`/api/prompts/${target.id}/regression`, 'POST', {});
    check('回归测试集运行通过', run.status === 200 && run.body.run.passed === true && run.body.run.total === 1);
    const submitted = await call(`/api/prompts/${target.id}/submit-review`, 'POST', {});
    check('当前修订通过门禁后可以提交审核', submitted.status === 200 && submitted.body.prompt.releaseStatus === 'review');
    await call(`/api/prompts/${target.id}`, 'PUT', { content: content + '\n再次修改' });
    const stale = await call(`/api/prompts/${target.id}/submit-review`, 'POST', {});
    check('草稿再次修改会使旧门禁失效', stale.status === 409 && stale.body.code === 'REGRESSION_GATE_FAILED');
    const second = prompts.body.items[1];
    const secondDetail = await call(`/api/prompts/${second.id}`); await call(`/api/prompts/${second.id}`, 'PUT', { content: secondDetail.body.prompt.content + '\n失败案例草稿' });
    await call('/api/test-cases', 'POST', { promptId: second.id, name: '门禁失败案例', role: '产品经理', jd: 'JD', resume: '简历', minScore: 95 });
    const failedRun = await call(`/api/prompts/${second.id}/regression`, 'POST', {});
    check('未达到最低分的回归运行明确失败', failedRun.status === 200 && failedRun.body.run.passed === false && failedRun.body.run.failed === 1);
    const history = await call(`/api/regressions?promptId=${target.id}`);
    check('回归结果持久化且不含原文', history.body.items.length >= 1 && !JSON.stringify(history.body.items).includes('五年产品经验'));
  } finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} }
  console.log(`\n────────  回归门禁通过 ${passed} · 失败 ${failed}  ────────`); process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
