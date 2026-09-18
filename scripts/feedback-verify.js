#!/usr/bin/env node
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const PROJECT = path.resolve(__dirname, '..'); const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-feedback-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const port = 6100 + Math.floor(Math.random() * 150); const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; }); let passed = 0; let failed = 0; const wait = ms => new Promise(r => setTimeout(r, ms));
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function call(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; }
async function main() {
  try {
    let ready = false; for (let i = 0; i < 30; i++) { await wait(100); try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {} }
    if (!ready) throw new Error(log || '服务启动失败');
    const result = await call('/api/analyze', 'POST', { role: '产品经理', jd: 'JD', resume: 'RESUME' });
    check('分析响应返回运行记录 ID', !!result.body.runId);
    const invalid = await call('/api/feedback', 'POST', { logId: result.body.runId, rating: 'unknown' });
    check('非法评价返回 400', invalid.status === 400 && invalid.body.code === 'INVALID_FEEDBACK_RATING');
    const saved = await call('/api/feedback', 'POST', { logId: result.body.runId, rating: 'bad', tags: ['事实错误', '结构问题'], comment: '需要补充证据', owner: 'editor' });
    check('可以保存质量反馈', saved.status === 201 && saved.body.item.rating === 'bad' && saved.body.item.prompts);
    check('质量反馈绑定实际 Prompt 版本', saved.body.item.promptVersions?.length > 0 && saved.body.item.promptVersions.every(item => item.name && item.version));
    const list = await call('/api/feedback');
    check('反馈列表不含 JD 或简历原文', list.body.items.length === 1 && !JSON.stringify(list.body.items).includes('RESUME') && !JSON.stringify(list.body.items).includes('"jd"'));
    check('反馈统计正确', list.body.stats.bad === 1 && list.body.stats.open === 1 && list.body.stats.byTag.some(item => item.tag === '事实错误'));
    const prompts = await call('/api/prompts');
    const promptId = prompts.body.items?.[0]?.id;
    const linked = await call(`/api/feedback/${saved.body.item.id}/link`, 'POST', { promptId, note: '加入回归验证' });
    check('反馈可以关联 Prompt 修复目标', linked.status === 200 && linked.body.item.loop?.promptId === promptId && linked.body.item.loop?.sourceVersion);
    check('闭环关联不包含业务正文', !JSON.stringify(linked.body.item.loop).includes('RESUME') && !JSON.stringify(linked.body.item.loop).includes('JD'));
    const updated = await call(`/api/feedback/${saved.body.item.id}`, 'PUT', { status: 'resolved', rating: 'good' });
    check('可以更新反馈状态', updated.status === 200 && updated.body.item.status === 'resolved' && updated.body.item.rating === 'good');
    const filtered = await call('/api/feedback?status=resolved&rating=good');
    check('反馈支持状态与评价筛选', filtered.body.items.length === 1);
    const missing = await call('/api/feedback', 'POST', { logId: 'missing-log', rating: 'good' });
    check('不存在的运行记录返回 404', missing.status === 404 && missing.body.code === 'LOG_NOT_FOUND');
    const html = fs.readFileSync(path.join(PROJECT, 'admin.html'), 'utf8'); const js = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8');
    check('后台包含质量反馈入口', html.includes('data-route="feedback"') && js.includes('function viewFeedback'));
  } finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} }
  console.log(`\n────────  质量反馈通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0);
}
main().catch(error => { console.error(error); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
