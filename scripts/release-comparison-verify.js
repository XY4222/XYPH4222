#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-release-comparison-'));
fs.cpSync(PROJECT, staged, {
  recursive: true,
  filter(source) {
    const top = path.relative(PROJECT, source).split(path.sep)[0];
    return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
  }
});

const dataDir = path.join(staged, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const releaseAt = '2026-09-10T00:00:00.000Z';
const beforeAt = '2026-09-09T12:00:00.000Z';
const afterAt = '2026-09-10T12:00:00.000Z';
const boundaryAt = '2026-09-10T00:00:00.000Z';
const prompt = { id: 1, name: '输入材料校验', version: 'v1.1', releaseStatus: 'published', publishedVersion: 'v1.1', publishedAt: releaseAt, content: '不应出现在报告中的 Prompt 正文' };
const versions = [{ vid: 'p1-v1.1', promptId: 1, version: 'v1.1', action: 'publish', actor: 'tester', at: releaseAt, snapshot: { name: prompt.name, content: prompt.content } }];
const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
const logs = [
  { id: 'before', at: beforeAt, ok: true, latencyMs: 100, attempts: 1, inputChars: 100, usage, promptVersions: [{ name: prompt.name, version: 'v1.1' }, { name: '另一个 Prompt', version: 'v2.0' }] },
  { id: 'after', at: afterAt, ok: false, code: 'ANALYZE_FAILED', latencyMs: 200, attempts: 2, inputChars: 200, usage, validationErrors: ['schema'], promptVersions: [{ name: prompt.name, version: 'v1.1' }] },
  { id: 'boundary', at: boundaryAt, ok: true, latencyMs: 120, attempts: 1, inputChars: 300, usage, promptVersions: [{ name: prompt.name, version: 'v1.1' }] },
  { id: 'outside', at: '2026-09-17T00:00:00.000Z', ok: true, latencyMs: 999, inputChars: 999, usage, promptVersions: [{ name: prompt.name, version: 'v1.1' }] }
];
fs.writeFileSync(path.join(dataDir, 'prompts.json'), JSON.stringify([prompt], null, 2));
fs.writeFileSync(path.join(dataDir, 'versions.json'), JSON.stringify(versions, null, 2));
fs.writeFileSync(path.join(dataDir, 'logs.jsonl'), logs.map(item => JSON.stringify(item)).join('\n') + '\n');
fs.writeFileSync(path.join(dataDir, 'feedback.json'), JSON.stringify([
  { logId: 'before', rating: 'good' }, { logId: 'after', rating: 'bad' }, { logId: 'boundary', rating: 'good' }
], null, 2));

const port = 5000 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = async url => { const response = await fetch(base + url); return { status: response.status, body: await response.json() }; };
let passed = 0; let failed = 0;
function check(label, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}${extra ? `  →  ${extra}` : ''}`); }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`); }
}

async function main() {
  try {
    let ready = false;
    for (let i = 0; i < 30; i += 1) {
      await wait(100);
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch { /* 启动中 */ }
    }
    if (!ready) throw new Error(`测试服务启动失败：${serverLog.trim() || '无日志'}`);
    const response = await get('/api/prompts/1/release-comparison?version=v1.1&beforeDays=1&afterDays=1');
    check('发布对比路由返回 200', response.status === 200, String(response.status));
    const report = response.body;
    check('发布记录时间作为窗口边界', report.windows.before.to === releaseAt && report.windows.after.from === releaseAt);
    check('边界时刻样本计入发布后窗口', report.before.calls === 1 && report.after.calls === 2, `${report.before.calls}/${report.after.calls}`);
    check('按 Prompt 名称和版本关联日志', report.after.calls === 2 && report.after.failed === 1);
    check('多 Prompt 日志成本按版本数均摊', report.before.cost === 0.003, String(report.before.cost));
    check('失败、Schema 错误和重试率正确', report.after.failureRate === 50 && report.after.schemaErrorRate === 50 && report.after.retryRate === 50);
    check('反馈 good/bad 统计正确', report.before.feedback.positiveRate === 100 && report.after.feedback.positiveRate === 50);
    const serialized = JSON.stringify(report);
    check('报告不包含 JD、简历或 Prompt 正文', !serialized.includes('不应出现在报告中的 Prompt 正文') && !serialized.includes('简历') && !serialized.includes('JD'));
    const missingVersion = await get('/api/prompts/1/release-comparison?version=v9.9');
    check('不存在版本返回 not_found', missingVersion.status === 200 && missingVersion.body.status === 'not_found');
    const missingPrompt = await get('/api/prompts/999/release-comparison?version=v1.1');
    check('不存在 Prompt 返回 404', missingPrompt.status === 404 && missingPrompt.body.code === 'NOT_FOUND');
    fs.writeFileSync(path.join(dataDir, 'logs.jsonl'), JSON.stringify({ id: 'only-before', at: beforeAt, ok: true, promptVersions: [{ name: prompt.name, version: 'v1.1' }] }) + '\n');
    const insufficient = await get('/api/prompts/1/release-comparison?version=v1.1&beforeDays=1&afterDays=1');
    check('任一窗口无样本返回 insufficient_data', insufficient.body.status === 'insufficient_data' && insufficient.body.after.calls === 0);
  } finally {
    server.kill('SIGKILL');
    await wait(100);
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
  }
  console.log(`\n────────  发布对比验证通过 ${passed} · 失败 ${failed}  ────────`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); try { server.kill('SIGKILL'); } catch { /* noop */ } process.exit(1); });
