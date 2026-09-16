const fs = require('fs');
const path = require('path');

/**
 * 服务端持久化层。
 *
 * data/prompts.json   —— Prompt 工作副本与已发布快照（唯一事实来源）
 * data/versions.json  —— 不可变版本快照，每次保存/启停/回滚追加一条
 * data/settings.json  —— 运行参数（模型、温度、超时、重试、单价、截断上限）
 * data/logs.jsonl     —— 每次 /api/analyze 调用一行，追加写入
 *
 * 原则：版本快照只追加、不覆盖。回滚是「以旧内容生成一个新版本」，不是删除历史。
 */

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  prompts: path.join(DATA_DIR, 'prompts.json'),
  versions: path.join(DATA_DIR, 'versions.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  logs: path.join(DATA_DIR, 'logs.jsonl')
};

const LOG_LIMIT = 5000;
const MAX_TEXT = 60000;

const DEFAULT_SETTINGS = {
  model: 'deepseek-v4-flash',
  temperature: 0.2,
  maxTokens: 6000,
  timeoutMs: 55000,
  retries: 2,
  analyzeEnabled: true,
  promptMaxChars: 4000,
  promptMaxCount: 20,
  inputPricePerM: 2,
  outputPricePerM: 8,
  logRetentionDays: 30
};

const SEED = [
  { id: 1, stepKey: 'input', step: 1, name: '输入材料校验', type: 'system', desc: '检查 JD、简历与补充信息是否足以分析', enabled: true, version: 'v1.0', content: '检查目标岗位、JD、原始简历和补充信息。明确指出缺失或互相矛盾的信息；不要把缺失信息推断为事实。输出仍须继续完成，但所有缺口必须标记为【待补充】或【待确认】。' },
  { id: 2, stepKey: 'jd', step: 2, name: 'JD 解析', type: 'task', desc: '提取职责、要求、关键词与理想候选人画像', enabled: true, version: 'v1.0', content: '区分 JD 明示要求与合理推断。提取核心职责、硬性要求、隐性要求、高频关键词和最重要的能力。隐性要求不得伪装成 JD 原文。' },
  { id: 3, stepKey: 'diagnosis', step: 3, name: '简历诊断', type: 'task', desc: '评估匹配度、结构、证据与可信度', enabled: true, version: 'v1.0', content: '从岗位相关性、专业能力、目标领域证据、成果量化、关键词覆盖和面试可信度六个维度诊断。评分必须说明加分项、扣分项和证据边界，不制造虚假精确性。' },
  { id: 4, stepKey: 'match', step: 4, name: '匹配分析', type: 'task', desc: '建立 JD 要求与简历证据的逐项映射', enabled: true, version: 'v1.0', content: '逐条输出 JD 要求、简历已有证据、证据强度、是否需要补充和优化建议。没有对应经历时明确写“无”，不得用措辞掩盖缺口。' },
  { id: 5, stepKey: 'questions', step: 5, name: '经历追问', type: 'task', desc: '针对证据缺口生成高价值追问', enabled: true, version: 'v1.0', content: '生成 5–10 个具体追问，优先追问项目背景、个人职责、关键动作、交付结果、数据口径、统计周期和协作范围。问题必须引用对应经历，避免泛泛提问。' },
  { id: 6, stepKey: 'optimize', step: 6, name: '简历优化', type: 'task', desc: '生成修改对照与完整优化版简历', enabled: true, version: 'v1.0', content: '按“动作+对象+方法+结果”重构表达，输出修改前、修改后、修改理由和风险提示。无数据时写可验证的过程结果或【待补充】，不得捏造百分比、规模或职责。' },
  { id: 7, stepKey: 'interview', step: 7, name: '面试准备', type: 'task', desc: '生成追问、证据清单、风险与自我介绍', enabled: true, version: 'v1.0', content: '生成恰好 10 个高概率追问，并列出需要准备的证据、可能夸大的表达、建议补充的数据和 60 秒自我介绍。回答框架不得替候选人虚构答案。' },
  { id: 8, stepKey: 'export', step: 8, name: '导出结果规范', type: 'system', desc: '约束最终简历结构和交付完整性', enabled: true, version: 'v1.0', content: '最终简历必须包含个人信息、求职意向、职业摘要、核心能力、工作经历、项目经历、技能工具和教育背景。未知个人信息保留占位符；不得遗留未解释的夸张表述。' }
];

