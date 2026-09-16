#!/usr/bin/env node
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const PROJECT = path.resolve(__dirname, '..'); const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-template-batch-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const port = 6400 + Math.floor(Math.random() * 100); const base = `http://127.0.0.1:${port}`; const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; });
let passed = 0; let failed = 0; const wait = ms => new Promise(r => setTimeout(r, ms)); function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function call(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; }
async function main() { try {
  let ready = false; for (let i = 0; i < 30; i++) { await wait(100); try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {} } if (!ready) throw new Error(log || '服务启动失败');
  const templates = await call('/api/templates'); check('模板列表可读取', templates.status === 200 && templates.body.items.length >= 2);
  const created = await call(`/api/templates/${templates.body.items[0].id}/create`, 'POST', {}); check('模板创建草稿', created.status === 201 && created.body.prompt.releaseStatus === 'draft');
  const prompts = await call('/api/prompts'); const ids = prompts.body.items.slice(0, 2).map(item => item.id); const batch = await call('/api/prompts/batch', 'POST', { ids, action: 'disable' }); check('批量停用返回逐项结果', batch.status === 200 && batch.body.total === 2 && batch.body.succeeded === 2 && batch.body.results.every(item => item.ok));
  const invalid = await call('/api/prompts/batch', 'POST', { ids: [], action: 'enable' }); check('空批量选择返回 400', invalid.status === 400 && invalid.body.code === 'EMPTY_BATCH');
  const mixed = await call('/api/prompts/batch', 'POST', { ids: [ids[0], 'missing'], action: 'enable' }); check('批量部分失败不伪造成功', mixed.status === 200 && mixed.body.succeeded === 1 && mixed.body.failed === 1 && mixed.body.results.some(item => !item.ok));
  const changes = await call('/api/changes?limit=50'); check('模板与批量操作写入审计', changes.body.items.some(item => item.action === 'create') && changes.body.items.some(item => item.action === 'enable'));
} finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} } console.log(`\n────────  模板批量通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0); }
main().catch(error => { console.error(error); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
