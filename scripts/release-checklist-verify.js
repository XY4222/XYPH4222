#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-checklist-verify-'));
fs.cpSync(project, staged, { recursive: true, filter(source) {
  const top = path.relative(project, source).split(path.sep)[0];
  return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
} });

const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const prompt = store.getPrompt(1);
let checklist = store.releaseChecklist(prompt);
assert(checklist.ready === true, 'seed checklist should be ready without cases');
assert(checklist.checks.some(item => item.id === 'regression' && !item.blocking), 'missing cases is a warning');
store.updatePrompt(1, { desc: 'checklist draft' }, 'verify');
store.createTestCase({ promptId: 1, name: 'checklist case', role: '产品经理', jd: 'jd', resume: 'resume', minScore: 0, maxScoreDrop: 5, requiredTerms: [] }, 'verify');
checklist = store.releaseChecklist(store.getPrompt(1));
assert(checklist.ready === false, 'configured cases require a fresh regression');
try { store.submitPromptReview(1, { actor: 'verify' }); throw new Error('stale checklist should block'); } catch (error) { assert(error.code === 'REGRESSION_GATE_FAILED' && error.checklist && error.checklist.ready === false, 'block includes checklist'); }
console.log('release checklist verification passed');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);
