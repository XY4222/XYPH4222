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
  check('模板列表返回分类选项', Array.isArray(templates.body.categories) && templates.body.categories.includes('证据校验'));
  const templateId = templates.body.items[0].id;
  const updated = await call(`/api/templates/${templateId}`, 'PUT', { category: '证据校验', tags: ['回归', '事实边界'] });
  check('模板可编辑分类与标签', updated.status === 200 && updated.body.item.category === '证据校验' && updated.body.item.tags.length === 2 && updated.body.item.version === 'v1.1');
  await call(`/api/templates/${templateId}`, 'PUT', { name: '临时模板名称' });
  const versions = await call(`/api/templates/${templateId}/versions`);
  check('模板编辑生成版本记录且保留初始版本', versions.status === 200 && versions.body.items.length === 3 && versions.body.items.some(item => item.version === 'v1.0'));
  const rolled = await call(`/api/templates/${templateId}/rollback`, 'POST', { versionId: versions.body.items.find(item => item.version === 'v1.1').id });
  check('模板可回滚且生成新版本', rolled.status === 200 && rolled.body.item.name === updated.body.item.name && rolled.body.item.version === 'v1.3');
  const beforeFailedRollback = await call('/api/templates');
  const beforeFailedVersions = await call(`/api/templates/${templateId}/versions`);
  const beforeFailedChanges = await call('/api/changes?limit=100');
  const writeBlocker = path.join(staged, 'data', 'templates.json.tmp');
  fs.mkdirSync(writeBlocker);
  const failedRollback = await call(`/api/templates/${templateId}/rollback`, 'POST', { versionId: beforeFailedVersions.body.items[0].id });
  fs.rmSync(writeBlocker, { recursive: true, force: true });
  const afterFailedRollback = await call('/api/templates');
  const afterFailedVersions = await call(`/api/templates/${templateId}/versions`);
  const afterFailedChanges = await call('/api/changes?limit=100');
  check('回滚写入失败时返回错误', failedRollback.status === 500);
  const beforeFailedItem = beforeFailedRollback.body.items.find(item => item.id === templateId);
  const afterFailedItem = afterFailedRollback.body.items.find(item => item.id === templateId);
  check('回滚失败不改变模板、版本或审计', afterFailedItem?.version === beforeFailedItem?.version && afterFailedVersions.body.items.length === beforeFailedVersions.body.items.length && afterFailedChanges.body.items.length === beforeFailedChanges.body.items.length);
  const emptyTemplate = await call(`/api/templates/${templateId}`, 'PUT', { content: '   ' }); check('服务端拒绝空模板内容', emptyTemplate.status === 400 && emptyTemplate.body.code === 'EMPTY_TEMPLATE_CONTENT');
  const searched = await call('/api/templates?q=事实边界&category=证据校验');
  check('模板支持服务端搜索与分类筛选', searched.status === 200 && searched.body.items.some(item => item.id === templateId));
  const archived = await call(`/api/templates/${templateId}/archive`, 'POST', { archived: true });
  check('模板可归档且默认列表隐藏', archived.status === 200 && archived.body.item.archived === true && !(await call('/api/templates')).body.items.some(item => item.id === templateId));
  const restored = await call(`/api/templates/${templateId}/archive`, 'POST', { archived: false });
  check('模板可恢复并在列表出现', restored.status === 200 && restored.body.item.archived === false && (await call('/api/templates')).body.items.some(item => item.id === templateId));
  const adminSource = await (await fetch(base + '/admin.js')).text(); check('后台提供模板编辑、版本和归档入口', ['data-template-edit', 'data-template-history', 'data-template-archive'].every(marker => adminSource.includes(marker)));
  const created = await call(`/api/templates/${templates.body.items[0].id}/create`, 'POST', {}); check('模板创建草稿', created.status === 201 && created.body.prompt.releaseStatus === 'draft');
  const prompts = await call('/api/prompts'); const ids = prompts.body.items.slice(0, 2).map(item => item.id); const batch = await call('/api/prompts/batch', 'POST', { ids, action: 'disable' }); check('批量停用返回逐项结果', batch.status === 200 && batch.body.total === 2 && batch.body.succeeded === 2 && batch.body.results.every(item => item.ok));
  const invalid = await call('/api/prompts/batch', 'POST', { ids: [], action: 'enable' }); check('空批量选择返回 400', invalid.status === 400 && invalid.body.code === 'EMPTY_BATCH');
  const mixed = await call('/api/prompts/batch', 'POST', { ids: [ids[0], 'missing'], action: 'enable' }); check('批量部分失败不伪造成功', mixed.status === 200 && mixed.body.succeeded === 1 && mixed.body.failed === 1 && mixed.body.results.some(item => !item.ok));
  const changes = await call('/api/changes?limit=100'); check('模板与批量操作写入审计', changes.body.items.some(item => item.action === 'create') && changes.body.items.some(item => item.action === 'enable') && changes.body.items.some(item => item.action === 'template_update') && changes.body.items.some(item => item.action === 'template_archive'));
} finally { server.kill('SIGKILL'); await wait(150); try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} } console.log(`\n────────  模板批量通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0); }
main().catch(error => { console.error(error); if (log) console.error(log); try { server.kill('SIGKILL'); } catch {} process.exit(1); });
