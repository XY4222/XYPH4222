#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-prompt-test-verify-'));
fs.cpSync(PROJECT, staged, {
  recursive: true,
  filter(source) {
    const top = path.relative(PROJECT, source).split(path.sep)[0];
    return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
  }
});

const port = 5600 + Math.floor(Math.random() * 250);
let base = `http://127.0.0.1:${port}`;
let server;
let serverLog = '';

function startServer(activePort, extraEnv = {}) {
  serverLog = '';
  server = spawn(process.execPath, ['server.js'], {
    cwd: staged,
    env: {
      ...process.env, PORT: String(activePort), NODE_ENV: 'test', ADMIN_AUTH_DISABLED: 'true',
      PROMPT_TEST_MOCK: 'true', ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  base = `http://127.0.0.1:${activePort}`;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
function check(label, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${label}${extra ? `  →  ${extra}` : ''}`); }
  else { failed += 1; console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`); }
}

async function call(url, { method = 'GET', body } = {}) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(100);
    try { if ((await call('/api/health')).status === 200) return true; } catch { /* starting */ }
  }
  return false;
}

async function main() {
  try {
    startServer(port);
    if (!await waitForServer()) throw new Error(`测试服务启动失败：${serverLog.trim() || '无日志'}`);

    const adminHtml = fs.readFileSync(path.join(PROJECT, 'admin.html'), 'utf8');
    const adminJs = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8');
    check('后台包含 Prompt 测试台菜单', /data-route="tests"/.test(adminHtml));
    check('后台包含测试台路由与视图', /tests:\s*'Prompt 测试台'/.test(adminJs) && /function viewTests\(/.test(adminJs));
    const editorGuard = adminJs.indexOf("${can('editor') ? `<div class=\"test-actions\"");
    const saveButton = adminJs.indexOf('id="saveTestCase"');
    const runButton = adminJs.indexOf('id="runPromptTest"');
    const viewerBranch = adminJs.indexOf("当前为查看者权限", editorGuard);
    check('查看者界面不渲染运行与保存按钮', editorGuard >= 0 && saveButton > editorGuard
      && runButton > saveButton && viewerBranch > runButton);

    const list = await call('/api/prompts');
    const target = list.body.items[0];
    const original = await call(`/api/prompts/${target.id}`);
    const draftText = `${original.body.prompt.content}\n这是测试台草稿专属规则。`;
    await call(`/api/prompts/${target.id}`, { method: 'PUT', body: { content: draftText } });

    const emptyInput = await call(`/api/prompts/${target.id}/test`, { method: 'POST', body: {} });
    check('空测试字段返回 400', emptyInput.status === 400 && emptyInput.body.code === 'BAD_REQUEST');
    const whitespaceInput = await call(`/api/prompts/${target.id}/test`, {
      method: 'POST', body: { role: '   ', jd: '  ', resume: '\n' }
    });
    check('纯空格测试字段返回 400', whitespaceInput.status === 400 && whitespaceInput.body.code === 'BAD_REQUEST');
    const invalidVariants = await call(`/api/prompts/${target.id}/test`, {
      method: 'POST', body: { role: '测试', jd: '测试 JD', resume: '测试简历', variants: ['unknown'] }
    });
    check('无有效测试版本返回 400', invalidVariants.status === 400 && invalidVariants.body.code === 'INVALID_TEST_VARIANTS');

    const tested = await call(`/api/prompts/${target.id}/test`, {
      method: 'POST',
      body: {
        role: 'AI 产品经理', jd: 'SENSITIVE_JD_7f91 负责 AI 产品规划和 Agent 设计',
        resume: 'SENSITIVE_RESUME_3a42 候选人有五年 B 端产品经验', extra: '仅使用真实经历', variants: ['published', 'draft']
      }
    });
    check('草稿与生产版本可以并行测试', tested.status === 200, String(tested.status));
    check('两侧结果都成功', tested.body.results.published.ok && tested.body.results.draft.ok);
    check('生产测试使用生产快照', !tested.body.results.published.analysis.finalResume.includes('测试台草稿专属规则'));
    check('草稿测试使用工作副本', tested.body.results.draft.analysis.finalResume.includes('测试台草稿专属规则'));
    check('返回耗时、Token 与成本', ['published', 'draft'].every(key =>
      Number.isFinite(tested.body.results[key].latencyMs)
      && tested.body.results[key].usage.total_tokens === 200
      && Number.isFinite(tested.body.results[key].cost)));
    check('返回版本比较摘要', tested.body.comparison.finalResumeChanged === true && tested.body.comparison.scoreDelta === 6);
    const afterTest = await call(`/api/prompts/${target.id}`);
    check('测试运行不会修改 Prompt', afterTest.body.prompt.content === draftText && afterTest.body.prompt.publishedVersion === original.body.prompt.publishedVersion);

    const unpublished = await call('/api/prompts', {
      method: 'POST', body: { name: '未发布测试 Prompt', content: '仅有草稿', enabled: true }
    });
    const noProduction = await call(`/api/prompts/${unpublished.body.prompt.id}/test`, {
      method: 'POST', body: { role: '测试岗位', jd: '测试 JD', resume: '测试简历', variants: ['published'] }
    });
    check('无生产版本返回可读错误', noProduction.status === 409
      && noProduction.body.results.published.code === 'NO_PUBLISHED_VERSION');

    const saved = await call('/api/test-cases', {
      method: 'POST', body: {
        name: 'AI 产品经理基础案例', role: 'AI 产品经理',
        jd: '负责 AI 产品规划和 Agent 设计', resume: '候选人有五年 B 端产品经验', extra: '仅使用真实经历'
      }
    });
    check('可以保存测试案例', saved.status === 201 && !!saved.body.item.id);
    const cases = await call('/api/test-cases');
    check('可以读取测试案例', cases.body.items.some(item => item.id === saved.body.item.id));

    const runs = await call(`/api/prompt-tests?promptId=${target.id}`);
    check('测试运行被记录', runs.body.items.length === 2, String(runs.body.items.length));
    check('运行记录不保存简历原文', runs.body.items.every(item => !('resume' in item) && !('jd' in item)));
    const serializedRuns = JSON.stringify(runs.body.items);
    check('运行记录任何字段都不包含输入哨兵', !serializedRuns.includes('SENSITIVE_JD_7f91')
      && !serializedRuns.includes('SENSITIVE_RESUME_3a42'));

    const whitespaceCase = await call('/api/test-cases', {
      method: 'POST', body: { name: '空白案例', role: ' ', jd: '\t', resume: '\n' }
    });
    check('纯空格案例字段返回 400', whitespaceCase.status === 400 && whitespaceCase.body.code === 'INVALID_TEST_CASE');

    const removed = await call(`/api/test-cases/${saved.body.item.id}`, { method: 'DELETE' });
    check('管理员可以删除测试案例', removed.status === 200);
    const changes = await call('/api/changes?limit=20');
    check('测试案例保存与删除写入审计', ['test_case_create', 'test_case_delete'].every(action =>
      changes.body.items.some(item => item.action === action && item.actor === 'auth-disabled')));

    server.kill('SIGKILL');
    await wait(200);
    startServer(port + 1, { PROMPT_TEST_MOCK_FAIL: 'true' });
    if (!await waitForServer()) throw new Error(`失败场景测试服务启动失败：${serverLog.trim() || '无日志'}`);
    const failedList = await call('/api/prompts');
    const failedRun = await call(`/api/prompts/${failedList.body.items[0].id}/test`, {
      method: 'POST', body: { role: '失败测试', jd: '测试 JD', resume: '测试简历', variants: ['published', 'draft'] }
    });
    check('生产与草稿都失败时返回 502', failedRun.status === 502);
    check('双侧失败响应保留错误详情', failedRun.body.results.published.code === 'PROMPT_TEST_MOCK_FAILED'
      && failedRun.body.results.draft.code === 'PROMPT_TEST_MOCK_FAILED');
    const failedLogs = await call(`/api/prompt-tests?promptId=${failedList.body.items[0].id}`);
    check('失败测试仍写入运行记录', failedLogs.body.items.filter(item => item.role === '失败测试' && !item.ok).length === 2);
  } finally {
    if (server) server.kill('SIGKILL');
    await wait(150);
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* noop */ }
  }

  console.log(`\n────────  测试台通过 ${passed} · 失败 ${failed}  ────────`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  if (serverLog.trim()) console.error(serverLog.trim());
  try { server.kill('SIGKILL'); } catch { /* noop */ }
  process.exit(1);
});
