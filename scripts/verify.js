#!/usr/bin/env node
/**
 * 回归自检：一次跑完「Node 后台」和「边缘产物」两条链路。
 *
 * 起因是两处改完不容易发现的坑，都踩过一次：
 *   1. 单条读写接口一度只回摘要，正文被剥掉，编辑抽屉和版本对比直接读不到 content；
 *   2. build.js 用模板字符串拼 Worker，早期多转义了一层反斜杠，
 *      生成的 dist/server/index.js 根本无法解析，但构建过程一声不吭。
 * 这里把关键契约固化成断言，改完随手 `node scripts/verify.js` 就能发现回归。
 *
 * 用法：node scripts/verify.js
 * 退出码非 0 表示有断言失败，可直接接进 CI。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, ok, extra) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${extra ? `  →  ${extra}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${extra ? `  →  ${extra}` : ''}`);
  }
}

function group(title) {
  console.log(`\n== ${title} ==`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 把项目复制到临时目录，避免自检污染本地 data/ 与 dist/。 */
function stageProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-verify-'));
  fs.cpSync(PROJECT, dir, {
    recursive: true,
    filter: source => {
      const rel = path.relative(PROJECT, source);
      const top = rel.split(path.sep)[0];
      return top !== 'data' && top !== 'dist' && top !== 'node_modules' && !top.startsWith('.git');
    }
  });
  return dir;
}

function json(res) {
  return res.text().then(text => {
    try { return JSON.parse(text); } catch { return { __body: text }; }
  });
}

