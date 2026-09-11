const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyzeResume } = require('./deepseek');

const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 4173);

http.createServer(async (req, res) => {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname === '/api/analyze' && req.method === 'POST') {
    let raw = '';
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 120000) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 }); }
      const input = JSON.parse(raw || '{}');
      if (!input.role || !input.jd || !input.resume) throw Object.assign(new Error('缺少目标岗位、JD 或原始简历'), { statusCode: 400 });
      const result = await analyzeResume(input);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(result)); return;
    } catch (error) {
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message || '分析失败', code: error.code || 'ANALYZE_FAILED' })); return;
    }
  }
  const target = pathname === '/' ? '/index.html' : (pathname === '/admin' ? '/admin.html' : pathname);
  const file = path.resolve(root, '.' + target);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Resume Expert: http://localhost:${port}`));