/* ---------- 基础读写 ---------- */

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILES.prompts)) {
    const now = new Date().toISOString();
    const prompts = SEED.map(p => ({
      ...p, createdAt: now, updatedAt: now, updatedLabel: '系统预置', revision: 1,
      releaseStatus: 'published', publishedVersion: p.version, publishedAt: now, publishedBy: '系统预置',
      publishedSnapshot: snapshotOf(p), reviewNote: ''
    }));
    writeJson(FILES.prompts, prompts);
    writeJson(FILES.versions, prompts.map(p => ({
      vid: `p${p.id}-v1.0`, promptId: p.id, version: p.version, action: 'seed', actor: '系统预置', at: now,
      snapshot: snapshotOf(p), note: '初始化种子 Prompt'
    })));
  }
  if (!fs.existsSync(FILES.settings)) writeJson(FILES.settings, DEFAULT_SETTINGS);
  if (!fs.existsSync(FILES.versions)) writeJson(FILES.versions, []);
  if (!fs.existsSync(FILES.logs)) fs.writeFileSync(FILES.logs, '', 'utf8');

  // 兼容旧数据：升级前的每条记录都等同于已经在线生效的生产版本。
  const existing = readJson(FILES.prompts, []);
  let migrated = false;
  const normalized = existing.map(prompt => {
    if (prompt.releaseStatus && Object.prototype.hasOwnProperty.call(prompt, 'publishedSnapshot')) return prompt;
    migrated = true;
    return {
      ...prompt,
      releaseStatus: 'published',
      publishedVersion: prompt.version,
      publishedAt: prompt.updatedAt || prompt.createdAt || new Date().toISOString(),
      publishedBy: prompt.updatedLabel || '系统迁移',
      publishedSnapshot: snapshotOf(prompt),
      reviewNote: ''
    };
  });
  if (migrated) writeJson(FILES.prompts, normalized);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[store] 读取 ${path.basename(file)} 失败：${error.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------- 工具 ---------- */

function snapshotOf(p) {
  return {
    name: p.name, type: p.type, desc: p.desc, content: p.content,
    enabled: !!p.enabled, step: p.step ?? null, stepKey: p.stepKey || 'extension'
  };
}

function bumpVersion(version) {
  const n = parseFloat(String(version || 'v1.0').replace(/^v/i, ''));
  return 'v' + ((Number.isFinite(n) ? n : 1) + 0.1).toFixed(1);
}

function clip(value, max = MAX_TEXT) {
  return String(value ?? '').slice(0, max);
}

function pushVersion(prompt, action, actor, note) {
  const versions = readJson(FILES.versions, []);
  versions.push({
    vid: `p${prompt.id}-${prompt.version}-${Date.now().toString(36)}`,
    promptId: prompt.id, version: prompt.version, action, actor: actor || '管理员',
    at: new Date().toISOString(), snapshot: snapshotOf(prompt), note: note || '',
    releaseStatus: prompt.releaseStatus || 'draft', publishedVersion: prompt.publishedVersion || null
  });
  writeJson(FILES.versions, versions);
}

/* ---------- Prompt ---------- */

function getPrompts() {
  return readJson(FILES.prompts, []);
}

function getPrompt(id) {
  return getPrompts().find(p => String(p.id) === String(id)) || null;
}

/**
 * 列表页摘要：不回传正文，避免每次都把几千字 Prompt 拉一遍。
 * 单条读写接口（getPrompt / create / update / rollback）返回完整对象，正文照给。
 */
function summarize(p) {
  const { content, ...rest } = p;
  return {
    ...rest,
    contentPreview: String(content || '').slice(0, 120),
    contentLength: String(content || '').length
  };
}

/** 单条接口返回完整对象：编辑抽屉、版本对比都需要正文。 */
function detail(p) {
  return p ? { ...p, contentLength: String(p.content || '').length } : null;
}

function listPrompts() {
  return getPrompts().map(summarize);
}

/**
 * 列表页的筛选在服务端完成：正文不随列表回传，但仍需参与关键词匹配。
 * status: all | on | off；type: all | system | task
 */
function queryPrompts({ q = '', status = 'all', type = 'all' } = {}) {
  const needle = String(q).trim().toLowerCase();
  return getPrompts()
    .filter(p => !needle || [p.name, p.desc, p.content].join(' ').toLowerCase().includes(needle))
    .filter(p => status === 'all' || (status === 'on' ? p.enabled : !p.enabled))
    .filter(p => type === 'all' || p.type === type)
    .map(summarize);
}

function createPrompt(input, actor) {
  const prompts = getPrompts();
  const now = new Date().toISOString();
  const stepRaw = input.step === null || input.step === undefined || input.step === '' ? null : Number(input.step);
  const prompt = {
    id: Date.now(),
    stepKey: clip(input.stepKey || 'extension', 40) || 'extension',
    step: Number.isFinite(stepRaw) && stepRaw >= 1 && stepRaw <= 8 ? stepRaw : null,
    name: clip(input.name, 80) || '未命名 Prompt',
    type: input.type === 'system' ? 'system' : 'task',
    desc: clip(input.desc, 200),
    content: clip(input.content),
    enabled: input.enabled !== false,
    version: 'v1.0',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    updatedLabel: '刚刚',
    releaseStatus: 'draft',
    publishedVersion: null,
    publishedAt: null,
    publishedBy: null,
    publishedSnapshot: null,
    reviewNote: ''
  };
  prompts.push(prompt);
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'create', actor, input.note);
  return detail(prompt);
}

