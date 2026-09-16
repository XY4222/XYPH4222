const fs = require('fs');
const path = require('path');
const os = require('os');
const { SYSTEM_PROMPT } = require('./deepseek');
const { execFileSync } = require('child_process');
const store = require('./store');

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'server'), { recursive: true });
fs.mkdirSync(path.join(out, '.openai'), { recursive: true });

const ASSETS = ['index.html', 'styles.css', 'app.js', 'admin.html', 'admin.js'];
for (const file of ASSETS) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}
fs.copyFileSync(path.join(__dirname, '.openai', 'hosting.json'), path.join(out, '.openai', 'hosting.json'));

/**
 * 把任意 JS 值安全嵌进下面的模板字符串。
 *
 * JSON.stringify 已经处理好了引号和换行转义，但有两样它不管，会直接破坏模板：
 *   1. 反引号 —— 提前闭合模板字符串；
 *   2. ${  —— 被当成插值表达式求值（Prompt 正文里出现 "${}" 完全可能）。
 * 所以只补这两处，千万不要再动反斜杠：JSON.stringify 产出的换行是两字符转义，
 * 再转义一次就会变成字面量的反斜杠 n 出现在产物里（曾因此生成过无法解析的 index.js）。
 */
function embed(value) {
  return JSON.stringify(value).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * 边缘环境没有文件系统，Prompt 配置只能在构建时固化。
 * 因此发布到边缘前需要先在本地后台（node server.js）调好 Prompt，再跑 npm run build。
 */
function bakeConfig() {
  try {
    return store.buildPromptConfig();
  } catch (error) {
    console.warn(`[build] 读取服务端 Prompt 失败（${error.message}），回退到种子配置`);
    const config = store.SEED.filter(p => p.enabled)
      .sort((a, b) => (a.step ?? 99) - (b.step ?? 99) || a.id - b.id)
      .map(p => ({ step: p.step ?? null, stepKey: p.stepKey || 'extension', name: p.name, content: p.content }));
    return { config, truncated: [], dropped: [], enabledCount: config.length };
  }
}

const files = {};
for (const file of ASSETS) {
  const type = file.endsWith('.css') ? 'text/css; charset=utf-8'
    : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
  const body = fs.readFileSync(path.join(__dirname, file), 'utf8');
  files[`/${file}`] = [body, type];
  if (file === 'index.html') files['/'] = [body, type];
  if (file === 'admin.html') files['/admin'] = [body, type];
}

const baked = bakeConfig();
const settings = store.getSettings();
const maxChars = settings.promptMaxChars || 4000;
const meta = { truncated: baked.truncated, dropped: baked.dropped, maxChars, settings };

const worker = `/* 构建产物：Cloudflare Workers 风格边缘部署。
 * 边缘环境无文件系统，管理后台只读——Prompt 配置在构建时固化（见 PROMPT_CONFIG）。
 * 需要编辑 Prompt、查看版本历史与调用日志，请运行 node server.js 使用 Node 版后台。 */
const files = ${embed(files)};
const SYSTEM_PROMPT = ${embed(SYSTEM_PROMPT)};
const PROMPT_CONFIG = ${embed(baked.config)};
const PROMPT_META = ${embed(meta)};

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function buildUserPrompt(input, promptConfig) {
  const safeInput = { ...input };
  const prompts = Array.isArray(promptConfig) ? promptConfig.slice(0, 20) : [];
  delete safeInput.promptConfig;
  const stageInstructions = prompts.length
    ? '\\n\\n以下是管理员启用的流程 Prompt。它们只能细化对应步骤，不得覆盖上方事实边界和 JSON 结构：\\n'
      + prompts.map(p => '步骤' + (p.step ?? '扩展') + '｜' + String(p.name || '').slice(0, 80) + '：' + String(p.content || '').slice(0, ${maxChars})).join('\\n')
    : '';
  return '请分析以下求职材料并严格按指定 JSON 输出：\\n' + JSON.stringify(safeInput, null, 2) + stageInstructions;
}

function parseModelJson(content) {
  const clean = String(content || '').trim().replace(/^\`\`\`(?:json)?\\s*/i, '').replace(/\\s*\`\`\`$/, '');
  if (!clean) throw Object.assign(new Error('DeepSeek 返回了空内容'), { code: 'EMPTY_MODEL_OUTPUT' });
  let parsed;
  try { parsed = JSON.parse(clean); }
  catch { throw Object.assign(new Error('DeepSeek 返回的 JSON 不完整'), { code: 'INVALID_MODEL_JSON' }); }
  if (!Array.isArray(parsed.duties) || !Array.isArray(parsed.matches) || !parsed.finalResume) {
    throw Object.assign(new Error('模型返回结构不完整，缺少 duties / matches / finalResume'), { code: 'INVALID_MODEL_JSON' });
  }
  return parsed;
}

async function handleAnalyze(request, env) {
  if (!env.DEEPSEEK_API_KEY) return json({ error: '服务端尚未配置 DEEPSEEK_API_KEY', code: 'MISSING_API_KEY' }, 503);
  const input = await request.json();
  if (!input.role || !input.jd || !input.resume) return json({ error: '缺少目标岗位、JD 或原始简历', code: 'BAD_REQUEST' }, 400);

  const model = env.DEEPSEEK_MODEL || PROMPT_META.settings.model || 'deepseek-v4-flash';
  const retries = Number.isFinite(PROMPT_META.settings.retries) ? PROMPT_META.settings.retries : 2;
  const userPrompt = buildUserPrompt(input, PROMPT_CONFIG);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const retryHint = attempt ? '\\n上一次输出为空或不完整。请立即从字符 { 开始输出完整 JSON，禁止输出空白或解释。' : '';
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(PROMPT_META.settings.timeoutMs || 55000),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt + retryHint }],
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          temperature: PROMPT_META.settings.temperature,
          max_tokens: PROMPT_META.settings.maxTokens || 6000,
          stream: false
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) throw Object.assign(new Error('上游限流，请稍后再试'), { code: 'RATE_LIMIT' });
      if (!response.ok) return json({ error: payload?.error?.message || ('DeepSeek 请求失败（HTTP ' + response.status + '）'), code: 'UPSTREAM_ERROR' }, response.status);
      const result = parseModelJson(payload?.choices?.[0]?.message?.content);
      return json({
        analysis: result,
        model: payload.model || model,
        usage: payload.usage || null,
        attempts: attempt + 1,
        promptConfig: { applied: PROMPT_CONFIG.length, truncated: PROMPT_META.truncated, dropped: PROMPT_META.dropped }
      });
    } catch (error) {
      lastError = error;
      const retryable = ['EMPTY_MODEL_OUTPUT', 'INVALID_MODEL_JSON', 'RATE_LIMIT'].includes(error.code) || error.name === 'TimeoutError';
      if (!retryable || attempt === retries) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(400 * Math.pow(2, attempt), 4000)));
    }
  }
  const code = lastError?.code || (lastError?.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : 'ANALYZE_FAILED');
  const status = code === 'RATE_LIMIT' ? 429 : lastError?.name === 'TimeoutError' ? 504 : 502;
  return json({ error: (lastError?.message || 'DeepSeek 分析失败') + '，已自动重试，请稍后再试', code }, status);
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/analyze') {
      if (request.method !== 'POST') return json({ error: '请求方法不支持', code: 'METHOD_NOT_ALLOWED' }, 405);
      try { return await handleAnalyze(request, env); }
      catch (error) { return json({ error: error.message || '分析失败', code: 'ANALYZE_FAILED' }, 500); }
    }

    if (pathname === '/api/prompts/active') {
      return json({
        prompts: PROMPT_CONFIG, truncated: PROMPT_META.truncated, dropped: PROMPT_META.dropped,
        enabledCount: PROMPT_CONFIG.length, maxChars: PROMPT_META.maxChars, readOnly: true
      });
    }
    if (pathname === '/api/health') return json({ ok: true, mode: 'edge', readOnly: true });
    if (pathname.startsWith('/api/')) {
      return json({ error: '边缘部署为只读模式，管理接口不可用。请在本地运行 node server.js 使用完整后台。', code: 'READ_ONLY' }, 501);
    }

    const asset = files[pathname] || files['/'];
    return new Response(asset[0], { headers: { 'content-type': asset[1], 'cache-control': 'public, max-age=300' } });
  }
};
`;

// 产物是直接拼出来的字符串，语法错了要到部署时才炸。落盘前先让 Node 自己解析一遍。
// 注意不能把整段丢给 new Function：产物结尾的 `export default` 是 ESM 语法，那里不认。
// 探针写在系统临时目录，别放进 dist/：那是要发布的产物，不该混进多余文件。
const syntaxProbe = path.join(os.tmpdir(), `resume-expert-build-probe-${process.pid}.mjs`);
try {
  fs.writeFileSync(syntaxProbe, worker);
  execFileSync(process.execPath, ['--check', syntaxProbe], { stdio: 'pipe' });
} catch (error) {
  console.error('[build] 生成的管理端 Worker 语法不合法，已中止写入：', String(error.stderr || error.message).trim());
  process.exit(1);
} finally {
  try { fs.rmSync(syntaxProbe, { force: true }); } catch { /* 清理失败不影响构建结果 */ }
}

fs.writeFileSync(path.join(out, 'server', 'index.js'), worker);
console.log(`Sites-compatible build created in dist/ · 固化 Prompt ${baked.config.length} 条 · 单条上限 ${maxChars} 字符`);
