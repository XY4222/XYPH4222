#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeResume, parseModelJson, upstreamCode } = require('../deepseek');

const valid = {
  score: 70, scoreSummary: '结论', scoreDescription: '说明', highestRisk: '风险', finalResume: '真实简历', intro: '介绍',
  duties: ['职责1', '职责2', '职责3', '职责4'], hard: ['要求1', '要求2', '要求3', '要求4'], implicit: ['隐含1', '隐含2', '隐含3'], ideal: ['特征1', '特征2', '特征3'], keywords: Array.from({ length: 8 }, (_, i) => `词${i}`),
  evidenceToPrepare: ['证据1', '证据2', '证据3', '证据4'], dataGaps: ['缺口1', '缺口2', '缺口3', '缺口4'], capabilities: [['能力', '高', '判断']], dimensions: Array.from({ length: 6 }, (_, i) => [`维度${i}`, 70]), issues: [['P1', '问题', '说明', 'amber']], matches: Array.from({ length: 6 }, (_, i) => [`要求${i}`, '证据', '中', '否', '建议']), questions: Array.from({ length: 5 }, (_, i) => [`问题${i}`, '目的']), comparisons: Array.from({ length: 4 }, (_, i) => [`模块${i}`, '前', '后', '理由', '风险']), interview: Array.from({ length: 10 }, (_, i) => [`追问${i}`, '准备'])
};

async function main() {
  assert.strictEqual(upstreamCode(429), 'RATE_LIMIT');
  assert.strictEqual(upstreamCode(503), 'MODEL_UNAVAILABLE');
  assert.strictEqual(upstreamCode(401), 'MODEL_AUTH_ERROR');
  assert.strictEqual(upstreamCode(400), 'MODEL_REQUEST_REJECTED');

  const originalFetch = global.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 });
  };
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const result = await analyzeResume({ role: '产品经理', jd: 'JD', resume: '简历' }, { settings: { retries: 1, timeoutMs: 1000 } });
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(calls, 2);

  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
  let failure;
  try { await analyzeResume({ role: '产品经理', jd: 'JD', resume: '简历' }, { settings: { retries: 0, timeoutMs: 1000 } }); }
  catch (error) { failure = error; }
  assert.strictEqual(failure.code, 'MODEL_UNAVAILABLE');
  assert.strictEqual(failure.statusCode, 503);

  let schemaFailure;
  try { parseModelJson(JSON.stringify({ duties: ['职责'], matches: [], finalResume: '简历' })); }
  catch (error) { schemaFailure = error; }
  assert.strictEqual(schemaFailure.code, 'INVALID_MODEL_SCHEMA');

  calls = 0;
  global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }); };
  try { await analyzeResume({ role: '产品经理', jd: 'JD', resume: '简历' }, { settings: { retries: 3, timeoutMs: 1000 } }); }
  catch (error) { failure = error; }
  assert.strictEqual(failure.code, 'MODEL_AUTH_ERROR');
  assert.strictEqual(calls, 1, '鉴权错误不应自动重试');

  global.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  });
  try { await analyzeResume({ role: '产品经理', jd: 'JD', resume: '简历' }, { settings: { retries: 0, timeoutMs: 5 } }); }
  catch (error) { failure = error; }
  assert.strictEqual(failure.code, 'UPSTREAM_TIMEOUT');
  assert.strictEqual(failure.attempts, 1);

  const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
  assert.match(appSource, /新请求开始即作废旧结果/);
  assert.match(appSource, /state\.analyzed=false; state\.analysisStatus='running'; state\.degradation=/);
  assert.match(appSource, /state\.analysisStatus==='running'\?'disabled'/);
  assert.match(appSource, /data-action="retry-analysis"/);

  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalKey;
  console.log('降级策略验证通过：限流重试、鉴权停止、旧结果作废和显式重试均符合契约');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
