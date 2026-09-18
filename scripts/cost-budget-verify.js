#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const project = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-cost-budget-'));
fs.cpSync(project, staged, { recursive: true, filter(source) { const top = path.relative(project, source).split(path.sep)[0]; return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git'); } });
const probe = `
const store = require(${JSON.stringify(path.join(staged, 'store.js'))});
const assert = (ok, message) => { if (!ok) throw new Error(message); };
store.saveSettings({ inputPricePerM: 100, outputPricePerM: 100, dailyCostBudget: 0 }, 'verify');
const disabled = store.costBudgetStatus(); assert(disabled.enabled === false && disabled.remaining === null, 'zero disables budget');
store.appendLog({ at: new Date().toISOString(), ok: true, usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });
store.saveSettings({ dailyCostBudget: 0.1 }, 'verify');
const status = store.costBudgetStatus();
assert(status.enabled && status.spent === 0.2 && status.exceeded === true && status.remaining === 0, 'budget computes and flags overage');
console.log('成本预算验证通过');
`;
const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
process.stdout.write(result.stdout); process.stderr.write(result.stderr); if (result.status !== 0) process.exit(result.status || 1);
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const server = fs.readFileSync(path.join(project, 'server.js'), 'utf8');
if (!admin.includes('s-dailyCostBudget')) throw new Error('预算设置未接入');
if (!server.includes("'GET /api/cost-budget'")) throw new Error('预算接口未接入');
if (!admin.includes('budget-summary') || !admin.includes('已超预算') || !admin.includes('预算监控未启用')) throw new Error('运营总览未显示预算状态');
