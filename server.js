const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyzeResume } = require('./deepseek');
const store = require('./store');
const { createAuth } = require('./auth');

const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

/**
 * 静态资源白名单。
 *
 * 之前是「凡在项目目录下就发」，于是 /server.js、/store.js、/package.json，
 * 以及整个 /data/（Prompt 正文、版本历史、调用日志）都能被直接下载。
 * 现在只认这几个前端资产：不在名单里的一律 404，源码与运行时数据不再对外。
 */
const PUBLIC_FILES = new Map([
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/admin.html', 'admin.html'],
  ['/admin.js', 'admin.js']
]);
const PUBLIC_ALIASES = new Map([['/', '/index.html'], ['/admin', '/admin.html']]);
const port = Number(process.env.PORT || 4173);
const BODY_LIMIT = 120000;
const ADMIN_LIMIT = 400000;
const auth = createAuth();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

async function readBody(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('请求内容过大'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('请求 JSON 格式错误'), { statusCode: 400, code: 'BAD_REQUEST' }); }
}

/** 统一落盘一次调用结果；失败也要记录，否则失败率看板永远是 0。 */
function record(entry) {
  const settings = store.getSettings();
  return store.appendLog({
    at: new Date().toISOString(),
    model: entry.model || settings.model,
    ok: !!entry.ok,
    code: entry.code || null,
    error: entry.error || null,
    latencyMs: entry.latencyMs || 0,
    attempts: entry.attempts || 1,
    usage: entry.usage || null,
    cost: Number(store.costOf(entry.usage, settings).toFixed(6)),
    modelReturned: entry.modelReturned || null,
    role: entry.role || null,
    prompts: entry.prompts || [],
    riskHits: entry.riskHits || [],
    truncated: entry.truncated || [],
    dropped: entry.dropped || [],
    inputChars: entry.inputChars || 0
  });
}

function degradationFor(code, retryAfter = 0) {
  const wait = Math.max(0, Math.min(300, Number(retryAfter) || 0));
  const table = {
    DISABLED: { state: 'paused', retryable: false, message: '分析服务已由管理员暂停' },
    RATE_LIMIT: { state: 'rate_limited', retryable: true, message: '分析请求较多，请稍后重试', defaultWait: 30 },
    UPSTREAM_TIMEOUT: { state: 'timeout', retryable: true, message: '模型响应超时，可重试', defaultWait: 3 },
    MODEL_UNAVAILABLE: { state: 'model_unavailable', retryable: true, message: '模型服务暂时不可用，可稍后重试', defaultWait: 10 },
    MISSING_API_KEY: { state: 'configuration_error', retryable: false, message: '分析服务尚未完成配置' },
    MODEL_AUTH_ERROR: { state: 'configuration_error', retryable: false, message: '模型服务鉴权失败，请联系管理员' },
    MODEL_REQUEST_REJECTED: { state: 'request_rejected', retryable: false, message: '模型服务拒绝了本次请求，请联系管理员检查配置' },
    EMPTY_MODEL_OUTPUT: { state: 'invalid_response', retryable: true, message: '模型未返回有效结果，可重试' },
    INVALID_MODEL_JSON: { state: 'invalid_response', retryable: true, message: '模型返回内容不完整，可重试' },
    BAD_REQUEST: { state: 'invalid_request', retryable: false, message: '请补全目标岗位、JD 和原始简历' },
    PAYLOAD_TOO_LARGE: { state: 'invalid_request', retryable: false, message: '输入内容超过允许长度，请精简后重试' }
  };
  const { defaultWait = 0, ...meta } = table[code] || { state: 'failed', retryable: true, message: '本次分析未完成', defaultWait: 3 };
  return { ...meta, retryAfterSeconds: wait || defaultWait };
}

