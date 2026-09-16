#!/usr/bin/env node
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PROJECT = path.resolve(__dirname, '..');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-alert-notification-verify-'));
fs.cpSync(PROJECT, staged, { recursive: true, filter(source) { const top = path.relative(PROJECT, source).split(path.sep)[0]; return !['data', 'dist', 'node_modules'].includes(top) && !top.startsWith('.git'); } });

let passed = 0; let failed = 0;
function check(label, ok) { if (ok) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); } }

(async () => {
  let received = null;
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { received = { headers: req.headers, body: JSON.parse(body) }; } catch {} res.writeHead(204); res.end(); });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const port = receiver.address().port;
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
  process.env.ALERT_WEBHOOK_TOKEN = 'server-secret-token';
  const store = require(path.join(staged, 'store.js'));
  try {
    store.saveSettings({ alertNotificationsEnabled: false }, '通知测试');
    try { store.testAlertNotification(); check('未启用通知时明确拒绝测试发送', false); } catch (error) { check('未启用通知时明确拒绝测试发送', error.code === 'ALERT_NOTIFICATIONS_DISABLED'); }
    store.saveSettings({ alertNotificationsEnabled: true }, '通知测试');
    const pending = store.testAlertNotification();
    check('启用通知后返回异步发送状态', pending.status === 'pending');
    await new Promise(resolve => setTimeout(resolve, 100));
    check('Webhook 收到 JSON 通知', received?.body?.source === 'resume-expert' && received.body.event === 'alert_test');
    check('通知不包含凭据或业务正文', !JSON.stringify(received?.body || {}).includes('server-secret-token') && !JSON.stringify(received?.body || {}).match(/JD_TEXT|RESUME_TEXT|promptContent/i));
    const latest = store.listAlertNotifications(1)[0];
    check('发送结果持久化为成功', latest?.status === 'sent');
  } finally {
    await new Promise(resolve => receiver.close(resolve));
    try { fs.rmSync(staged, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n────────  告警通知通过 ${passed} · 失败 ${failed} ────────`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
