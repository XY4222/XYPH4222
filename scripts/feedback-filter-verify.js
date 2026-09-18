#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const project = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(admin.includes('feedbackStatusFilter') && admin.includes('feedbackRatingFilter') && admin.includes('feedbackPromptFilter'), '反馈筛选控件缺失');
assert(admin.includes('Object.entries(state.feedbackFilter)') && admin.includes('params.set(key, value)'), '反馈筛选未传给服务端');
assert(admin.includes('clearFeedbackFilters'), '反馈筛选缺少清除入口');
const view = admin.match(/function viewFeedback[\s\S]*?\n  function viewRules/);
assert(view && !/(jd|resume|content)/i.test(view[0]), '反馈页筛选区域疑似泄露正文');
console.log('质量反馈筛选验证通过');