async function handleAnalyze(req, res) {
  const started = Date.now();
  const settings = store.getSettings();
  let input = null;

  try {
    input = await readBody(req, BODY_LIMIT);
    if (!String(input.role || '').trim() || !String(input.jd || '').trim() || !String(input.resume || '').trim()) {
      const runId = record({ ok: false, code: 'BAD_REQUEST', error: '缺少目标岗位、JD 或原始简历', latencyMs: Date.now() - started });
      return send(res, 400, { error: '缺少目标岗位、JD 或原始简历', code: 'BAD_REQUEST', runId, degradation: degradationFor('BAD_REQUEST') });
    }
    if (!settings.analyzeEnabled) {
      const runId = record({ ok: false, code: 'DISABLED', error: '管理员已暂停分析服务', latencyMs: Date.now() - started, role: input.role });
      return send(res, 503, { error: '管理员已暂停分析服务', code: 'DISABLED', runId, degradation: degradationFor('DISABLED') });
    }

    // Prompt 配置一律以服务端为准，前端不需要自己拼装，也就不会出现浏览器与服务端配置不一致
    const resolved = store.buildPromptConfig(undefined, input);
    const payload = { ...input, promptConfig: resolved.config };

    const result = await analyzeResume(payload, { settings });
    const riskCheck = store.scanRisk(result.analysis?.finalResume);
    const runId = record({
      ok: true, modelReturned: result.model, usage: result.usage, latencyMs: Date.now() - started,
      attempts: result.attempts, role: input.role, prompts: resolved.config.map(p => p.name),
      truncated: resolved.truncated, dropped: resolved.dropped,
      riskHits: riskCheck.violations.map(item => item.ruleId),
      inputChars: String(input.jd || '').length + String(input.resume || '').length
    });
    return send(res, 200, {
      ...result, state: 'completed',
      promptConfig: { applied: resolved.config.length, truncated: resolved.truncated, dropped: resolved.dropped }, riskCheck, runId
    });
  } catch (error) {
    const runId = record({
      ok: false, code: error.code || 'ANALYZE_FAILED', error: error.message || '分析失败',
      latencyMs: Date.now() - started, attempts: error.attempts, role: input?.role
    });
    const code = error.code || 'ANALYZE_FAILED';
    const degradation = degradationFor(code, error.retryAfter);
    if (degradation.retryAfterSeconds > 0) res.setHeader('Retry-After', String(degradation.retryAfterSeconds));
    const safeError = ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE'].includes(code) ? (error.message || degradation.message) : degradation.message;
    return send(res, error.statusCode || 500, { error: safeError, code, runId, degradation });
  }
}

function mockPromptTestResult(variant, resolved) {
  if (process.env.PROMPT_TEST_MOCK_FAIL === 'true') {
    throw Object.assign(new Error(`${variant} 模拟调用失败`), { code: 'PROMPT_TEST_MOCK_FAILED', statusCode: 502 });
  }
  const targetContent = String(resolved.target?.snapshot?.content || '');
  return {
    analysis: {
      duties: ['测试岗位职责'], hardRequirements: ['测试硬性要求'], implicit: ['测试隐性要求'], keywords: ['测试'],
      capabilities: [['Prompt 测试', '高', variant]], dimensions: [['测试维度', 80]],
      score: variant === 'draft' ? 82 : 76, scoreSummary: `${variant} 模拟结果`, scoreDescription: '仅用于自动化验证',
      issues: [], matches: [['测试要求', targetContent.slice(0, 120), '中', '否', '无']], questions: [],
      comparisons: [], interview: [], evidence: [], risks: [], intro: '测试自我介绍', highestRisk: '无',
      finalResume: `${variant}｜${targetContent}`
    },
    model: 'prompt-test-mock', usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }, attempts: 1
  };
}

