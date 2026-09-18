#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-rejection-note-'));
fs.cpSync(project, staged, { recursive: true, filter(source) { const top = path.relative(project, source).split(path.sep)[0]; return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git'); } });
const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const p = store.getPrompt(1); store.updatePrompt(1, { content: p.content + ' draft' }, 'verify'); store.submitPromptReview(1, { actor: 'verify', note: '审查' });
let rejected = false; try { store.rejectPromptReview(1, { actor: 'verify', note: '  ' }); } catch (error) { rejected = error.code === 'REJECTION_NOTE_REQUIRED' && error.statusCode === 400; }
assert(rejected, 'empty rejection reason blocked');
const result = store.rejectPromptReview(1, { actor: 'verify', note: '事实边界需要补充证据' });
assert(result.reviewNote === '事实边界需要补充证据' && result.releaseStatus === 'draft', 'reason persisted');
assert(store.listVersions(1, 5).some(item => item.action === 'reject_review' && item.note === '事实边界需要补充证据'), 'reason audited');
console.log('驳回理由验证通过');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); if (result.status !== 0) process.exit(result.status || 1);
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
if (!admin.includes('驳回审核必须填写理由')) throw new Error('前端未要求驳回理由');
