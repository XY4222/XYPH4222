#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const project = path.resolve(__dirname, '..');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-release-freeze-'));
fs.cpSync(project, staged, { recursive: true, filter(source) { const top = path.relative(project, source).split(path.sep)[0]; return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git'); } });
const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const before = store.getPrompt(1);
store.saveSettings({ releaseFreeze: true, releaseFreezeReason: '模型异常排查' }, 'verify');
assert(store.getSettings().releaseFreeze === true, 'freeze persists');
let blocked = false;
try { store.startCanary(1, { trafficPercent: 10, actor: 'verify' }); } catch (error) { blocked = error.code === 'RELEASE_FROZEN' && error.statusCode === 423 && error.message.includes('模型异常排查'); }
assert(blocked, 'canary start blocked with explicit reason');
assert(store.getPrompt(1).publishedVersion === before.publishedVersion, 'production unchanged');
store.saveSettings({ releaseFreeze: false, releaseFreezeReason: '' }, 'verify');
const started = store.startCanary(1, { trafficPercent: 10, actor: 'verify' });
assert(started.canary && started.canary.version, 'release resumes after unfreeze');
store.stopCanary(1, { actor: 'verify' });
console.log('发布冻结验证通过');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); if (result.status !== 0) process.exit(result.status || 1);
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
assert(admin.includes('s-releaseFreeze') && admin.includes('releaseFreezeReason'), 'settings UI missing');
assert(admin.includes('发布冻结'), 'freeze label missing');