async function handlePromptTest(req, res, promptId) {
  const parsed = await readBody(req, ADMIN_LIMIT);
  const body = parsed && typeof parsed === 'object' ? parsed : {};
  const prompt = store.getPrompt(promptId);
  if (!prompt) return send(res, 404, { error: 'Prompt 不存在', code: 'NOT_FOUND' });
  const variants = Array.isArray(body.variants) && body.variants.length
    ? [...new Set(body.variants.filter(item => item === 'draft' || item === 'published'))]
    : ['published', 'draft'];
  if (!variants.length) {
    return send(res, 400, { error: '至少选择一个有效测试版本', code: 'INVALID_TEST_VARIANTS' });
  }
  const settings = store.getSettings();
  const input = {
    role: String(body.role || '').trim().slice(0, 100), industry: String(body.industry || '').trim().slice(0, 100),
    company: String(body.company || '').slice(0, 100), stage: String(body.stage || '').slice(0, 100),
    jd: String(body.jd || '').trim(), resume: String(body.resume || '').trim(),
    extra: String(body.extra || '').trim()
  };
  if (!input.role || !input.jd || !input.resume) {
    return send(res, 400, { error: '缺少目标岗位、JD 或测试简历', code: 'BAD_REQUEST' });
  }
  if (input.jd.length > BODY_LIMIT || input.resume.length > BODY_LIMIT || input.extra.length > 10000) {
    return send(res, 413, { error: '测试输入过长：JD/简历各最多 120000 字符，补充信息最多 10000 字符', code: 'PROMPT_TEST_INPUT_TOO_LARGE' });
  }
  const results = {};

  for (const variant of variants) {
    const started = Date.now();
    try {
        const resolved = store.buildPromptConfigForTest(promptId, variant, undefined, input);
      const result = process.env.NODE_ENV === 'test' && process.env.PROMPT_TEST_MOCK === 'true'
        ? mockPromptTestResult(variant, resolved)
        : await analyzeResume({ ...input, promptConfig: resolved.config }, { settings });
      const latencyMs = Date.now() - started;
      const cost = Number(store.costOf(result.usage, settings).toFixed(6));
      results[variant] = {
        ok: true, variant, analysis: result.analysis, model: result.model, usage: result.usage,
        attempts: result.attempts, latencyMs, cost,
        promptConfig: { applied: resolved.config.length, truncated: resolved.truncated, dropped: resolved.dropped }
      };
      store.appendPromptTest({
        promptId: prompt.id, promptName: prompt.name, variant, ok: true, actor: req.auth.username,
        model: result.model, usage: result.usage, latencyMs, cost, role: input.role,
        inputChars: input.jd.length + input.resume.length, caseId: body.caseId || null
      });
    } catch (error) {
      const latencyMs = Date.now() - started;
      results[variant] = { ok: false, variant, error: error.message, code: error.code || 'PROMPT_TEST_FAILED', latencyMs };
      store.appendPromptTest({
        promptId: prompt.id, promptName: prompt.name, variant, ok: false, actor: req.auth.username,
        code: error.code || 'PROMPT_TEST_FAILED', latencyMs, role: input.role,
        inputChars: input.jd.length + input.resume.length, caseId: body.caseId || null
      });
    }
  }

  const successCount = Object.values(results).filter(item => item.ok).length;
  const bothSucceeded = results.published?.ok === true && results.draft?.ok === true;
  const publishedResume = results.published?.analysis?.finalResume || '';
  const draftResume = results.draft?.analysis?.finalResume || '';
  const comparison = {
    bothSucceeded,
    finalResumeChanged: bothSucceeded ? publishedResume !== draftResume : null,
    scoreDelta: bothSucceeded ? Number(results.draft.analysis.score || 0) - Number(results.published.analysis.score || 0) : null,
    latencyDeltaMs: bothSucceeded ? Number(results.draft.latencyMs || 0) - Number(results.published.latencyMs || 0) : null,
    costDelta: bothSucceeded ? Number((Number(results.draft.cost || 0) - Number(results.published.cost || 0)).toFixed(6)) : null
  };
  const failures = Object.values(results).filter(item => !item.ok);
  const status = successCount ? 200 : failures.length && failures.every(item => item.code === 'NO_PUBLISHED_VERSION') ? 409 : 502;
  return send(res, status, { prompt: store.summarize(prompt), results, comparison });
}

