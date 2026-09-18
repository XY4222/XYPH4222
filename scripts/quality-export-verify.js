#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const project = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(project, 'admin.js'), 'utf8');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(admin.includes('id="exportQuality"'), '质量分析缺少导出按钮');
assert(admin.includes('function exportQuality'), '质量导出函数缺失');
assert(admin.includes('data.byPrompt') && admin.includes('data.byRole') && admin.includes('data.overall'), '质量导出未覆盖三类聚合');
const fn = admin.match(/function exportQuality[\s\S]*?\n  async function loadLogs/);
assert(fn && !/(jd|resume|content)/i.test(fn[0]), '质量导出疑似包含敏感正文');
assert(fn && fn[0].includes('csvCell') && fn[0].includes('质量分析-'), '质量导出未生成安全 CSV');
console.log('质量报告导出验证通过');
