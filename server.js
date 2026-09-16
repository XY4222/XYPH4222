const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyzeResume } = require('./deepseek');
const store = require('./store');

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

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('请求内容过大'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  }
  return raw ? JSON.parse(raw) : {};
}

/** 统一落盘一次调用结果；失败也要记录，否则失败率看板永远是 0。 */
function record(entry) {
  const settings = store.getSettings();
  store.appendLog({
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
    truncated: entry.truncated || [],
    dropped: entry.dropped || [],
    inputChars: entry.inputChars || 0
  });
}

async function handleAnalyze(req, res) {
  const started = Date.now();
  const settings = store.getSettings();
  let input = null;

  try {
    input = await readBody(req, BODY_LIMIT);
    if (!input.role || !input.jd || !input.resume) {
      record({ ok: false, code: 'BAD_REQUEST', error: '缺少目标岗位、JD 或原始简历', latencyMs: Date.now() - started });
      return send(res, 400, { error: '缺少目标岗位、JD 或原始简历', code: 'BAD_REQUEST' });
    }
    if (!settings.analyzeEnabled) {
      record({ ok: false, code: 'DISABLED', error: '管理员已暂停分析服务', latencyMs: Date.now() - started, role: input.role });
      return send(res, 503, { error: '管理员已暂停分析服务', code: 'DISABLED' });
    }

    // Prompt 配置一律以服务端为准，前端不需要自己拼装，也就不会出现浏览器与服务端配置不一致
    const resolved = store.buildPromptConfig();
    const payload = { ...input, promptConfig: resolved.config };

    const result = await analyzeResume(payload, { settings });
    record({
      ok: true, modelReturned: result.model, usage: result.usage, latencyMs: Date.now() - started,
      attempts: result.attempts, role: input.role, prompts: resolved.config.map(p => p.name),
      truncated: resolved.truncated, dropped: resolved.dropped,
      inputChars: String(input.jd || '').length + String(input.resume || '').length
    });
    return send(res, 200, {
      ...result,
      promptConfig: { applied: resolved.config.length, truncated: resolved.truncated, dropped: resolved.dropped }
    });
  } catch (error) {
    record({
      ok: false, code: error.code || 'ANALYZE_FAILED', error: error.message || '分析失败',
      latencyMs: Date.now() - started, attempts: error.attempts, role: input?.role
    });
    return send(res, error.statusCode || 500, { error: error.message || '分析失败', code: error.code || 'ANALYZE_FAILED' });
  }
}

const routes = {
  'GET /api/health': (req, res) => send(res, 200, { ok: true, at: new Date().toISOString() }),

  'GET /api/overview': (req, res) => send(res, 200, store.overview()),

  'GET /api/prompts': (req, res, url) => {
    // 搜索在服务端完成：列表不回传正文，但关键词仍需匹配到正文
    const items = store.queryPrompts({
      q: url.searchParams.get('q') || '',
      status: url.searchParams.get('status') || 'all',
      type: url.searchParams.get('type') || 'all'
    });
    send(res, 200, { items, total: items.length });
  },

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
    send(res, 201, { prompt: store.createPrompt(body, body.actor) });
  },

  'PUT /api/prompts/:id': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.updatePrompt(params.id, body, body.actor);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/toggle': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.setEnabled(params.id, body.enabled !== false, body.actor);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/rollback': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    if (!body.vid) return send(res, 400, { error: '缺少目标版本 vid' });
    const result = store.rollbackPrompt(params.id, body.vid, body.actor);
    if (!result) return send(res, 404, { error: 'Prompt 或目标版本不存在' });
    send(res, 200, result);
  },

  'POST /api/prompts/:id/submit-review': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.submitPromptReview(params.id, body);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/reject-review': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.rejectPromptReview(params.id, body);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/publish': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    const prompt = store.publishPrompt(params.id, body);
    if (!prompt) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { prompt });
  },

  'POST /api/prompts/:id/production-rollback': async (req, res, url, params) => {
    const body = await readBody(req, ADMIN_LIMIT);
    if (!body.vid) return send(res, 400, { error: '缺少目标版本 vid' });
    const result = store.rollbackProduction(params.id, body.vid, body);
    if (!result) return send(res, 404, { error: 'Prompt 或目标版本不存在' });
    send(res, 200, result);
  },

  'DELETE /api/prompts/:id': (req, res, url, params) => {
    if (!store.removePrompt(params.id, url.searchParams.get('actor'))) return send(res, 404, { error: 'Prompt 不存在' });
    send(res, 200, { ok: true });
  },

  'GET /api/versions': (req, res, url) => send(res, 200, {
    items: store.listVersions(url.searchParams.get('promptId'), Number(url.searchParams.get('limit') || 100))
  }),

  'GET /api/changes': (req, res, url) => {
    const items = store.listChanges(Number(url.searchParams.get('limit') || 100)).map(v => ({
      ...v,
      promptName: v.promptId ? (store.getPrompt(v.promptId)?.name || '已删除的 Prompt') : '运行参数'
    }));
    send(res, 200, { items });
  },

  'GET /api/logs': (req, res, url) => {
    const okParam = url.searchParams.get('ok');
    const result = store.readLogs({
      limit: Number(url.searchParams.get('limit') || 200),
      days: Number(url.searchParams.get('days') || 0),
      ok: okParam === 'true' ? true : okParam === 'false' ? false : undefined,
      code: url.searchParams.get('code') || undefined
    });
    send(res, 200, {
      items: result.rows, total: result.total,
      prices: { input: result.settings.inputPricePerM, output: result.settings.outputPricePerM }
    });
  },

  'GET /api/logs/stats': (req, res, url) => send(res, 200, store.logStats(Number(url.searchParams.get('days') || 7))),

  'POST /api/logs/prune': (req, res) => send(res, 200, { kept: store.pruneLogs() }),

  'GET /api/settings': (req, res) => send(res, 200, { settings: store.getSettings() }),

  'PUT /api/settings': async (req, res) => {
    const body = await readBody(req, ADMIN_LIMIT);
    send(res, 200, { settings: store.saveSettings(body, body.actor) });
  }
};

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
    if (pathname === '/api/analyze') {
      if (req.method !== 'POST') return send(res, 405, { error: '请求方法不支持' });
      try { await handleAnalyze(req, res); }
      catch (error) {
        console.error(`[server] analyze 未捕获异常：${error.message}`);
        if (!res.headersSent) send(res, 500, { error: '分析失败', code: 'ANALYZE_FAILED' });
      }
      return;
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