async function handleRegression(req, res, promptId) {
  await readBody(req, ADMIN_LIMIT);
  const prompt = store.getPrompt(promptId);
  if (!prompt) return send(res, 404, { error: 'Prompt 不存在', code: 'NOT_FOUND' });
  const cases = store.listTestCases(promptId);
  if (!cases.length) return send(res, 409, { error: '该 Prompt 尚未配置回归测试案例', code: 'NO_REGRESSION_CASES' });
  const results = [];
  for (const testCase of cases) {
    const input = { role: testCase.role, jd: testCase.jd, resume: testCase.resume, extra: testCase.extra || '' };
    const sideResults = {};
    for (const variant of ['published', 'draft']) {
      const started = Date.now();
      try {
        const resolved = store.buildPromptConfigForTest(promptId, variant, undefined, input);
        const modelResult = process.env.NODE_ENV === 'test' && process.env.PROMPT_TEST_MOCK === 'true'
          ? mockPromptTestResult(variant, resolved)
          : await analyzeResume({ ...input, promptConfig: resolved.config }, { settings: store.getSettings() });
        sideResults[variant] = { ok: true, score: Number(modelResult.analysis?.score || 0), finalResume: modelResult.analysis?.finalResume || '', latencyMs: Date.now() - started };
      } catch (error) {
        sideResults[variant] = { ok: false, code: error.code || 'PROMPT_TEST_FAILED', error: error.message, latencyMs: Date.now() - started };
      }
    }
    const draft = sideResults.draft;
    const published = sideResults.published;
    const scoreDrop = draft.ok && published.ok ? published.score - draft.score : null;
    const missingTerms = draft.ok ? testCase.requiredTerms.filter(term => !draft.finalResume.includes(term)) : testCase.requiredTerms;
    const comparableOrNew = published.ok || published.code === 'NO_PUBLISHED_VERSION';
    const passed = draft.ok && comparableOrNew && draft.score >= testCase.minScore
      && (!published.ok || scoreDrop <= testCase.maxScoreDrop) && missingTerms.length === 0;
    results.push({
      caseId: testCase.id, caseName: testCase.name, passed, minScore: testCase.minScore,
      maxScoreDrop: testCase.maxScoreDrop, requiredTerms: testCase.requiredTerms, missingTerms,
      published: { ok: published.ok, score: published.score, code: published.code, latencyMs: published.latencyMs },
      draft: { ok: draft.ok, score: draft.score, code: draft.code, latencyMs: draft.latencyMs }, scoreDrop
    });
  }
  const run = store.appendRegression({
    promptId: prompt.id, promptName: prompt.name, promptVersion: prompt.version, promptRevision: prompt.revision,
    suiteKey: store.regressionSuiteKey(prompt.id), passed: results.every(item => item.passed),
    total: results.length, failed: results.filter(item => !item.passed).length, actor: req.auth.username, results
  });
  return send(res, 200, { run });
}

