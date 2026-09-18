#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-tasks-verify-'));
fs.cpSync(project, staged, { recursive: true, filter(source) { const top = path.relative(project, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
fs.mkdirSync(path.join(staged, 'data'), { recursive: true });
const store = require(path.join(staged, 'store.js'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
store.appendLog({ ok: true, role: '产品经理', model: 'm1', promptVersions: [{ name: 'JD', version: 'v1.0' }], usage: { total_tokens: 10 }, cost: 0.1 });
store.appendLog({ ok: false, code: 'UPSTREAM_TIMEOUT', role: '产品经理', model: 'm1', promptVersions: [{ name: 'JD', version: 'v1.1' }], usage: { total_tokens: 20 }, cost: 0.2 });
store.appendLog({ ok: false, code: 'BAD_REQUEST', role: '研发经理', model: 'm2', usage: null, cost: 0 });
const all = store.listTasks({ days: 0, limit: 2 });
assert(all.total === 3 && all.items.length === 2 && all.summary.failed === 2, '分页和汇总');
assert(all.summary.retryable === 1, '重试资格');
assert(!JSON.stringify(all).includes('JD_SECRET') && !JSON.stringify(all).includes('resume'), '任务列表不含正文');
assert(store.listTasks({ status: 'failed', role: '产品', days: 0 }).total === 1, '状态和岗位筛选');
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(project, 'server.js'), 'utf8');
assert(html.includes('data-route="tasks"') && admin.includes('function viewTasks'), '后台任务中心入口');
assert(server.includes("'GET /api/tasks'"), '任务中心接口');
console.log('任务中心通过');
try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
