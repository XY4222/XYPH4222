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
    logs: [],
    logStats: null,
    logDays: 7,
    logFilter: { ok: 'all', model: '', prompt: '', role: '', minLatency: 0 },
    settings: null,
    testCases: [],
    testRuns: [],
    regressionRuns: [],
    feedback: [],
    feedbackStats: null,
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

  const ROUTE_TITLE = { prompts: 'Prompt 总览', releases: '发布中心', tests: 'Prompt 测试台', changes: '变更记录', logs: '运行日志', feedback: '质量反馈', rules: '风险规则', dependencies: '流程依赖', settings: '项目设置' };

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
      if (route === 'changes') await loadChanges();
      else if (route === 'logs') await loadLogs();
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
    if (state.route === 'prompts') page.innerHTML = viewPrompts();
    else if (state.route === 'releases') page.innerHTML = viewReleases();
    else if (state.route === 'tests') page.innerHTML = viewTests();
    else if (state.route === 'changes') page.innerHTML = viewChanges();
    else if (state.route === 'logs') page.innerHTML = viewLogs();
    else if (state.route === 'feedback') page.innerHTML = viewFeedback();
    else if (state.route === 'rules') page.innerHTML = viewRules();
    else if (state.route === 'dependencies') page.innerHTML = viewDependencies();
    else page.innerHTML = viewSettings();
    bindView();
    // viewPrompts() 只铺出空表格骨架，行要靠 renderRows 填。切走再切回来时
    // navigate() 因为 state.overview 已存在不会重新拉数据，这里不补一次，
    // 表格就会一直是空的（筛选、停留、往返都会踩到）。
    if (state.route === 'prompts') renderRows();
  }

  function loading(text) { return `<div class="panel"><div class="loading">${escapeHtml(text || '加载中…')}</div></div>`; }

  function viewFeedback() {
    const s = state.feedbackStats || { total: 0, good: 0, bad: 0, positiveRate: 0, open: 0, resolved: 0, byTag: [] };
    const rows = state.feedback.map(item => `<tr><td class="prompt-meta">${fullTime(item.updatedAt)}</td><td>${tag(item.rating === 'good' ? '有效' : '需改进', item.rating === 'good' ? 'green' : 'red')}</td><td>${tag(item.status, item.status === 'resolved' ? 'green' : item.status === 'open' ? 'amber' : 'blue')}</td><td>${escapeHtml(item.role || '-')}</td><td>${escapeHtml((item.prompts || []).join('、') || '-')}</td><td>${escapeHtml((item.promptVersions || []).map(version => `${version.name}@${version.version}`).join('、') || '-')}</td><td>${escapeHtml((item.tags || []).join('、') || '-')}</td><td>${escapeHtml(item.comment || '-')}</td><td>${can('editor') ? `<select class="filter" data-feedback-status="${item.id}">${['open','reviewing','resolved','dismissed'].map(status => `<option value="${status}"${status === item.status ? ' selected' : ''}>${status}</option>`).join('')}</select>` : tag(item.owner || '未分派')}</td></tr>`).join('');
    return `<div class="headline"><div><h1>质量反馈</h1><p>只记录运行元数据与人工评价，不复制 JD 或简历原文。</p></div><button class="secondary" id="reloadFeedback">刷新</button></div>
      ${can('editor') ? `<section class="panel"><div class="panel-head"><div><h2>新增反馈</h2><p>从运行日志的 ID 关联请求；不要粘贴 JD 或简历原文</p></div></div><div style="padding:18px"><div class="grid2"><div class="field"><label>运行记录 ID</label><input id="feedback-logId" placeholder="例如：mabc123-x7k9" /></div><div class="field"><label>评价</label><select id="feedback-rating"><option value="bad">需改进</option><option value="good">有效</option></select></div><div class="field"><label>问题标签</label><input id="feedback-tags" placeholder="例如：事实错误、结构不完整、格式问题" /></div><div class="field"><label>负责人</label><input id="feedback-owner" /></div></div><div class="field"><label>备注</label><textarea id="feedback-comment" style="min-height:90px" placeholder="记录可复现的问题和改进方向"></textarea></div><div style="display:flex;justify-content:flex-end"><button class="primary" id="saveFeedback">保存反馈</button></div></div></section>` : ''}
      <section class="stats"><div class="stat"><label>反馈总数</label><strong>${s.total}</strong><small>有效 ${s.good} · 需改进 ${s.bad}</small></div><div class="stat"><label>正向率</label><strong>${s.positiveRate}%</strong><small>基于人工反馈</small></div><div class="stat"><label>待处理</label><strong>${s.open}</strong><small>开放或审查中</small></div><div class="stat"><label>已解决</label><strong>${s.resolved}</strong><small>已闭环反馈</small></div></section>
      <section class="panel"><div class="panel-head"><div><h2>反馈明细</h2><p>通过运行记录 ID 关联具体请求，并保留实际生效 Prompt 版本</p></div></div>${rows ? `<table class="table"><thead><tr><th>更新时间</th><th>评价</th><th>状态</th><th>岗位</th><th>Prompt</th><th>生效版本</th><th>问题标签</th><th>备注</th><th>处理状态</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">暂无质量反馈</div>'}</section>`;
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
        actions = can('editor') ? `<button class="iconbtn" data-act="edit" data-id="${p.id}">编辑</button><button class="iconbtn" data-act="submit-review" data-id="${p.id}">提交审核</button>` : '<span class="prompt-meta">等待编辑者提交</span>';
      } else if (p.releaseStatus === 'review') {
        actions = can('admin') ? `<button class="iconbtn" data-act="reject-review" data-id="${p.id}">驳回</button><button class="primary" style="padding:6px 10px" data-act="publish" data-id="${p.id}">发布生产</button>` : '<span class="prompt-meta">等待管理员审核</span>';
      }
      return `<tr>
        <td><div class="prompt-name">${escapeHtml(p.name)}</div><div class="prompt-meta">${escapeHtml(p.desc || '')}</div></td>
        <td>${status}</td>
        <td><span class="version">${escapeHtml(p.version)}</span></td>
        <td><span class="version">${escapeHtml(p.publishedVersion || '未发布')}</span></td>
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
      <div class="panel-head"><div><h2>版本发布队列</h2><p>所有发布和回滚都会写入变更记录</p></div></div>
      <table class="table"><thead><tr><th>Prompt</th><th>状态</th><th>工作版本</th><th>生产版本</th><th>最近发布</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }

  /* ---------- 视图：变更记录 ---------- */

  function viewChanges() {
    if (!state.changes.length) return `<div class="headline"><div><h1>变更记录</h1><p>所有 Prompt 与运行参数的修改轨迹。</p></div></div>${loading('暂无变更记录')}`;
    const items = state.changes.map(v => {
      const snap = v.snapshot || {};
      const detail = v.action === 'update' || v.action === 'create'
        ? `<div class="tl-note">版本 ${escapeHtml(v.version)} · ${escapeHtml(String(snap.content || '').slice(0, 90))}${String(snap.content || '').length > 90 ? '…' : ''}</div>`
        : v.note ? `<div class="tl-note">${escapeHtml(v.note)}</div>` : '';
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
    return `
      <div class="headline"><div><h1>变更记录</h1><p>所有 Prompt 与运行参数的修改轨迹，按时间倒序。</p></div>
        <button class="secondary" id="reloadChanges">刷新</button></div>
      <section class="panel"><div class="inner" style="padding:20px 18px"><div class="timeline">${items}</div></div></section>`;
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
        <td class="prompt-meta">${notes.join('') || '—'}</td>
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
            <div class="field"><label>日志保留天数（1–365）</label><input id="s-logRetentionDays" type="number" min="1" max="365" value="${s.logRetentionDays}" /></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:6px">
            <button class="secondary" id="reloadSettings">放弃修改</button>
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
      const data = await api('/api/changes?limit=120');
      state.changes = data.items;
      render();
    } catch (error) { showConnError(`变更记录加载失败：${error.message}`); }
  }

  async function loadLogs() {
    try {
      const params = new URLSearchParams({ days: String(state.logDays), limit: '200' });
      if (state.logFilter.ok !== 'all') params.set('ok', state.logFilter.ok);
      ['model', 'prompt', 'role'].forEach(key => { if (state.logFilter[key]) params.set(key, state.logFilter[key]); });
      if (state.logFilter.minLatency) params.set('minLatency', String(state.logFilter.minLatency));
      const [stats, logs] = await Promise.all([api(`/api/logs/stats?${params}`), api(`/api/logs?${params}`)]);
      state.logStats = stats;
      state.logs = logs.items;
      render();
    } catch (error) { showConnError(`运行日志加载失败：${error.message}`); }
  }

  async function loadFeedback() {
    try {
      const data = await api('/api/feedback?limit=200');
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

    // 运行日志
    const logDays = $('#logDays');
    if (logDays) logDays.addEventListener('change', () => { state.logDays = Number(logDays.value); loadLogs(); });
    const reloadLogs = $('#reloadLogs');
    if (reloadLogs) reloadLogs.addEventListener('click', loadLogs);
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

    const reloadFeedback = $('#reloadFeedback');
    if (reloadFeedback) reloadFeedback.addEventListener('click', loadFeedback);
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
      ['model', 'temperature', 'maxTokens', 'timeoutMs', 'retries', 'promptMaxChars', 'promptMaxCount', 'inputPricePerM', 'outputPricePerM', 'logRetentionDays'].forEach(key => {
        payload[key] = $('#s-' + key).value;
      });
      payload.analyzeEnabled = $('#s-analyzeEnabled').value === 'true';
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
  }

  // 表格与时间线里的委托事件
  document.addEventListener('click', async event => {
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
      if (!window.confirm(`确认${labels[act]}？`)) return;
      try {
        const data = await api(`/api/prompts/${target.dataset.id}/${act}`, {
          method: 'POST', body: { actor: '管理员', note: labels[act] }
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