const routes = {
  'GET /api/health': (req, res) => send(res, 200, { ok: true, at: new Date().toISOString() }),

  'GET /api/overview': (req, res) => send(res, 200, store.overview()),
  'GET /api/dependencies': (req, res) => send(res, 200, store.dependencyView()),

  'GET /api/prompts': (req, res, url) => {
    // 搜索在服务端完成：列表不回传正文，但关键词仍需匹配到正文
    const items = store.queryPrompts({
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || 'all',
      type: url.searchParams.get('type') || 'all'
    });
    send(res, 200, { items, total: items.length });
  },

  'GET /api/templates': (req, res) => send(res, 200, { items: store.listTemplates() }),
  'POST /api/templates/:id/create': async (req, res, url, params) => { const body = await readBody(req, ADMIN_LIMIT); send(res, 201, { prompt: store.createPromptFromTemplate(params.id, body, req.auth.username) }); },
  'POST /api/prompts/batch': async (req, res) => { const body = await readBody(req, ADMIN_LIMIT); send(res, 200, store.batchPromptAction(body.ids, body.action, body, req.auth.username)); },

  /** 用户端调用：拿当前生效的 Prompt 配置 */
  'GET /api/prompts/active': (req, res) => {
    const resolved = store.buildPromptConfig();
    send(res, 200, {
      prompts: resolved.config, truncated: resolved.truncated, dropped: resolved.dropped,
      enabledCount: resolved.enabledCount, maxChars: store.getSettings().promptMaxChars
    });
  },

  'GET /api/prompts/:id': (req, res, url, params) => {
    const prompt = store.getPrompt(params.id);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt, versions: store.listVersions(params.id, 50) });
  },

  'POST /api/prompts': async (req, res) => {
    const body = await readBody(req, ADMIN_LIMIT);
    send(res, 201, { prompt: store.createPrompt(body, req.auth.username) });
  },

  'PUT /api/prompts/:id': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.updatePrompt(params.id, body, req.auth.username);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/toggle': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.setEnabled(params.id, body.enabled !== false, req.auth.username);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/rollback': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    if (!body.vid) return send(res, 400, { error: '缺少目标版本 vid' });
    const result = store.rollbackPrompt(params.id, body.vid, req.auth.username);
    if (!result) return send(res, 404, { error: 'Prompt 或目标版本不存在' });
    send(res, 200, result);
  },

  'POST /api/prompts/:id/submit-review': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.submitPromptReview(params.id, { ...body, actor: req.auth.username });
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/reject-review': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.rejectPromptReview(params.id, { ...body, actor: req.auth.username });
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/publish': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.publishPrompt(params.id, { ...body, actor: req.auth.username });
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/production-rollback': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    if (!body.vid) return send(res, 400, { error: '缺少目标版本 vid' });
    const result = store.rollbackProduction(params.id, body.vid, { ...body, actor: req.auth.username });
    if (!result) return send(res, 404, { error: 'Prompt 或目标版本不存在' });
    send(res, 200, result);
  },

  'POST /api/prompts/:id/test': async (req, res, url, params) => handlePromptTest(req, res, params.id),
  'POST /api/prompts/:id/regression': async (req, res, url, params) => handleRegression(req, res, params.id),

  'DELETE /api/prompts/:id': (req, res, url, params) => {
    if (!store.removePrompt(params.id, req.auth.username)) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { ok: true });
  },

  'GET /api/versions': (req, res, url) => send(res, 200, {
    items: store.listVersions(url.searchParams.get('promptId'), Number(url.searchParams.get('limit') || 100))
  }),

  'GET /api/changes': (req, res, url) => {
    const items = store.listChanges(Number(url.searchParams.get('limit') || 100)).map(v => ({
      ...v,
      promptName: v.promptName || (v.promptId ? (store.getPrompt(v.promptId)?.name || '已删除的 Prompt') : '运行参数')
    }));
    send(res, 200, { items });
  },

  'GET /api/logs': (req, res, url) => {
    const okParam = url.searchParams.get('ok');
    const result = store.readLogs({
      limit: Number(url.searchParams.get('limit') || 200),
      days: Number(url.searchParams.get('days') || 0),
      ok: okParam === 'true' ? true : okParam === 'false' ? false : undefined,
      code: url.searchParams.get('code') || undefined,
      model: url.searchParams.get('model') || undefined,
      prompt: url.searchParams.get('prompt') || undefined,
      role: url.searchParams.get('role') || undefined,
      minLatency: Number(url.searchParams.get('minLatency') || 0)
    });
    send(res, 200, {
      items: result.rows, total: result.total,
      prices: { input: result.settings.inputPricePerM, output: result.settings.outputPricePerM }
    });
  },

  'GET /api/logs/stats': (req, res, url) => send(res, 200, store.logStats(Number(url.searchParams.get('days') || 7), {
    model: url.searchParams.get('model') || undefined,
    prompt: url.searchParams.get('prompt') || undefined,
    role: url.searchParams.get('role') || undefined,
    minLatency: Number(url.searchParams.get('minLatency') || 0)
  })),

  'GET /api/test-cases': (req, res, url) => send(res, 200, { items: store.listTestCases(url.searchParams.get('promptId')) }),

  'POST /api/test-cases': async (req, res) => {
    const body = await readBody(req, ADMIN_LIMIT);
    send(res, 201, { item: store.createTestCase(body, req.auth.username) });
  },

  'DELETE /api/test-cases/:id': (req, res, url, params) => {
    if (!store.removeTestCase(params.id, req.auth.username)) return send(res, 404, { error: '测试案例不存在' });
    send(res, 200, { ok: true });
  },

  'GET /api/prompt-tests': (req, res, url) => send(res, 200, {
    items: store.listPromptTests(url.searchParams.get('promptId'), Number(url.searchParams.get('limit') || 50))
  }),
  'GET /api/regressions': (req, res, url) => send(res, 200, {
    items: store.listRegressions(url.searchParams.get('promptId'), Number(url.searchParams.get('limit') || 30))
  }),

  'GET /api/feedback': (req, res, url) => send(res, 200, {
    items: store.listFeedback({ status: url.searchParams.get('status') || undefined, rating: url.searchParams.get('rating') || undefined, prompt: url.searchParams.get('prompt') || undefined, limit: Number(url.searchParams.get('limit') || 200) }),
    stats: store.feedbackStats()
  }),

  'GET /api/rules': (req, res) => send(res, 200, { items: store.listRules() }),
  'POST /api/rules': async (req, res) => { const body = await readBody(req, ADMIN_LIMIT); send(res, 201, { item: store.createRule(body, req.auth.username) }); },
  'PUT /api/rules/:id': async (req, res, url, params) => { const body = await readBody(req, ADMIN_LIMIT); const item = store.updateRule(params.id, body, req.auth.username); if (!item) return send(res, 404, { error: '风险规则不存在', code: 'NOT_FOUND' }); send(res, 200, { item }); },
  'DELETE /api/rules/:id': (req, res, url, params) => { if (!store.removeRule(params.id, req.auth.username)) return send(res, 404, { error: '风险规则不存在', code: 'NOT_FOUND' }); send(res, 200, { ok: true }); },

  'POST /api/feedback': async (req, res) => {
    const body = await readBody(req, ADMIN_LIMIT);
    send(res, 201, { item: store.saveFeedback(body, req.auth.username) });
  },

  'PUT /api/feedback/:id': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const item = store.updateFeedback(params.id, body, req.auth.username);
    if (!item) return send(res, 404, { error: '质量反馈不存在', code: 'NOT_FOUND' });
    send(res, 200, { item });
  },

  'POST /api/logs/prune': (req, res) => send(res, 200, { kept: store.pruneLogs() }),

  'GET /api/settings': (req, res) => send(res, 200, { settings: store.getSettings() }),

  'PUT /api/settings': async (req, res) => {
    const body = await readBody(req, ADMIN_LIMIT);
    send(res, 200, { settings: store.saveSettings(body, req.auth.username) });
  }
};