function updatePrompt(id, input, actor) {
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;

  const before = snapshotOf(prompt);
  const stepRaw = input.step === null || input.step === undefined || input.step === '' ? null : Number(input.step);

  if (input.name !== undefined) prompt.name = clip(input.name, 80) || prompt.name;
  if (input.type !== undefined) prompt.type = input.type === 'system' ? 'system' : 'task';
  if (input.desc !== undefined) prompt.desc = clip(input.desc, 200);
  if (input.content !== undefined) prompt.content = clip(input.content);
  if (input.enabled !== undefined) prompt.enabled = !!input.enabled;
  if (input.step !== undefined) prompt.step = Number.isFinite(stepRaw) && stepRaw >= 1 && stepRaw <= 8 ? stepRaw : null;
  if (input.stepKey !== undefined) prompt.stepKey = clip(input.stepKey || 'extension', 40) || 'extension';

  const contentChanged = before.content !== prompt.content;
  const metaChanged = before.name !== prompt.name || before.desc !== prompt.desc || before.type !== prompt.type;
  const scopeChanged = before.step !== prompt.step || before.stepKey !== prompt.stepKey;

  if (contentChanged || metaChanged || scopeChanged) {
    prompt.version = bumpVersion(prompt.version);
    prompt.revision = (prompt.revision || 1) + 1;
    prompt.updatedAt = new Date().toISOString();
    prompt.updatedLabel = '刚刚';
    prompt.releaseStatus = 'draft';
    prompt.reviewNote = '';
  } else if (before.enabled !== prompt.enabled) {
    prompt.updatedAt = new Date().toISOString();
    prompt.updatedLabel = '刚刚';
    prompt.releaseStatus = 'draft';
    prompt.reviewNote = '';
  }

  writeJson(FILES.prompts, prompts);

  const action = contentChanged ? 'update' : scopeChanged ? 'scope' : metaChanged ? 'meta' : 'status';
  if (action !== 'status' || before.enabled !== prompt.enabled) {
    pushVersion(prompt, action, actor, input.note);
  }
  return detail(prompt);
}

