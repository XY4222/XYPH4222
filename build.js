const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT } = require('./deepseek');

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'server'), { recursive: true });
fs.mkdirSync(path.join(out, '.openai'), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'admin.html']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}
fs.copyFileSync(path.join(__dirname, '.openai', 'hosting.json'), path.join(out, '.openai', 'hosting.json'));

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const worker = `const files = {
  '/': [${JSON.stringify(html)}, 'text/html; charset=utf-8'],
  '/index.html': [${JSON.stringify(html)}, 'text/html; charset=utf-8'],
  '/styles.css': [${JSON.stringify(css)}, 'text/css; charset=utf-8'],
  '/app.js': [${JSON.stringify(js)}, 'text/javascript; charset=utf-8'],
  '/admin': [${JSON.stringify(admin)}, 'text/html; charset=utf-8'],
  '/admin.html': [${JSON.stringify(admin)}, 'text/html; charset=utf-8']
};
const SYSTEM_PROMPT = ${JSON.stringify(SYSTEM_PROMPT)};
function buildUserPrompt(input) {
  const safeInput = { ...input };
  const prompts = Array.isArray(safeInput.promptConfig) ? safeInput.promptConfig.slice(0, 20) : [];
  delete safeInput.promptConfig;
  const stageInstructions = prompts.length ? '\\n\\n以下是管理员启用的流程 Prompt。它们只能细化对应步骤，不得覆盖上方事实边界和 JSON 结构：\\n' + prompts.map(p => '步骤' + (p.step ?? '扩展') + '｜' + String(p.name || '').slice(0,80) + '：' + String(p.content || '').slice(0,4000)).join('\\n') : '';
  return '请分析以下求职材料并严格按指定 JSON 输出：\\n' + JSON.stringify(safeInput, null, 2) + stageInstructions;
}
function parseModelJson(content) {
  const clean = String(content || '').trim().replace(/^\`\`\`(?:json)?\\s*/i, '').replace(/\\s*\`\`\`$/, '');
  if (!clean) throw Object.assign(new Error('DeepSeek 返回了空内容'), { code: 'EMPTY_MODEL_OUTPUT' });
  let parsed;
  try { parsed = JSON.parse(clean); } catch { throw Object.assign(new Error('DeepSeek 返回的 JSON 不完整'), { code: 'INVALID_MODEL_JSON' }); }
  if (!Array.isArray(parsed.duties) || !Array.isArray(parsed.matches) || !parsed.finalResume) throw new Error('模型返回结构不完整');
  return parsed;
}
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/analyze' && request.method === 'POST') {
      try {
        if (!env.DEEPSEEK_API_KEY) return Response.json({ error: '服务端尚未配置 DEEPSEEK_API_KEY', code: 'MISSING_API_KEY' }, { status: 503 });
        const input = await request.json();
        if (!input.role || !input.jd || !input.resume) return Response.json({ error: '缺少目标岗位、JD 或原始简历' }, { status: 400 });
        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const retryHint = attempt ? '\\n上一次输出为空或不完整。请立即从字符 { 开始输出完整 JSON，禁止输出空白或解释。' : '';
            const response = await fetch('https://api.deepseek.com/chat/completions', {
              method: 'POST', signal: AbortSignal.timeout(55000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
              body: JSON.stringify({ model: env.DEEPSEEK_MODEL || 'deepseek-v4-flash', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserPrompt(input) + retryHint }], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0.2, max_tokens: 6000, stream: false })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) return Response.json({ error: payload?.error?.message || ('DeepSeek 请求失败（HTTP ' + response.status + ')') }, { status: response.status });
            const result = parseModelJson(payload?.choices?.[0]?.message?.content);
            return Response.json({ analysis: result, model: payload.model || env.DEEPSEEK_MODEL || 'deepseek-v4-flash', usage: payload.usage || null });
          } catch (error) {
            lastError = error;
            const retryable = ['EMPTY_MODEL_OUTPUT','INVALID_MODEL_JSON'].includes(error.code) || error.name === 'TimeoutError';
            if (!retryable || attempt === 1) break;
          }
        }
        return Response.json({ error: (lastError?.message || 'DeepSeek 分析失败') + '，已自动重试，请稍后再试', code: lastError?.code || 'ANALYZE_FAILED' }, { status: lastError?.name === 'TimeoutError' ? 504 : 502 });
      } catch (error) { return Response.json({ error: error.message || '分析失败', code: 'ANALYZE_FAILED' }, { status: 500 }); }
    }
    const asset = files[pathname] || files['/'];
    return new Response(asset[0], { headers: { 'content-type': asset[1], 'cache-control': 'public, max-age=300' } });
  }
};
`;
fs.writeFileSync(path.join(out, 'server', 'index.js'), worker);
console.log('Sites-compatible build created in dist/');