const PUBLIC_API = new Set([
  'GET /api/health', 'POST /api/analyze',
  'GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/logout'
]);

function requiredRole(method, pathname) {
  if (PUBLIC_API.has(`${method} ${pathname}`)) return null;
  if (method === 'GET') return 'viewer';
  if (method === 'POST' && pathname === '/api/prompts') return 'editor';
  if (method === 'POST' && pathname === '/api/prompts/batch') return 'editor';
  if (method === 'POST' && /^\/api\/templates\/[^/]+\/create$/.test(pathname)) return 'editor';
  if (method === 'PUT' && /^\/api\/prompts\/[^/]+$/.test(pathname)) return 'editor';
  if (method === 'POST' && /^\/api\/prompts\/[^/]+\/(toggle|rollback|submit-review)$/.test(pathname)) return 'editor';
  if (method === 'POST' && /^\/api\/prompts\/[^/]+\/test$/.test(pathname)) return 'editor';
  if (method === 'POST' && /^\/api\/prompts\/[^/]+\/regression$/.test(pathname)) return 'editor';
  if (method === 'POST' && pathname === '/api/test-cases') return 'editor';
  if ((method === 'POST' && pathname === '/api/feedback') || (method === 'PUT' && /^\/api\/feedback\/[^/]+$/.test(pathname))) return 'editor';
  if (method === 'POST' && pathname === '/api/rules') return 'editor';
  if (method === 'PUT' && /^\/api\/rules\/[^/]+$/.test(pathname)) return 'editor';
  return 'admin';
}