function setEnabled(id, enabled, actor) {
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;
  if (prompt.enabled === !!enabled) return detail(prompt);
  prompt.enabled = !!enabled;
  prompt.version = bumpVersion(prompt.version);
  prompt.revision = (prompt.revision || 1) + 1;
  prompt.updatedAt = new Date().toISOString();
  prompt.updatedLabel = '刚刚';
  prompt.releaseStatus = 'draft';
  prompt.reviewNote = '';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, enabled ? 'enable' : 'disable', actor, enabled ? '启用' : '停用');
  return detail(prompt);
}

function removePrompt(id, actor) {
  const prompts = getPrompts();
  const index = prompts.findIndex(p => String(p.id) === String(id));
  if (index < 0) return false;
  if (prompts[index].publishedSnapshot && prompts[index].publishedSnapshot.enabled) {
    throw Object.assign(new Error('已在生产启用的 Prompt 不能直接删除，请先停用、审核并发布'), {
      statusCode: 409, code: 'PUBLISHED_PROMPT_DELETE_BLOCKED'
    });
  }
  const [prompt] = prompts.splice(index, 1);
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'delete', actor, '删除 Prompt');
  return true;
}

function rollbackPrompt(id, vid, actor) {
  const versions = readJson(FILES.versions, []);
  const target = versions.find(v => v.vid === vid && String(v.promptId) === String(id));
  if (!target) return null;

  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;

  const fromVersion = prompt.version;
  Object.assign(prompt, target.snapshot);
  prompt.version = bumpVersion(prompt.version);
  prompt.revision = (prompt.revision || 1) + 1;
  prompt.updatedAt = new Date().toISOString();
  prompt.updatedLabel = '刚刚';
  prompt.releaseStatus = 'draft';
  prompt.reviewNote = '';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'rollback', actor, `从 ${fromVersion} 回滚至 ${target.version}`);
  return { prompt: detail(prompt), restoredFrom: target.version, rolledBackFrom: fromVersion };
}

function submitPromptReview(id, input = {}) {
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;
  if (prompt.releaseStatus === 'published') {
    throw Object.assign(new Error('当前没有待审核的草稿'), { statusCode: 409, code: 'NO_DRAFT' });
  }
  prompt.releaseStatus = 'review';
  prompt.reviewNote = clip(input.note, 200);
  prompt.updatedAt = new Date().toISOString();
  prompt.updatedLabel = '刚刚';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'submit_review', input.actor, input.note || '提交审核');
  return detail(prompt);
}

function rejectPromptReview(id, input = {}) {
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;
  if (prompt.releaseStatus !== 'review') {
    throw Object.assign(new Error('只有待审核版本可以驳回'), { statusCode: 409, code: 'NOT_IN_REVIEW' });
  }
  prompt.releaseStatus = 'draft';
  prompt.reviewNote = clip(input.note, 200);
  prompt.updatedAt = new Date().toISOString();
  prompt.updatedLabel = '刚刚';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'reject_review', input.actor, input.note || '审核驳回');
  return detail(prompt);
}

function publishPrompt(id, input = {}) {
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;
  if (prompt.releaseStatus !== 'review') {
    throw Object.assign(new Error('只有待审核版本可以发布'), { statusCode: 409, code: 'NOT_IN_REVIEW' });
  }
  if (!String(prompt.content || '').trim()) {
    throw Object.assign(new Error('Prompt 内容为空，不能发布'), { statusCode: 400, code: 'EMPTY_PROMPT' });
  }
  prompt.publishedSnapshot = snapshotOf(prompt);
  prompt.publishedVersion = prompt.version;
  prompt.publishedAt = new Date().toISOString();
  prompt.publishedBy = clip(input.actor || '管理员', 80);
  prompt.releaseStatus = 'published';
  prompt.reviewNote = clip(input.note, 200);
  prompt.updatedAt = prompt.publishedAt;
  prompt.updatedLabel = '刚刚';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'publish', input.actor, input.note || '发布生产');
  return detail(prompt);
}

