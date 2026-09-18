#!/usr/bin/env node
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path'); const { spawn } = require('child_process');
const PROJECT = path.resolve(__dirname, '..'); const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-logs-export-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const port = 6500 + Math.floor(Math.random() * 100); const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], { cwd: staged, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', c => { log += c; }); server.stderr.on('data', c => { log += c; }); const wait = ms => new Promise(r => setTimeout(r, ms)); let passed = 0; let failed = 0;
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
async function call(url, method = 'GET', body) { const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json().catch(() => ({})) }; }
async function main() { try {
  let ready = false; for (let i = 0; i < 30; i++) { await wait(100); try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {} } if (!ready) throw new Error(log || '服务启动失败');
  const source = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8');
  check('后台提供运行日志导出入口', source.includes('id="exportLogs"') && source.includes('async function exportLogs'));
  check('导出沿用当前日志筛选条件', source.includes("state.logFilter.ok") && source.includes("state.logFilter.minLatency") && source.includes("limit: '5000'"));
  check('导出字段仅包含安全元数据', source.includes('Prompt 版本') && source.includes('Schema 错误数') && !source.includes('item.jd') && !source.includes('item.resume') && !source.includes('item.content'));
  const logs = await call('/api/logs?days=1&limit=5000');
  check('服务端日志接口支持完整导出上限', logs.status === 200 && Array.isArray(logs.body.items) && !JSON.stringify(logs.body).includes('resumeText'));
  check('日志响应不含业务正文', !JSON.stringify(logs.body).includes('jd') && !JSON.stringify(logs.body).includes('resume'));
} finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} } console.log(`\n──────── 运行日志导出通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0); }
main().catch(error => { console.error(error); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