async function handleAuth(req, res, pathname) {
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const user = auth.current(req);
    return send(res, 200, { authenticated: !!user, user });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req, 20000);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const key = `${ip}:${String(body.username || '').trim().toLowerCase()}`;
    const now = Date.now();
    let attempt = loginAttempts.get(key);
    if (attempt && attempt.blockedUntil > now) {
      return send(res, 429, { error: '登录失败次数过多，请稍后再试', code: 'LOGIN_RATE_LIMITED' });
    }
    if (!attempt || attempt.windowUntil <= now) attempt = { failures: 0, windowUntil: now + LOGIN_WINDOW_MS, blockedUntil: 0 };
    const result = auth.login(body.username, body.password);
    if (!result) {
      attempt.failures += 1;
      if (attempt.failures >= LOGIN_MAX_FAILURES) attempt.blockedUntil = now + LOGIN_BLOCK_MS;
      loginAttempts.set(key, attempt);
      console.warn(`[auth] 登录失败：${ip} / ${String(body.username || '').slice(0, 80)} / ${attempt.failures} 次`);
      if (attempt.blockedUntil) return send(res, 429, { error: '登录失败次数过多，请稍后再试', code: 'LOGIN_RATE_LIMITED' });
      return send(res, 401, { error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' });
    }
    loginAttempts.delete(key);
    return send(res, 200, { authenticated: true, user: result.user }, { 'Set-Cookie': auth.cookie(result.token, req) });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.revoke(req);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie('', req, 0) });
  }
  return send(res, 405, { error: '请求方法不支持', code: 'METHOD_NOT_ALLOWED' });
}

/** 极简路由：支持 /api/prompts/:id/rollback 这类带参路径 */
function matchRoute(method, pathname) {
  const direct = routes[`${method} ${pathname}`];
  if (direct) return { handler: direct, params: {} };

  const target = pathname.split('/').filter(Boolean);
  for (const [routeKey, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = routeKey.split(' ');
    if (routeMethod !== method) continue;
    const pattern = routePath.split('/').filter(Boolean);
    if (pattern.length !== target.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodeURIComponent(target[i]);
      else if (pattern[i] !== target[i]) { matched = false; break; }
    }
    if (matched) return { handler, params };
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    if (pathname.startsWith('/api/auth/')) {
      try { await handleAuth(req, res, pathname); }
      catch (error) { if (!res.headersSent) send(res, error.statusCode || 400, { error: error.message, code: error.code || 'AUTH_FAILED' }); }
      return;
    }
    if (pathname === '/api/analyze') {
      if (req.method !== 'POST') return send(res, 405, { error: '请求方法不支持' });
      try { await handleAnalyze(req, res); }
      catch (error) {
        console.error(`[server] analyze 未捕获异常：${error.message}`);
        if (!res.headersSent) {
          const code = error.code || 'ANALYZE_FAILED';
          const runId = record({ ok: false, code, error: error.message || '分析失败', latencyMs: 0 });
          send(res, error.statusCode || 500, { error: degradationFor(code).message, code, runId, degradation: degradationFor(code) });
        }
      }
      return;
    }
    const role = requiredRole(req.method, pathname);
    if (role) {
      const user = auth.current(req);
      if (!user) return send(res, 401, { error: '请先登录管理后台', code: 'UNAUTHENTICATED' });
      if (!auth.hasRole(user, role)) return send(res, 403, { error: `当前角色无权执行此操作，需要 ${role} 权限`, code: 'FORBIDDEN' });
      req.auth = user;
    }
    const match = matchRoute(req.method, pathname);
    if (!match) return send(res, 404, { error: '接口不存在', code: 'NOT_FOUND' });
    try { await match.handler(req, res, url, match.params); }
    catch (error) {
      console.error(`[server] ${req.method} ${pathname} 失败：${error.message}`);
      if (!res.headersSent) send(res, error.statusCode || 500, { error: error.message || '服务端错误', code: error.code || 'SERVER_ERROR' });
    }
    return;
  }

  const canonical = PUBLIC_ALIASES.get(pathname) || pathname;
  const relative = PUBLIC_FILES.get(canonical);
  if (!relative) { res.writeHead(404); res.end('Not found'); return; }
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Resume Expert: http://localhost:${port}`));
