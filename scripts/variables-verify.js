#!/usr/bin/env node
'use strict';
const store = require('../store');
let passed = 0; let failed = 0;
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
try {
  check('允许变量集合明确', store.PROMPT_VARIABLES.has('role') && store.PROMPT_VARIABLES.has('resume') && !store.PROMPT_VARIABLES.has('secret'));
  check('合法变量可以校验', store.validatePromptContent('岗位 {{role}}\nJD {{jd}}') .length === 2);
  let unknownCode = ''; try { store.validatePromptContent('{{unknown}}'); } catch (error) { unknownCode = error.code; }
  check('未知变量返回明确错误', unknownCode === 'UNKNOWN_PROMPT_VARIABLE');
  check('运行时变量由服务端替换', store.replacePromptVariables('岗位={{role}} JD={{jd}}', { role: '产品经理', jd: 'JD文本' }) === '岗位=产品经理 JD=JD文本');
  check('缺少运行变量不会伪造为空', store.replacePromptVariables('{{role}} {{missing}}', { role: '产品经理' }).includes('{{missing}}'));
} finally { /* no-op */ }
console.log(`\n────────  Prompt 变量通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0);
