#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const project = path.resolve(__dirname, '..');
const store = require(path.join(project, 'store.js'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const result = store.systemHealth();
const ids = result.checks.map(item => item.id);
assert(['data_files', 'data_dir', 'production_prompts', 'model_provider', 'admin_auth'].every(id => ids.includes(id)), '健康检查项不完整');
assert(['ok', 'warn', 'fail'].includes(result.status), '健康总状态非法');
const serialized = JSON.stringify(result);
assert(!/DEEPSEEK_API_KEY|OPENAI_API_KEY|password|SENSITIVE_JD|SENSITIVE_RESUME/i.test(serialized), '健康结果泄露密钥或业务正文');
const health = fs.readFileSync(path.join(project, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
assert(health.includes("'GET /api/system-health'"), '健康接口未接入');
assert(admin.includes('function viewSystemHealth') && admin.includes("api('/api/system-health')"), '健康页面未接入');
assert(html.includes('data-route="health"'), '健康导航未接入');
console.log('系统健康验证通过');
