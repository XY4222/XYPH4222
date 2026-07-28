const fs = require('fs');
const path = require('path');
const { SYSTEM_PROMPT } = require('./deepseek');

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'server'), { recursive: true });
fs.mkdirSync(path.join(out, '.openai'), { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}
fs.copyFileSync(path.join(__dirname, '.openai', 'hosting.json'), path.join(out, '.openai', 'hosting.json'));

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const worker = `const files = {
  '/': [${JSON.stringify(html)}, 'text/html; charset=utf-8'],
  '/index.html': [${JSON.stringify(html)}, 'text/html; charset=utf-8'],
  '/styles.css': [${JSON.stringify(css)}, 'text/css; charset=utf-8'],
  '/app.js': [${JSON.stringify(js)}, 'text/javascript; charset=utf-8']
};
const SYSTEM_PROMPT = ${JSON.stringify(SYSTEM_PROMPT)};
function parseModelJson(content) {
  const clean = String(content || '').trim().replace(/^\`\`\`(?:json)?\\s*/i, '').replace(/\\s*\`\`\`$/, '');
  const parsed = JSON.parse(clean);
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
        const response = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
          body: JSON.stringify({ model: env.DEEPSEEK_MODEL || 'deepseek-v4-pro', messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '请分析以下求职材料并严格按指定 JSON 输出：\\n' + JSON.stringify(input, null, 2) }], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 8000, stream: false })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return Response.json({ error: payload?.error?.message || ('DeepSeek 请求失败（HTTP ' + response.status + ')') }, { status: response.status });
        return Response.json({ analysis: parseModelJson(payload?.choices?.[0]?.message?.content), model: payload.model || env.DEEPSEEK_MODEL || 'deepseek-v4-pro', usage: payload.usage || null });
      } catch (error) { return Response.json({ error: error.message || '分析失败', code: 'ANALYZE_FAILED' }, { status: 500 }); }
    }
    const asset = files[pathname] || files['/'];
    return new Response(asset[0], { headers: { 'content-type': asset[1], 'cache-control': 'public, max-age=300' } });
  }
};
`;
fs.writeFileSync(path.join(out, 'server', 'index.js'), worker);
console.log('Sites-compatible build created in dist/');
