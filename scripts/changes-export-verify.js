#!/usr/bin/env node
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const PROJECT = path.resolve(__dirname, '..'); const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-changes-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const port = 6250 + Math.floor(Math.random() * 100); const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; }); const wait = ms => new Promise(r => setTimeout(r, ms)); let passed = 0; let failed = 0;
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function call(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; }
async function main() {
  try {
    let ready = false; for (let i = 0; i < 30; i++) { await wait(100); try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {} }
    if (!ready) throw new Error(log || '服务启动失败');
    const all = await call('/api/changes?limit=120');
    check('变更接口返回分页元数据与操作类型', all.status === 200 && Array.isArray(all.body.items) && Number.isInteger(all.body.total) && Array.isArray(all.body.actions));
    const action = all.body.items.find(item => item.action);
    if (action) {
      const filtered = await call(`/api/changes?limit=120&action=${encodeURIComponent(action.action)}`);
      check('操作类型筛选生效', filtered.body.items.length > 0 && filtered.body.items.every(item => item.action === action.action));
      const actor = action.actor || '管理员';
      const byActor = await call(`/api/changes?limit=120&actor=${encodeURIComponent(actor.slice(0, 3))}`);
      check('操作人筛选生效', byActor.body.items.every(item => String(item.actor || '').toLowerCase().includes(actor.slice(0, 3).toLowerCase())));
    } else { check('操作类型筛选生效', false); check('操作人筛选生效', false); }
    check('审计响应不含快照或正文', !JSON.stringify(all.body).includes('snapshot') && !JSON.stringify(all.body).includes('content'));
    const empty = await call('/api/changes?limit=120&action=__missing__');
    check('无结果筛选返回合法空列表', empty.status === 200 && Array.isArray(empty.body.items) && empty.body.items.length === 0);
    const js = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8');
    check('后台包含筛选与安全 CSV 导出逻辑', js.includes('exportChanges') && js.includes('changeFilter') && js.includes('csvCell') && !js.includes('v.snapshot'));
  } finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} }
  console.log(`\n──────── 变更记录通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0);
}
main().catch(error => { console.error(error); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
