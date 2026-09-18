#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-quality-verify-'));
fs.cpSync(project, staged, { recursive: true, filter(source) {
  const top = path.relative(project, source).split(path.sep)[0];
  return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
} });

const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const logA = store.appendLog({ at: new Date().toISOString(), ok: true, model: 'm1', role: '产品经理', prompts: ['JD 解析'], promptVersions: [{ name: 'JD 解析', version: 'v1.0' }], latencyMs: 100, attempts: 1, usage: { total_tokens: 10 }, cost: 0.1 });
const logB = store.appendLog({ at: new Date().toISOString(), ok: false, code: 'MODEL_ERROR', model: 'm1', role: '产品经理', prompts: ['JD 解析'], promptVersions: [{ name: 'JD 解析', version: 'v2.0' }], latencyMs: 300, attempts: 2, usage: { total_tokens: 20 }, cost: 0.2, validationErrors: ['finalResume'] });
store.appendLog({ at: new Date().toISOString(), ok: true, model: 'm2', role: '研发经理', prompts: ['简历诊断'], promptVersions: [{ name: '简历诊断', version: 'v1.0' }], latencyMs: 200, attempts: 1, usage: { total_tokens: 30 }, cost: 0.3 });
store.saveFeedback({ logId: logA, rating: 'good', tags: [], comment: 'ok' }, 'verify');
store.saveFeedback({ logId: logB, rating: 'bad', tags: [], comment: 'bad' }, 'verify');
const result = store.qualityStats(7);
assert(result.overall.calls === 3, 'overall calls');
assert(result.overall.failed === 1 && result.overall.successRate === 66.7, 'overall quality');
const v2 = result.byPrompt.find(item => item.prompt === 'JD 解析' && item.version === 'v2.0');
assert(v2 && v2.failureRate === 100 && v2.schemaErrorRate === 100 && v2.retryRate === 100, 'version metrics');
assert(v2.positiveRate === 0 && v2.feedback === 1, 'feedback metrics');
assert(result.byRole.some(item => item.role === '研发经理' && item.calls === 1), 'role metrics');
console.log('质量分析通过');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);

const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(project, 'server.js'), 'utf8');
if (!html.includes('data-route="quality"') || !admin.includes('function viewQuality')) throw new Error('质量分析页面未接入');
if (!server.includes("'GET /api/quality'")) throw new Error('质量分析接口未接入');
