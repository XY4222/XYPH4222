const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(__dirname, file), path.join(out, file));
}
console.log('Static site built in dist/');
