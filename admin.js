/* 简历专家 · Prompt 管理后台
 * 数据全部来自服务端（data/ 目录），不再依赖 localStorage。
 * 页面：Prompt 总览 / 发布中心 / Prompt 测试台 / 变更记录 / 运行日志 / 项目设置
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    auth: null,
    route: 'prompts',
    overview: null,
    prompts: [],
    query: { q: '', status: 'all', type: 'all' },
    changes: [],
    changesMeta: { total: 0, page: 1, pages: 1, actions: [] },
    changeFilter: { action: '', actor: '', from: '', to: '' },
    logs: [],
    tasks: null,
    taskFilter: { status: '', role: '', days: 7, page: 1 },
    logStats: null,
    logDays: 7,
    logFilter: { ok: 'all', model: '', prompt: '', role: '', minLatency: 0 },
    settings: null,
    notification: null,
    testCases: [],
    testRuns: [],
    regressionRuns: [],
    feedback: [],
    feedbackStats: null,
    feedbackFilter: { status: '', rating: '', prompt: '' },
    quality: null,
    qualityDays: 7,
    experiments: null,
    experimentDays: 7,
    regressionCenter: null,
    dashboard: null,
    systemHealth: null,
    rules: [],
    dependencies: null,
    testResult: null,
    testForm: { promptId: '', caseId: '', name: '', role: '', jd: '', resume: '', extra: '', minScore: '0', maxScoreDrop: '5', requiredTerms: '' },
    currentPrompt: null,
    currentVersions: []
    ,selectedPrompts: [], templates: []
  };

  /* ---------- 工具 ---------- */

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(message, isError) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function showConnError(message) {
    const el = $('#connBanner');
    el.textContent = message;
    el.classList.add('show');
  }

  function clearConnError() {
    $('#connBanner').classList.remove('show');
  }

  async function api(path, options) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`);
      error.code = payload.code;
      error.status = response.status;
      error.payload = payload;
      if (response.status === 401 && !path.startsWith('/api/auth/')) setTimeout(() => renderLogin('登录已过期，请重新登录'), 0);
      throw error;
    }
    return payload;
  }

  const ROLE_LEVEL = { viewer: 1, editor: 2, admin: 3 };
  const ROLE_LABEL = { viewer: '查看者', editor: '编辑者', admin: '管理员' };
  function can(role) { return !!state.auth && ROLE_LEVEL[state.auth.role] >= ROLE_LEVEL[role]; }

  function updateAccount() {
    const user = state.auth;
    $('#accountName').textContent = user ? user.username : '未登录';
    $('#accountRole').textContent = user ? (ROLE_LABEL[user.role] || user.role) : '访客';
    $('#accountAvatar').textContent = user ? user.username.slice(0, 1).toUpperCase() : '访';
    $('#logoutBtn').style.display = user ? '' : 'none';
  }

  function renderLogin(message) {
    state.auth = null;
    updateAccount();
    $('#page').innerHTML = `<section class="panel" style="max-width:460px;margin:70px auto">
      <div class="panel-head"><div><h2>登录 Prompt 管理后台</h2><p>账号由服务端环境变量配置，密码不会保存在浏览器中。</p></div></div>
      <form id="loginForm" style="padding:24px">
        ${message ? `<div class="banner error show">${escapeHtml(message)}</div>` : ''}
        <div class="field"><label>用户名</label><input id="loginUsername" autocomplete="username" required /></div>
        <div class="field"><label>密码</label><input id="loginPassword" type="password" autocomplete="current-password" required /></div>
        <button class="primary" type="submit" style="width:100%">登录</button>
      </form>
    </section>`;
    $('#loginForm').addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const result = await api('/api/auth/login', {
          method: 'POST', body: { username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }
        });
        state.auth = result.user;
        updateAccount();
        await loadAuthenticatedApp();
      } catch (error) { renderLogin(error.message); }
    });
  }

  function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '-';
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
    return new Date(iso).toLocaleDateString('zh-CN');
  }

  function fullTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  const ACTION_TAG = {
    seed: 'grey', create: 'green', update: 'blue', meta: 'blue', scope: 'amber',
    status: 'grey', enable: 'green', disable: 'amber', rollback: 'amber', delete: 'red', settings: 'blue',
    submit_review: 'amber', reject_review: 'red', publish: 'green', production_rollback: 'amber',
    test_case_create: 'blue', test_case_delete: 'red'
  };

  function tag(text, tone) { return `<span class="tag ${tone || ''}">${escapeHtml(text)}</span>`; }

  function fmtNumber(value) {
    if (!Number.isFinite(Number(value))) return '-';
    return Number(value).toLocaleString('zh-CN');
  }

  function fmtCost(value) {
    const n = Number(value || 0);
    if (n === 0) return '0';
    return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
  }

  function fmtLatency(ms) {
    if (!ms) return '-';
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  /* ---------- 行级 diff（LCS） ---------- */

  function diffLines(before, after) {
    const a = String(before || '').split('\n');
    const b = String(after || '').split('\n');
    const n = a.length;
    const m = b.length;

    // 超大文本退化为整体替换，避免 O(n*m) 卡死浏览器
    if (n * m > 400000) {
      return a.map(line => ({ type: 'del', text: line })).concat(b.map(line => ({ type: 'add', text: line })));
    }

    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
      else { out.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < n) out.push({ type: 'del', text: a[i++] });
    while (j < m) out.push({ type: 'add', text: b[j++] });
    return out;
  }

  /** 折叠未变化的长段落，只保留变更点前后各 2 行 */
  function renderDiff(before, after) {
    const rows = diffLines(before, after);
    const keep = new Array(rows.length).fill(false);
    rows.forEach((row, index) => {
      if (row.type === 'same') return;
      for (let k = Math.max(0, index - 2); k <= Math.min(rows.length - 1, index + 2); k++) keep[k] = true;
    });
    const html = [];
    let skipped = 0;
    const flush = () => {
      if (skipped) { html.push(`<div class="row same"><span class="sign">⋯</span><span>（${skipped} 行未变化）</span></div>`); skipped = 0; }
    };
    rows.forEach((row, index) => {
      if (!keep[index]) { skipped++; return; }
      flush();
      const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
      html.push(`<div class="row ${row.type}"><span class="sign">${sign}</span><span>${escapeHtml(row.text) || '&nbsp;'}</span></div>`);
    });
    flush();
    const added = rows.filter(r => r.type === 'add').length;
    const removed = rows.filter(r => r.type === 'del').length;
    if (!added && !removed) return '<div class="empty">两个版本内容完全一致</div>';
    return `<div class="diff">${html.join('')}</div><p class="prompt-meta" style="margin-top:8px">新增 ${added} 行，删除 ${removed} 行</p>`;
  }

  /* ---------- 路由 ---------- */

  const ROUTE_TITLE = { dashboard: '运营总览', prompts: 'Prompt 总览', releases: '发布中心', tests: 'Prompt 测试台', changes: '变更记录', logs: '运行日志', tasks: '任务中心', quality: '质量分析', experiments: '实验中心', regressions: '回归中心', health: '系统健康', feedback: '质量反馈', rules: '风险规则', dependencies: '流程依赖', settings: '项目设置' };

  function setNav(route) {
    $('#crumb').textContent = ROUTE_TITLE[route] || route;
    $$('#nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.route === route));
  }

  async function navigate(route) {
    state.route = route;
    setNav(route);
    render();
    // 首次进入某个页签时再拉数据，避免启动时打满请求
    try {
      if (route === 'dashboard') await loadDashboard();
      else if (route === 'changes') await loadChanges();
      else if (route === 'logs') await loadLogs();
      else if (route === 'tasks') await loadTasks();
      else if (route === 'quality') await loadQuality();
      else if (route === 'experiments') await loadExperiments();
      else if (route === 'regressions') await loadRegressionCenter();
      else if (route === 'health') await loadSystemHealth();
      else if (route === 'feedback') await loadFeedback();
      else if (route === 'rules') await loadRules();
      else if (route === 'dependencies') await loadDependencies();
      else if (route === 'settings') await loadSettings();
      else if (route === 'tests') await loadTests();
      else if ((route === 'prompts' || route === 'releases') && !state.overview) await loadPrompts();
    } catch (error) { showConnError(error.message); }
  }

  function render() {
    const page = $('#page');
    if (state.route === 'dashboard') { page.innerHTML = viewDashboard(); const b = state.dashboard?.budget || {}; page.insertAdjacentHTML('afterbegin', `<section class="panel budget-summary"><div class="panel-head"><div><h2>近 24 小时成本预算</h2><p>${b.enabled ? `预算 ¥${fmtCost(b.budget)} · 已使用 ¥${fmtCost(b.spent || 0)} · 剩余 ¥${fmtCost(b.remaining || 0)}` : '预算监控未启用（每日预算设为 0）'}</p></div>${b.exceeded ? tag('已超预算', 'red') : b.enabled ? tag('预算内', 'green') : ''}</div></section>`); }
    else if (state.route === 'prompts') page.innerHTML = viewPrompts();
    else if (state.route === 'releases') page.innerHTML = viewReleases();
    else if (state.route === 'tests') page.innerHTML = viewTests();
    else if (state.route === 'changes') page.innerHTML = viewChanges();
    else if (state.route === 'logs') page.innerHTML = viewLogs();
    else if (state.route === 'tasks') page.innerHTML = viewTasks();
    else if (state.route === 'quality') page.innerHTML = viewQuality();
    else if (state.route === 'experiments') page.innerHTML = viewExperiments();
    else if (state.route === 'regressions') page.innerHTML = viewRegressionCenter();
    else if (state.route === 'health') page.innerHTML = viewSystemHealth();
    else if (state.route === 'feedback') page.innerHTML = viewFeedback();
    else if (state.route === 'rules') page.innerHTML = viewRules();
    else if (state.route === 'dependencies') page.innerHTML = viewDependencies();
    else page.innerHTML = viewSettings();
    enhanceEmptyState();
    bindView();
    // viewPrompts() 只铺出空表格骨架，行要靠 renderRows 填。切走再切回来时
    // navigate() 因为 state.overview 已存在不会重新拉数据，这里不补一次，
    // 表格就会一直是空的（筛选、停留、往返都会踩到）。
    if (state.route === 'prompts') renderRows();
  }

  function loading(text) { return `<div class="panel"><div class="loading">${escapeHtml(text || '加载中…')}</div></div>`; }

  function emptyGuide(title, description, steps, actions = []) {
    return `<div class="empty-guide"><div class="empty-guide-icon">◎</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><ol>${steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>${actions.length ? `<div class="actions">${actions.map(action => action.href ? `<a class="${action.primary ? 'primary' : 'secondary'}" href="${escapeHtml(action.href)}" target="_blank" rel="noopener">${escapeHtml(action.label)}</a>` : `<button class="${action.primary ? 'primary' : 'secondary'}" data-go-route="${escapeHtml(action.route)}">${escapeHtml(action.label)}</button>`).join('')}</div>` : ''}</div>`;
  }

  function enhanceEmptyState() {
    if (state.route === 'dashboard' && Number(state.dashboard?.quality?.overall?.calls || 0) === 0 && !document.querySelector('#page .first-use-guide')) {
      document.querySelector('#page')?.insertAdjacentHTML('afterbegin', emptyGuide('第一次使用，从一条真实链路开始', '后台不会自动生成演示指标。先完成一次真实分析，再回来查看运行、质量和成本数据。', ['打开用户端，填写目标岗位、JD 和简历并完成分析', '回到 Prompt 测试台，保存一个可重复运行的测试案例', '确认结果后再使用发布、灰度、回归和质量反馈功能'], [{ label: '打开用户端', href: '/', primary: true }, { label: '打开测试台', route: 'tests' }]));
      const guide = document.querySelector('#page .empty-guide');
      if (guide) guide.classList.add('first-use-guide');
    }
    const guides = {
      experiments: ['还没有灰度实验', '实验数据只会在一个 Prompt 启动灰度后产生。', ['在 Prompt 总览编辑并保存一个工作草稿', '到测试台用真实案例比较草稿与生产版本', '审核并发布候选版本后，在发布中心启动灰度'], [{ label: '查看 Prompt', route: 'prompts' }, { label: '打开发布中心', route: 'releases', primary: true }]],
      regressions: ['还没有回归结果', '回归中心不会自动造数，需要先建立可重复运行的测试案例。', ['打开 Prompt 测试台并选择目标 Prompt', '填写真实 JD 与简历，保存为测试案例', '运行回归测试集，结果会汇总到这里'], [{ label: '去测试台建立案例', route: 'tests', primary: true }]],
      logs: ['还没有运行记录', '用户端完成真实分析后，这里才会记录模型、耗时、Token、成本和错误码。', ['打开用户端并填写目标岗位、JD 和简历', '点击开始分析并等待完成', '返回本页刷新查看运行记录'], [{ label: '打开用户端', href: '/', primary: true }]],
      tasks: ['还没有分析任务', '任务中心展示用户端真实分析请求，不展示虚构的演示任务。', ['到用户端完成一次简历分析', '成功和失败请求都会形成任务记录', '返回本页查看状态、耗时和失败原因'], [{ label: '发起一次分析', href: '/', primary: true }]],
      quality: ['还没有质量样本', '质量指标来自真实运行记录；至少先完成一次分析，更多样本后趋势才有意义。', ['到用户端运行一份真实 JD 与简历', '在运行日志确认请求已经入库', '积累样本后查看成功率、耗时、成本和版本对比'], [{ label: '打开用户端', href: '/', primary: true }, { label: '查看运行日志', route: 'logs' }]],
      feedback: ['还没有人工反馈', '反馈必须关联真实运行记录，避免无法复现的问题描述。', ['先在用户端完成一次分析', '在运行日志复制对应的运行记录 ID', '回到本页新增“有效”或“需改进”反馈'], [{ label: '查看运行日志', route: 'logs', primary: true }]],
      changes: ['还没有变更记录', '编辑、送审、发布 Prompt 或修改项目设置后，变更会自动记录。', ['到 Prompt 总览打开任意 Prompt', '修改正文并保存为草稿', '返回本页查看操作人、版本和备注'], [{ label: '编辑 Prompt', route: 'prompts', primary: true }]]
    };
    const guide = guides[state.route];
    if (!guide) return;
    const empty = Array.from(document.querySelectorAll('#page .empty')).find(node => /没有|暂无|尚无/.test(node.textContent));
    if (empty) empty.outerHTML = emptyGuide(...guide);
  }

  function viewDashboard() {
    const data = state.dashboard;
    if (!data) return `<div class="headline"><div><h1>运营总览</h1><p>集中查看发布、运行、质量和告警状态。</p></div></div>${loading()}`;
    const o = data.overview || {}; const q = data.quality?.overall || {}; const t = data.tasks?.summary || {}; const b = data.budget || {};
    const alerts = (data.alerts?.items || []).filter(item => item.status !== 'recovered');
    const alertRows = alerts.slice(0, 6).map(item => `<tr><td>${escapeHtml(item.scope || '-')}</td><td>${escapeHtml(item.metric || '-')}</td><td>${tag(item.status || 'active', item.status === 'acknowledged' ? 'blue' : 'amber')}</td><td>${item.lastRate != null ? `${item.lastRate}%` : '—'}</td></tr>`).join('');
    return `<div class="headline"><div><h1>运营总览</h1><p>数据来自服务端接口，统计窗口：近 7 天。</p></div><button class="secondary" id="reloadDashboard">刷新</button></div><section class="stats"><div class="stat"><label>待审核 Prompt</label><strong>${fmtNumber(o.reviews || 0)}</strong><small>${o.reviews ? '需要管理员处理' : '当前无待审核'}</small></div><div class="stat"><label>失败任务</label><strong>${fmtNumber(t.failed || 0)}</strong><small class="${t.failed ? 'warn' : 'good'}">当前窗口</small></div><div class="stat"><label>近 7 天成功率</label><strong>${q.successRate == null ? '—' : `${q.successRate}%`}</strong><small>${fmtNumber(q.calls || 0)} 次调用</small></div><div class="stat"><label>活动告警</label><strong>${fmtNumber(alerts.length)}</strong><small class="${alerts.length ? 'warn' : 'good'}">${alerts.length ? '需要关注' : '运行正常'}</small></div><div class="stat"><label>流程覆盖</label><strong>${o.coverage || 0}/${o.coverageTotal || 8}</strong><small class="${o.coverage === o.coverageTotal ? 'good' : 'warn'}">${o.coverage === o.coverageTotal ? '全部步骤已覆盖' : '存在生产缺口'}</small></div></section><section class="panel"><div class="panel-head"><div><h2>当前告警</h2><p>只展示未恢复的告警；详情请到运行日志查看。</p></div><button class="secondary" id="dashboardOpenLogs">查看运行日志</button></div>${alertRows ? `<table class="table"><thead><tr><th>范围</th><th>指标</th><th>状态</th><th>最近比例</th></tr></thead><tbody>${alertRows}</tbody></table>` : '<div class="empty">当前没有活动告警</div>'}</section><div class="grid2"><section class="panel"><div class="panel-head"><div><h2>发布队列</h2><p>草稿和待审核数量</p></div><button class="secondary" id="dashboardOpenReleases">打开发布中心</button></div><div class="kv"><div class="item"><label>草稿</label><strong>${fmtNumber(o.drafts || 0)}</strong></div><div class="item"><label>待审核</label><strong>${fmtNumber(o.reviews || 0)}</strong></div><div class="item"><label>已发布</label><strong>${fmtNumber(o.published || 0)}</strong></div></div></section><section class="panel"><div class="panel-head"><div><h2>成本与重试</h2><p>近 7 天质量汇总</p></div><button class="secondary" id="dashboardOpenQuality">查看质量分析</button></div><div class="kv"><div class="item"><label>估算成本</label><strong>¥${fmtCost(q.cost || 0)}</strong></div><div class="item"><label>重试率</label><strong>${q.retryRate == null ? '—' : `${q.retryRate}%`}</strong></div><div class="item"><label>Schema 错误率</label><strong>${q.schemaErrorRate == null ? '—' : `${q.schemaErrorRate}%`}</strong></div></div></section></div>`;
  }

  function viewSystemHealth() {
    const data = state.systemHealth;
    if (!data) return `<div class="headline"><div><h1>系统健康</h1><p>检查后台运行所需的配置和数据状态。</p></div></div>${loading()}`;
    const labels = { ok: ['正常', 'green'], warn: ['需关注', 'amber'], fail: ['异常', 'red'] };
    const [summary, tone] = labels[data.status] || ['未知', 'grey'];
    const rows = (data.checks || []).map(item => { const [label, itemTone] = labels[item.status] || ['未知', 'grey']; return `<tr><td><strong>${escapeHtml(item.label)}</strong><div class="prompt-meta">${escapeHtml(item.id)}</div></td><td>${tag(label, itemTone)}</td><td>${escapeHtml(item.detail)}</td></tr>`; }).join('');
    return `<div class="headline"><div><h1>系统健康</h1><p>仅检查运行条件，不显示密钥、Prompt 正文或用户输入。</p></div><div class="actions">${tag(summary, tone)}<button class="secondary" id="reloadSystemHealth">刷新</button></div></div><section class="panel"><div class="panel-head"><div><h2>检查项</h2><p>最近检查：${fullTime(data.generatedAt)}</p></div></div>${rows ? `<table class="table"><thead><tr><th>检查项</th><th>状态</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">暂无检查结果</div>'}</section>`;
  }

  function viewFeedback() {
    const s = state.feedbackStats || { total: 0, good: 0, bad: 0, positiveRate: 0, open: 0, resolved: 0, byTag: [] };
    const rows = state.feedback.map(item => `<tr><td class="prompt-meta">${fullTime(item.updatedAt)}</td><td>${tag(item.rating === 'good' ? '有效' : '需改进', item.rating === 'good' ? 'green' : 'red')}</td><td>${tag(item.status, item.status === 'resolved' ? 'green' : item.status === 'open' ? 'amber' : 'blue')}</td><td>${escapeHtml(item.role || '-')}</td><td>${escapeHtml((item.prompts || []).join('、') || '-')}</td><td>${escapeHtml((item.promptVersions || []).map(version => `${version.name}@${version.version}`).join('、') || '-')}</td><td>${escapeHtml((item.tags || []).join('、') || '-')}</td><td>${escapeHtml(item.comment || '-')}</td><td>${item.loop ? `<div>${tag('已关联', 'green')}<div class="prompt-meta">${escapeHtml(item.loop.promptName)} · ${escapeHtml(item.loop.sourceVersion || '-')} ${item.loop.testCaseName ? `· ${escapeHtml(item.loop.testCaseName)}` : ''}</div></div>` : (can('editor') ? `<button class="iconbtn" data-feedback-link="${item.id}">建立闭环</button>` : tag('未关联'))}</td><td>${can('editor') ? `<select class="filter" data-feedback-status="${item.id}">${['open','reviewing','resolved','dismissed'].map(status => `<option value="${status}"${status === item.status ? ' selected' : ''}>${status}</option>`).join('')}</select>` : tag(item.owner || '未分派')}</td></tr>`).join('');
    return `<div class="headline"><div><h1>质量反馈</h1><p>只记录运行元数据与人工评价，不复制 JD 或简历原文。</p></div><div class="actions"><button class="secondary" id="reloadFeedback">刷新</button></div></div>
      <section class="panel"><div class="toolbar"><select class="filter" id="feedbackStatusFilter"><option value="">全部处理状态</option>${['open','reviewing','resolved','dismissed'].map(x => `<option value="${x}"${state.feedbackFilter.status === x ? ' selected' : ''}>${x}</option>`).join('')}</select><select class="filter" id="feedbackRatingFilter"><option value="">全部评价</option><option value="good"${state.feedbackFilter.rating === 'good' ? ' selected' : ''}>有效</option><option value="bad"${state.feedbackFilter.rating === 'bad' ? ' selected' : ''}>需改进</option></select><input class="filter" id="feedbackPromptFilter" placeholder="按 Prompt 筛选" value="${escapeHtml(state.feedbackFilter.prompt)}" /><button class="secondary" id="clearFeedbackFilters">清除筛选</button></div></section>
      ${can('editor') ? `<section class="panel"><div class="panel-head"><div><h2>新增反馈</h2><p>从运行日志的 ID 关联请求；不要粘贴 JD 或简历原文</p></div></div><div style="padding:18px"><div class="grid2"><div class="field"><label>运行记录 ID</label><input id="feedback-logId" placeholder="例如：mabc123-x7k9" /></div><div class="field"><label>评价</label><select id="feedback-rating"><option value="bad">需改进</option><option value="good">有效</option></select></div><div class="field"><label>问题标签</label><input id="feedback-tags" placeholder="例如：事实错误、结构不完整、格式问题" /></div><div class="field"><label>负责人</label><input id="feedback-owner" /></div></div><div class="field"><label>备注</label><textarea id="feedback-comment" style="min-height:90px" placeholder="记录可复现的问题和改进方向"></textarea></div><div style="display:flex;justify-content:flex-end"><button class="primary" id="saveFeedback">保存反馈</button></div></div></section>` : ''}
      <section class="stats"><div class="stat"><label>反馈总数</label><strong>${s.total}</strong><small>有效 ${s.good} · 需改进 ${s.bad}</small></div><div class="stat"><label>正向率</label><strong>${s.positiveRate}%</strong><small>基于人工反馈</small></div><div class="stat"><label>待处理</label><strong>${s.open}</strong><small>开放或审查中</small></div><div class="stat"><label>已解决</label><strong>${s.resolved}</strong><small>已闭环反馈</small></div></section>
      <section class="panel"><div class="panel-head"><div><h2>反馈明细</h2><p>通过运行记录 ID 关联具体请求，并保留实际生效 Prompt 版本；闭环关联只保存 Prompt、版本和测试案例元数据</p></div></div>${rows ? `<table class="table"><thead><tr><th>更新时间</th><th>评价</th><th>状态</th><th>岗位</th><th>Prompt</th><th>生效版本</th><th>问题标签</th><th>备注</th><th>修复闭环</th><th>处理状态</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">暂无质量反馈</div>'}</section>`;
  }

  function viewRules() {
    const rows = state.rules.map(rule => `<tr><td>${escapeHtml(rule.name)}</td><td>${tag(rule.type === 'forbidden_pattern' ? '禁止匹配' : '必须匹配', rule.type === 'forbidden_pattern' ? 'red' : 'blue')}</td><td><code>${escapeHtml(rule.pattern)}</code></td><td>${tag(rule.severity, rule.severity === 'critical' || rule.severity === 'high' ? 'red' : 'amber')}</td><td>${rule.enabled ? tag('启用', 'green') : tag('停用')}</td><td>${can('editor') ? `<button class="iconbtn" data-rule-toggle="${escapeHtml(rule.id)}" data-enabled="${rule.enabled ? 'false' : 'true'}">${rule.enabled ? '停用' : '启用'}</button>` : ''}${can('admin') ? `<button class="iconbtn danger-text" data-rule-delete="${escapeHtml(rule.id)}">删除</button>` : ''}</td></tr>`).join('');
    return `<div class="headline"><div><h1>风险规则</h1><p>服务端扫描模型输出，命中结果会回传给调用方并写入运行指标。</p></div><button class="secondary" id="reloadRules">刷新</button></div><section class="panel"><div class="panel-head"><div><h2>规则列表</h2><p>规则变更进入审计记录；停用不删除历史</p></div></div>${rows ? `<table class="table"><thead><tr><th>规则</th><th>类型</th><th>模式</th><th>级别</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">暂无风险规则</div>'}</section>`;
  }

  function viewDependencies() {
    const data = state.dependencies;
    if (!data) return loading();
    const rows = data.steps.map(step => `<tr><td><strong>步骤 ${step.step}</strong></td><td>${step.covered ? tag('生产已覆盖', 'green') : tag('生产缺失', 'red')}</td><td>${step.workspaceCount} / ${step.productionCount}</td><td>${step.hasDraft ? tag('有草稿', 'amber') : tag('一致', 'green')}</td><td>${step.prompts.length ? step.prompts.map(prompt => `<div class="prompt-name">${escapeHtml(prompt.name)} ${prompt.variables.length ? tag(`变量 ${prompt.variables.length}`, 'blue') : ''} ${prompt.regressionCases ? tag(prompt.latestRegression ? '门禁通过' : '门禁未通过', prompt.latestRegression ? 'green' : 'red') : ''}</div>`).join('') : '<span class="prompt-meta">未配置</span>'}</td></tr>`).join('');
    const extensions = data.extensionPrompts.length ? data.extensionPrompts.map(prompt => `<div class="case-row"><div class="case-main"><div class="prompt-name">${escapeHtml(prompt.name)}</div><div class="prompt-meta">${prompt.enabled ? '启用' : '停用'} · ${escapeHtml(prompt.releaseStatus)}</div></div></div>`).join('') : '<div class="empty">暂无扩展 Prompt</div>';
    return `<div class="headline"><div><h1>流程依赖</h1><p>从服务端数据查看 8 步流程的生产覆盖、草稿漂移、变量和回归门禁状态。</p></div><button class="secondary" id="reloadDependencies">刷新</button></div><section class="panel"><div class="panel-head"><div><h2>步骤覆盖矩阵</h2><p>工作区数量 / 生产数量；生产缺失需要先发布对应 Prompt</p></div></div><table class="table"><thead><tr><th>步骤</th><th>生产覆盖</th><th>工作区 / 生产</th><th>一致性</th><th>Prompt 与依赖</th></tr></thead><tbody>${rows}</tbody></table></section><div class="grid2"><section class="panel"><div class="panel-head"><div><h2>扩展 Prompt</h2><p>不属于 8 个固定步骤的额外注入</p></div></div><div class="case-list">${extensions}</div></section><section class="panel"><div class="panel-head"><div><h2>当前启用风险规则</h2><p>输出扫描会影响分析结果的 riskCheck</p></div></div><div class="case-list">${data.enabledRules.length ? data.enabledRules.map(rule => `<div class="case-row"><div class="case-main"><div class="prompt-name">${escapeHtml(rule.name)}</div><div class="prompt-meta">${escapeHtml(rule.severity)} · ${escapeHtml(rule.id)}</div></div></div>`).join('') : '<div class="empty">暂无启用规则</div>'}</div></section></div>`;
  }

  function captureTestForm() {
    const fields = ['promptId', 'caseId', 'name', 'role', 'jd', 'resume', 'extra', 'minScore', 'maxScoreDrop', 'requiredTerms'];
    fields.forEach(key => {
      const el = $('#test-' + key);
      if (el) state.testForm[key] = el.value;
    });
    return { ...state.testForm };
  }

  function testResultCard(label, result) {
    if (!result) return `<article class="result-card"><div class="result-head"><strong>${label}</strong>${tag('未运行')}</div><div class="empty">尚无结果</div></article>`;
    if (!result.ok) return `<article class="result-card failed"><div class="result-head"><strong>${label}</strong>${tag('失败', 'red')}</div><div class="result-body"><p class="run-status fail">${escapeHtml(result.code || 'PROMPT_TEST_FAILED')}</p><p>${escapeHtml(result.error || '测试调用失败')}</p><div class="prompt-meta">耗时 ${fmtLatency(result.latencyMs)}</div></div></article>`;
    const usage = result.usage || {};
    const analysis = result.analysis || {};
    const config = result.promptConfig || {};
    return `<article class="result-card"><div class="result-head"><strong>${label}</strong>${tag('成功', 'green')}</div><div class="result-body">
      <div class="kv">
        <div class="item"><label>模型</label><strong>${escapeHtml(result.model || '-')}</strong></div>
        <div class="item"><label>匹配分数</label><strong>${escapeHtml(analysis.score ?? '-')}</strong></div>
        <div class="item"><label>耗时</label><strong>${fmtLatency(result.latencyMs)}</strong></div>
        <div class="item"><label>Token 入 / 出</label><strong>${fmtNumber(usage.prompt_tokens)} / ${fmtNumber(usage.completion_tokens)}</strong></div>
        <div class="item"><label>估算成本</label><strong>¥${fmtCost(result.cost)}</strong></div>
        <div class="item"><label>Prompt 注入</label><strong>${fmtNumber(config.applied)} 条</strong></div>
      </div>
      ${(config.truncated || []).length || (config.dropped || []).length ? `<div class="banner warn show" style="margin-top:14px;margin-bottom:14px">截断 ${(config.truncated || []).length} 条，丢弃 ${(config.dropped || []).length} 条</div>` : ''}
      <h3>优化后简历</h3><div class="resume-output">${escapeHtml(analysis.finalResume || '模型未返回 finalResume')}</div>
    </div></article>`;
  }

  function viewTests() {
    const f = state.testForm;
    const result = state.testResult;
    const promptOptions = state.prompts.map(p => `<option value="${p.id}"${String(f.promptId) === String(p.id) ? ' selected' : ''}>${escapeHtml(p.name)} · 工作 ${escapeHtml(p.version)} / 生产 ${escapeHtml(p.publishedVersion || '未发布')}</option>`).join('');
    const caseOptions = state.testCases.map(item => `<option value="${escapeHtml(item.id)}"${f.caseId === item.id ? ' selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.role)}</option>`).join('');
    const comparison = result && result.comparison ? `<div class="comparison"><div class="kv">
      <div class="item"><label>两侧均成功</label><strong>${result.comparison.bothSucceeded ? '是' : '否'}</strong></div>
      <div class="item"><label>输出是否变化</label><strong>${result.comparison.finalResumeChanged == null ? '不可比较' : result.comparison.finalResumeChanged ? '有变化' : '无变化'}</strong></div>
      <div class="item"><label>草稿分数差</label><strong>${result.comparison.scoreDelta == null ? '不可比较' : `${Number(result.comparison.scoreDelta) >= 0 ? '+' : ''}${result.comparison.scoreDelta}`}</strong></div>
      <div class="item"><label>草稿耗时差</label><strong>${result.comparison.latencyDeltaMs == null ? '不可比较' : `${Number(result.comparison.latencyDeltaMs) >= 0 ? '+' : ''}${fmtLatency(result.comparison.latencyDeltaMs)}`}</strong></div>
      <div class="item"><label>草稿成本差</label><strong>${result.comparison.costDelta == null ? '不可比较' : `${Number(result.comparison.costDelta) >= 0 ? '+' : ''}¥${fmtCost(result.comparison.costDelta)}`}</strong></div>
    </div></div>` : '';
    const cases = state.testCases.length ? state.testCases.map(item => `<div class="case-row"><div class="case-main"><div class="prompt-name">${escapeHtml(item.name)}</div><div class="prompt-meta">${escapeHtml(item.role)} · 最低分 ${item.minScore || 0} · 最大降分 ${item.maxScoreDrop ?? 5} · ${escapeHtml(item.createdBy)} · ${fullTime(item.updatedAt)}</div></div><button class="iconbtn" data-testcase-load="${escapeHtml(item.id)}">载入</button>${can('admin') ? `<button class="iconbtn danger-text" data-testcase-delete="${escapeHtml(item.id)}">删除</button>` : ''}</div>`).join('') : '<div class="empty">尚未保存测试案例</div>';
    const runs = state.testRuns.length ? `<table class="table"><thead><tr><th>时间</th><th>Prompt</th><th>版本</th><th>状态</th><th>岗位</th><th>模型</th><th>耗时</th><th>Token</th><th>成本</th></tr></thead><tbody>${state.testRuns.map(run => `<tr><td class="prompt-meta">${fullTime(run.at)}</td><td>${escapeHtml(run.promptName)}</td><td>${tag(run.variant === 'draft' ? '草稿' : '生产', run.variant === 'draft' ? 'blue' : 'green')}</td><td><span class="run-status ${run.ok ? 'ok' : 'fail'}">${run.ok ? '成功' : escapeHtml(run.code || '失败')}</span></td><td>${escapeHtml(run.role || '-')}</td><td>${escapeHtml(run.model || '-')}</td><td>${fmtLatency(run.latencyMs)}</td><td>${fmtNumber(run.usage && run.usage.total_tokens)}</td><td>¥${fmtCost(run.cost)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">尚无测试运行记录</div>';
    const latestRegression = state.regressionRuns.find(run => String(run.promptId) === String(f.promptId));
    const regressionPanel = `<section class="panel"><div class="panel-head"><div><h2>发布回归门禁</h2><p>当前 Prompt 的全部案例通过后，当前草稿修订才可提交审核或发布</p></div>${can('editor') ? '<button class="primary" id="runRegression">运行回归测试集</button>' : ''}</div>${latestRegression ? `<div style="padding:18px"><div class="kv"><div class="item"><label>最近结果</label><strong class="run-status ${latestRegression.passed ? 'ok' : 'fail'}">${latestRegression.passed ? '通过' : '未通过'}</strong></div><div class="item"><label>测试版本</label><strong>${escapeHtml(latestRegression.promptVersion)}</strong></div><div class="item"><label>案例</label><strong>${latestRegression.total} 个 / 失败 ${latestRegression.failed}</strong></div><div class="item"><label>运行时间</label><strong>${fullTime(latestRegression.at)}</strong></div></div>${latestRegression.results.map(item => `<div class="case-row" style="margin-top:10px"><div class="case-main"><div class="prompt-name">${escapeHtml(item.caseName)}</div><div class="prompt-meta">草稿分 ${item.draft.score ?? '-'} · 生产分 ${item.published.score ?? '-'}${item.missingTerms.length ? ` · 缺少词：${escapeHtml(item.missingTerms.join('、'))}` : ''}</div></div>${tag(item.passed ? '通过' : '失败', item.passed ? 'green' : 'red')}</div>`).join('')}</div>` : '<div class="empty">当前 Prompt 尚无回归运行记录</div>'}</section>`;
    return `<div class="headline"><div><h1>Prompt 测试台</h1><p>用同一份输入对比当前生产快照与工作草稿；测试不会发布或改写任何 Prompt。</p></div><button class="secondary" id="reloadTests">刷新数据</button></div>
      <section class="panel"><div class="panel-head"><div><h2>测试输入</h2><p>普通试运行只记录字符数与性能指标，不保存 JD 和简历原文</p></div></div><div class="test-form">
        <div class="grid2"><div class="field"><label>目标 Prompt</label><select id="test-promptId" required>${promptOptions}</select></div><div class="field"><label>载入已保存案例</label><select id="test-caseId"><option value="">不载入</option>${caseOptions}</select></div><div class="field"><label>案例名称</label><input id="test-name" value="${escapeHtml(f.name)}" placeholder="例如：AI 产品经理 5 年经验" /></div><div class="field"><label>目标岗位</label><input id="test-role" value="${escapeHtml(f.role)}" placeholder="必填" /></div><div class="field"><label>最低草稿分数</label><input id="test-minScore" type="number" min="0" max="100" value="${escapeHtml(f.minScore)}" /></div><div class="field"><label>相对生产最大允许降分</label><input id="test-maxScoreDrop" type="number" min="0" max="100" value="${escapeHtml(f.maxScoreDrop)}" /></div></div>
        <div class="field"><label>职位描述 JD</label><textarea id="test-jd" placeholder="必填">${escapeHtml(f.jd)}</textarea></div><div class="field"><label>测试简历</label><textarea id="test-resume" placeholder="必填">${escapeHtml(f.resume)}</textarea></div><div class="field"><label>补充信息</label><textarea id="test-extra" style="min-height:90px">${escapeHtml(f.extra)}</textarea></div><div class="field"><label>优化后简历必含词（逗号或换行分隔）</label><input id="test-requiredTerms" value="${escapeHtml(f.requiredTerms)}" /></div>
        ${can('editor') ? `<div class="test-actions"><span class="privacy-note">保存为案例会把完整 JD、简历和补充信息持久化到服务端（JD/简历各最多 120000 字符）；普通试运行不会保存原文。</span><button class="secondary" id="saveTestCase">保存为测试案例</button><button class="primary" id="runPromptTest">对比草稿与生产</button></div>` : '<div class="banner warn show">当前为查看者权限：可以查看案例与运行记录，但不能运行测试或保存输入。</div>'}
      </div></section>
      ${result ? `<section class="panel"><div class="panel-head"><div><h2>本次对比结果</h2><p>${escapeHtml(result.prompt && result.prompt.name || '')}</p></div></div><div class="result-grid">${testResultCard('生产版本', result.results && result.results.published)}${testResultCard('工作草稿', result.results && result.results.draft)}</div>${comparison}</section>` : ''}
      ${regressionPanel}
      <section class="grid2"><div class="panel"><div class="panel-head"><div><h2>已保存测试案例</h2><p>这里包含完整测试输入，请按敏感数据管理</p></div></div><div class="case-list">${cases}</div></div><div class="panel"><div class="panel-head"><div><h2>最近运行</h2><p>仅保存指标和错误，不保存输入原文</p></div></div>${runs}</div></section>`;
  }

  /* ---------- 视图：Prompt 总览 ---------- */

  /** 把「会被截断」「会被丢弃」的 Prompt 直接点名——旧版本是静默截断到 4000 字符，没人知道尾部丢了 */
  function truncationNotice() {
    const maxChars = (state.overview && state.overview.settings && state.overview.settings.promptMaxChars) || 4000;
    const maxCount = (state.overview && state.overview.settings && state.overview.settings.promptMaxCount) || 20;
    const enabled = state.prompts.filter(p => p.enabled).sort((a, b) => (a.step ?? 99) - (b.step ?? 99) || a.id - b.id);
    const over = state.prompts.filter(p => p.enabled && p.contentLength > maxChars);
    const dropped = enabled.slice(maxCount);
    if (!over.length && !dropped.length) return '';
    const parts = [];
    if (over.length) parts.push(`以下 Prompt 超过单条 ${maxChars} 字符上限，超出的尾部不会发送给模型：${over.map(p => `${escapeHtml(p.name)}（${p.contentLength} 字）`).join('、')}`);
    if (dropped.length) parts.push(`启用条数超过 ${maxCount} 条上限，排在末位的 ${dropped.length} 条不会被注入：${dropped.map(p => escapeHtml(p.name)).join('、')}`);
    return `<div class="banner warn show" style="margin-bottom:20px">${parts.join('<br />')}</div>`;
  }

  function viewPrompts() {
    const o = state.overview || { total: 0, enabled: 0, changes7d: 0, coverage: 0, coverageTotal: 8, settings: {} };
    const note = o.lastChange ? `最近变更：${timeAgo(o.lastChange.at)}` : '暂无变更记录';
    return `
      <div class="headline">
      <div><h1>Prompt 总览</h1><p>统一维护 Prompt 工作副本。编辑只保存草稿，生产版本在发布中心单独控制。支持变量：{{role}}、{{jd}}、{{resume}}、{{industry}}、{{company}}、{{stage}}、{{extra}}。</p></div>
        ${can('editor') ? '<button class="primary" id="newBtn">＋ 新建 Prompt</button>' : ''}
      </div>
      ${truncationNotice()}
      <section class="stats">
        <div class="stat"><label>流程 Prompt</label><strong>${o.total}</strong><small>对应用户端 8 个步骤</small></div>
        <div class="stat"><label>已发布</label><strong>${o.published || 0}</strong><small>${o.drafts || 0} 个草稿 · ${o.reviews || 0} 个待审核</small></div>
        <div class="stat"><label>近 7 天变更</label><strong>${o.changes7d}</strong><small>${escapeHtml(note)}</small></div>
        <div class="stat"><label>流程覆盖</label><strong>${o.coverage}/${o.coverageTotal}</strong><small class="${o.coverage === o.coverageTotal ? 'good' : 'warn'}">${o.coverage === o.coverageTotal ? '全部步骤已覆盖' : `有 ${o.coverageTotal - o.coverage} 个步骤未启用`}</small></div>
      </section>
      <section class="panel">
        <div class="toolbar">
          <div class="search"><span>⌕</span><input id="search" placeholder="搜索名称、用途或内容" value="${escapeHtml(state.query.q)}" /></div>
          ${can('editor') ? '<button class="secondary" id="openTemplates">从模板创建</button><button class="secondary" id="batchEnable">批量启用</button><button class="secondary" id="batchDisable">批量停用</button><button class="secondary" id="batchReview">批量提交审核</button>' : ''}
          <select class="filter" id="statusFilter">
            <option value="all"${state.query.status === 'all' ? ' selected' : ''}>全部状态</option>
            <option value="on"${state.query.status === 'on' ? ' selected' : ''}>已启用</option>
            <option value="off"${state.query.status === 'off' ? ' selected' : ''}>已停用</option>
          </select>
          <select class="filter" id="typeFilter">
            <option value="all"${state.query.type === 'all' ? ' selected' : ''}>全部类型</option>
            <option value="system"${state.query.type === 'system' ? ' selected' : ''}>系统 Prompt</option>
            <option value="task"${state.query.type === 'task' ? ' selected' : ''}>任务 Prompt</option>
          </select>
        </div>
        <table class="table">
          <thead><tr><th>Prompt</th><th>类型</th><th>运行状态</th><th>发布状态</th><th>工作版本</th><th>生产版本</th><th>字数</th><th>最后更新</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="empty" style="display:none">没有符合条件的 Prompt</div>
      </section>`;
  }

  function renderRows() {
    const maxChars = (state.overview && state.overview.settings && state.overview.settings.promptMaxChars) || 4000;
    const list = state.prompts;
    const body = $('#rows');
    const empty = $('#empty');
    if (!body || !empty) return;

    if (!list.length) { body.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    body.innerHTML = list.map(p => {
      const over = p.contentLength > maxChars;
      const stepTag = p.step ? `步骤 ${p.step}` : '扩展';
      const release = p.releaseStatus === 'review'
        ? tag('待审核', 'amber')
        : p.releaseStatus === 'draft' ? tag('草稿', 'blue') : tag('已发布', 'green');
      return `<tr>
        <td><input type="checkbox" class="prompt-select" data-id="${p.id}" ${state.selectedPrompts.includes(String(p.id)) ? 'checked' : ''} aria-label="选择 ${escapeHtml(p.name)}" />
          <div class="prompt-name">${tag(stepTag)}${escapeHtml(p.name)}</div>
          <div class="prompt-meta">${escapeHtml(p.desc || '')}</div>
        </td>
        <td>${tag(p.type === 'system' ? '系统' : '任务', p.type === 'system' ? 'blue' : '')}</td>
        <td><span class="status ${p.enabled ? '' : 'off'}"><span class="dot"></span>${p.enabled ? '已启用' : '已停用'}</span></td>
        <td>${release}</td>
        <td><span class="version">${escapeHtml(p.version)}</span></td>
        <td><span class="version">${escapeHtml(p.publishedVersion || '未发布')}</span></td>
        <td>${over ? `<span class="tag red" title="超出单条上限 ${maxChars} 字符，超出部分不会发给模型">${p.contentLength} 超限</span>` : `<span class="version">${p.contentLength}</span>`}</td>
        <td class="prompt-meta">${timeAgo(p.updatedAt)}</td>
        <td><div class="actions">
          ${can('editor') ? `<button class="iconbtn" data-act="edit" data-id="${p.id}">编辑</button>` : ''}
          <button class="iconbtn" data-act="history" data-id="${p.id}">历史</button>
          ${can('editor') ? `<button class="iconbtn" data-act="toggle" data-id="${p.id}" data-enabled="${p.enabled ? 'false' : 'true'}">${p.enabled ? '停用' : '启用'}</button>` : ''}
        </div></td>
      </tr>`;
    }).join('');
  }

  /* ---------- 视图：发布中心 ---------- */

  function viewReleases() {
    const o = state.overview || { published: 0, drafts: 0, reviews: 0 };
    const pending = state.prompts.filter(p => p.releaseStatus !== 'published');
    const rows = state.prompts.map(p => {
      const status = p.releaseStatus === 'review'
        ? tag('待审核', 'amber')
        : p.releaseStatus === 'draft' ? tag('草稿', 'blue') : tag('已发布', 'green');
      let actions = '<span class="prompt-meta">无需操作</span>';
      if (p.releaseStatus === 'draft') {
        actions = can('editor') ? `<button class="iconbtn" data-act="edit" data-id="${p.id}">编辑</button><button class="iconbtn" data-act="release-checklist" data-id="${p.id}">检查清单</button><button class="iconbtn" data-act="submit-review" data-id="${p.id}">提交审核</button>` : '<span class="prompt-meta">等待编辑者提交</span>';
      } else if (p.releaseStatus === 'review') {
        actions = can('admin') ? `<button class="iconbtn" data-act="release-checklist" data-id="${p.id}">检查清单</button><button class="iconbtn" data-act="reject-review" data-id="${p.id}">驳回</button><button class="primary" style="padding:6px 10px" data-act="publish" data-id="${p.id}">发布生产</button>` : '<span class="prompt-meta">等待管理员审核</span>';
      }
      if (p.canary?.active) {
        const m = p.canary.metrics || {};
        actions += `<div class="prompt-meta" style="margin-top:6px">灰度 ${escapeHtml(p.canary.version)} · ${p.canary.trafficPercent}% · ${m.calls || 0} 次 · 失败 ${m.failureRate || 0}% · Schema ${m.schemaErrorRate || 0}%</div>`;
        if (can('editor')) actions += `<button class="iconbtn" data-act="canary-traffic" data-id="${p.id}">调整流量</button><button class="iconbtn" data-act="canary-stop" data-id="${p.id}">停止灰度</button>`;
        if (can('admin')) actions += `<button class="primary" style="padding:6px 10px" data-act="canary-promote" data-id="${p.id}">全量发布</button>`;
      } else if (p.publishedVersion && can('editor')) {
        actions += `<button class="iconbtn" data-act="canary-start" data-id="${p.id}">启动灰度</button>`;
      }
      if (p.publishedVersion) actions += `<button class="iconbtn" data-act="release-comparison" data-id="${p.id}" data-version="${escapeHtml(p.publishedVersion)}">发布前后对比</button>`;
      return `<tr>
        <td><div class="prompt-name">${escapeHtml(p.name)}</div><div class="prompt-meta">${escapeHtml(p.desc || '')}</div></td>
        <td>${status}</td>
        <td><span class="version">${escapeHtml(p.version)}</span></td>
        <td><span class="version">${escapeHtml(p.publishedVersion || '未发布')}</span>${p.canary?.active ? `<div class="prompt-meta">灰度中</div>` : ''}</td>
        <td class="prompt-meta">${p.publishedAt ? fullTime(p.publishedAt) : '尚未发布'}</td>
        <td><div class="actions">${actions}<button class="iconbtn" data-act="history" data-id="${p.id}">版本历史</button></div></td>
      </tr>`;
    }).join('');

    return `<div class="headline">
      <div><h1>发布中心</h1><p>草稿不会影响用户请求；审核通过并发布后才替换生产版本。</p></div>
      <button class="secondary" id="reloadReleases">刷新状态</button>
    </div>
    <section class="stats">
      <div class="stat"><label>已发布</label><strong>${o.published || 0}</strong><small>当前生产版本</small></div>
      <div class="stat"><label>草稿</label><strong>${o.drafts || 0}</strong><small>尚未提交审核</small></div>
      <div class="stat"><label>待审核</label><strong>${o.reviews || 0}</strong><small>等待管理员发布</small></div>
      <div class="stat"><label>待处理</label><strong>${pending.length}</strong><small>${pending.length ? '存在未上线修改' : '生产与工作区一致'}</small></div>
    </section>
      <section class="panel">
      <div class="panel-head"><div><h2>版本发布队列</h2><p>所有发布、灰度和回滚都会写入变更记录；灰度版本不会覆盖生产版本</p></div></div>
      <table class="table"><thead><tr><th>Prompt</th><th>状态</th><th>工作版本</th><th>生产版本</th><th>最近发布</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }

  function comparisonValue(value, suffix = '') {
    return value === null || value === undefined ? '—' : `${escapeHtml(String(value))}${suffix}`;
  }

  function comparisonMetric(label, before, after, suffix = '') {
    return `<div class="stat"><label>${escapeHtml(label)}</label><strong>${comparisonValue(before, suffix)} <span style="font-size:12px;color:#8490a0">→</span> ${comparisonValue(after, suffix)}</strong><small>发布前 → 发布后</small></div>`;
  }

  function releaseComparisonHtml(data) {
    const beforeWindow = data.windows.before;
    const afterWindow = data.windows.after;
    const insufficient = data.status === 'insufficient_data';
    const b = data.before || {}; const a = data.after || {};
    return `<div class="drawer-head">
      <div><h2>发布前后对比</h2><p class="prompt-meta">${escapeHtml(data.prompt.name)} · ${escapeHtml(data.version)} · 发布于 ${fullTime(data.release.at)}</p></div>
      <button class="close" data-act="close-drawer">×</button>
    </div>
    <div class="hint" style="margin-top:8px">发布前：${escapeHtml(fullTime(beforeWindow.from))} 至 ${escapeHtml(fullTime(beforeWindow.to))}；发布后：${escapeHtml(fullTime(afterWindow.from))} 至 ${escapeHtml(fullTime(afterWindow.to))}</div>
    ${insufficient ? '<div class="notice warning" style="margin-top:14px">样本不足：至少一个时间窗口没有调用样本，以下数据不能用于判断发布效果。</div>' : ''}
    <section class="stats" style="margin-top:16px">
      ${comparisonMetric('调用数', b.calls, a.calls)}
      ${comparisonMetric('成功率', b.successRate, a.successRate, '%')}
      ${comparisonMetric('失败率', b.failureRate, a.failureRate, '%')}
      ${comparisonMetric('Schema 错误率', b.schemaErrorRate, a.schemaErrorRate, '%')}
      ${comparisonMetric('重试率', b.retryRate, a.retryRate, '%')}
      ${comparisonMetric('P50 延迟', b.p50Latency, a.p50Latency, ' ms')}
      ${comparisonMetric('P95 延迟', b.p95Latency, a.p95Latency, ' ms')}
      ${comparisonMetric('平均输入字符', b.avgInputChars, a.avgInputChars)}
      ${comparisonMetric('Token 数', b.tokens, a.tokens)}
      ${comparisonMetric('成本', b.cost, a.cost)}
      ${comparisonMetric('反馈正向率', b.feedback?.positiveRate, a.feedback?.positiveRate, '%')}
    </section>
    <p class="prompt-meta" style="margin-top:16px">反馈样本：${comparisonValue(b.feedback?.total)} → ${comparisonValue(a.feedback?.total)}（good / bad：${comparisonValue(b.feedback?.good)} / ${comparisonValue(b.feedback?.bad)} → ${comparisonValue(a.feedback?.good)} / ${comparisonValue(a.feedback?.bad)}）</p>`;
  }

  async function openReleaseComparison(promptId, version) {
    openDrawer(loading('加载发布前后对比…'), true);
    try {
      const data = await api(`/api/prompts/${encodeURIComponent(promptId)}/release-comparison?version=${encodeURIComponent(version)}`);
      if (data.status === 'not_found') throw new Error('找不到该生产版本的发布记录');
      openDrawer(releaseComparisonHtml(data), true);
    } catch (error) {
      closeDrawer();
      toast(error.message, true);
    }
  }

  async function openReleaseChecklist(promptId) {
    openDrawer(loading('加载发布检查清单…'), true);
    try {
      const data = await api(`/api/prompts/${encodeURIComponent(promptId)}/release-checklist`);
      const checklist = data.checklist;
      const rows = checklist.checks.map(item => `<div class="vrow"><div><strong>${item.passed ? '✓' : '×'} ${escapeHtml(item.label)}</strong><div class="prompt-meta">${escapeHtml(item.detail)}</div></div>${item.blocking ? tag('阻断项', item.passed ? 'green' : 'red') : tag('提醒', 'amber')}</div>`).join('');
      openDrawer(`<div class="drawer-head"><div><h2>发布前检查清单</h2><p>${escapeHtml(checklist.version)} · ${checklist.ready ? '已满足发布条件' : '存在阻断项'}</p></div><button class="close" data-act="close-drawer">×</button></div><div class="vlist">${rows}</div>`, true);
    } catch (error) { closeDrawer(); toast(error.message, true); }
  }

  /* ---------- 视图：变更记录 ---------- */

  function viewChanges() {
    const items = state.changes.map(v => {
      const detail = v.note ? `<div class="tl-note">${escapeHtml(v.note)}</div>` : '';
      return `<div class="tl-item ${v.action}">
        <div class="tl-body">
          <div class="tl-top">
            <div class="tl-title">${escapeHtml(v.promptName)} ${tag(v.actionLabel || v.action, ACTION_TAG[v.action])}${v.action === 'rollback' ? tag('回滚', 'amber') : ''}</div>
            <div class="tl-time" title="${fullTime(v.at)}">${fullTime(v.at)}</div>
          </div>
          ${detail}
          <div class="tl-note">操作人：${escapeHtml(v.actor || '管理员')}${v.promptId ? `　·　<a class="iconbtn" style="padding:2px 6px" href="#" data-act="open-versions" data-id="${v.promptId}">查看该 Prompt 版本历史</a>` : ''}</div>
        </div>
      </div>`;
    }).join('');
    const actions = (state.changesMeta.actions || []).map(item => `<option value="${escapeHtml(item.value)}" ${state.changeFilter.action === item.value ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('');
    const empty = state.changes.length ? '' : '<div class="empty">所选条件下没有变更记录</div>';
    const meta = state.changesMeta.total ? `<span class="muted">共 ${fmtNumber(state.changesMeta.total)} 条，第 ${state.changesMeta.page}/${state.changesMeta.pages} 页</span>` : '<span class="muted">共 0 条</span>';
    return `
      <div class="headline"><div><h1>变更记录</h1><p>所有 Prompt 与运行参数的修改轨迹，按时间倒序。</p></div>
        <div class="actions"><button class="secondary" id="reloadChanges">刷新</button><button class="secondary" id="exportChanges">导出 CSV</button></div></div>
      <section class="panel"><div class="inner" style="padding:16px 18px"><div class="filterbar changes-filter">
        <label>操作类型<select id="changeAction"><option value="">全部</option>${actions}</select></label>
        <label>操作人<input id="changeActor" value="${escapeHtml(state.changeFilter.actor)}" placeholder="姓名或账号"></label>
        <label>开始日期<input id="changeFrom" type="date" value="${escapeHtml(state.changeFilter.from)}"></label>
        <label>结束日期<input id="changeTo" type="date" value="${escapeHtml(state.changeFilter.to)}"></label>
        <button class="secondary" id="clearChangeFilters">清除筛选</button>${meta}
      </div><div class="timeline">${items}</div>${empty}</div></section>`;
  }

  /* ---------- 视图：运行日志 ---------- */

  function dailyChart(daily) {
    if (!daily.length) return '<div class="empty">所选区间内没有调用记录</div>';
    const width = 720;
    const height = 170;
    const pad = { top: 14, right: 12, bottom: 26, left: 40 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...daily.map(d => d.total));
    const slot = innerW / daily.length;
    const barW = Math.max(3, Math.min(26, slot * 0.55));

    const bars = daily.map((d, i) => {
      const x = pad.left + slot * i + (slot - barW) / 2;
      const totalH = (d.total / max) * innerH;
      const failH = (d.failed / max) * innerH;
      const y = pad.top + innerH - totalH;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${totalH.toFixed(1)}" rx="3" fill="#93b4f5"></rect>
        ${failH ? `<rect x="${x.toFixed(1)}" y="${(pad.top + innerH - failH).toFixed(1)}" width="${barW.toFixed(1)}" height="${failH.toFixed(1)}" rx="3" fill="#d4717c"></rect>` : ''}`;
    }).join('');

    const labels = daily.map((d, i) => {
      if (daily.length > 12 && i % Math.ceil(daily.length / 8) !== 0) return '';
      const x = pad.left + slot * i + slot / 2;
      return `<text x="${x.toFixed(1)}" y="${height - 8}" font-size="10" fill="#8490a0" text-anchor="middle">${escapeHtml(d.day.slice(5))}</text>`;
    }).join('');

    const ticks = [0, 0.5, 1].map(ratio => {
      const y = pad.top + innerH - ratio * innerH;
      return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#eef1f6" stroke-width="1"></line>
        <text x="${pad.left - 6}" y="${y + 3}" font-size="10" fill="#8490a0" text-anchor="end">${Math.round(max * ratio)}</text>`;
    }).join('');

    return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="每日调用量">
        ${ticks}${bars}${labels}
      </svg>
      <div class="legend"><span><i style="background:#93b4f5"></i>总调用</span><span><i style="background:#d4717c"></i>失败</span></div>`;
  }

  function promptTrendChart(trends, alerts) {
    const keys = [...new Set((alerts || []).map(item => item.scope).filter(scope => scope && scope.includes('@')))];
    const selected = keys.map(key => trends.find(item => `${item.prompt}@${item.version}` === key)).filter(Boolean).slice(0, 6);
    if (!selected.length) return '<div class="empty">当前区间暂无 Prompt 版本趋势</div>';
    const width = 720; const height = 150; const pad = { top: 14, right: 12, bottom: 26, left: 38 }; const innerW = width - pad.left - pad.right; const innerH = height - pad.top - pad.bottom;
    const renderLine = (daily, field, color) => {
      const max = Math.max(100, ...daily.map(item => Number(item[field] || 0)));
      const points = daily.map((item, index) => `${(pad.left + (daily.length === 1 ? innerW / 2 : innerW * index / (daily.length - 1))).toFixed(1)},${(pad.top + innerH - Number(item[field] || 0) / max * innerH).toFixed(1)}`).join(' ');
      return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>`;
    };
    return selected.map(item => {
      const daily = item.daily; const labels = daily.filter((_, index) => daily.length <= 8 || index % Math.ceil(daily.length / 8) === 0).map(day => escapeHtml(day.day.slice(5))).join(' · ');
      return `<div class="trend-card"><div class="panel-head"><div><h3>${escapeHtml(item.prompt)} · ${escapeHtml(item.version)}</h3><p>${labels || '暂无日期'} · 每日比例（%）</p></div></div><svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(item.prompt)} ${escapeHtml(item.version)} 告警趋势"><line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="#eef1f6"></line>${renderLine(daily, 'failureRate', '#d4717c')}${renderLine(daily, 'schemaErrorRate', '#e0a34a')}${renderLine(daily, 'retryRate', '#6b8ed6')}</svg><div class="legend"><span><i style="background:#d4717c"></i>失败率</span><span><i style="background:#e0a34a"></i>Schema 错误率</span><span><i style="background:#6b8ed6"></i>重试率</span></div></div>`;
    }).join('');
  }

  function qualityMetric(label, value, suffix = '') {
    return `<div class="stat"><label>${escapeHtml(label)}</label><strong>${value == null ? '—' : `${escapeHtml(String(value))}${suffix}`}</strong></div>`;
  }

  function viewQuality() {
    const data = state.quality;
    if (!data) return `<div class="headline"><div><h1>质量分析</h1><p>按 Prompt 版本聚合运行结果与人工反馈，不展示输入正文。</p></div></div>${loading()}`;
    const o = data.overall || {};
    const promptRows = (data.byPrompt || []).map(item => `<tr><td><strong>${escapeHtml(item.prompt)}</strong></td><td>${escapeHtml(item.version)}</td><td>${item.calls}</td><td>${item.successRate}%</td><td>${item.schemaErrorRate}%</td><td>${item.retryRate}%</td><td>${fmtLatency(item.avgLatency)}</td><td>¥${fmtCost(item.cost)}</td><td>${item.feedback ? `${item.positiveRate}%（${item.feedback}）` : '—'}</td></tr>`).join('');
    const roleRows = (data.byRole || []).map(item => `<tr><td>${escapeHtml(item.role)}</td><td>${item.calls}</td><td>${item.successRate}%</td><td>${item.failureRate}%</td><td>${fmtLatency(item.avgLatency)}</td><td>${item.feedback ? `${item.positiveRate}%（${item.feedback}）` : '—'}</td></tr>`).join('');
    return `<div class="headline"><div><h1>质量分析</h1><p>按 Prompt 版本和目标岗位查看成功率、结构错误、重试、延迟、成本与人工反馈。统计窗口：近 ${data.days} 天。</p></div><div class="actions"><select class="filter" id="qualityDays"><option value="7"${data.days === 7 ? ' selected' : ''}>近 7 天</option><option value="30"${data.days === 30 ? ' selected' : ''}>近 30 天</option><option value="90"${data.days === 90 ? ' selected' : ''}>近 90 天</option></select><button class="secondary" id="reloadQuality">刷新</button><button class="secondary" id="exportQuality">导出 CSV</button></div></div>
      <section class="stats">${qualityMetric('调用次数', o.calls)}${qualityMetric('成功率', o.successRate, '%')}${qualityMetric('Schema 错误率', o.schemaErrorRate, '%')}${qualityMetric('人工正向率', o.feedback ? o.positiveRate : null, o.feedback ? '%' : '')}${qualityMetric('平均延迟', fmtLatency(o.avgLatency))}${qualityMetric('总成本', `¥${fmtCost(o.cost)}`)}</section>
      <section class="panel"><div class="panel-head"><div><h2>Prompt 版本质量</h2><p>反馈率只基于已关联运行记录的人工评价；“—”表示没有反馈样本。</p></div></div>${promptRows ? `<table class="table"><thead><tr><th>Prompt</th><th>版本</th><th>调用</th><th>成功率</th><th>Schema 错误</th><th>重试率</th><th>平均延迟</th><th>成本</th><th>人工正向率</th></tr></thead><tbody>${promptRows}</tbody></table>` : '<div class="empty">所选区间没有运行记录</div>'}</section>
      <section class="panel"><div class="panel-head"><div><h2>岗位维度</h2><p>用于发现某类岗位的质量回退，不包含岗位描述正文。</p></div></div>${roleRows ? `<table class="table"><thead><tr><th>目标岗位</th><th>调用</th><th>成功率</th><th>失败率</th><th>平均延迟</th><th>人工正向率</th></tr></thead><tbody>${roleRows}</tbody></table>` : '<div class="empty">所选区间没有岗位维度数据</div>'}</section>`;
  }

  function experimentMetric(group) {
    return `<td>${fmtNumber(group.calls)}</td><td>${group.calls ? `${group.successRate}%` : '—'}</td><td>${group.calls ? `${group.schemaErrorRate}%` : '—'}</td><td>${group.calls ? `${group.retryRate}%` : '—'}</td><td>${group.calls ? `${fmtLatency(group.p50Latency)} / ${fmtLatency(group.p95Latency)}` : '—'}</td><td>${group.calls ? `¥${fmtCost(group.cost)}` : '—'}</td><td>${group.feedback.total ? `${group.feedback.positiveRate}%（${group.feedback.total}）` : '—'}</td>`;
  }

  function viewExperiments() {
    const data = state.experiments;
    if (!data) return `<div class="headline"><div><h1>实验中心</h1><p>比较进行中的 Prompt 灰度对照组与候选组。</p></div></div>${loading()}`;
    const statusLabel = { insufficient_data: ['样本不足', 'amber'], observing: ['观察中', 'blue'], candidate_better: ['候选更优', 'green'], candidate_worse: ['候选较差', 'red'], inconclusive: ['暂无结论', 'grey'] };
    const rows = (data.items || []).map(item => {
      const [label, tone] = statusLabel[item.status] || ['未知', 'grey'];
      return `<tr><td><strong>${escapeHtml(item.promptName)}</strong><div class="prompt-meta">${escapeHtml(item.promptId)}</div></td><td>${escapeHtml(item.sourceVersion)}</td><td>${escapeHtml(item.candidateVersion)}</td><td>${item.trafficPercent}%</td><td>${tag(label, tone)}<div class="prompt-meta">${item.sufficientData ? '两组样本充足' : `每组至少 ${item.minCalls} 次`}</div></td><td>${experimentMetric(item.control)}</td><td>${experimentMetric(item.candidate)}</td></tr>`;
    }).join('');
    return `<div class="headline"><div><h1>实验中心</h1><p>进行中的灰度实验，统计窗口：近 ${data.days} 天。P50 / P95 仅基于成功请求；成本按 Prompt 版本均摊。</p></div><div class="actions"><select class="filter" id="experimentDays"><option value="7"${data.days === 7 ? ' selected' : ''}>近 7 天</option><option value="30"${data.days === 30 ? ' selected' : ''}>近 30 天</option><option value="90"${data.days === 90 ? ' selected' : ''}>近 90 天</option></select><button class="secondary" id="reloadExperiments">刷新</button></div></div><section class="panel"><div class="panel-head"><div><h2>对照组 vs 候选组</h2><p>状态只在两组均达到最小样本量后计算；样本不足不会判定候选版本优劣。</p></div></div>${rows ? `<div style="overflow:auto"><table class="table"><thead><tr><th>Prompt</th><th>对照版本</th><th>候选版本</th><th>灰度流量</th><th>结论</th><th colspan="7">对照组：调用 / 成功率 / Schema 错误 / 重试 / P50-P95 / 成本 / 正向反馈</th><th colspan="7">候选组：调用 / 成功率 / Schema 错误 / 重试 / P50-P95 / 成本 / 正向反馈</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">暂无进行中的灰度实验</div>'}</section>`;
  }

  function viewRegressionCenter() {
    const data = state.regressionCenter;
    if (!data) return `<div class="headline"><div><h1>回归中心</h1><p>统一查看所有 Prompt 的回归门禁状态。</p></div></div>${loading()}`;
    const labels = { no_cases: ['未配置案例', 'grey'], not_run: ['未运行', 'amber'], passed: ['通过', 'green'], failed: ['失败', 'red'], stale: ['已过期', 'amber'] };
    const rows = (data.items || []).map(item => {
      const [label, tone] = labels[item.status] || ['未知', 'grey'];
      const latest = item.latest;
      return `<tr><td><strong>${escapeHtml(item.promptName)}</strong><div class="prompt-meta">${item.step ? `步骤 ${item.step}` : '扩展'} · ${escapeHtml(item.promptId)}</div></td><td>${escapeHtml(item.version)} / ${escapeHtml(item.publishedVersion || '未发布')}</td><td>${item.caseCount}</td><td>${tag(label, tone)}${item.status === 'stale' ? '<div class="prompt-meta">草稿或案例已变更</div>' : ''}</td><td>${latest ? `${fullTime(latest.at)}<div class="prompt-meta">${latest.total} 个案例 · 失败 ${latest.failed} · ${escapeHtml(latest.actor || '未知')}</div>` : '—'}</td><td>${latest ? escapeHtml(latest.promptVersion || '-') : '—'}</td><td>${can('editor') && item.caseCount ? `<button class="iconbtn" data-regression-run="${escapeHtml(item.promptId)}">运行回归</button>` : '<span class="prompt-meta">—</span>'}</td></tr>`;
    }).join('');
    return `<div class="headline"><div><h1>回归中心</h1><p>统一查看所有 Prompt 的测试案例与发布门禁；运行操作仍按 Prompt 单独执行。</p></div><button class="secondary" id="reloadRegressionCenter">刷新</button></div><section class="panel"><div class="panel-head"><div><h2>门禁状态</h2><p>“已过期”表示最近一次通过记录对应的草稿修订或案例集合已发生变化。</p></div></div>${rows ? `<div style="overflow:auto"><table class="table"><thead><tr><th>Prompt</th><th>工作 / 生产版本</th><th>案例数</th><th>状态</th><th>最近运行</th><th>测试版本</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">暂无 Prompt</div>'}</section>`;
  }

  function viewTasks() {
    const data = state.tasks;
    if (!data) return `<div class="headline"><div><h1>任务中心</h1><p>集中查看简历分析任务状态与失败诊断。</p></div></div>${loading()}`;
    const summary = data.summary || { total: 0, succeeded: 0, failed: 0, retryable: 0, cost: 0 };
    const rows = (data.items || []).map(task => `<tr>
      <td class="prompt-meta">${fullTime(task.at)}</td>
      <td>${tag(task.status === 'succeeded' ? '成功' : '失败', task.status === 'succeeded' ? 'green' : 'red')}</td>
      <td>${escapeHtml(task.role || '-')}</td><td>${escapeHtml(task.model || '-')}</td>
      <td>${escapeHtml((task.promptVersions || []).map(v => `${v.name}@${v.version}`).join('、') || '-')}</td>
      <td>${fmtLatency(task.latencyMs)}</td><td>${fmtNumber(task.totalTokens)}</td><td>¥${fmtCost(task.cost)}</td>
      <td>${task.status === 'failed' ? `<span class="tag ${task.retryable ? 'amber' : 'grey'}">${task.retryable ? '可重试' : '不可重试'}</span><div class="prompt-meta">${escapeHtml(task.errorLabel || task.code || '调用失败')}</div>` : '<span class="prompt-meta">—</span>'}</td>
      <td><button class="iconbtn" data-log-detail="${escapeHtml(task.id)}">详情</button></td></tr>`).join('');
    const page = data.page || 1; const pages = data.pages || 1;
    return `<div class="headline"><div><h1>任务中心</h1><p>按分析运行记录汇总任务状态；只展示运营元数据，不保存 JD 或简历正文。</p></div><div class="actions"><select class="filter" id="taskDays"><option value="1"${state.taskFilter.days === 1 ? ' selected' : ''}>近 1 天</option><option value="7"${state.taskFilter.days === 7 ? ' selected' : ''}>近 7 天</option><option value="30"${state.taskFilter.days === 30 ? ' selected' : ''}>近 30 天</option><option value="0"${state.taskFilter.days === 0 ? ' selected' : ''}>全部</option></select><button class="secondary" id="reloadTasks">刷新</button></div></div>
      <section class="stats"><div class="stat"><label>任务总数</label><strong>${fmtNumber(summary.total)}</strong><small>当前筛选范围</small></div><div class="stat"><label>成功</label><strong>${fmtNumber(summary.succeeded)}</strong><small>已完成分析</small></div><div class="stat"><label>失败</label><strong>${fmtNumber(summary.failed)}</strong><small class="${summary.failed ? 'warn' : 'good'}">需要诊断 ${summary.failed}</small></div><div class="stat"><label>可重试</label><strong>${fmtNumber(summary.retryable)}</strong><small>需重新提交输入</small></div><div class="stat"><label>估算成本</label><strong>¥${fmtCost(summary.cost)}</strong><small>按项目单价计算</small></div></section>
      <section class="panel"><div class="panel-head"><div><h2>任务筛选</h2><p>失败任务的重试资格由服务端错误码判定；后台不保留原始输入，因此不会提供伪造的一键重试。</p></div></div><div class="filters"><select class="filter" id="taskStatus"><option value=""${!state.taskFilter.status ? ' selected' : ''}>全部状态</option><option value="succeeded"${state.taskFilter.status === 'succeeded' ? ' selected' : ''}>成功</option><option value="failed"${state.taskFilter.status === 'failed' ? ' selected' : ''}>失败</option></select><input class="filter" id="taskRole" placeholder="按岗位搜索" value="${escapeHtml(state.taskFilter.role)}" /><button class="secondary" id="clearTaskFilters">清除筛选</button></div></section>
      <section class="panel"><div class="panel-head"><div><h2>任务列表</h2><p>第 ${page} / ${pages} 页，共 ${fmtNumber(data.total)} 条</p></div><div class="actions"><button class="secondary" id="taskPrev" ${page <= 1 ? 'disabled' : ''}>上一页</button><button class="secondary" id="taskNext" ${page >= pages ? 'disabled' : ''}>下一页</button></div></div>${rows ? `<table class="table"><thead><tr><th>时间</th><th>状态</th><th>岗位</th><th>模型</th><th>Prompt 版本</th><th>耗时</th><th>Token</th><th>成本</th><th>失败诊断</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">当前筛选范围没有任务</div>'}</section>`;
  }

  function viewLogs() {
    const s = state.logStats;
    if (!s) return `<div class="headline"><div><h1>运行日志</h1><p>每次分析的模型、耗时、token、成本与错误分布。</p></div></div>${loading()}`;

    const okRate = s.total ? ((s.total - s.failed) / s.total * 100).toFixed(1) : '—';
    const errorBars = s.byCode.length
      ? s.byCode.map(c => {
          const ratio = s.failed ? (c.count / s.failed) * 100 : 0;
          return `<div class="bar-row"><span class="name">${escapeHtml(c.label)}</span><span class="bar"><i style="width:${ratio.toFixed(1)}%"></i></span><span class="num">${c.count}</span></div>`;
        }).join('')
      : '<div class="empty" style="padding:20px">区间内没有失败调用</div>';
    const modelRows = s.byModel.length ? s.byModel.map(item => `<tr><td>${escapeHtml(item.model)}</td><td>${item.total}</td><td>${item.successRate}%</td><td>${fmtLatency(item.avgLatency)}</td><td>${fmtNumber(item.tokens)}</td><td>¥${fmtCost(item.cost)}</td></tr>`).join('') : '';
    const promptRows = s.byPrompt.length ? s.byPrompt.map(item => `<tr><td>${escapeHtml(item.prompt)}</td><td>${item.calls}</td><td>${item.failed}</td><td>${item.truncated}</td><td>${item.dropped}</td></tr>`).join('') : '';
    const promptVersionRows = (s.byPromptVersion || []).length ? s.byPromptVersion.map(item => `<tr><td>${escapeHtml(item.prompt)}</td><td>${escapeHtml(item.version)}</td><td>${item.calls}</td><td>${item.failureRate}%</td><td>${item.retryRate}%</td><td>${fmtLatency(item.avgLatency)}</td><td>¥${fmtCost(item.cost)}</td><td>${item.schemaErrors}</td></tr>`).join('') : '';
    const alertRows = (s.alerts || []).map(item => `<div class="banner ${item.acknowledged ? 'good' : 'warn'} show"><strong>${escapeHtml(item.scope)}</strong> · ${escapeHtml(item.message)}（${item.calls} 次调用，阈值 ${item.threshold}%） ${item.drilldown ? `<button class="secondary" style="margin-left:10px;padding:4px 8px" data-alert-drill="${escapeHtml(item.id)}" data-alert-prompt="${escapeHtml(item.drilldown.prompt || '')}" data-alert-ok="${escapeHtml(item.drilldown.ok || 'all')}" data-alert-days="${item.drilldown.days || 7}">查看相关日志</button>` : ''}${item.acknowledged ? `已确认：${escapeHtml(item.acknowledgedBy || '管理员')} · ${fullTime(item.acknowledgedAt)}` : (can('editor') ? `<button class="secondary" style="margin-left:10px;padding:4px 8px" data-alert-ack="${escapeHtml(item.id)}">确认</button>` : '')}</div>`).join('');
    const alertHistoryRows = (s.alertHistory || []).map(item => `<tr><td>${escapeHtml(item.scope || '-')}</td><td>${escapeHtml(item.metric || '-')}</td><td>${tag(item.status || 'active', item.status === 'recovered' ? 'green' : item.status === 'acknowledged' ? 'blue' : 'amber')}</td><td>${item.lastRate != null ? `${item.lastRate}%` : '-'}</td><td class="prompt-meta">${fullTime(item.recoveredAt || item.acknowledgedAt || item.lastSeenAt)}</td><td>${escapeHtml(item.acknowledgedBy || '-')}</td></tr>`).join('');
    const slowRows = s.slowest.length ? s.slowest.map(item => `<tr><td>${fullTime(item.at)}</td><td>${fmtLatency(item.latencyMs)}</td><td>${escapeHtml(item.model || '-')}</td><td>${escapeHtml(item.role || '-')}</td><td>${escapeHtml((item.prompts || []).join('、') || '-')}</td><td>${fmtNumber(item.inputChars)}</td><td>${item.attempts || 1}</td></tr>`).join('') : '';

    const rows = state.logs.map(l => {
      const status = l.ok ? tag('成功', 'green') : tag('失败', 'red');
      const usage = l.usage ? `${fmtNumber(l.usage.prompt_tokens)} / ${fmtNumber(l.usage.completion_tokens)}` : '—';
      const notes = [];
      if ((l.truncated || []).length) notes.push(`<span class="tag amber">截断 ${l.truncated.length} 条</span>`);
      if ((l.dropped || []).length) notes.push(`<span class="tag amber">超量丢弃 ${l.dropped.length} 条</span>`);
      if ((l.attempts || 1) > 1) notes.push(`<span class="tag grey">重试 ${l.attempts} 次</span>`);
      if ((l.validationErrors || []).length) notes.push(`<span class="tag red" title="${escapeHtml(l.validationErrors.join('、'))}">结构字段 ${l.validationErrors.length} 个</span>`);
      return `<tr>
        <td class="prompt-meta" title="${fullTime(l.at)}">${timeAgo(l.at)}</td>
        <td>${status}</td>
        <td class="prompt-meta">${escapeHtml(l.model || '-')}</td>
        <td class="prompt-meta">${escapeHtml(l.role || '—')}</td>
        <td class="version">${fmtLatency(l.latencyMs)}</td>
        <td class="version" title="输入 / 输出 token">${usage}</td>
        <td class="version">${l.usage ? fmtCost(l.cost) : '—'}</td>
        <td>${l.code ? `<span class="tag red" title="${escapeHtml(l.error || '')}">${escapeHtml(l.code)}</span>` : '<span class="prompt-meta">—</span>'}</td>
        <td class="prompt-meta">${notes.join('') || '—'} <button class="iconbtn" data-log-detail="${escapeHtml(l.id)}">详情</button></td>
      </tr>`;
    }).join('');

    return `
      <div class="headline">
        <div><h1>运行日志</h1><p>每次分析的模型、耗时、token、成本与错误分布，数据来自服务端 data/logs.jsonl。</p></div>
        <div style="display:flex;gap:9px">
          <select class="filter" id="logDays">
            ${[1, 7, 30, 90].map(d => `<option value="${d}"${state.logDays === d ? ' selected' : ''}>近 ${d} 天</option>`).join('')}
          </select>
          <button class="secondary" id="reloadLogs">刷新</button>
          <button class="secondary" id="exportLogs">导出 CSV</button>
          ${can('admin') ? '<button class="secondary" id="pruneLogs">清理过期</button>' : ''}
        </div>
      </div>
      <section class="panel"><div class="toolbar">
        <select class="filter" id="logModel"><option value="">全部模型</option>${s.filters.models.map(item => `<option value="${escapeHtml(item)}"${state.logFilter.model === item ? ' selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select>
        <select class="filter" id="logPrompt"><option value="">全部 Prompt</option>${s.filters.prompts.map(item => `<option value="${escapeHtml(item)}"${state.logFilter.prompt === item ? ' selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select>
        <input class="filter" id="logRole" placeholder="按岗位搜索" value="${escapeHtml(state.logFilter.role)}" />
        <select class="filter" id="logMinLatency"><option value="0">全部耗时</option>${[1000,3000,5000,10000].map(ms => `<option value="${ms}"${state.logFilter.minLatency === ms ? ' selected' : ''}>≥ ${fmtLatency(ms)}</option>`).join('')}</select>
        <button class="secondary" id="clearLogFilters">清除筛选</button>
      </div></section>
      <section class="stats">
        <div class="stat"><label>总调用</label><strong>${fmtNumber(s.total)}</strong><small>近 ${s.days} 天</small></div>
        <div class="stat"><label>成功率</label><strong>${okRate}%</strong><small class="${s.failed === 0 ? 'good' : 'warn'}">失败 ${s.failed} 次</small></div>
        <div class="stat"><label>平均耗时</label><strong>${fmtLatency(s.avgLatency)}</strong><small>P50 ${fmtLatency(s.p50Latency)} · P95 ${fmtLatency(s.p95Latency)} · P99 ${fmtLatency(s.p99Latency)}</small></div>
        <div class="stat"><label>Token 用量</label><strong>${fmtNumber(s.tokens)}</strong><small>${s.truncatedCalls ? `<span class="warn">${s.truncatedCalls} 次调用发生截断</span>` : '无截断事件'}</small></div>
        <div class="stat"><label>预估成本</label><strong>${fmtCost(s.cost)}</strong><small>¥ · 按项目设置单价折算</small></div>
        <div class="stat"><label>重试率</label><strong>${s.retryRate}%</strong><small>${s.retryCalls} 次重试 · ${s.droppedCalls} 次丢弃</small></div>
        <div class="stat"><label>平均输入规模</label><strong>${fmtNumber(s.avgInputChars)}</strong><small>字符/次，不保存输入原文</small></div>
        <div class="stat"><label>Schema 结构错误</label><strong>${fmtNumber((s.schemaFields || []).reduce((sum, item) => sum + item.count, 0))}</strong><small>${(s.schemaFields || []).slice(0, 3).map(item => `${escapeHtml(item.field)} ${item.count} 次`).join(' · ') || '无结构错误'}</small></div>
      </section>
      ${alertRows || '<div class="banner good show">当前区间没有触发异常阈值告警</div>'}
      ${alertHistoryRows ? `<section class="panel"><div class="panel-head"><div><h2>告警生命周期</h2><p>同一范围与指标自动归并；低于阈值后标记为已恢复</p></div></div><table class="table"><thead><tr><th>范围</th><th>指标</th><th>状态</th><th>最近比例</th><th>状态时间</th><th>确认人</th></tr></thead><tbody>${alertHistoryRows}</tbody></table></section>` : ''}
      <section class="panel"><div class="panel-head"><div><h2>Prompt 版本趋势</h2><p>仅展示当前告警关联版本；按天计算失败率、Schema 错误率和重试率</p></div></div><div class="trend-grid">${promptTrendChart(s.promptVersionTrends || [], s.alerts || [])}</div></section>
      <div class="grid2">
        <section class="panel">
          <div class="panel-head"><div><h2>每日调用量</h2><p>失败调用叠加显示</p></div></div>
          <div style="padding:12px 16px 6px">${dailyChart(s.daily)}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><div><h2>失败原因分布</h2><p>共 ${s.failed} 次失败</p></div></div>
          <div style="padding:14px 18px">${errorBars}</div>
        </section>
      </div>
      <div class="grid2"><section class="panel"><div class="panel-head"><div><h2>模型表现</h2><p>成功率、耗时与成本</p></div></div>${modelRows ? `<table class="table"><thead><tr><th>模型</th><th>调用</th><th>成功率</th><th>平均耗时</th><th>Token</th><th>成本</th></tr></thead><tbody>${modelRows}</tbody></table>` : '<div class="empty">暂无模型数据</div>'}</section><section class="panel"><div class="panel-head"><div><h2>Prompt 使用与截断</h2><p>定位高频、截断和丢弃配置</p></div></div>${promptRows ? `<table class="table"><thead><tr><th>Prompt</th><th>调用</th><th>失败</th><th>截断</th><th>丢弃</th></tr></thead><tbody>${promptRows}</tbody></table>` : '<div class="empty">暂无 Prompt 数据</div>'}</section></div>
      <section class="panel"><div class="panel-head"><div><h2>Prompt 版本质量对比</h2><p>按实际生效版本比较失败率、重试率、耗时、成本和 Schema 错误</p></div></div>${promptVersionRows ? `<table class="table"><thead><tr><th>Prompt</th><th>版本</th><th>调用</th><th>失败率</th><th>重试率</th><th>平均耗时</th><th>成本</th><th>Schema 错误</th></tr></thead><tbody>${promptVersionRows}</tbody></table>` : '<div class="empty">暂无 Prompt 版本数据</div>'}</section>
      <section class="panel"><div class="panel-head"><div><h2>最慢请求 Top 10</h2><p>仅展示元数据，不保存 JD 或简历原文</p></div></div>${slowRows ? `<table class="table"><thead><tr><th>时间</th><th>耗时</th><th>模型</th><th>岗位</th><th>Prompt</th><th>输入字符</th><th>尝试</th></tr></thead><tbody>${slowRows}</tbody></table>` : '<div class="empty">暂无成功请求</div>'}</section>
      <section class="panel">
        <div class="panel-head">
          <div><h2>调用明细</h2><p>点击「刷新」或切换区间重新拉取</p></div>
          <div class="tabs" style="border:0;background:none;padding:0">
            <button data-logfilter="all" class="${state.logFilter.ok === 'all' ? 'active' : ''}">全部</button>
            <button data-logfilter="true" class="${state.logFilter.ok === 'true' ? 'active' : ''}">仅成功</button>
            <button data-logfilter="false" class="${state.logFilter.ok === 'false' ? 'active' : ''}">仅失败</button>
          </div>
        </div>
        ${state.logs.length ? `<table class="table">
          <thead><tr><th>时间</th><th>状态</th><th>模型</th><th>岗位</th><th>耗时</th><th>Token 入/出</th><th>成本</th><th>错误码</th><th>备注</th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="empty">该区间内没有调用记录</div>'}
      </section>`;
  }

  /* ---------- 视图：项目设置 ---------- */

  function viewSettings() {
    const s = state.settings;
    if (!s) return loading();
    const notification = state.notification || {};
    const lastNotification = notification.last;
    return `
      <div class="headline"><div><h1>项目设置</h1><p>运行参数直接作用于线上分析链路，保存后立即生效并记入变更记录。</p></div></div>
      <section class="panel">
        <div class="panel-head"><div><h2>模型与请求</h2><p>原先硬编码在 deepseek.js 中的参数</p></div></div>
        <div style="padding:18px">
          <div class="grid2">
            <div class="field"><label>模型</label><input id="s-model" value="${escapeHtml(s.model)}" /></div>
            <div class="field"><label>Temperature（0–2）</label><input id="s-temperature" type="number" step="0.1" min="0" max="2" value="${s.temperature}" /></div>
            <div class="field"><label>Max tokens（256–32000）</label><input id="s-maxTokens" type="number" min="256" max="32000" value="${s.maxTokens}" /></div>
            <div class="field"><label>单次超时（毫秒）</label><input id="s-timeoutMs" type="number" min="5000" max="300000" value="${s.timeoutMs}" /></div>
            <div class="field"><label>重试次数（0–5）</label><input id="s-retries" type="number" min="0" max="5" value="${s.retries}" /></div>
            <div class="field"><label>分析总开关</label>
              <select id="s-analyzeEnabled">
                <option value="true"${s.analyzeEnabled ? ' selected' : ''}>正常运行</option>
                <option value="false"${s.analyzeEnabled ? '' : ' selected'}>暂停所有分析请求</option>
              </select>
            </div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Prompt 注入上限</h2><p>超出上限的内容不会发给模型，后台会明确标注</p></div></div>
        <div style="padding:18px">
          <div class="grid2">
            <div class="field"><label>单条 Prompt 最大字符数</label><input id="s-promptMaxChars" type="number" min="200" max="60000" value="${s.promptMaxChars}" />
              <div class="hint"><span>超出部分会被截断，列表页会显示「超限」标记</span></div></div>
            <div class="field"><label>每次注入的最大条数</label><input id="s-promptMaxCount" type="number" min="1" max="50" value="${s.promptMaxCount}" /></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>成本与留存</h2><p>单价仅用于日志页的成本估算</p></div></div>
        <div style="padding:18px">
          <div class="grid2">
            <div class="field"><label>输入单价（元 / 百万 token）</label><input id="s-inputPricePerM" type="number" step="0.1" min="0" value="${s.inputPricePerM}" /></div>
            <div class="field"><label>输出单价（元 / 百万 token）</label><input id="s-outputPricePerM" type="number" step="0.1" min="0" value="${s.outputPricePerM}" /></div>
            <div class="field"><label>每日成本预算（元）</label><input id="s-dailyCostBudget" type="number" step="0.01" min="0" max="100000" value="${s.dailyCostBudget || 0}" /><div class="hint">设为 0 关闭预算监控；超预算只告警，不会停止分析。</div></div>
            <div class="field"><label>日志保留天数（1–365）</label><input id="s-logRetentionDays" type="number" min="1" max="365" value="${s.logRetentionDays}" /></div>
            <div class="field"><label>失败率告警阈值（%）</label><input id="s-alertFailureRate" type="number" min="0" max="100" value="${s.alertFailureRate}" /><div class="hint">设为 0 可关闭该项告警</div></div>
            <div class="field"><label>Schema 错误率告警阈值（%）</label><input id="s-alertSchemaErrorRate" type="number" min="0" max="100" value="${s.alertSchemaErrorRate}" /></div>
            <div class="field"><label>重试率告警阈值（%）</label><input id="s-alertRetryRate" type="number" min="0" max="100" value="${s.alertRetryRate}" /></div>
            <div class="field"><label>触发告警的最少调用数</label><input id="s-alertMinCalls" type="number" min="1" max="10000" value="${s.alertMinCalls}" /></div>
            <div class="field"><label>灰度失败率熔断阈值（%）</label><input id="s-canaryFailureRate" type="number" min="0" max="100" value="${s.canaryFailureRate}" /><div class="hint">设为 0 可关闭失败率熔断</div></div>
            <div class="field"><label>灰度 Schema 错误率熔断阈值（%）</label><input id="s-canarySchemaErrorRate" type="number" min="0" max="100" value="${s.canarySchemaErrorRate}" /></div>
            <div class="field"><label>灰度自动熔断最少调用数</label><input id="s-canaryMinCalls" type="number" min="1" max="10000" value="${s.canaryMinCalls}" /></div>
            <div class="field"><label>灰度自动熔断</label><select id="s-canaryAutoStop"><option value="true"${s.canaryAutoStop ? ' selected' : ''}>启用</option><option value="false"${s.canaryAutoStop ? '' : ' selected'}>停用</option></select><div class="hint">达到最少调用数且超过任一阈值时停止灰度</div></div>
            <div class="field"><label>Webhook 告警通知</label><select id="s-alertNotificationsEnabled"><option value="true"${s.alertNotificationsEnabled ? ' selected' : ''}>启用</option><option value="false"${s.alertNotificationsEnabled ? '' : ' selected'}>停用</option></select><div class="hint">地址与令牌只从服务端环境变量读取；当前配置：${s.alertWebhookConfigured ? '已配置' : '未配置'}。最近状态：${lastNotification ? `${escapeHtml(lastNotification.status)} · ${fullTime(lastNotification.at)}` : '暂无记录'}</div></div>
            <div class="field"><label>发布冻结</label><select id="s-releaseFreeze"><option value="false"${s.releaseFreeze ? '' : ' selected'}>允许生产变更</option><option value="true"${s.releaseFreeze ? ' selected' : ''}>冻结发布、灰度与生产回滚</option></select><input id="s-releaseFreezeReason" placeholder="冻结原因（可选）" value="${escapeHtml(s.releaseFreezeReason || '')}" /><div class="hint">冻结只阻止生产变更，不影响用户分析、日志和查看功能。</div></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">
            <button class="secondary" id="reloadSettings">放弃修改</button>
            ${can('admin') ? '<button class="secondary" id="testAlertNotification">发送测试通知</button>' : ''}
            ${can('admin') ? '<button class="primary" id="saveSettings">保存设置</button>' : ''}
          </div>
        </div>
      </section>`;
  }

  /* ---------- 抽屉：编辑 ---------- */

  function openDrawer(html, wide) {
    const body = $('#drawerBody');
    body.className = 'drawer' + (wide ? ' wide' : '');
    body.innerHTML = html;
    $('#drawer').classList.add('open');
  }

  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawerBody').innerHTML = '';
  }

  async function openLogDetail(id) {
    try {
      const data = await api(`/api/logs/${encodeURIComponent(id)}`);
      const item = data.item || {};
      const usage = item.usage ? `${fmtNumber(item.usage.prompt_tokens)} / ${fmtNumber(item.usage.completion_tokens)} / ${fmtNumber(item.usage.total_tokens)}` : '—';
      const versions = (item.promptVersions || []).map(version => `${version.name || ''}@${version.version || ''}`).join('、') || '—';
      const list = (values, empty = '无') => values && values.length ? values.map(value => escapeHtml(value)).join('、') : empty;
      openDrawer(`<div class="drawer-head"><div><h2>运行日志详情</h2><p>${escapeHtml(item.id || id)} · ${fullTime(item.at)}</p></div><button class="close" data-act="close-drawer">×</button></div>
        <div class="grid2">
          <div class="field"><label>状态</label><div>${item.ok ? tag('成功', 'green') : tag('失败', 'red')} ${escapeHtml(item.errorLabel || '')}</div></div>
          <div class="field"><label>错误码</label><div>${escapeHtml(item.code || '—')}</div></div>
          <div class="field"><label>模型</label><div>${escapeHtml(item.model || '—')}${item.modelReturned ? ` · 返回 ${escapeHtml(item.modelReturned)}` : ''}</div></div>
          <div class="field"><label>目标岗位</label><div>${escapeHtml(item.role || '—')}</div></div>
          <div class="field"><label>Prompt 版本</label><div>${escapeHtml(versions)}</div></div>
          <div class="field"><label>耗时 / 尝试</label><div>${fmtLatency(item.latencyMs)} · ${item.attempts || 1} 次</div></div>
          <div class="field"><label>Token（输入 / 输出 / 总计）</label><div>${usage}</div></div>
          <div class="field"><label>成本</label><div>¥${fmtCost(item.cost)}</div></div>
          <div class="field"><label>输入字符数</label><div>${fmtNumber(item.inputChars)}</div></div>
          <div class="field"><label>截断 / 丢弃</label><div>${item.truncatedCount || 0} / ${item.droppedCount || 0}</div></div>
        </div>
        <div class="field"><label>结构校验错误</label><div>${list(item.schemaErrors)}</div></div>
        <div class="field"><label>风险命中摘要</label><div>${list(item.riskHits)}</div></div>
        <div class="field"><label>调用 Prompt</label><div>${list(item.prompts)}</div></div>
        <p class="prompt-meta">详情仅展示运行元数据，不包含 JD、简历、Prompt 正文或上游原始错误。</p>`, true);
    } catch (error) { toast(error.message, true); }
  }

  function editorHtml(prompt) {
    const maxChars = (state.overview && state.overview.settings && state.overview.settings.promptMaxChars) || 4000;
    const isEdit = !!prompt;
    const p = prompt || { name: '', type: 'task', desc: '', content: '', enabled: true, step: null, version: 'v1.0' };
    return `
      <div class="drawer-head">
        <div>
          <h2>${isEdit ? '编辑 Prompt' : '新建 Prompt'}</h2>
          <p class="prompt-meta" id="drawerMeta">${isEdit ? `当前工作版本 ${escapeHtml(p.version)} · 保存后成为草稿，不会立即影响生产` : '新 Prompt 默认保存为草稿，发布前不会进入分析链路'}</p>
        </div>
        <button class="close" data-act="close-drawer">×</button>
      </div>
      <form id="editorForm">
        <div class="field"><label>名称</label><input id="f-name" maxlength="80" required value="${escapeHtml(p.name)}" /></div>
        <div class="grid2">
          <div class="field"><label>类型</label>
            <select id="f-type">
              <option value="system"${p.type === 'system' ? ' selected' : ''}>系统 Prompt</option>
              <option value="task"${p.type === 'task' ? ' selected' : ''}>任务 Prompt</option>
            </select>
          </div>
          <div class="field"><label>归属步骤</label>
            <select id="f-step">
              <option value="">扩展（全局附加）</option>
              ${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}"${Number(p.step) === n ? ' selected' : ''}>步骤 ${n}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field"><label>用途说明</label><input id="f-desc" maxlength="200" value="${escapeHtml(p.desc || '')}" /></div>
        <div class="field">
          <label>Prompt 内容</label>
          <textarea id="f-content" required>${escapeHtml(p.content || '')}</textarea>
          <div class="hint" id="charHint"><span>超出 ${maxChars} 字符的部分不会发送给模型</span><span id="charCount">0 / ${maxChars}</span></div>
        </div>
        <div class="field"><label>状态</label>
          <select id="f-enabled">
            <option value="true"${p.enabled ? ' selected' : ''}>启用（发布后生效）</option>
            <option value="false"${p.enabled ? '' : ' selected'}>停用</option>
          </select>
        </div>
        <div class="field"><label>变更备注（可选）</label><input id="f-note" maxlength="200" placeholder="例如：收紧事实边界，禁止把 Demo 写为商业项目" /></div>
        <div class="drawer-foot">
          <button type="button" class="secondary" data-act="close-drawer">取消</button>
          <button type="submit" class="primary">保存草稿</button>
        </div>
      </form>`;
  }

  function bindEditor(prompt) {
    const maxChars = (state.overview && state.overview.settings && state.overview.settings.promptMaxChars) || 4000;
    const textarea = $('#f-content');
    const counter = $('#charCount');
    const hint = $('#charHint');
    const sync = () => {
      const len = textarea.value.length;
      counter.textContent = `${len} / ${maxChars}`;
      hint.classList.toggle('over', len > maxChars);
    };
    textarea.addEventListener('input', sync);
    sync();

    $('#editorForm').addEventListener('submit', async event => {
      event.preventDefault();
      const payload = {
        name: $('#f-name').value.trim(),
        type: $('#f-type').value,
        step: $('#f-step').value === '' ? null : Number($('#f-step').value),
        stepKey: $('#f-step').value === '' ? 'extension' : ['input', 'jd', 'diagnosis', 'match', 'questions', 'optimize', 'interview', 'export'][Number($('#f-step').value) - 1],
        desc: $('#f-desc').value.trim(),
        content: $('#f-content').value,
        enabled: $('#f-enabled').value === 'true',
        note: $('#f-note').value.trim(),
        actor: '管理员'
      };
      try {
        if (prompt) await api(`/api/prompts/${prompt.id}`, { method: 'PUT', body: payload });
        else await api('/api/prompts', { method: 'POST', body: payload });
        closeDrawer();
        await refreshPrompts();
        toast(prompt ? '草稿已保存，生产版本未变化' : 'Prompt 草稿已创建');
      } catch (error) { toast(error.message, true); }
    });
  }

  /* ---------- 抽屉：版本历史 ---------- */

  async function openHistory(promptId) {
    openDrawer(loading('加载版本历史…'), true);
    try {
      const { prompt, versions } = await api(`/api/prompts/${promptId}`);
      state.currentPrompt = prompt;
      state.currentVersions = versions;
      openDrawer(historyHtml(prompt, versions), true);
      bindHistory();
    } catch (error) {
      closeDrawer();
      toast(error.message, true);
    }
  }

  function historyHtml(prompt, versions) {
    const rows = versions.map((v, index) => {
      const isCurrent = index === 0;
      return `<div class="vrow ${isCurrent ? 'current' : ''}">
        <span class="vver">${escapeHtml(v.version)}</span>
        <span class="vmeta">${tag(v.actionLabel || v.action, ACTION_TAG[v.action])}${fullTime(v.at)} · ${escapeHtml(v.actor || '管理员')}${v.note ? ` · ${escapeHtml(v.note)}` : ''}${isCurrent ? ' · 当前版本' : ''}</span>
        <span class="actions">
          ${isCurrent ? '' : `<button class="iconbtn" data-act="diff" data-vid="${v.vid}" data-index="${index}">与当前对比</button>`}
          ${isCurrent || !can('editor') ? '' : `<button class="iconbtn" data-act="restore" data-vid="${v.vid}" data-version="${escapeHtml(v.version)}">恢复为草稿</button>`}
          ${isCurrent || !can('admin') || !['seed', 'publish', 'production_rollback'].includes(v.action) ? '' : `<button class="iconbtn" data-act="production-rollback" data-vid="${v.vid}" data-version="${escapeHtml(v.version)}">回滚生产</button>`}
        </span>
      </div>`;
    }).join('');

    return `
      <div class="drawer-head">
        <div>
          <h2>版本历史</h2>
          <p class="prompt-meta">${escapeHtml(prompt.name)} · 工作版本 ${escapeHtml(prompt.version)} · 生产版本 ${escapeHtml(prompt.publishedVersion || '未发布')} · 共 ${versions.length} 个记录</p>
        </div>
        <button class="close" data-act="close-drawer">×</button>
      </div>
      <p class="prompt-meta" style="margin-top:-8px">“恢复为草稿”不会影响生产；“回滚生产”会立即生成新的生产版本，但不会删除历史。</p>
      <div class="vlist" style="margin-top:16px">${rows}</div>
      <div id="diffArea"></div>
      <details class="collapse" style="margin-top:16px">
        <summary>查看当前 Prompt 内容</summary>
        <div class="inner"><div class="diff"><div class="row same"><span class="sign"> </span><span>${escapeHtml(prompt.content || '').replace(/\n/g, '</span></div><div class="row same"><span class="sign"> </span><span>')}</span></div></div></div>
      </details>`;
  }

  function bindHistory() {
    const area = $('#diffArea');
    $$('[data-act="diff"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.index);
        const target = state.currentVersions.find(v => v.vid === btn.dataset.vid);
        if (!target || !area) return;
        area.innerHTML = `<details class="collapse" open style="margin-top:16px">
          <summary>${escapeHtml(target.version)} → ${escapeHtml(state.currentPrompt.version)} 的内容差异</summary>
          <div class="inner">${renderDiff(target.snapshot.content, state.currentPrompt.content)}</div>
        </details>`;
      });
    });

    $$('[data-act="restore"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const version = btn.dataset.version;
        if (!window.confirm(`确认把 ${version} 恢复为新草稿？\n\n生产版本不会变化。`)) return;
        try {
          const result = await api(`/api/prompts/${state.currentPrompt.id}/rollback`, {
            method: 'POST',
            body: { vid: btn.dataset.vid, actor: '管理员' }
          });
          toast(`已恢复为草稿：${result.rolledBackFrom} → ${result.prompt.version}`);
          await refreshPrompts();
          await openHistory(state.currentPrompt.id);
        } catch (error) { toast(error.message, true); }
      });
    });

    $$('[data-act="production-rollback"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const version = btn.dataset.version;
        if (!window.confirm(`确认将生产环境回滚到 ${version}？\n\n系统会生成一个新的生产版本，历史不会删除。`)) return;
        try {
          const result = await api(`/api/prompts/${state.currentPrompt.id}/production-rollback`, {
            method: 'POST', body: { vid: btn.dataset.vid, actor: '管理员', note: `生产回滚至 ${version}` }
          });
          toast(`生产已回滚：${result.rolledBackFrom || '未发布'} → ${result.prompt.publishedVersion}`);
          await refreshPrompts();
          await openHistory(state.currentPrompt.id);
        } catch (error) { toast(error.message, true); }
      });
    });
  }

  /* ---------- 数据加载 ---------- */

  async function refreshPrompts() {
    const params = new URLSearchParams({ q: state.query.q, status: state.query.status, type: state.query.type });
    const [overview, list] = await Promise.all([api('/api/overview'), api(`/api/prompts?${params}`)]);
    state.overview = overview;
    state.settings = overview.settings;
    state.prompts = list.items;
    clearConnError();
  }

  async function loadTemplates() {
    const data = await api('/api/templates'); state.templates = data.items || [];
  }

  async function loadPrompts() {
    try {
      await refreshPrompts();
      render();
      renderRows();
    } catch (error) {
      showConnError(`无法连接到管理接口：${error.message}。请通过 node server.js 启动后访问 /admin。`);
      $('#page').innerHTML = loading('数据加载失败');
    }
  }

  async function loadChanges() {
    try {
      const params = new URLSearchParams({ limit: '120', page: '1' });
      Object.entries(state.changeFilter).forEach(([key, value]) => { if (value) params.set(key, value); });
      const data = await api(`/api/changes?${params}`);
      state.changes = data.items || [];
      state.changesMeta = { total: data.total || 0, page: data.page || 1, pages: data.pages || 1, actions: data.actions || [] };
      clearConnError();
      render();
    } catch (error) { showConnError(`变更记录加载失败：${error.message}`); }
  }

  function csvCell(value) {
    const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportChanges() {
    const headers = ['时间', '操作类型', 'Prompt', '版本', '操作人', '备注'];
    const rows = state.changes.map(item => [fullTime(item.at), item.actionLabel || item.action, item.promptName || '', item.version || '', item.actor || '', item.note || '']);
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `变更记录-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    toast(`已导出 ${state.changes.length} 条变更记录`);
  }

  async function exportLogs() {
    const params = new URLSearchParams({ days: String(state.logDays), limit: '5000' });
    if (state.logFilter.ok !== 'all') params.set('ok', state.logFilter.ok);
    ['model', 'prompt', 'role'].forEach(key => { if (state.logFilter[key]) params.set(key, state.logFilter[key]); });
    if (state.logFilter.minLatency) params.set('minLatency', String(state.logFilter.minLatency));
    const data = await api(`/api/logs?${params}`);
    const headers = ['时间', '状态', '模型', '岗位', 'Prompt 版本', '耗时毫秒', '输入 Token', '输出 Token', '成本', '错误码', '重试次数', '输入字符', 'Schema 错误数', '截断条数', '丢弃条数'];
    const rows = (data.items || []).map(item => [
      fullTime(item.at), item.ok ? '成功' : '失败', item.model || '', item.role || '',
      (item.promptVersions || []).map(version => `${version.name || ''}@${version.version || ''}`).join('；'),
      item.latencyMs || 0, item.usage?.prompt_tokens || '', item.usage?.completion_tokens || '', item.cost ?? '',
      item.code || '', item.attempts || 1, item.inputChars || 0, (item.validationErrors || []).length,
      (item.truncated || []).length, (item.dropped || []).length
    ]);
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url;
    link.download = `运行日志-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    toast(`已导出 ${rows.length} 条运行日志`);
  }

  function exportQuality() {
    const data = state.quality;
    if (!data) throw new Error('质量分析数据尚未加载');
    const headers = ['统计窗口', '维度', 'Prompt/岗位', '版本', '调用', '成功率', '失败率', 'Schema错误率', '重试率', '平均延迟毫秒', 'P50延迟毫秒', 'P95延迟毫秒', 'Token', '成本', '反馈数', '人工正向率'];
    const rows = []; const o = data.overall || {};
    rows.push([`近${data.days}天`, '总体', '全部', '', o.calls || 0, o.successRate ?? '', o.failureRate ?? '', o.schemaErrorRate ?? '', o.retryRate ?? '', o.avgLatency ?? '', o.p50Latency ?? '', o.p95Latency ?? '', o.tokens || 0, o.cost || 0, o.feedback || 0, o.positiveRate ?? '']);
    (data.byPrompt || []).forEach(item => rows.push([`近${data.days}天`, 'Prompt版本', item.prompt || '', item.version || '', item.calls || 0, item.successRate ?? '', item.failureRate ?? '', item.schemaErrorRate ?? '', item.retryRate ?? '', item.avgLatency ?? '', '', '', item.tokens || 0, item.cost || 0, item.feedback || 0, item.positiveRate ?? '']));
    (data.byRole || []).forEach(item => rows.push([`近${data.days}天`, '岗位', item.role || '', '', item.calls || 0, item.successRate ?? '', item.failureRate ?? '', item.schemaErrorRate ?? '', item.retryRate ?? '', item.avgLatency ?? '', '', '', item.tokens || 0, item.cost || 0, item.feedback || 0, item.positiveRate ?? '']));
    const csv = '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `质量分析-${data.days}天-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    toast(`已导出 ${rows.length} 条质量汇总`);
  }

  async function loadLogs() {
    try {
      const params = new URLSearchParams({ days: String(state.logDays), limit: '200' });
      if (state.logFilter.ok !== 'all') params.set('ok', state.logFilter.ok);
      ['model', 'prompt', 'role'].forEach(key => { if (state.logFilter[key]) params.set(key, state.logFilter[key]); });
      if (state.logFilter.minLatency) params.set('minLatency', String(state.logFilter.minLatency));
      const [stats, logs] = await Promise.all([api(`/api/logs/stats?${params}`), api(`/api/logs?${params}`)]);
      state.logStats = {
        total: 0, failed: 0, days: state.logDays, avgLatency: 0, p50Latency: 0, p95Latency: 0, p99Latency: 0,
        tokens: 0, cost: 0, retryRate: 0, retryCalls: 0, droppedCalls: 0, truncatedCalls: 0, avgInputChars: 0,
        byCode: [], byModel: [], byPrompt: [], byPromptVersion: [], promptVersionTrends: [], schemaFields: [],
        slowest: [], daily: [], alerts: [], alertHistory: [], filters: { models: [], prompts: [] }, ...stats
      };
      state.logStats.filters = { models: [], prompts: [], ...(state.logStats.filters || {}) };
      state.logs = Array.isArray(logs.items) ? logs.items : [];
      render();
    } catch (error) { showConnError(`运行日志加载失败：${error.message}`); }
  }

  async function loadTasks() {
    try {
      const f = state.taskFilter;
      const params = new URLSearchParams({ page: String(f.page), limit: '50', days: String(f.days) });
      if (f.status) params.set('status', f.status);
      if (f.role) params.set('role', f.role);
      state.tasks = await api(`/api/tasks?${params}`);
      clearConnError();
      render();
    } catch (error) { showConnError(`任务中心加载失败：${error.message}`); }
  }

  async function loadQuality() {
    try {
      state.quality = await api(`/api/quality?days=${state.qualityDays}`);
      clearConnError();
      render();
    } catch (error) { showConnError(`质量分析加载失败：${error.message}`); }
  }

  async function loadExperiments() {
    try {
      state.experiments = await api(`/api/experiments?days=${state.experimentDays}`);
      clearConnError();
      render();
    } catch (error) { showConnError(`实验中心加载失败：${error.message}`); }
  }

  async function loadRegressionCenter() {
    try {
      state.regressionCenter = await api('/api/regression-center');
      clearConnError();
      render();
    } catch (error) { showConnError(`回归中心加载失败：${error.message}`); }
  }

  async function loadDashboard() {
    try {
      const [overview, quality, tasks, alerts, budget] = await Promise.all([
        api('/api/overview'), api('/api/quality?days=7'), api('/api/tasks?days=7&limit=1'), api('/api/alerts?limit=100'), api('/api/cost-budget')
      ]);
      state.dashboard = { overview, quality, tasks, alerts, budget };
      clearConnError();
      render();
    } catch (error) { showConnError(`运营总览加载失败：${error.message}`); }
  }

  async function loadSystemHealth() {
    try {
      state.systemHealth = await api('/api/system-health');
      clearConnError();
      render();
    } catch (error) { showConnError(`系统健康加载失败：${error.message}`); }
  }

  async function loadFeedback() {
    try {
      const params = new URLSearchParams({ limit: '200' });
      Object.entries(state.feedbackFilter).forEach(([key, value]) => { if (value) params.set(key, value); });
      const data = await api(`/api/feedback?${params}`);
      state.feedback = data.items || [];
      state.feedbackStats = data.stats || null;
      clearConnError();
      render();
    } catch (error) { showConnError(`质量反馈加载失败：${error.message}`); }
  }

  async function loadRules() {
    try { const data = await api('/api/rules'); state.rules = data.items || []; clearConnError(); render(); }
    catch (error) { showConnError(`风险规则加载失败：${error.message}`); }
  }

  async function loadDependencies() {
    try { const data = await api('/api/dependencies'); state.dependencies = data; clearConnError(); render(); }
    catch (error) { showConnError(`流程依赖加载失败：${error.message}`); }
  }

  async function loadSettings() {
    try {
      const data = await api('/api/settings');
      state.settings = data.settings;
      state.notification = data.notification || null;
      render();
    } catch (error) { showConnError(`设置加载失败：${error.message}`); }
  }

  async function loadTests() {
    try {
      if (!state.prompts.length) await refreshPrompts();
      const [cases, runs, regressions] = await Promise.all([api('/api/test-cases'), api('/api/prompt-tests?limit=50'), api('/api/regressions?limit=30')]);
      state.testCases = cases.items || [];
      state.testRuns = runs.items || [];
      state.regressionRuns = regressions.items || [];
      if (!state.testForm.promptId && state.prompts.length) state.testForm.promptId = String(state.prompts[0].id);
      clearConnError();
      render();
    } catch (error) {
      showConnError(`Prompt 测试台加载失败：${error.message}`);
      $('#page').innerHTML = loading('测试台数据加载失败');
    }
  }

  /* ---------- 事件绑定 ---------- */

  function bindView() {
    $$('[data-go-route]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.goRoute)));
    // Prompt 总览
    const search = $('#search');
    if (search) {
      let timer;
      search.addEventListener('input', () => {
        state.query.q = search.value;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await refreshPrompts();
          renderRows();
        }, 220);
      });
    }
    const statusFilter = $('#statusFilter');
    if (statusFilter) statusFilter.addEventListener('change', async () => { state.query.status = statusFilter.value; await refreshPrompts(); renderRows(); });
    const typeFilter = $('#typeFilter');
    if (typeFilter) typeFilter.addEventListener('change', async () => { state.query.type = typeFilter.value; await refreshPrompts(); renderRows(); });
    const newBtn = $('#newBtn');
    if (newBtn) newBtn.addEventListener('click', () => { openDrawer(editorHtml(null)); bindEditor(null); });
    $$('.prompt-select').forEach(box => box.addEventListener('change', () => { const id = box.dataset.id; state.selectedPrompts = box.checked ? [...new Set([...state.selectedPrompts, id])] : state.selectedPrompts.filter(item => item !== id); }));
    const batch = async action => {
      if (!state.selectedPrompts.length) return toast('请先选择 Prompt', true);
      try { const result = await api('/api/prompts/batch', { method: 'POST', body: { ids: state.selectedPrompts, action } }); state.selectedPrompts = []; await refreshPrompts(); render(); toast(`批量操作完成：成功 ${result.succeeded}，失败 ${result.failed}`, result.failed > 0); }
      catch (error) { toast(error.message, true); }
    };
    const batchEnable = $('#batchEnable'); if (batchEnable) batchEnable.addEventListener('click', () => batch('enable'));
    const batchDisable = $('#batchDisable'); if (batchDisable) batchDisable.addEventListener('click', () => batch('disable'));
    const batchReview = $('#batchReview'); if (batchReview) batchReview.addEventListener('click', () => batch('submit-review'));
    const openTemplates = $('#openTemplates');
    if (openTemplates) openTemplates.addEventListener('click', async () => {
      try {
        await loadTemplates();
        const draw = () => `<div class="drawer-head"><div><h2>Prompt 模板</h2><p>模板只用于创建新的草稿，不会直接进入生产。</p></div><button class="close" data-act="close-drawer">×</button></div><div class="toolbar"><input id="templateSearch" placeholder="搜索模板名称、标签或内容" /><select id="templateCategory"><option value="">全部分类</option>${['通用', 'JD 分析', '证据校验', '匹配分析', '面试准备', '其他'].map(x => `<option>${x}</option>`).join('')}</select></div><div class="vlist">${state.templates.map(template => `<div class="vrow"><div class="vmeta"><div class="vver">${escapeHtml(template.name)} ${tag(template.version || 'v1.0')} ${template.archived ? tag('已归档', 'grey') : ''}</div><div>${escapeHtml(template.desc || '')}</div><div class="prompt-meta">${escapeHtml(template.category || '未分类')} · 步骤 ${template.step || '扩展'} · 标签 ${(template.tags || []).join('、') || '无'} · 变量 ${(template.variables || []).join('、') || '无'}</div></div><div class="actions"><button class="primary" style="padding:7px 10px" data-template-create="${escapeHtml(template.id)}" ${template.archived ? 'disabled' : ''}>创建草稿</button><button class="iconbtn" data-template-edit="${escapeHtml(template.id)}">编辑</button><button class="iconbtn" data-template-history="${escapeHtml(template.id)}">版本</button><button class="iconbtn" data-template-archive="${escapeHtml(template.id)}" data-archived="${template.archived ? 'false' : 'true'}">${template.archived ? '恢复' : '归档'}</button></div></div>`).join('')}</div>`;
        openDrawer(draw(), true);
        const reload = async () => { const q = $('#templateSearch')?.value || ''; const category = $('#templateCategory')?.value || ''; const data = await api(`/api/templates?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}&includeArchived=true`); state.templates = data.items || []; openDrawer(draw(), true); bindTemplateFilters(); };
        const bindTemplateFilters = () => { $('#templateSearch')?.addEventListener('input', () => { clearTimeout(bindTemplateFilters.timer); bindTemplateFilters.timer = setTimeout(reload, 250); }); $('#templateCategory')?.addEventListener('change', reload); };
        bindTemplateFilters();
      }
      catch (error) { toast(error.message, true); }
    });
    const reloadReleases = $('#reloadReleases');
    if (reloadReleases) reloadReleases.addEventListener('click', async () => { await refreshPrompts(); render(); });

    // Prompt 测试台
    const loadSelectedCase = caseId => {
      const selected = state.testCases.find(item => item.id === caseId);
      if (!selected) return;
      state.testForm = {
        ...state.testForm, caseId: selected.id, name: selected.name, role: selected.role,
        promptId: selected.promptId || state.testForm.promptId, jd: selected.jd, resume: selected.resume, extra: selected.extra || '',
        minScore: String(selected.minScore || 0), maxScoreDrop: String(selected.maxScoreDrop ?? 5),
        requiredTerms: (selected.requiredTerms || []).join('、')
      };
      render();
    };
    const caseSelect = $('#test-caseId');
    if (caseSelect) caseSelect.addEventListener('change', () => {
      captureTestForm();
      if (caseSelect.value) loadSelectedCase(caseSelect.value);
    });
    $$('[data-testcase-load]').forEach(btn => btn.addEventListener('click', () => loadSelectedCase(btn.dataset.testcaseLoad)));
    $$('[data-testcase-delete]').forEach(btn => btn.addEventListener('click', async () => {
      if (!window.confirm('确认删除这个测试案例？完整测试输入将从服务端移除。')) return;
      try {
        await api(`/api/test-cases/${encodeURIComponent(btn.dataset.testcaseDelete)}`, { method: 'DELETE' });
        if (state.testForm.caseId === btn.dataset.testcaseDelete) state.testForm.caseId = '';
        toast('测试案例已删除');
        await loadTests();
      } catch (error) { toast(error.message, true); }
    }));
    const saveTestCase = $('#saveTestCase');
    if (saveTestCase) saveTestCase.addEventListener('click', async () => {
      const form = captureTestForm();
      if (!form.role.trim() || !form.jd.trim() || !form.resume.trim()) return toast('请填写目标岗位、JD 和测试简历', true);
      if (!window.confirm('保存后，完整 JD、简历与补充信息会持久化到服务端。确认保存？')) return;
      saveTestCase.disabled = true;
      try {
        const data = await api('/api/test-cases', { method: 'POST', body: form });
        state.testForm.caseId = data.item.id;
        toast('测试案例已保存');
        await loadTests();
      } catch (error) { toast(error.message, true); }
      finally { saveTestCase.disabled = false; }
    });
    const runPromptTest = $('#runPromptTest');
    if (runPromptTest) runPromptTest.addEventListener('click', async () => {
      const form = captureTestForm();
      if (!form.promptId) return toast('请选择目标 Prompt', true);
      if (!form.role.trim() || !form.jd.trim() || !form.resume.trim()) return toast('请填写目标岗位、JD 和测试简历', true);
      runPromptTest.disabled = true;
      runPromptTest.textContent = '正在测试…';
      try {
        const data = await api(`/api/prompts/${encodeURIComponent(form.promptId)}/test`, {
          method: 'POST', body: { ...form, variants: ['published', 'draft'] }
        });
        state.testResult = data;
        toast('草稿与生产对比完成');
      } catch (error) {
        if (error.payload && error.payload.results) state.testResult = error.payload;
        toast(`测试失败：${error.message}`, true);
      }
      try {
        const runs = await api('/api/prompt-tests?limit=50');
        state.testRuns = runs.items || [];
      } catch (error) { showConnError(`测试记录刷新失败：${error.message}`); }
      render();
    });
    const promptSelect = $('#test-promptId');
    if (promptSelect) promptSelect.addEventListener('change', () => { captureTestForm(); render(); });
    const runRegression = $('#runRegression');
    if (runRegression) runRegression.addEventListener('click', async () => {
      const form = captureTestForm();
      if (!form.promptId) return toast('请选择目标 Prompt', true);
      runRegression.disabled = true;
      runRegression.textContent = '回归运行中…';
      try {
        const data = await api(`/api/prompts/${encodeURIComponent(form.promptId)}/regression`, { method: 'POST', body: {} });
        state.regressionRuns = [data.run, ...state.regressionRuns.filter(item => item.id !== data.run.id)];
        toast(data.run.passed ? '回归门禁通过' : `回归门禁未通过：${data.run.failed} 个案例失败`, !data.run.passed);
      } catch (error) { toast(error.message, true); }
      render();
    });
    const reloadTests = $('#reloadTests');
    if (reloadTests) reloadTests.addEventListener('click', () => { captureTestForm(); loadTests(); });

    // 变更记录
    const reloadChanges = $('#reloadChanges');
    if (reloadChanges) reloadChanges.addEventListener('click', loadChanges);
    const exportChangesButton = $('#exportChanges');
    if (exportChangesButton) exportChangesButton.addEventListener('click', exportChanges);
    const bindChangeFilter = (id, key) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => { state.changeFilter[key] = el.value.trim(); loadChanges(); });
    };
    bindChangeFilter('#changeAction', 'action');
    bindChangeFilter('#changeFrom', 'from');
    bindChangeFilter('#changeTo', 'to');
    const changeActor = $('#changeActor');
    if (changeActor) {
      let changeTimer;
      changeActor.addEventListener('input', () => { clearTimeout(changeTimer); changeTimer = setTimeout(() => { state.changeFilter.actor = changeActor.value.trim(); loadChanges(); }, 300); });
    }
    const clearChangeFilters = $('#clearChangeFilters');
    if (clearChangeFilters) clearChangeFilters.addEventListener('click', () => { state.changeFilter = { action: '', actor: '', from: '', to: '' }; loadChanges(); });

    // 运行日志
    const logDays = $('#logDays');
    if (logDays) logDays.addEventListener('change', () => { state.logDays = Number(logDays.value); loadLogs(); });
    const reloadLogs = $('#reloadLogs');
    if (reloadLogs) reloadLogs.addEventListener('click', loadLogs);
    const exportLogsButton = $('#exportLogs');
    if (exportLogsButton) exportLogsButton.addEventListener('click', async () => {
      exportLogsButton.disabled = true;
      try { await exportLogs(); } catch (error) { toast(error.message, true); }
      finally { exportLogsButton.disabled = false; }
    });
    const pruneLogs = $('#pruneLogs');
    if (pruneLogs) pruneLogs.addEventListener('click', async () => {
      try { const r = await api('/api/logs/prune', { method: 'POST' }); toast(`已清理，保留 ${r.kept} 条`); loadLogs(); }
      catch (error) { toast(error.message, true); }
    });
    $$('[data-logfilter]').forEach(btn => btn.addEventListener('click', () => {
      state.logFilter.ok = btn.dataset.logfilter;
      loadLogs();
    }));
    const bindLogFilter = (id, key, transform = value => value) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => { state.logFilter[key] = transform(el.value); loadLogs(); });
    };
    bindLogFilter('#logModel', 'model');
    bindLogFilter('#logPrompt', 'prompt');
    bindLogFilter('#logMinLatency', 'minLatency', Number);
    const logRole = $('#logRole');
    if (logRole) {
      let roleTimer;
      logRole.addEventListener('input', () => { clearTimeout(roleTimer); roleTimer = setTimeout(() => { state.logFilter.role = logRole.value.trim(); loadLogs(); }, 300); });
    }
    const clearLogFilters = $('#clearLogFilters');
    if (clearLogFilters) clearLogFilters.addEventListener('click', () => { state.logFilter = { ok: 'all', model: '', prompt: '', role: '', minLatency: 0 }; loadLogs(); });

    // 任务中心
    const taskDays = $('#taskDays');
    if (taskDays) taskDays.addEventListener('change', () => { state.taskFilter.days = Number(taskDays.value); state.taskFilter.page = 1; loadTasks(); });
    const taskStatus = $('#taskStatus');
    if (taskStatus) taskStatus.addEventListener('change', () => { state.taskFilter.status = taskStatus.value; state.taskFilter.page = 1; loadTasks(); });
    const taskRole = $('#taskRole');
    if (taskRole) {
      let taskTimer;
      taskRole.addEventListener('input', () => { clearTimeout(taskTimer); taskTimer = setTimeout(() => { state.taskFilter.role = taskRole.value.trim(); state.taskFilter.page = 1; loadTasks(); }, 300); });
    }
    const clearTaskFilters = $('#clearTaskFilters');
    if (clearTaskFilters) clearTaskFilters.addEventListener('click', () => { state.taskFilter = { status: '', role: '', days: 7, page: 1 }; loadTasks(); });
    const reloadTasks = $('#reloadTasks');
    if (reloadTasks) reloadTasks.addEventListener('click', loadTasks);
    const taskPrev = $('#taskPrev');
    if (taskPrev) taskPrev.addEventListener('click', () => { state.taskFilter.page -= 1; loadTasks(); });
    const taskNext = $('#taskNext');
    if (taskNext) taskNext.addEventListener('click', () => { state.taskFilter.page += 1; loadTasks(); });

    // 质量分析
    const qualityDays = $('#qualityDays');
    if (qualityDays) qualityDays.addEventListener('change', () => { state.qualityDays = Number(qualityDays.value); loadQuality(); });
    const reloadQuality = $('#reloadQuality');
    if (reloadQuality) reloadQuality.addEventListener('click', loadQuality);
    const exportQualityButton = $('#exportQuality');
    if (exportQualityButton) exportQualityButton.addEventListener('click', () => { try { exportQuality(); } catch (error) { toast(error.message, true); } });

    const experimentDays = $('#experimentDays');
    if (experimentDays) experimentDays.addEventListener('change', () => { state.experimentDays = Number(experimentDays.value); loadExperiments(); });
    const reloadExperiments = $('#reloadExperiments');
    if (reloadExperiments) reloadExperiments.addEventListener('click', loadExperiments);

    const reloadRegressionCenter = $('#reloadRegressionCenter');
    if (reloadRegressionCenter) reloadRegressionCenter.addEventListener('click', loadRegressionCenter);
    $$('[data-regression-run]').forEach(button => button.addEventListener('click', () => {
      state.testForm.promptId = String(button.dataset.regressionRun);
      navigate('tests');
    }));
    const reloadDashboard = $('#reloadDashboard');
    if (reloadDashboard) reloadDashboard.addEventListener('click', loadDashboard);
    const dashboardOpenLogs = $('#dashboardOpenLogs');
    if (dashboardOpenLogs) dashboardOpenLogs.addEventListener('click', () => navigate('logs'));
    const dashboardOpenReleases = $('#dashboardOpenReleases');
    if (dashboardOpenReleases) dashboardOpenReleases.addEventListener('click', () => navigate('releases'));
    const dashboardOpenQuality = $('#dashboardOpenQuality');
    if (dashboardOpenQuality) dashboardOpenQuality.addEventListener('click', () => navigate('quality'));
    const reloadSystemHealth = $('#reloadSystemHealth');
    if (reloadSystemHealth) reloadSystemHealth.addEventListener('click', loadSystemHealth);

    const reloadFeedback = $('#reloadFeedback');
    if (reloadFeedback) reloadFeedback.addEventListener('click', loadFeedback);
    const feedbackStatusFilter = $('#feedbackStatusFilter');
    if (feedbackStatusFilter) feedbackStatusFilter.addEventListener('change', () => { state.feedbackFilter.status = feedbackStatusFilter.value; loadFeedback(); });
    const feedbackRatingFilter = $('#feedbackRatingFilter');
    if (feedbackRatingFilter) feedbackRatingFilter.addEventListener('change', () => { state.feedbackFilter.rating = feedbackRatingFilter.value; loadFeedback(); });
    const feedbackPromptFilter = $('#feedbackPromptFilter');
    if (feedbackPromptFilter) { let timer; feedbackPromptFilter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.feedbackFilter.prompt = feedbackPromptFilter.value.trim(); loadFeedback(); }, 300); }); }
    const clearFeedbackFilters = $('#clearFeedbackFilters');
    if (clearFeedbackFilters) clearFeedbackFilters.addEventListener('click', () => { state.feedbackFilter = { status: '', rating: '', prompt: '' }; loadFeedback(); });
    const saveFeedback = $('#saveFeedback');
    if (saveFeedback) saveFeedback.addEventListener('click', async () => {
      const logId = $('#feedback-logId').value.trim();
      const comment = $('#feedback-comment').value.trim();
      if (!logId) return toast('请填写运行记录 ID', true);
      saveFeedback.disabled = true;
      try {
        await api('/api/feedback', { method: 'POST', body: {
          logId, rating: $('#feedback-rating').value,
          tags: $('#feedback-tags').value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean),
          owner: $('#feedback-owner').value.trim(), comment
        } });
        toast('质量反馈已保存');
        await loadFeedback();
      } catch (error) { toast(error.message, true); }
      finally { saveFeedback.disabled = false; }
    });
    $$('[data-feedback-status]').forEach(select => select.addEventListener('change', async () => {
      try { await api(`/api/feedback/${encodeURIComponent(select.dataset.feedbackStatus)}`, { method: 'PUT', body: { status: select.value } }); toast('反馈状态已更新'); await loadFeedback(); }
      catch (error) { toast(error.message, true); }
    }));
    $$('[data-feedback-link]').forEach(button => button.addEventListener('click', async () => {
      const promptId = window.prompt('输入要修复的 Prompt ID');
      if (!promptId) return;
      const testCaseId = window.prompt('输入回归测试案例 ID（可留空）') || '';
      const note = window.prompt('输入修复备注（可留空）') || '';
      try { await api(`/api/feedback/${encodeURIComponent(button.dataset.feedbackLink)}/link`, { method: 'POST', body: { promptId, testCaseId, note } }); toast('反馈已关联修复目标'); await loadFeedback(); }
      catch (error) { toast(error.message, 'error'); }
    }));
    const reloadRules = $('#reloadRules');
    if (reloadRules) reloadRules.addEventListener('click', loadRules);
    $$('[data-rule-toggle]').forEach(button => button.addEventListener('click', async () => {
      try { await api(`/api/rules/${encodeURIComponent(button.dataset.ruleToggle)}`, { method: 'PUT', body: { enabled: button.dataset.enabled === 'true' } }); toast('规则状态已更新'); await loadRules(); }
      catch (error) { toast(error.message, true); }
    }));
    $$('[data-rule-delete]').forEach(button => button.addEventListener('click', async () => {
      if (!window.confirm('确认删除这条风险规则？历史命中记录不会被删除。')) return;
      try { await api(`/api/rules/${encodeURIComponent(button.dataset.ruleDelete)}`, { method: 'DELETE' }); toast('风险规则已删除'); await loadRules(); }
      catch (error) { toast(error.message, true); }
    }));
    const reloadDependencies = $('#reloadDependencies');
    if (reloadDependencies) reloadDependencies.addEventListener('click', loadDependencies);

    // 项目设置
    const saveSettings = $('#saveSettings');
    if (saveSettings) saveSettings.addEventListener('click', async () => {
      const payload = { actor: '管理员' };
      ['model', 'temperature', 'maxTokens', 'timeoutMs', 'retries', 'promptMaxChars', 'promptMaxCount', 'inputPricePerM', 'outputPricePerM', 'dailyCostBudget', 'logRetentionDays', 'alertFailureRate', 'alertSchemaErrorRate', 'alertRetryRate', 'alertMinCalls', 'canaryFailureRate', 'canarySchemaErrorRate', 'canaryMinCalls'].forEach(key => {
        payload[key] = $('#s-' + key).value;
      });
      payload.analyzeEnabled = $('#s-analyzeEnabled').value === 'true';
      payload.alertNotificationsEnabled = $('#s-alertNotificationsEnabled').value === 'true';
      payload.canaryAutoStop = $('#s-canaryAutoStop').value === 'true';
      payload.releaseFreeze = $('#s-releaseFreeze').value === 'true';
      payload.releaseFreezeReason = $('#s-releaseFreezeReason').value.trim();
      try {
        const data = await api('/api/settings', { method: 'PUT', body: payload });
        state.settings = data.settings;
        toast('设置已保存，立即生效');
        await refreshPrompts();
        render();
      } catch (error) { toast(error.message, true); }
    });
    const reloadSettings = $('#reloadSettings');
    if (reloadSettings) reloadSettings.addEventListener('click', loadSettings);
    const testAlertNotification = $('#testAlertNotification');
    if (testAlertNotification) testAlertNotification.addEventListener('click', async () => {
      testAlertNotification.disabled = true;
      try { await api('/api/alert-notifications/test', { method: 'POST', body: {} }); toast('测试通知已提交'); }
      catch (error) { toast(error.message, true); }
      finally { testAlertNotification.disabled = false; }
    });
  }

  // 表格与时间线里的委托事件
  document.addEventListener('click', async event => {
    const logDetail = event.target.closest('[data-log-detail]');
    if (logDetail) {
      await openLogDetail(logDetail.dataset.logDetail);
      return;
    }
    const drillButton = event.target.closest('[data-alert-drill]');
    if (drillButton) {
      state.logDays = Number(drillButton.dataset.alertDays) || 7;
      state.logFilter = { ok: drillButton.dataset.alertOk || 'all', model: '', prompt: drillButton.dataset.alertPrompt || '', role: '', minLatency: 0 };
      await navigate('logs');
      return;
    }
    const alertButton = event.target.closest('[data-alert-ack]');
    if (alertButton) {
      alertButton.disabled = true;
      try { await api(`/api/alerts/${encodeURIComponent(alertButton.dataset.alertAck)}/ack`, { method: 'POST', body: {} }); toast('告警已确认'); await loadLogs(); }
      catch (error) { alertButton.disabled = false; toast(error.message, true); }
      return;
    }
    const templateButton = event.target.closest('[data-template-create]');
    if (templateButton) {
      try { const data = await api(`/api/templates/${encodeURIComponent(templateButton.dataset.templateCreate)}/create`, { method: 'POST', body: {} }); closeDrawer(); await refreshPrompts(); render(); toast(`已创建草稿：${data.prompt.name}`); } catch (error) { toast(error.message, true); }
      return;
    }
    const templateArchive = event.target.closest('[data-template-archive]');
    if (templateArchive) {
      try { await api(`/api/templates/${encodeURIComponent(templateArchive.dataset.templateArchive)}/archive`, { method: 'POST', body: { archived: templateArchive.dataset.archived === 'true' } }); toast(templateArchive.dataset.archived === 'true' ? '模板已归档' : '模板已恢复'); $('#openTemplates')?.click(); } catch (error) { toast(error.message, true); }
      return;
    }
    const templateEdit = event.target.closest('[data-template-edit]');
    if (templateEdit) {
      const template = state.templates.find(item => item.id === templateEdit.dataset.templateEdit);
      if (!template) return;
      openDrawer(`<div class="drawer-head"><div><h2>编辑模板</h2><p>修改只影响后续从模板创建的草稿。</p></div><button class="close" data-act="close-drawer">×</button></div><form id="templateEditForm"><div class="field"><label>模板名称</label><input id="te-name" value="${escapeHtml(template.name)}" required /></div><div class="field"><label>分类</label><select id="te-category">${['通用', 'JD 分析', '证据校验', '匹配分析', '面试准备', '其他'].map(x => `<option${template.category === x ? ' selected' : ''}>${x}</option>`).join('')}</select></div><div class="field"><label>标签（顿号或逗号分隔）</label><input id="te-tags" value="${escapeHtml((template.tags || []).join('、'))}" /></div><div class="field"><label>用途说明</label><textarea id="te-desc">${escapeHtml(template.desc || '')}</textarea></div><div class="field"><label>模板内容</label><textarea id="te-content" style="min-height:260px" required>${escapeHtml(template.content || '')}</textarea><span class="hint">允许变量：{{role}}、{{jd}}、{{resume}}、{{industry}}、{{company}}、{{stage}}、{{extra}}</span></div><div class="drawer-actions"><button type="button" class="secondary" data-act="close-drawer">取消</button><button class="primary" type="submit">保存模板</button></div></form>`, true);
      $('#templateEditForm').addEventListener('submit', async formEvent => {
        formEvent.preventDefault();
        const tags = $('#te-tags').value.split(/[、,，]/).map(item => item.trim()).filter(Boolean);
        try { await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'PUT', body: { name: $('#te-name').value.trim(), category: $('#te-category').value, tags, desc: $('#te-desc').value.trim(), content: $('#te-content').value } }); closeDrawer(); toast('模板已保存'); } catch (error) { toast(error.message, true); }
      });
      return;
    }
    const templateHistory = event.target.closest('[data-template-history]');
    if (templateHistory) {
      try { const data = await api(`/api/templates/${encodeURIComponent(templateHistory.dataset.templateHistory)}/versions`); openDrawer(`<div class="drawer-head"><div><h2>模板版本</h2><p>回滚会生成新版本，历史不会删除。</p></div><button class="close" data-act="close-drawer">×</button></div><div class="vlist">${data.items.length ? data.items.map(item => `<div class="vrow"><div class="vmeta"><div class="vver">${escapeHtml(item.version)}</div><div>${fullTime(item.at)} · ${escapeHtml(item.actor || '')}</div></div><button class="iconbtn" data-template-rollback="${escapeHtml(templateHistory.dataset.templateHistory)}" data-version-id="${escapeHtml(item.id)}">恢复此版本</button></div>`).join('') : '<div class="empty">该模板尚无编辑版本</div>'}</div>`, true); } catch (error) { toast(error.message, true); }
      return;
    }
    const templateRollback = event.target.closest('[data-template-rollback]');
    if (templateRollback) {
      try { await api(`/api/templates/${encodeURIComponent(templateRollback.dataset.templateRollback)}/rollback`, { method: 'POST', body: { versionId: templateRollback.dataset.versionId } }); closeDrawer(); toast('模板版本已恢复'); } catch (error) { toast(error.message, true); }
      return;
    }
    const target = event.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;

    if (act === 'close-drawer') { closeDrawer(); return; }

    if (act === 'edit' || act === 'history') {
      event.preventDefault();
      const id = target.dataset.id;
      if (act === 'history') return void openHistory(id);
      try {
        const data = await api(`/api/prompts/${id}`);
        openDrawer(editorHtml(data.prompt));
        bindEditor(data.prompt);
      } catch (error) { toast(error.message, true); }
      return;
    }

    if (act === 'open-versions') {
      event.preventDefault();
      return void openHistory(target.dataset.id);
    }

    if (act === 'release-comparison') {
      event.preventDefault();
      return void openReleaseComparison(target.dataset.id, target.dataset.version);
    }

    if (act === 'release-checklist') {
      event.preventDefault();
      return void openReleaseChecklist(target.dataset.id);
    }

    if (act === 'canary-start' || act === 'canary-stop' || act === 'canary-promote' || act === 'canary-traffic') {
      const id = target.dataset.id;
      try {
        if (act === 'canary-start') {
          const value = window.prompt('灰度流量百分比（1-100）', '10');
          if (value === null) return;
          await api(`/api/prompts/${encodeURIComponent(id)}/canary/start`, { method: 'POST', body: { trafficPercent: Number(value) } });
          toast('灰度已启动');
        } else if (act === 'canary-stop') {
          if (!window.confirm('确认停止灰度？生产版本不会变化。')) return;
          await api(`/api/prompts/${encodeURIComponent(id)}/canary/stop`, { method: 'POST', body: { reason: '管理员停止灰度' } });
          toast('灰度已停止');
        } else if (act === 'canary-promote') {
          if (!window.confirm('确认将灰度版本全量发布到生产？')) return;
          const data = await api(`/api/prompts/${encodeURIComponent(id)}/canary/promote`, { method: 'POST', body: { note: '灰度验证通过，全量发布' } });
          toast(`已全量发布 ${data.prompt.publishedVersion}`);
        } else {
          const value = window.prompt('新的灰度流量百分比（1-100）', '10');
          if (value === null) return;
          await api(`/api/prompts/${encodeURIComponent(id)}/canary/traffic`, { method: 'PUT', body: { trafficPercent: Number(value) } });
          toast('灰度流量已调整');
        }
        await refreshPrompts();
        render();
      } catch (error) { toast(error.message, true); }
      return;
    }

    if (act === 'toggle') {
      try {
        await api(`/api/prompts/${target.dataset.id}/toggle`, {
          method: 'POST',
          body: { enabled: target.dataset.enabled === 'true', actor: '管理员' }
        });
        await refreshPrompts();
        renderRows();
        toast(target.dataset.enabled === 'true' ? '启用状态已保存为草稿，发布后生效' : '停用状态已保存为草稿，发布后生效');
      } catch (error) { toast(error.message, true); }
      return;
    }

    if (act === 'submit-review' || act === 'reject-review' || act === 'publish') {
      const labels = { 'submit-review': '提交审核', 'reject-review': '驳回为草稿', publish: '发布到生产' };
      const note = act === 'reject-review' ? window.prompt('请输入驳回理由（必填）', '') : labels[act];
      if (act === 'reject-review' && !String(note || '').trim()) { toast('驳回审核必须填写理由', true); return; }
      if (!window.confirm(`确认${labels[act]}？`)) return;
      try {
        const data = await api(`/api/prompts/${target.dataset.id}/${act}`, {
          method: 'POST', body: { actor: '管理员', note: String(note || '').trim() }
        });
        await refreshPrompts();
        render();
        const message = act === 'publish'
          ? `已发布生产版本 ${data.prompt.publishedVersion}`
          : act === 'submit-review' ? '已提交审核，生产版本未变化' : '已驳回为草稿';
        toast(message);
      } catch (error) { toast(error.message, true); }
    }
  });

  $('#drawer').addEventListener('click', event => { if (event.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawer(); });

  $$('#nav button').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.route)));

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); }
    finally { renderLogin('已安全退出'); }
  });

  /* ---------- 启动 ---------- */

  async function loadAuthenticatedApp() {
    setNav(state.route);
    try {
      await refreshPrompts();
      render();
      renderRows();

      const overview = state.overview;
      if (overview) {
        const changesBtn = $('#nav button[data-route="changes"]');
        if (changesBtn) changesBtn.innerHTML = `<i>◷</i><span>变更记录</span><span class="badge">${overview.changes7d}</span>`;
      }
    } catch (error) {
      showConnError(`无法连接到管理接口：${error.message}。请通过 node server.js 启动后访问 /admin。`);
      $('#page').innerHTML = loading('数据加载失败');
    }
  }

  (async function start() {
    try {
      const status = await api('/api/auth/status');
      if (!status.authenticated) return renderLogin();
      state.auth = status.user;
      updateAccount();
      await loadAuthenticatedApp();
    } catch (error) {
      renderLogin(`鉴权服务不可用：${error.message}`);
    }
  })();
})();
