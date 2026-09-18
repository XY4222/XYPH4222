#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const project = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(project, 'admin.html'), 'utf8');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(html.includes('data-route="dashboard"'), '运营总览导航未接入');
assert(admin.includes('function viewDashboard'), '运营总览视图未接入');
assert(admin.includes("api('/api/overview')") && admin.includes("api('/api/quality?days=7')") && admin.includes("api('/api/tasks?days=7&limit=1')") && admin.includes("api('/api/alerts?limit=100')"), '运营总览未从服务端接口取数');
assert(admin.includes('dashboardOpenLogs') && admin.includes('dashboardOpenReleases') && admin.includes('dashboardOpenQuality'), '运营总览快捷入口缺失');
const dashboardView = admin.match(/function viewDashboard[\s\S]*?\n  function viewFeedback/);
assert(dashboardView && !/(jd|resume|content)/i.test(dashboardView[0]), '运营总览疑似包含业务正文');
console.log('运营总览验证通过');