function rollbackProduction(id, vid, input = {}) {
  const versions = readJson(FILES.versions, []);
  const target = versions.find(v => v.vid === vid && String(v.promptId) === String(id) && v.snapshot
    && ['seed', 'publish', 'production_rollback'].includes(v.action));
  if (!target) return null;
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;

  const rolledBackFrom = prompt.publishedVersion;
  Object.assign(prompt, target.snapshot);
  prompt.version = bumpVersion(prompt.version);
  prompt.revision = (prompt.revision || 1) + 1;
  prompt.publishedSnapshot = snapshotOf(prompt);
  prompt.publishedVersion = prompt.version;
  prompt.publishedAt = new Date().toISOString();
  prompt.publishedBy = clip(input.actor || '管理员', 80);
  prompt.releaseStatus = 'published';
  prompt.reviewNote = clip(input.note, 200);
  prompt.updatedAt = prompt.publishedAt;
  prompt.updatedLabel = '刚刚';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'production_rollback', input.actor, input.note || `生产回滚至 ${target.version}`);
  return { prompt: detail(prompt), restoredFrom: target.version, rolledBackFrom };
}

/* ---------- 版本与变更记录 ---------- */

const ACTION_LABEL = {
  seed: '初始化', create: '新建', update: '修改内容', meta: '修改描述', scope: '调整归属步骤',
  status: '修改状态', enable: '启用', disable: '停用', rollback: '恢复为草稿', delete: '删除',
  submit_review: '提交审核', reject_review: '审核驳回', publish: '发布生产', production_rollback: '生产回滚'
};

function listVersions(promptId, limit = 200) {
  let versions = readJson(FILES.versions, []);
  if (promptId !== undefined && promptId !== null && promptId !== '') {
    versions = versions.filter(v => String(v.promptId) === String(promptId));
  }
  versions.sort((a, b) => new Date(b.at) - new Date(a.at));
  return versions.slice(0, limit).map(v => ({ ...v, actionLabel: ACTION_LABEL[v.action] || v.action }));
}

function getVersion(vid) {
  return readJson(FILES.versions, []).find(v => v.vid === vid) || null;
}

function listChanges(limit = 100) {
  return listVersions(null, limit);
}

function changesInLastDays(days) {
  const since = Date.now() - days * 86400000;
  return readJson(FILES.versions, []).filter(v => new Date(v.at).getTime() >= since).length;
}

/* ---------- 设置 ---------- */

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(FILES.settings, {}) };
}

function saveSettings(patch, actor) {
  const next = { ...getSettings(), ...patch };
  const numeric = {
    temperature: [0, 2], maxTokens: [256, 32000], timeoutMs: [5000, 300000], retries: [0, 5],
    promptMaxChars: [200, 60000], promptMaxCount: [1, 50], inputPricePerM: [0, 10000],
    outputPricePerM: [0, 10000], logRetentionDays: [1, 365]
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    const value = Number(next[key]);
    next[key] = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : DEFAULT_SETTINGS[key];
  }
  next.analyzeEnabled = next.analyzeEnabled !== false;
  next.model = clip(next.model, 60) || DEFAULT_SETTINGS.model;
  writeJson(FILES.settings, next);
  const versions = readJson(FILES.versions, []);
  versions.push({
    vid: `settings-${Date.now().toString(36)}`, promptId: null, version: '-', action: 'settings',
    actor: actor || '管理员', at: new Date().toISOString(), snapshot: next, note: '更新运行参数'
  });
  writeJson(FILES.versions, versions);
  return next;
}

