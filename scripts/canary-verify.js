#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-canary-verify-'));
fs.cpSync(project, staged, { recursive: true, filter(source) {
  const top = path.relative(project, source).split(path.sep)[0];
  return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
} });

const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const first = store.getPrompt(1);
assert(first && first.publishedSnapshot, 'seed prompt must be published');
assert(store.startCanary(1, { trafficPercent: 25, actor: 'verify' }).canary, 'canary starts');
const active = store.getPrompt(1);
assert(active.publishedVersion === 'v1.0', 'production version unchanged');
const a = store.buildPromptConfig(undefined, { role: 'same-user', jd: 'jd', resume: 'resume' });
const b = store.buildPromptConfig(undefined, { role: 'same-user', jd: 'jd', resume: 'resume' });
assert(JSON.stringify(a.config) === JSON.stringify(b.config), 'same request is stable');
const varied = Array.from({ length: 100 }, (_, i) => store.buildPromptConfig(undefined, { role: 'u' + i, jd: 'jd', resume: 'resume' }));
assert(varied.some(item => item.canary.length > 0) && varied.some(item => item.canary.length === 0), 'traffic split is observable');
const changed = store.setCanaryTraffic(1, 60, 'verify');
assert(changed.canary.trafficPercent === 60, 'traffic updates');
const stopped = store.stopCanary(1, { actor: 'verify', reason: 'test' });
assert(!stopped.canary, 'canary stops');
store.startCanary(1, { trafficPercent: 10, actor: 'verify' });
const promoted = store.promoteCanary(1, { actor: 'verify', note: 'test' });
assert(promoted.publishedVersion === 'v1.0', 'promotion keeps candidate base version');
assert(!promoted.canary, 'promotion clears canary');
const second = store.getPrompt(2);
store.startCanary(2, { trafficPercent: 100, actor: 'verify' });
const secondCanary = store.getPrompt(2).canary;
for (let i = 0; i < 10; i++) store.appendLog({ ok: false, promptVersions: [{ name: second.name, version: secondCanary.version }], validationErrors: [] });
store.buildPromptConfig();
assert(!store.getPrompt(2).canary, 'auto stop triggers at minimum calls');
console.log('canary verification passed');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);
