/* This file is concatenated into the Sites Worker by build.js. */
function initialEdgeState() {
  const now = new Date().toISOString();
  return {
    prompts: PROMPT_CONFIG.map((item, index) => ({
      id: index + 1, step: item.step, stepKey: item.stepKey, name: item.name,
      type: item.step == null ? 'extension' : 'task', desc: '', content: item.content,
      enabled: true, version: 'v1.0', revision: 1, releaseStatus: 'published',
      publishedVersion: 'v1.0', publishedAt: now, publishedBy: '上线初始化',
      createdAt: now, updatedAt: now, updatedLabel: '上线初始化', reviewNote: ''
    })),
    settings: { ...PROMPT_META.settings },
    changes: [], rules: [], templates: [], feedback: [], testCases: [], promptTests: [], regressions: []
  };
}

async function edgeState(env) {
  if (!env.DB) throw Object.assign(new Error('线上数据库尚未绑定'), { statusCode: 503, code: 'STORAGE_UNAVAILABLE' });
  const row = await env.DB.prepare('SELECT value_json FROM admin_state WHERE state_key = ?').bind('main').first();
  if (row?.value_json) return JSON.parse(row.value_json);
  const state = initialEdgeState();
  await env.DB.prepare('INSERT INTO admin_state (state_key, value_json, updated_at) VALUES (?, ?, ?)')
    .bind('main', JSON.stringify(state), new Date().toISOString()).run();
  return state;
}

async function saveEdgeState(env, state) {
  await env.DB.prepare('UPDATE admin_state SET value_json = ?, updated_at = ? WHERE state_key = ?')
    .bind(JSON.stringify(state), new Date().toISOString(), 'main').run();
}

function edgePromptSummary(prompt) {
  const { content, ...item } = prompt;
  return { ...item, contentPreview: String(content || '').slice(0, 100), contentLength: String(content || '').length };
}

function edgeOverview(state) {
  const prompts = state.prompts || [];
  return {
    total: prompts.length, enabled: prompts.filter(p => p.enabled).length,
    workspaceEnabled: prompts.filter(p => p.enabled).length,
    published: prompts.filter(p => p.releaseStatus === 'published').length,
    drafts: prompts.filter(p => p.releaseStatus === 'draft').length,
    reviews: prompts.filter(p => p.releaseStatus === 'review').length,
    changes7d: (state.changes || []).filter(c => Date.now() - new Date(c.at).getTime() < 604800000).length,
    coverage: new Set(prompts.filter(p => p.enabled && p.step).map(p => p.step)).size,
    coverageTotal: 8, lastChange: state.changes?.[0] || null, settings: state.settings
  };
}

function edgeChange(state, prompt, action, note) {
  state.changes ||= [];
  state.changes.unshift({
    vid: 'edge-' + crypto.randomUUID(), promptId: prompt?.id || null, promptName: prompt?.name || '项目设置',
    version: prompt?.version || '-', action, actionLabel: action, actor: 'sites-owner', at: new Date().toISOString(), note: note || ''
  });
  state.changes = state.changes.slice(0, 500);
}