/* ---------- 运行日志 ---------- */

function appendLog(entry) {
  const line = JSON.stringify({ id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, ...entry });
  try {
    fs.appendFileSync(FILES.logs, line + '\n', 'utf8');
  } catch (error) {
    console.error(`[store] 写入日志失败：${error.message}`);
  }
}

function readLogs({ limit = 200, days = 0, ok, code } = {}) {
  const settings = getSettings();
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const raw = fs.existsSync(FILES.logs) ? fs.readFileSync(FILES.logs, 'utf8') : '';
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (since && new Date(entry.at).getTime() < since) continue;
      if (ok !== undefined && !!entry.ok !== ok) continue;
      if (code && entry.code !== code) continue;
      rows.push(entry);
    } catch { /* 跳过损坏行 */ }
  }
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { rows: rows.slice(0, limit), total: rows.length, settings };
}

function pruneLogs() {
  const settings = getSettings();
  const raw = fs.existsSync(FILES.logs) ? fs.readFileSync(FILES.logs, 'utf8') : '';
  let lines = raw.split('\n').filter(l => l.trim());
  const cutoff = Date.now() - settings.logRetentionDays * 86400000;
  lines = lines.filter(line => {
    try { return new Date(JSON.parse(line).at).getTime() >= cutoff; } catch { return false; }
  });
  if (lines.length > LOG_LIMIT) lines = lines.slice(lines.length - LOG_LIMIT);
  fs.writeFileSync(FILES.logs, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  return lines.length;
}

const ERROR_LABEL = {
  MISSING_API_KEY: '未配置 API Key', UPSTREAM_TIMEOUT: '上游超时', EMPTY_MODEL_OUTPUT: '模型返回空内容',
  INVALID_MODEL_JSON: '模型 JSON 不完整', ANALYZE_FAILED: '分析失败', DISABLED: '后台已关闭分析',
  BAD_REQUEST: '请求参数缺失', PAYLOAD_TOO_LARGE: '请求内容过大', RATE_LIMIT: '限流'
};

function costOf(usage, settings) {
  if (!usage) return 0;
  const input = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  return (input / 1e6) * settings.inputPricePerM + (output / 1e6) * settings.outputPricePerM;
}

function logStats(days = 7) {
  const { rows } = readLogs({ limit: Number.MAX_SAFE_INTEGER, days });
  const settings = getSettings();
  const total = rows.length;
  const failed = rows.filter(r => !r.ok).length;
  const successes = rows.filter(r => r.ok);
  const latencies = successes.map(r => r.latencyMs || 0).sort((a, b) => a - b);
  const tokens = rows.reduce((sum, r) => sum + Number(r.usage?.total_tokens || 0), 0);
  const cost = rows.reduce((sum, r) => sum + costOf(r.usage, settings), 0);

  const byDay = {};
  for (const r of rows) {
    const day = String(r.at).slice(0, 10);
    byDay[day] = byDay[day] || { day, total: 0, failed: 0, tokens: 0, cost: 0, latencySum: 0, latencyCount: 0 };
    const bucket = byDay[day];
    bucket.total += 1;
    if (!r.ok) bucket.failed += 1;
    bucket.tokens += Number(r.usage?.total_tokens || 0);
    bucket.cost += costOf(r.usage, settings);
    if (r.ok) { bucket.latencySum += r.latencyMs || 0; bucket.latencyCount += 1; }
  }
  const daily = Object.values(byDay)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(d => ({
      day: d.day, total: d.total, failed: d.failed, tokens: d.tokens,
      cost: Number(d.cost.toFixed(4)),
      avgLatency: d.latencyCount ? Math.round(d.latencySum / d.latencyCount) : 0
    }));

  const byCode = {};
  for (const r of rows) {
    if (r.ok) continue;
    const key = r.code || 'UNKNOWN';
    byCode[key] = byCode[key] || { code: key, label: ERROR_LABEL[key] || key, count: 0 };
    byCode[key].count += 1;
  }

  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;

  return {
    total, failed, successRate: total ? Number(((total - failed) / total * 100).toFixed(1)) : 100,
    avgLatency: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    p95Latency: p95,
    tokens, cost: Number(cost.toFixed(4)),
    truncatedCalls: rows.filter(r => (r.truncated || []).length).length,
    daily, byCode: Object.values(byCode).sort((a, b) => b.count - a.count),
    settings: { inputPricePerM: settings.inputPricePerM, outputPricePerM: settings.outputPricePerM },
    days
  };
}

/* ---------- 供分析链路使用 ---------- */

/**
 * 把启用中的 Prompt 组装成发给模型的附加指令。
 * 同时回传截断信息——之前前端静默截断到 4000 字符且毫无提示，管理员根本不知道尾部丢了。
 */
function buildPromptConfig(settingsOverride) {
  const settings = { ...getSettings(), ...(settingsOverride || {}) };
  const enabled = getPrompts()
    .filter(p => p.publishedSnapshot && p.publishedSnapshot.enabled && String(p.publishedSnapshot.content || '').trim())
    .map(p => ({ ...p, ...p.publishedSnapshot, version: p.publishedVersion || p.version }));
  const sorted = enabled.sort((a, b) => (a.step ?? 99) - (b.step ?? 99) || a.id - b.id);
  const picked = sorted.slice(0, settings.promptMaxCount);
  const truncated = [];

  const config = picked.map(p => {
    const content = String(p.content);
    if (content.length > settings.promptMaxChars) {
      truncated.push({ id: p.id, name: p.name, originalLength: content.length, sentLength: settings.promptMaxChars });
    }
    return {
      step: Number.isFinite(Number(p.step)) && p.step !== null ? Number(p.step) : null,
      stepKey: String(p.stepKey || 'extension').slice(0, 40),
      name: String(p.name || '自定义 Prompt').slice(0, 80),
      content: content.slice(0, settings.promptMaxChars)
    };
  });

  const dropped = sorted.slice(settings.promptMaxCount).map(p => ({ id: p.id, name: p.name }));
  return { config, truncated, dropped, enabledCount: enabled.length };
}

function overview() {
  const prompts = getPrompts();
  const production = prompts
    .filter(p => p.publishedSnapshot)
    .map(p => ({ ...p, ...p.publishedSnapshot }));
  const covered = new Set(production.filter(p => p.enabled && p.step >= 1 && p.step <= 8).map(p => p.step)).size;
  return {
    total: prompts.length,
    enabled: production.filter(p => p.enabled).length,
    workspaceEnabled: prompts.filter(p => p.enabled).length,
    published: prompts.filter(p => p.releaseStatus === 'published').length,
    drafts: prompts.filter(p => p.releaseStatus === 'draft').length,
    reviews: prompts.filter(p => p.releaseStatus === 'review').length,
    changes7d: changesInLastDays(7),
    coverage: covered,
    coverageTotal: 8,
    lastChange: listVersions(null, 1)[0] || null,
    settings: getSettings()
  };
}

ensureData();
pruneLogs();

module.exports = {
  DATA_DIR, FILES, DEFAULT_SETTINGS, ACTION_LABEL, ERROR_LABEL, SEED,
  ensureData, getPrompts, getPrompt, listPrompts, queryPrompts, summarize, detail, createPrompt, updatePrompt, setEnabled,
  removePrompt, rollbackPrompt, submitPromptReview, rejectPromptReview, publishPrompt, rollbackProduction,
  listVersions, getVersion, listChanges, changesInLastDays,
  getSettings, saveSettings, appendLog, readLogs, pruneLogs, logStats, buildPromptConfig,
  overview, costOf, bumpVersion
};
