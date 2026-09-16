#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-monitoring-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });
const store = require(path.join(staged, 'store.js'));
let passed = 0; let failed = 0;
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }
try {
  const now = new Date().toISOString();
  store.saveSettings({ alertFailureRate: 25, alertSchemaErrorRate: 25, alertRetryRate: 25, alertMinCalls: 1 }, '监控测试');
  store.appendLog({ at: now, ok: true, model: 'model-a', modelReturned: 'model-a', latencyMs: 1000, attempts: 1, role: '产品经理', prompts: ['JD 解析'], promptVersions: [{ name: 'JD 解析', version: 'v1.0' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, inputChars: 500, truncated: [], dropped: [] });
  store.appendLog({ at: now, ok: true, model: 'model-a', modelReturned: 'model-a', latencyMs: 5000, attempts: 2, role: '运营经理', prompts: ['JD 解析', '简历诊断'], promptVersions: [{ name: 'JD 解析', version: 'v1.1' }, { name: '简历诊断', version: 'v1.0' }], usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }, inputChars: 1500, truncated: [{ name: 'JD 解析' }], dropped: [{ name: '简历诊断' }] });
  store.appendLog({ at: now, ok: false, model: 'model-b', latencyMs: 200, attempts: 1, role: '产品经理', prompts: ['简历诊断'], code: 'UPSTREAM_TIMEOUT', error: 'SENSITIVE_RESUME_SHOULD_NOT_PERSIST' });
  store.appendLog({ at: now, ok: false, model: 'model-b', latencyMs: 220, attempts: 2, role: '产品经理', prompts: ['简历诊断'], promptVersions: [{ name: '简历诊断', version: 'v1.0' }], code: 'INVALID_MODEL_SCHEMA', validationErrors: ['score', 'dimensions.score'], error: 'SENSITIVE_SCHEMA_DETAIL_SHOULD_NOT_PERSIST' });
  const stats = store.logStats(7);
  check('计算 P50/P95/P99 耗时', stats.p50Latency === 1000 && stats.p95Latency === 5000 && stats.p99Latency === 5000);
  check('计算重试率和平均输入规模', stats.retryCalls === 2 && stats.retryRate === 50 && stats.avgInputChars === 500);
  check('按模型聚合成功率与成本', stats.byModel.some(item => item.model === 'model-a' && item.total === 2 && item.successRate === 100));
  check('按 Prompt 聚合截断和丢弃', stats.byPrompt.some(item => item.prompt === 'JD 解析' && item.truncated === 1) && stats.byPrompt.some(item => item.prompt === '简历诊断' && item.dropped === 1));
  check('最慢请求按耗时排序', stats.slowest[0].latencyMs === 5000 && stats.slowest[1].latencyMs === 1000);
  check('模型、Prompt 筛选项完整', stats.filters.models.includes('model-a') && stats.filters.models.includes('model-b') && stats.filters.prompts.includes('JD 解析'));
  check('服务端支持组合筛选', store.readLogs({ model: 'model-a', prompt: 'JD 解析', minLatency: 3000 }).rows.length === 1);
  const raw = fs.readFileSync(store.FILES.logs, 'utf8');
  check('失败日志不保存上游原始错误文本', !raw.includes('SENSITIVE_RESUME_SHOULD_NOT_PERSIST') && !raw.includes('SENSITIVE_SCHEMA_DETAIL_SHOULD_NOT_PERSIST') && raw.includes('上游超时'));
  check('Schema 错误字段进入聚合统计', stats.schemaFields.some(item => item.field === 'score' && item.count >= 1) && stats.schemaFields.some(item => item.field === 'dimensions.score'));
  check('Prompt 版本进入质量对比统计', stats.byPromptVersion.some(item => item.prompt === 'JD 解析' && item.version === 'v1.1' && item.calls === 1 && item.retryRate === 100));
  check('失败调用也关联实际 Prompt 版本', stats.byPromptVersion.some(item => item.prompt === '简历诊断' && item.version === 'v1.0' && item.failed === 1 && item.schemaErrors === 1));
  check('异常阈值告警按区间统计触发', stats.alerts.some(item => item.scope === 'overall' && item.metric === 'failureRate') && stats.alerts.some(item => item.scope === '简历诊断@v1.0' && item.metric === 'schemaErrorRate'));
  check('Schema 告警按请求计数而非字段计数', stats.alerts.find(item => item.scope === 'overall' && item.metric === 'schemaErrorRate')?.rate === 25);
  const alert = stats.alerts.find(item => item.scope === 'overall' && item.metric === 'failureRate');
  const ack = store.acknowledgeAlert(alert.id, '监控管理员');
  const acknowledged = store.logStats(7).alerts.find(item => item.id === alert.id);
  check('告警确认状态持久化并回显', ack.id === alert.id && acknowledged?.acknowledged === true && acknowledged.acknowledgedBy === '监控管理员' && store.listAlertHistory()[0].id === alert.id);
  store.saveSettings({ alertFailureRate: 100, alertSchemaErrorRate: 100, alertRetryRate: 100 }, '监控测试');
  const recovered = store.logStats(7).alertHistory.find(item => item.id === alert.id);
  check('异常解除后告警标记为已恢复', recovered?.status === 'recovered' && recovered.recoveredAt);
  try { store.acknowledgeAlert('bad id', '监控管理员'); check('非法告警 ID 被拒绝', false); } catch (error) { check('非法告警 ID 被拒绝', error.code === 'INVALID_ALERT_ID'); }
  const statWithFilter = store.logStats(7, { model: 'model-a', minLatency: 3000 });
  check('统计接口与明细接口使用同一筛选口径', statWithFilter.total === 1 && statWithFilter.byModel[0].model === 'model-a');
} finally { try { fs.rmSync(staged, { recursive: true, force: true }); } catch {} }
console.log(`\n────────  运行监控通过 ${passed} · 失败 ${failed}  ────────`);
process.exit(failed ? 1 : 0);
