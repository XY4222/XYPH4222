#!/usr/bin/env node
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const PROJECT = path.resolve(__dirname, '..'); const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-risk-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const port = 6250 + Math.floor(Math.random() * 100); const base = `http://127.0.0.1:${port}`; const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; }); let passed = 0; let failed = 0; const wait = ms => new Promise(r => setTimeout(r, ms));
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function call(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; }
async function main() {
  try {
    let ready = false; for (let i = 0; i < 30; i++) { await wait(100); try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {} }
    if (!ready) throw new Error(log || '服务启动失败');
    const initial = await call('/api/rules'); check('规则接口返回默认规则', initial.status === 200 && initial.body.items.length >= 1);
    const created = await call('/api/rules', 'POST', { name: '禁止测试词', pattern: 'SENSITIVE_RISK_TERM', severity: 'critical', type: 'forbidden_pattern' });
    check('可以创建风险规则', created.status === 201 && created.body.item.severity === 'critical');
    const store = require(path.join(staged, 'store.js'));
    const hit = store.scanRisk('这段输出包含 SENSITIVE_RISK_TERM'); check('服务端扫描返回命中项', !hit.passed && hit.violations.some(item => item.ruleId === created.body.item.id));
    const miss = store.scanRisk('这段输出没有命中'); check('未命中时返回通过', miss.passed && miss.violations.length === 0);
    const invalid = await call('/api/rules', 'POST', { name: '坏规则', pattern: '[' }); check('非法正则返回 400', invalid.status === 400 && invalid.body.code === 'INVALID_RULE_PATTERN');
    const disabled = await call(`/api/rules/${created.body.item.id}`, 'PUT', { enabled: false }); check('规则可以停用', disabled.status === 200 && disabled.body.item.enabled === false);
    check('停用规则不再命中', store.scanRisk('SENSITIVE_RISK_TERM').passed);
    const deleted = await call(`/api/rules/${created.body.item.id}`, 'DELETE'); check('管理员可以删除规则', deleted.status === 200);
    const changes = await call('/api/changes?limit=30'); check('规则操作进入审计', changes.body.items.some(item => item.action === 'rule_create') && changes.body.items.some(item => item.action === 'rule_delete'));
    const html = fs.readFileSync(path.join(PROJECT, 'admin.html'), 'utf8'); const js = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8'); check('后台包含风险规则入口', html.includes('data-route="rules"') && js.includes('function viewRules'));
    const app = fs.readFileSync(path.join(PROJECT, 'app.js'), 'utf8'); check('用户端展示规则命中警告', app.includes('riskCheck') && app.includes('输出风险检查'));
  } finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} }
  console.log(`\n────────  风险规则通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0);
}
main().catch(error => { console.error(error); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
