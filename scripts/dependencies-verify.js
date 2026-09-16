#!/usr/bin/env node
'use strict';
const store = require('../store');
let passed = 0; let failed = 0; function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
const view = store.dependencyView();
check('依赖视图返回 8 个固定步骤', Array.isArray(view.steps) && view.steps.length === 8);
check('每个步骤包含覆盖与草稿状态', view.steps.every(step => typeof step.covered === 'boolean' && typeof step.hasDraft === 'boolean' && Array.isArray(step.prompts)));
check('步骤 Prompt 返回变量与门禁元数据', view.steps.every(step => step.prompts.every(prompt => Array.isArray(prompt.variables) && Number.isInteger(prompt.regressionCases))));
check('依赖视图列出启用风险规则', Array.isArray(view.enabledRules));
console.log(`\n────────  流程依赖通过 ${passed} · 失败 ${failed} ────────`); process.exit(failed ? 1 : 0);