async function main() {
  const dir = stageProject();
  const port = 4300 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });

  const get = (p, init) => fetch(base + p, init);
  const postJson = (p, body, method = 'POST') => fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  try {
    await sleep(1600);

    /* ---------- 后台静态资源只放行白名单 ---------- */
    group('1. 源码与运行时数据不可下载');
    for (const p of ['/server.js', '/store.js', '/deepseek.js', '/package.json', '/data/prompts.json']) {
      const res = await get(p);
      check(`${p} 不可访问`, res.status === 404, `HTTP ${res.status}`);
    }
    for (const p of ['/', '/admin', '/styles.css', '/app.js', '/admin.js']) {
      const res = await get(p);
      check(`${p} 正常可访问`, res.status === 200, `HTTP ${res.status}`);
    }
    check('/admin 确实挂载了后台脚本', (await (await get('/admin')).text()).includes('admin.js'));
    check('/admin.js 有实际内容', (await (await get('/admin.js')).text()).length > 10000);

    /* ---------- 列表摘要 / 单条完整 ---------- */
    group('2. 列表剥正文，单条含正文');
    const list = await json(await get('/api/prompts'));
    check('列表不含 content', list.items.every(p => !('content' in p)));
    check('列表带 contentLength', list.items.every(p => typeof p.contentLength === 'number'));

    const firstId = list.items[0].id;
    const single = await json(await get(`/api/prompts/${firstId}`));
    check('单条含完整 content', typeof single.prompt.content === 'string' && single.prompt.content.length > 0,
      `${String(single.prompt.content || '').length} 字`);
    check('单条同时带上版本历史', Array.isArray(single.versions) && single.versions.length > 0,
      `${single.versions.length} 个版本`);

    /* ---------- 写入接口返回完整体 ---------- */
    group('3. 写入接口返回完整体（曾因只回摘要而回归）');
    const created = await json(await postJson('/api/prompts', {
      name: '自检用 Prompt', stepKey: 'extension', type: 'custom', desc: '由 verify.js 创建',
      content: '这是一段自检正文。'.repeat(6), enabled: false
    }));
    check('新建返回含 content', typeof created.prompt.content === 'string', `${String(created.prompt.content || '').length} 字`);

    const newId = created.prompt.id;
    const longer = '这是一段自检正文。'.repeat(12);
    const edited = await json(await postJson(`/api/prompts/${newId}`, { content: longer }, 'PUT'));
    check('编辑返回含 content', typeof edited.prompt.content === 'string', `${String(edited.prompt.content || '').length} 字`);
    check('编辑后正文确实变长', edited.prompt.content.length > created.prompt.content.length,
      `${created.prompt.content.length} → ${edited.prompt.content.length} 字`);
    check('编辑后版本号递增', edited.prompt.version !== created.prompt.version,
      `${created.prompt.version} → ${edited.prompt.version}`);

    const toggled = await json(await postJson(`/api/prompts/${newId}/toggle`, { enabled: true }));
    check('启用返回含 content', typeof toggled.prompt.content === 'string');
    check('启用后 enabled=true', toggled.prompt.enabled === true);

    /* ---------- 回滚保留历史 ---------- */
    group('4. 回滚恢复旧文，且历史不丢');
    const beforeRollback = await json(await get(`/api/prompts/${newId}`));
    const versionsBefore = beforeRollback.versions.length;
    // 回滚接口吃的是版本记录的 vid（形如 p12-v1.0），不是 "v1.0" 本身。
    const targetVid = beforeRollback.versions.find(v => v.version === created.prompt.version).vid;
    const rolled = await json(await postJson(`/api/prompts/${newId}/rollback`, { vid: targetVid }));
    check('回滚返回含 content', typeof rolled.prompt.content === 'string');
    check('回滚后正文逐字等于初版', rolled.prompt.content === created.prompt.content);
    check('回滚来源可追溯', rolled.rolledBackFrom === beforeRollback.prompt.version,
      `从 ${rolled.rolledBackFrom} 回滚`);
    const afterRollback = await json(await get(`/api/prompts/${newId}`));
    check('版本数只增不减', afterRollback.versions.length > versionsBefore,
      `${versionsBefore} → ${afterRollback.versions.length}`);
    check('被回滚掉的版本仍在历史里（可再滚回去）',
      afterRollback.versions.some(v => v.version === edited.prompt.version));

    await get(`/api/prompts/${newId}`, { method: 'DELETE' });
    check('删除后列表不再包含该条', !(await json(await get('/api/prompts'))).items.some(p => p.id === newId));

    /* ---------- 生效配置 ---------- */
    group('5. 用户端生效配置');
    const active = await json(await get('/api/prompts/active'));
    check('返回启用中的 Prompt', Array.isArray(active.prompts) && active.prompts.length > 0, `${active.prompts.length} 条`);
    check('按 step 升序', active.prompts.every((p, i) => i === 0 || (p.step ?? 99) >= (active.prompts[i - 1].step ?? 99)));
    check('每条都带正文', active.prompts.every(p => typeof p.content === 'string' && p.content.length > 0));

    /* ---------- 失败也要进日志 ---------- */
    group('6. 失败也落日志');
    const bad = await postJson('/api/analyze', {});
    check('缺字段返回 400', bad.status === 400, (await json(bad)).code);

    const saved = await json(await get('/api/settings'));
    await postJson('/api/settings', { ...saved.settings, analyzeEnabled: false }, 'PUT');
    // 必须带齐 role/jd/resume，否则先撞上字段校验拿 400，验不到总开关这条路径。
    const disabled = await postJson('/api/analyze', { role: 'x', jd: 'y', resume: 'z' });
    check('关闭总开关返回 503', disabled.status === 503, (await json(disabled)).code);
    await postJson('/api/settings', saved.settings, 'PUT');

    const stats = await json(await get('/api/logs/stats?days=7'));
    check('失败已记账（失败率非 0）', stats.failed >= 2, `failed=${stats.failed}`);
    check('错误码可读', Array.isArray(stats.byCode) && stats.byCode.length >= 2,
      stats.byCode.map(c => c.label).join('、'));
    check('每日序列可用于画图', Array.isArray(stats.daily) && stats.daily.length > 0);

    /* ---------- 设置钳制 ---------- */
    group('7. 设置越界被钳制');
    await postJson('/api/settings', { ...saved.settings, temperature: 99, retries: -3, logRetentionDays: 9999 }, 'PUT');
    const clamped = (await json(await get('/api/settings'))).settings;
    check('temperature → 2', clamped.temperature === 2, String(clamped.temperature));
    check('retries → 0', clamped.retries === 0, String(clamped.retries));
    check('logRetentionDays → 365', clamped.logRetentionDays === 365, String(clamped.logRetentionDays));
    await postJson('/api/settings', saved.settings, 'PUT');
  } finally {
    server.kill('SIGKILL');
    await sleep(200);
  }

  /* ---------- 构建产物 ---------- */
  group('8. 构建产物可解析、可运行');
  let buildOk = true;
  try {
    execFileSync(process.execPath, ['build.js'], { cwd: dir, stdio: 'pipe' });
  } catch (error) {
    buildOk = false;
    console.log(`    构建失败：${String(error.stderr || error.message).trim().split('\n')[0]}`);
  }
  check('npm run build 成功', buildOk);

  const workerPath = path.join(dir, 'dist', 'server', 'index.js');
  if (buildOk && fs.existsSync(workerPath)) {
    let syntaxOk = true;
    try {
      execFileSync(process.execPath, ['--check', workerPath], { stdio: 'pipe' });
    } catch (error) {
      syntaxOk = false;
      console.log(`    产物语法错误：${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
    check('产物语法合法（曾因多转义反斜杠而无法解析）', syntaxOk);

    const probe = path.join(os.tmpdir(), `resume-verify-worker-${process.pid}.mjs`);
    fs.copyFileSync(workerPath, probe);
    const mod = await import(`file://${probe}?t=${Date.now()}`);
    const handler = mod.default;
    const call = (p, init) => handler.fetch(new Request(`https://edge.local${p}`, init));

    const edgeActive = await json(await call('/api/prompts/active'));
    check('边缘产物固化 Prompt 可用', Array.isArray(edgeActive.prompts) && edgeActive.prompts.length > 0,
      `${edgeActive.prompts.length} 条`);
    check('边缘为只读模式', edgeActive.readOnly === true);

    const edgeWrite = await call('/api/prompts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('边缘写接口返回 501 READ_ONLY', edgeWrite.status === 501, (await json(edgeWrite)).code);

    for (const p of ['/', '/admin', '/admin.js', '/styles.css', '/app.js']) {
      const res = await call(p);
      const body = await res.text();
      check(`边缘托管 ${p}`, res.status === 200 && body.length > 500, `${body.length}B`);
    }
    fs.rmSync(probe, { force: true });
  } else {
    check('产物存在', false);
  }

  /* ---------- 管理端源码不变量 ----------
   * 下面两条是浏览器里的渲染逻辑，服务端跑不到，但都真出过问题，
   * 所以退一步用源码断言把不变量钉住（改动一旦破坏就报错）。 */
  group('9. 管理端渲染不变量');
  const adminSrc = fs.readFileSync(path.join(PROJECT, 'admin.js'), 'utf8');

  // 曾出错：render() 铺完空表骨架却没人填行，切走再切回 Prompt 页签时表格永远空白。
  const renderBody = (adminSrc.match(/function render\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  check('render() 会补填 Prompt 表格行',
    /state\.route === 'prompts'/.test(renderBody) && /renderRows\(\)/.test(renderBody));

  // 曾出错：版本按时间倒序，index 0 就是当前版本，diff 按钮却长在它身上——
  // 点「与当前对比」比的是它自己，diff 区域永远是「两个版本内容完全一致」。
  const historyBody = (adminSrc.match(/function historyHtml\([\s\S]*?\n  \}/) || [''])[0];
  const diffLine = (historyBody.match(/.*data-act="diff".*"/) || [''])[0];
  check('diff 按钮只出现在非当前版本上',
    /isCurrent \? '' :/.test(diffLine) && !/index \+ 1 < versions\.length/.test(diffLine));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

  console.log(`\n────────  通过 ${passed} · 失败 ${failed}  ────────`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error('自检脚本自身异常：', error);
  process.exit(1);
});
