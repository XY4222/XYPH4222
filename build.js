const fs = require('fs');
const path = require('path');

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
export default {
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const asset = files[pathname] || files['/'];
    return new Response(asset[0], { headers: { 'content-type': asset[1], 'cache-control': 'public, max-age=300' } });
  }
};
`;
fs.writeFileSync(path.join(out, 'server', 'index.js'), worker);
console.log('Sites-compatible build created in dist/');