async function edgeLog(env, entry) {
  if (!env.DB) return;
  await env.DB.prepare(`INSERT INTO run_logs
    (id, at, ok, model, role, code, latency_ms, attempts, input_tokens, output_tokens, cost, input_chars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(entry.id, entry.at, entry.ok ? 1 : 0, entry.model || null, entry.role || null, entry.code || null,
      entry.latencyMs || 0, entry.attempts || 1, entry.inputTokens || 0, entry.outputTokens || 0,
      entry.cost || 0, entry.inputChars || 0).run();
}

async function edgeLogs(env, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 5000);
  const rows = await env.DB.prepare('SELECT * FROM run_logs ORDER BY at DESC LIMIT ?').bind(limit).all();
  return (rows.results || []).map(row => ({
    id: row.id, at: row.at, ok: !!row.ok, model: row.model, role: row.role, code: row.code,
    latencyMs: row.latency_ms, attempts: row.attempts,
    usage: { prompt_tokens: row.input_tokens, completion_tokens: row.output_tokens, total_tokens: row.input_tokens + row.output_tokens },
    cost: row.cost, inputChars: row.input_chars, promptVersions: [], validationErrors: [], truncated: [], dropped: []
  }));
}

function edgeQuality(rows, days) {
  const total = rows.length, failed = rows.filter(r => !r.ok).length;
  const latencies = rows.map(r => Number(r.latencyMs || 0)).sort((a, b) => a - b);
  const pct = n => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * n))] : 0;
  const models = [...new Set(rows.map(r => r.model).filter(Boolean))].sort();
  const prompts = [...new Set(rows.flatMap(r => Array.isArray(r.prompts) ? r.prompts : []))].sort();
  const byCode = {}, byModel = {}, byPrompt = {}, dailyByDay = {};
  rows.forEach(row => {
    const day = String(row.at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const daily = dailyByDay[day] || { day, total: 0, failed: 0, tokens: 0, cost: 0, latencySum: 0, latencyCount: 0 };
    daily.total += 1; if (!row.ok) daily.failed += 1;
    daily.tokens += Number(row.usage?.total_tokens || 0); daily.cost += Number(row.cost || 0);
    if (row.ok) { daily.latencySum += Number(row.latencyMs || 0); daily.latencyCount += 1; }
    dailyByDay[day] = daily;
    const model = row.model || 'unknown';
    const modelBucket = byModel[model] || { model, total: 0, failed: 0, latencySum: 0, latencyCount: 0, tokens: 0, cost: 0 };
    modelBucket.total += 1; if (!row.ok) modelBucket.failed += 1;
    if (row.ok) { modelBucket.latencySum += Number(row.latencyMs || 0); modelBucket.latencyCount += 1; }
    modelBucket.tokens += Number(row.usage?.total_tokens || 0); modelBucket.cost += Number(row.cost || 0); byModel[model] = modelBucket;
    (Array.isArray(row.prompts) ? row.prompts : []).forEach(prompt => {
      const bucket = byPrompt[prompt] || { prompt, calls: 0, failed: 0, truncated: 0, dropped: 0 };
      bucket.calls += 1; if (!row.ok) bucket.failed += 1;
      bucket.truncated += Array.isArray(row.truncated) && row.truncated.some(item => item.name === prompt) ? 1 : 0;
      bucket.dropped += Array.isArray(row.dropped) && row.dropped.some(item => item.name === prompt) ? 1 : 0;
      byPrompt[prompt] = bucket;
    });
    if (!row.ok) { const code = row.code || 'UNKNOWN'; byCode[code] = byCode[code] || { code, label: code, count: 0 }; byCode[code].count += 1; }
  });
  const daily = Object.values(dailyByDay).sort((a, b) => a.day.localeCompare(b.day)).map(item => ({ ...item, cost: Number(item.cost.toFixed(4)), avgLatency: item.latencyCount ? Math.round(item.latencySum / item.latencyCount) : 0 }));
  const byModelRows = Object.values(byModel).map(item => ({ ...item, successRate: item.total ? Number(((item.total - item.failed) / item.total * 100).toFixed(1)) : 100, avgLatency: item.latencyCount ? Math.round(item.latencySum / item.latencyCount) : 0, cost: Number(item.cost.toFixed(4)) })).sort((a, b) => b.total - a.total);
  const overall = {
    calls: total, succeeded: total - failed, failed, successRate: total ? Number(((total - failed) / total * 100).toFixed(1)) : 100,
    failureRate: total ? Number((failed / total * 100).toFixed(1)) : 0, schemaErrorRate: 0,
    retryRate: total ? Number((rows.filter(r => r.attempts > 1).length / total * 100).toFixed(1)) : 0,
    avgLatency: total ? Math.round(rows.reduce((s, r) => s + Number(r.latencyMs || 0), 0) / total) : 0,
    p50Latency: pct(.5), p95Latency: pct(.95), p99Latency: pct(.99),
    tokens: rows.reduce((s, r) => s + Number(r.usage?.total_tokens || 0), 0),
    cost: Number(rows.reduce((s, r) => s + Number(r.cost || 0), 0).toFixed(4)), feedback: 0, positiveRate: null
  };
  return {
    days, ...overall, daily, byCode: Object.values(byCode).sort((a, b) => b.count - a.count),
    byModel: byModelRows, byPrompt: Object.values(byPrompt).sort((a, b) => b.calls - a.calls), byPromptVersion: [],
    promptVersionTrends: [], schemaFields: [], slowest: rows.filter(r => r.ok).sort((a, b) => Number(b.latencyMs || 0) - Number(a.latencyMs || 0)).slice(0, 10),
    filters: { models, prompts }, alerts: [], alertHistory: [], byRole: []
  };
}

async function readRequestJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function handleEdgeAdmin(request, env, url) {
  const pathname = url.pathname;
  const method = request.method;
  if (pathname === '/api/auth/status') return json({ authenticated: true, user: { username: 'sites-owner', role: 'admin' } });
  if (pathname === '/api/auth/login') return json({ authenticated: true, user: { username: 'sites-owner', role: 'admin' } });
  if (pathname === '/api/auth/logout') return json({ ok: true });
  if (!pathname.startsWith('/api/') || pathname === '/api/analyze' || pathname === '/api/prompts/active' || pathname === '/api/health') return null;

  const state = await edgeState(env);
  const promptMatch = pathname.match(/^\/api\/prompts\/([^/]+)$/);

  if (method === 'GET' && pathname === '/api/overview') return json(edgeOverview(state));
  if (method === 'GET' && pathname === '/api/prompts') {
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const status = url.searchParams.get('status') || '';
    const type = url.searchParams.get('type') || '';
    const items = state.prompts.filter(p => (!q || `${p.name} ${p.desc} ${p.content}`.toLowerCase().includes(q)) && (!status || p.releaseStatus === status) && (!type || p.type === type)).map(edgePromptSummary);
    return json({ items, total: items.length });
  }
  if (method === 'GET' && promptMatch) {
    const prompt = state.prompts.find(p => String(p.id) === decodeURIComponent(promptMatch[1]));
    if (!prompt) return json({ error: 'Prompt 不存在', code: 'NOT_FOUND' }, 404);
    return json({ prompt, versions: [] });
  }
  if (method === 'POST' && pathname === '/api/prompts') {
    const body = await readRequestJson(request); const now = new Date().toISOString();
    const prompt = { id: crypto.randomUUID(), step: body.step || null, stepKey: body.stepKey || 'extension', name: String(body.name || '未命名 Prompt'), type: body.type || 'extension', desc: String(body.desc || ''), content: String(body.content || ''), enabled: body.enabled !== false, version: 'v1.0', revision: 1, releaseStatus: 'draft', publishedVersion: null, createdAt: now, updatedAt: now, updatedLabel: 'sites-owner', reviewNote: '' };
    state.prompts.push(prompt); edgeChange(state, prompt, 'create', '创建线上草稿'); await saveEdgeState(env, state); return json({ prompt }, 201);
  }
  if (method === 'PUT' && promptMatch) {
    const prompt = state.prompts.find(p => String(p.id) === decodeURIComponent(promptMatch[1]));
    if (!prompt) return json({ error: 'Prompt 不存在', code: 'NOT_FOUND' }, 404);
    const body = await readRequestJson(request); Object.assign(prompt, { name: body.name ?? prompt.name, type: body.type ?? prompt.type, desc: body.desc ?? prompt.desc, content: body.content ?? prompt.content, step: body.step ?? prompt.step, stepKey: body.stepKey ?? prompt.stepKey, enabled: body.enabled ?? prompt.enabled, revision: Number(prompt.revision || 0) + 1, releaseStatus: 'draft', updatedAt: new Date().toISOString(), updatedLabel: 'sites-owner' });
    const [major, minor] = String(prompt.version || 'v1.0').slice(1).split('.').map(Number); prompt.version = `v${major || 1}.${(minor || 0) + 1}`;
    edgeChange(state, prompt, 'update', '保存线上草稿'); await saveEdgeState(env, state); return json({ prompt });
  }
  const actionMatch = pathname.match(/^\/api\/prompts\/([^/]+)\/(toggle|submit|reject|publish)$/);
  if (method === 'POST' && actionMatch) {
    const prompt = state.prompts.find(p => String(p.id) === decodeURIComponent(actionMatch[1]));
    if (!prompt) return json({ error: 'Prompt 不存在', code: 'NOT_FOUND' }, 404);
    const body = await readRequestJson(request); const action = actionMatch[2];
    if (action === 'toggle') prompt.enabled = body.enabled !== false;
    if (action === 'submit') prompt.releaseStatus = 'review';
    if (action === 'reject') { prompt.releaseStatus = 'draft'; prompt.reviewNote = String(body.note || ''); }
    if (action === 'publish') { prompt.releaseStatus = 'published'; prompt.publishedVersion = prompt.version; prompt.publishedAt = new Date().toISOString(); prompt.publishedBy = 'sites-owner'; prompt.publishedSnapshot = { name: prompt.name, type: prompt.type, desc: prompt.desc, content: prompt.content, enabled: prompt.enabled, step: prompt.step, stepKey: prompt.stepKey }; }
    prompt.updatedAt = new Date().toISOString(); edgeChange(state, prompt, action, body.note || ''); await saveEdgeState(env, state); return json({ prompt });
  }

  const rows = await edgeLogs(env, url);
  const days = Number(url.searchParams.get('days')) || 7;
  if (method === 'GET' && pathname === '/api/logs') return json({ items: rows, total: rows.length, settings: state.settings });
  if (method === 'GET' && pathname === '/api/logs/stats') return json(edgeQuality(rows, days));
  if (method === 'GET' && pathname === '/api/quality') return json(edgeQuality(rows, days));
  if (method === 'GET' && pathname === '/api/tasks') return json({ items: rows.map(r => ({ id: r.id, at: r.at, status: r.ok ? 'succeeded' : 'failed', role: r.role, model: r.model, cost: r.cost, retryable: false })), total: rows.length, page: 1, pages: 1, summary: { total: rows.length, succeeded: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok).length, retryable: 0, cost: rows.reduce((s, r) => s + Number(r.cost || 0), 0) }, roles: [] });
  if (method === 'GET' && pathname === '/api/alerts') return json({ items: [], total: 0 });
  if (method === 'GET' && pathname === '/api/cost-budget') { const spent = rows.reduce((s, r) => s + Number(r.cost || 0), 0), budget = Number(state.settings.dailyCostBudget || 0); return json({ enabled: budget > 0, budget, spent, remaining: budget > 0 ? Math.max(0, budget - spent) : null, exceeded: budget > 0 && spent >= budget }); }
  if (method === 'GET' && pathname === '/api/changes') return json({ items: state.changes || [], total: state.changes?.length || 0, page: 1, pages: 1, actions: [] });
  if (method === 'GET' && pathname === '/api/system-health') return json({ status: 'ok', checks: [{ id: 'database', name: '线上数据库', status: 'ok', detail: 'D1 已连接' }, { id: 'model_provider', name: '模型服务配置', status: env.DEEPSEEK_API_KEY ? 'ok' : 'warn', detail: env.DEEPSEEK_API_KEY ? 'DeepSeek 凭据已配置' : 'DeepSeek 凭据未配置' }] });
  if (method === 'GET' && pathname === '/api/settings') return json({ settings: state.settings, notification: { configured: false, enabled: false } });
  if (method === 'PUT' && pathname === '/api/settings') { const body = await readRequestJson(request); state.settings = { ...state.settings, ...body }; edgeChange(state, null, 'settings', '更新线上设置'); await saveEdgeState(env, state); return json({ settings: state.settings }); }
  if (method === 'GET' && pathname === '/api/rules') return json({ items: state.rules || [] });
  if (method === 'GET' && pathname === '/api/templates') return json({ items: state.templates || [], categories: [] });
  if (method === 'GET' && pathname === '/api/feedback') return json({ items: state.feedback || [], stats: { total: state.feedback?.length || 0, good: 0, bad: 0 } });
  if (method === 'GET' && pathname === '/api/dependencies') {
    const steps = Array.from({ length: 8 }, (_, index) => {
      const step = index + 1;
      const prompts = state.prompts.filter(p => Number(p.step) === step).map(p => ({
        id: p.id, name: p.name, enabled: !!p.enabled, releaseStatus: p.releaseStatus,
        publishedVersion: p.publishedVersion, version: p.version, variables: [],
        regressionCases: 0, latestRegression: null
      }));
      return { step, stepKey: prompts[0]?.stepKey || null, prompts, workspaceCount: prompts.length,
        productionCount: prompts.filter(p => p.releaseStatus === 'published' && p.enabled).length,
        covered: prompts.some(p => p.releaseStatus === 'published' && p.enabled),
        hasDraft: prompts.some(p => p.releaseStatus !== 'published') };
    });
    const extensionPrompts = state.prompts.filter(p => p.step == null).map(p => ({ id: p.id, name: p.name, enabled: !!p.enabled, releaseStatus: p.releaseStatus }));
    return json({ steps, extensionPrompts, enabledRules: state.rules || [] });
  }
  if (method === 'GET' && pathname === '/api/test-cases') return json({ items: state.testCases || [] });
  if (method === 'GET' && pathname === '/api/prompt-tests') return json({ items: state.promptTests || [] });
  if (method === 'GET' && pathname === '/api/regressions') return json({ items: state.regressions || [] });
  if (method === 'GET' && pathname === '/api/regression-center') return json({ prompts: [], summary: { total: 0, passed: 0, failed: 0, notRun: 0 } });
  if (method === 'GET' && pathname === '/api/experiments') return json({ days, items: [], summary: { total: 0, active: 0 } });
  return json({ error: '该线上管理操作尚未开放', code: 'NOT_IMPLEMENTED' }, 501);
}
