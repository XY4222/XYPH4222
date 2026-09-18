#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-experiments-verify-'));
fs.cpSync(project, staged, { recursive: true, filter(source) {
  const top = path.relative(project, source).split(path.sep)[0];
  return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
} });

const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const prompt = store.getPrompt(1);
store.startCanary(1, { trafficPercent: 20, actor: 'verify' });
const active = store.getPrompt(1);
const source = active.canary.sourceVersion;
const candidate = active.canary.version;
for (let i = 0; i < 10; i++) store.appendLog({ at: new Date().toISOString(), ok: true, promptVersions: [{ name: prompt.name, version: source }], latencyMs: 100 + i, attempts: 1, usage: { total_tokens: 100 }, cost: 0.01 });
for (let i = 0; i < 10; i++) store.appendLog({ at: new Date().toISOString(), ok: i < 9, promptVersions: [{ name: prompt.name, version: candidate }], latencyMs: 200 + i, attempts: i < 2 ? 2 : 1, usage: { total_tokens: 200 }, cost: 0.02, validationErrors: i === 9 ? ['score'] : [] });
const result = store.experiments(7);
assert(result.items.length === 1, 'one active experiment');
const item = result.items[0];
assert(item.control.calls === 10 && item.candidate.calls === 10, 'control/candidate aggregation');
assert(item.control.successRate === 100 && item.candidate.failureRate === 10, 'success and failure rates');
assert(item.candidate.schemaErrorRate === 10 && item.candidate.retryRate === 20, 'schema and retry rates');
assert(item.control.p50Latency === 104 && item.candidate.p95Latency === 208, 'latency percentiles');
assert(item.status === 'candidate_worse' && item.sufficientData === true, 'conclusion status');
const feedbackLog = store.appendLog({ at: new Date().toISOString(), ok: true, promptVersions: [{ name: prompt.name, version: candidate }] });
store.saveFeedback({ logId: feedbackLog, rating: 'good', tags: [], comment: 'internal' }, 'verify');
const withFeedback = store.experiments(7).items[0];
assert(withFeedback.candidate.feedback.good === 1 && withFeedback.candidate.feedback.positiveRate === 100, 'feedback joins by log id');
store.stopCanary(1, { actor: 'verify' });
assert(store.experiments(7).items.length === 0, 'empty experiment list');
console.log('实验中心验证通过');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);

const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(project, 'server.js'), 'utf8');
if (!html.includes('data-route="experiments"') || !admin.includes('function viewExperiments')) throw new Error('实验中心页面未接入');
if (!server.includes("'GET /api/experiments'")) throw new Error('实验中心接口未接入');
if (!server.includes("if (method === 'GET') return 'viewer';")) throw new Error('实验中心未走 viewer 鉴权');
if (admin.includes('item.candidateVersion') && /jd|resume|content/i.test(admin.match(/function viewExperiments[\s\S]*?function viewTasks/)[0])) throw new Error('实验中心页面疑似包含正文');
