#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-release-verify-'));
fs.cpSync(PROJECT, staged, {
  recursive: true,
  filter(source) {
    const top = path.relative(PROJECT, source).split(path.sep)[0];
    return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
  }
});

const port = 4800 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: staged,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

let passed = 0;
let failed = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (url, init) => fetch(base + url, init);
const json = async responsePromise => {
  const response = await responsePromise;
  return { status: response.status, body: await response.json() };
};
const post = (url, body, method = 'POST') => json(request(url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {})
}));
const get = url => json(request(url));

function check(label, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}${extra ? `  →  ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`);
  }
}

async function main() {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(100);
      try {
        const health = await request('/api/health');
        if (health.ok) { ready = true; break; }
      } catch { /* 服务仍在启动 */ }
    }
    if (!ready) throw new Error(`测试服务启动失败：${serverLog.trim() || '无日志'}`);
    const initial = await get('/api/prompts');
    const first = initial.body.items[0];
    check('种子 Prompt 初始为已发布', first.releaseStatus === 'published', first.releaseStatus);

    const beforeActive = await get('/api/prompts/active');
    const beforeContent = beforeActive.body.prompts.find(item => item.step === first.step).content;
    const editedContent = `${beforeContent}\n仅用于发布流程自检。`;

    const edited = await post(`/api/prompts/${first.id}`, {
      content: editedContent,
      note: '验证草稿不会直接影响生产',
      actor: '发布流程自检'
    }, 'PUT');
    check('编辑后进入草稿状态', edited.body.prompt.releaseStatus === 'draft', edited.body.prompt.releaseStatus);

    const blockedPublish = await post(`/api/prompts/${first.id}/publish`, {
      note: '不应允许草稿直接发布', actor: '发布流程自检'
    });
    check('草稿不能绕过审核直接发布', blockedPublish.status === 409, String(blockedPublish.status));

    const activeAfterEdit = await get('/api/prompts/active');
    const stillPublished = activeAfterEdit.body.prompts.find(item => item.step === first.step).content;
    check('草稿不会立即影响生产', stillPublished === beforeContent);

    const submitted = await post(`/api/prompts/${first.id}/submit-review`, {
      note: '请审核事实边界', actor: '发布流程自检'
    });
    check('可以提交审核', submitted.body.prompt.releaseStatus === 'review', submitted.body.prompt.releaseStatus);

    const published = await post(`/api/prompts/${first.id}/publish`, {
      note: '回归测试通过', actor: '发布流程自检'
    });
    check('审核版本可以发布', published.body.prompt.releaseStatus === 'published', published.body.prompt.releaseStatus);
    check('发布版本号被记录', published.body.prompt.publishedVersion === published.body.prompt.version,
      published.body.prompt.publishedVersion);

    const activeAfterPublish = await get('/api/prompts/active');
    const nowPublished = activeAfterPublish.body.prompts.find(item => item.step === first.step).content;
    check('发布后生产配置更新', nowPublished === editedContent);

    const detail = await get(`/api/prompts/${first.id}`);
    const draftVersion = detail.body.versions.find(item => item.action === 'update');
    const blockedRollback = await post(`/api/prompts/${first.id}/production-rollback`, {
      vid: draftVersion && draftVersion.vid,
      note: '不应允许未发布快照进入生产', actor: '发布流程自检'
    });
    check('未发布快照不能用于生产回滚', blockedRollback.status === 404, String(blockedRollback.status));
    const oldVersion = detail.body.versions.find(item => item.snapshot && item.snapshot.content === beforeContent);
    const rolled = await post(`/api/prompts/${first.id}/production-rollback`, {
      vid: oldVersion && oldVersion.vid,
      note: '回滚自检', actor: '发布流程自检'
    });
    check('可以一键回滚生产版本', rolled.body.prompt.releaseStatus === 'published');

    const activeAfterRollback = await get('/api/prompts/active');
    const rolledContent = activeAfterRollback.body.prompts.find(item => item.step === first.step).content;
    check('回滚后生产内容恢复', rolledContent === beforeContent);

    const created = await post('/api/prompts', {
      name: '发布流程新建项', content: '新 Prompt 初始只能是草稿', enabled: true,
      actor: '发布流程自检'
    });
    check('新建 Prompt 默认是草稿', created.body.prompt.releaseStatus === 'draft', created.body.prompt.releaseStatus);
    const activeAfterCreate = await get('/api/prompts/active');
    check('未发布的新 Prompt 不进入生产', !activeAfterCreate.body.prompts.some(item => item.name === '发布流程新建项'));

    const publishedDelete = await request(`/api/prompts/${first.id}`, { method: 'DELETE' });
    check('生产启用中的 Prompt 不能直接删除', publishedDelete.status === 409, String(publishedDelete.status));

    const overview = await get('/api/overview');
    check('总览统计草稿数量', overview.body.drafts >= 1, String(overview.body.drafts));
    check('总览返回已发布数量', overview.body.published >= 1, String(overview.body.published));
  } finally {
    server.kill('SIGKILL');
    await wait(150);
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响断言 */ }
  }

  console.log(`\n────────  发布流程通过 ${passed} · 失败 ${failed}  ────────`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  if (serverLog.trim()) console.error(serverLog.trim());
  try { server.kill('SIGKILL'); } catch { /* noop */ }
  process.exit(1);
});
