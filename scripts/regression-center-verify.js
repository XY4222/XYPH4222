#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-regression-center-verify-'));
fs.cpSync(project, staged, { recursive: true, filter(source) {
  const top = path.relative(project, source).split(path.sep)[0];
  return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
} });

const probe = `
const fs = require('fs');
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const prompts = store.getPrompts();
const noCases = store.regressionCenter().items.find(item => item.promptId === prompts[0].id);
assert(noCases.status === 'no_cases', 'no cases status');
const testCase = store.createTestCase({ promptId: prompts[1].id, name: '内部案例', role: '测试岗位', jd: 'SENSITIVE_JD_SENTINEL', resume: 'SENSITIVE_RESUME_SENTINEL' }, 'verify');
let item = store.regressionCenter().items.find(row => row.promptId === prompts[1].id);
assert(item.status === 'not_run' && item.caseCount === 1, 'not run status');
store.appendRegression({ promptId: prompts[1].id, promptName: prompts[1].name, promptVersion: prompts[1].version, promptRevision: prompts[1].revision, suiteKey: store.regressionSuiteKey(prompts[1].id), passed: true, total: 1, failed: 0, actor: 'verify', results: [] });
item = store.regressionCenter().items.find(row => row.promptId === prompts[1].id);
assert(item.status === 'passed' && item.latest.failed === 0, 'passed status');
store.updatePrompt(prompts[1].id, { content: prompts[1].content + ' changed' }, 'verify');
item = store.regressionCenter().items.find(row => row.promptId === prompts[1].id);
assert(item.status === 'stale', 'stale status after prompt change');
store.createTestCase({ promptId: prompts[2].id, name: '失败案例', role: '测试岗位', jd: 'JD', resume: '简历' }, 'verify');
store.appendRegression({ promptId: prompts[2].id, promptName: prompts[2].name, promptVersion: prompts[2].version, promptRevision: prompts[2].revision, suiteKey: store.regressionSuiteKey(prompts[2].id), passed: false, total: 2, failed: 1, actor: 'verify', results: [] });
item = store.regressionCenter().items.find(row => row.promptId === prompts[2].id);
assert(item.status === 'failed', 'failed status');
const publicView = JSON.stringify(store.regressionCenter());
assert(!publicView.includes('SENSITIVE_JD_SENTINEL') && !publicView.includes('SENSITIVE_RESUME_SENTINEL'), 'center does not expose case正文');
console.log('回归中心验证通过');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);

const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(project, 'server.js'), 'utf8');
if (!html.includes('data-route="regressions"') || !admin.includes('function viewRegressionCenter')) throw new Error('回归中心页面未接入');
if (!server.includes("'GET /api/regression-center'")) throw new Error('回归中心接口未接入');
if (!server.includes("if (method === 'GET') return 'viewer';")) throw new Error('回归中心未走 viewer 鉴权');
