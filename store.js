const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

/**
 * 服务端持久化层。
 *
 * data/prompts.json   —— Prompt 工作副本与已发布快照（唯一事实来源）
 * data/versions.json  —— 不可变版本快照，每次保存/启停/回滚追加一条
 * data/settings.json  —— 运行参数（模型、温度、超时、重试、单价、截断上限）
 * data/logs.jsonl     —— 每次 /api/analyze 调用一行，追加写入
 * data/test-cases.json —— 管理员显式保存的完整测试输入
 * data/prompt-tests.jsonl —— Prompt 测试运行指标，不保存简历原文
 * data/regressions.jsonl —— 回归门禁运行结果，不保存测试输入原文
 * data/feedback.json —— 调用质量反馈，只保存评价元数据
 * data/rules.json —— 输出风险规则与启停状态
 * data/templates.json —— 可复用 Prompt 模板
 *
 * 原则：版本快照只追加、不覆盖。回滚是「以旧内容生成一个新版本」，不是删除历史。
 */

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  prompts: path.join(DATA_DIR, 'prompts.json'),
  versions: path.join(DATA_DIR, 'versions.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  logs: path.join(DATA_DIR, 'logs.jsonl'),
  testCases: path.join(DATA_DIR, 'test-cases.json'),
  promptTests: path.join(DATA_DIR, 'prompt-tests.jsonl'),
  regressions: path.join(DATA_DIR, 'regressions.jsonl'),
  feedback: path.join(DATA_DIR, 'feedback.json'),
  rules: path.join(DATA_DIR, 'rules.json'),
  templates: path.join(DATA_DIR, 'templates.json'),
  templateVersions: path.join(DATA_DIR, 'template-versions.json'),
  alertAcks: path.join(DATA_DIR, 'alert-ack.json'),
  alertStates: path.join(DATA_DIR, 'alert-states.json'),
  alertNotifications: path.join(DATA_DIR, 'alert-notifications.json')
};

const LOG_LIMIT = 5000;
const MAX_TEXT = 60000;
const TEST_INPUT_MAX = 120000;
const PROMPT_VARIABLES = new Set(['role', 'jd', 'resume', 'industry', 'company', 'stage', 'extra']);

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
  dailyCostBudget: 0,
  logRetentionDays: 30,
  alertFailureRate: 30,
  alertSchemaErrorRate: 10,
  alertRetryRate: 50,
  alertMinCalls: 10,
  alertNotificationsEnabled: false,
  canaryFailureRate: 30,
  canarySchemaErrorRate: 10,
  canaryMinCalls: 10,
  canaryAutoStop: true,
  releaseFreeze: false,
  releaseFreezeReason: ''
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
  if (!fs.existsSync(FILES.testCases)) writeJson(FILES.testCases, []);
  if (!fs.existsSync(FILES.promptTests)) fs.writeFileSync(FILES.promptTests, '', 'utf8');
  if (!fs.existsSync(FILES.regressions)) fs.writeFileSync(FILES.regressions, '', 'utf8');
  if (!fs.existsSync(FILES.feedback)) writeJson(FILES.feedback, []);
  if (!fs.existsSync(FILES.rules)) writeJson(FILES.rules, [
    { id: 'rule-no-fabrication-terms', name: '禁止虚构承诺', type: 'forbidden_pattern', pattern: '虚构|编造|捏造', severity: 'high', enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'rule-review-placeholders', name: '检查未确认占位符', type: 'forbidden_pattern', pattern: '【待补充|【待确认', severity: 'medium', enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ]);
  if (!fs.existsSync(FILES.templates)) writeJson(FILES.templates, [
    { id: 'tpl-evidence-safe', name: '证据边界检查', type: 'task', stepKey: 'diagnosis', step: 3, desc: '强调事实边界、责任范围和待确认信息', content: '围绕 {{role}} 岗位，检查简历中的职责、结果和数字是否有 {{resume}} 中的事实依据。对无法核验的内容标记【待确认】，不得补写。', variables: ['role', 'resume'], version: 'v1.0', category: '证据校验', tags: ['事实边界'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 'tpl-jd-match', name: 'JD 证据映射', type: 'task', stepKey: 'match', step: 4, desc: '将岗位要求映射到候选人证据', content: '将 {{jd}} 的关键要求逐项映射到 {{resume}} 的证据，区分强、中、弱、无，并指出需要补充的事实。', variables: ['jd', 'resume'], version: 'v1.0', category: '匹配分析', tags: ['JD'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ]);
  if (!fs.existsSync(FILES.templateVersions)) writeJson(FILES.templateVersions, []);
  if (!fs.existsSync(FILES.alertAcks)) writeJson(FILES.alertAcks, []);
  if (!fs.existsSync(FILES.alertStates)) writeJson(FILES.alertStates, []);
  if (!fs.existsSync(FILES.alertNotifications)) writeJson(FILES.alertNotifications, []);
  const templates = readJson(FILES.templates, []);
  const templateVersions = readJson(FILES.templateVersions, []);
  let templatesChanged = false; let templateVersionsChanged = false;
  for (const template of templates) {
    if (!template.version) { template.version = 'v1.0'; templatesChanged = true; }
    if (!template.category) { template.category = '其他'; templatesChanged = true; }
    if (!Array.isArray(template.tags)) { template.tags = []; templatesChanged = true; }
    if (!templateVersions.some(item => item.templateId === template.id)) {
      templateVersions.push({ id: `tv-seed-${template.id}`, templateId: template.id, version: template.version, action: 'seed', actor: '系统初始化', at: template.createdAt || new Date().toISOString(), snapshot: { name: template.name, desc: template.desc, content: template.content, category: template.category, tags: template.tags, variables: template.variables || [] } });
      templateVersionsChanged = true;
    }
  }
  if (templatesChanged) writeJson(FILES.templates, templates);
  if (templateVersionsChanged) writeJson(FILES.templateVersions, templateVersions);

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

function validatePromptContent(content) {
  const names = [...String(content || '').matchAll(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g)].map(match => match[1]);
  const unknown = [...new Set(names.filter(name => !PROMPT_VARIABLES.has(name)))];
  if (unknown.length) throw Object.assign(new Error(`Prompt 包含未知变量：${unknown.join('、')}`), { statusCode: 400, code: 'UNKNOWN_PROMPT_VARIABLE' });
  return [...new Set(names)];
}

function listTemplates({ q = '', category, includeArchived = false } = {}) {
  const needle = String(q).trim().toLowerCase();
  return readJson(FILES.templates, [])
    .filter(item => includeArchived || !item.archived)
    .filter(item => !category || item.category === category)
    .filter(item => !needle || [item.name, item.desc, item.content, item.category, ...(item.tags || [])].join(' ').toLowerCase().includes(needle))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function updateTemplate(id, input, actor) {
  const templates = readJson(FILES.templates, []);
  const template = templates.find(item => item.id === id);
  if (!template) return null;
  const nextContent = input.content === undefined ? template.content : clip(input.content);
  if (!String(nextContent || '').trim()) throw Object.assign(new Error('模板内容不能为空'), { statusCode: 400, code: 'EMPTY_TEMPLATE_CONTENT' });
  const variables = validatePromptContent(nextContent);
  const allowedCategories = new Set(['通用', 'JD 分析', '证据校验', '匹配分析', '面试准备', '其他']);
  if (input.name !== undefined) template.name = clip(input.name, 100).trim() || template.name;
  if (input.desc !== undefined) template.desc = clip(input.desc, 300).trim();
  if (input.content !== undefined) template.content = nextContent;
  if (input.category !== undefined) template.category = allowedCategories.has(input.category) ? input.category : '其他';
  if (input.tags !== undefined) template.tags = Array.isArray(input.tags) ? input.tags.map(tag => clip(tag, 40).trim()).filter(Boolean).slice(0, 20) : [];
  template.variables = variables;
  template.version = bumpVersion(template.version || 'v1.0');
  template.updatedAt = new Date().toISOString();
  template.updatedBy = actor;
  pushTemplateVersion(template, actor, 'update');
  pushAuditEvent('template_update', actor, `模板：${template.name}`, `更新 ${template.id}`);
  writeJson(FILES.templates, templates);
  return template;
}

function pushTemplateVersion(template, actor, action) {
  const versions = readJson(FILES.templateVersions, []);
  versions.push({ id: `tv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, templateId: template.id, version: template.version || 'v1.0', action, actor, at: new Date().toISOString(), snapshot: { name: template.name, desc: template.desc, content: template.content, category: template.category || '其他', tags: template.tags || [], variables: template.variables || [] } });
  writeJson(FILES.templateVersions, versions);
}

function listTemplateVersions(id) { return readJson(FILES.templateVersions, []).filter(item => item.templateId === id).sort((a, b) => new Date(b.at) - new Date(a.at)); }

function rollbackTemplate(id, versionId, actor) {
  const templates = readJson(FILES.templates, []);
  const template = templates.find(item => item.id === id);
  const target = listTemplateVersions(id).find(item => item.id === versionId);
  if (!template || !target) return null;
  const previousTemplates = JSON.stringify(templates);
  const previousTemplateVersions = JSON.stringify(readJson(FILES.templateVersions, []));
  const previousVersions = JSON.stringify(readJson(FILES.versions, []));
  const nextTemplate = { ...template, ...target.snapshot };
  nextTemplate.version = bumpVersion(template.version || 'v1.0');
  nextTemplate.updatedAt = new Date().toISOString(); nextTemplate.updatedBy = actor;
  const templateVersions = JSON.parse(previousTemplateVersions);
  templateVersions.push({ id: `tv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, templateId: nextTemplate.id, version: nextTemplate.version, action: 'rollback', actor, at: nextTemplate.updatedAt, snapshot: { name: nextTemplate.name, desc: nextTemplate.desc, content: nextTemplate.content, category: nextTemplate.category || '其他', tags: nextTemplate.tags || [], variables: nextTemplate.variables || [] } });
  const nextTemplates = templates.map(item => item.id === id ? nextTemplate : item);
  const versions = JSON.parse(previousVersions);
  versions.push({ vid: `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, promptId: null, promptName: `模板：${nextTemplate.name}`, version: '-', action: 'template_rollback', actor: actor || '管理员', at: nextTemplate.updatedAt, note: clip(`恢复 ${target.version} 为 ${nextTemplate.version}`, 300) });
  try {
    writeJson(FILES.templates, nextTemplates);
    writeJson(FILES.templateVersions, templateVersions);
    writeJson(FILES.versions, versions);
  } catch (error) {
    // Restore every file touched by this operation so a failed rollback cannot look successful.
    try { writeJson(FILES.templates, JSON.parse(previousTemplates)); } catch {}
    try { writeJson(FILES.templateVersions, JSON.parse(previousTemplateVersions)); } catch {}
    try { writeJson(FILES.versions, JSON.parse(previousVersions)); } catch {}
    throw error;
  }
  return nextTemplate;
}

function archiveTemplate(id, archived, actor) {
  const templates = readJson(FILES.templates, []);
  const template = templates.find(item => item.id === id);
  if (!template) return null;
  template.archived = archived !== false;
  template.archivedAt = template.archived ? new Date().toISOString() : null;
  template.updatedAt = new Date().toISOString(); template.updatedBy = actor;
  pushAuditEvent(template.archived ? 'template_archive' : 'template_restore', actor, `模板：${template.name}`, `${template.archived ? '归档' : '恢复'} ${template.id}`);
  writeJson(FILES.templates, templates);
  return template;
}

function createPromptFromTemplate(templateId, input, actor) {
  const template = listTemplates().find(item => item.id === templateId);
  if (!template) throw Object.assign(new Error('Prompt 模板不存在'), { statusCode: 404, code: 'TEMPLATE_NOT_FOUND' });
  return createPrompt({ ...template, ...input, name: input.name || template.name, content: input.content || template.content, step: input.step === undefined ? template.step : input.step, stepKey: input.stepKey || template.stepKey, type: input.type || template.type, desc: input.desc || template.desc }, actor);
}

function batchPromptAction(ids, action, input, actor) {
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('至少选择一个 Prompt'), { statusCode: 400, code: 'EMPTY_BATCH' });
  const allowed = new Set(['enable', 'disable', 'submit-review']);
  if (!allowed.has(action)) throw Object.assign(new Error('批量操作不支持'), { statusCode: 400, code: 'INVALID_BATCH_ACTION' });
  const results = ids.map(id => {
    try {
      let prompt;
      if (action === 'enable') prompt = setEnabled(id, true, actor);
      else if (action === 'disable') prompt = setEnabled(id, false, actor);
      else prompt = submitPromptReview(id, { ...input, actor });
      if (!prompt) return { id, ok: false, code: 'NOT_FOUND', error: 'Prompt 不存在' };
      return { id, ok: true, prompt: summarize(prompt) };
    } catch (error) { return { id, ok: false, code: error.code || 'BATCH_ITEM_FAILED', error: error.message }; }
  });
  return { action, total: results.length, succeeded: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length, results };
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
  if (rest.canary) rest.canary = canaryView(p);
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

function canaryView(prompt) {
  if (!prompt?.canary) return null;
  const c = prompt.canary;
  return {
    active: true,
    version: c.version,
    trafficPercent: c.trafficPercent,
    startedAt: c.startedAt,
    startedBy: c.startedBy,
    sourceVersion: c.sourceVersion || prompt.publishedVersion,
    stopReason: c.stopReason || null,
    metrics: canaryMetrics(prompt)
  };
}

function canaryMetrics(prompt) {
  const canary = prompt?.canary;
  if (!canary) return { calls: 0, failed: 0, schemaErrors: 0, failureRate: 0, schemaErrorRate: 0 };
  const version = String(canary.version);
  const rows = readLogs({ limit: Number.MAX_SAFE_INTEGER }).rows.filter(row =>
    (row.promptVersions || []).some(item => String(item.name) === String(prompt.name) && String(item.version) === version)
  );
  const failed = rows.filter(row => !row.ok).length;
  const schemaErrors = rows.filter(row => (row.validationErrors || []).length > 0).length;
  return {
    calls: rows.length, failed, schemaErrors,
    failureRate: rows.length ? Number((failed / rows.length * 100).toFixed(1)) : 0,
    schemaErrorRate: rows.length ? Number((schemaErrors / rows.length * 100).toFixed(1)) : 0
  };
}

function startCanary(id, input = {}) {
  assertReleaseOpen();
  const prompts = getPrompts();
  const prompt = prompts.find(item => String(item.id) === String(id));
  if (!prompt) return null;
  if (!prompt.publishedSnapshot) throw Object.assign(new Error('没有生产版本，不能启动灰度'), { statusCode: 409, code: 'NO_PUBLISHED_VERSION' });
  if (prompt.canary) throw Object.assign(new Error('该 Prompt 已存在进行中的灰度'), { statusCode: 409, code: 'CANARY_ALREADY_ACTIVE' });
  if (!String(prompt.content || '').trim()) throw Object.assign(new Error('Prompt 内容为空，不能灰度'), { statusCode: 400, code: 'EMPTY_PROMPT' });
  assertRegressionGate(prompt);
  const trafficPercent = Math.min(Math.max(Number(input.trafficPercent) || 10, 1), 100);
  const now = new Date().toISOString();
  prompt.canary = {
    version: `${prompt.version}-canary`, snapshot: snapshotOf(prompt), trafficPercent,
    startedAt: now, startedBy: clip(input.actor || '管理员', 80), sourceVersion: prompt.publishedVersion
  };
  writeJson(FILES.prompts, prompts);
  pushAuditEvent('canary_start', input.actor, prompt.name, `启动 ${prompt.canary.version}，流量 ${trafficPercent}%`);
  return detail(prompt);
}

function stopCanary(id, input = {}) {
  const prompts = getPrompts();
  const prompt = prompts.find(item => String(item.id) === String(id));
  if (!prompt) return null;
  if (!prompt.canary) throw Object.assign(new Error('该 Prompt 没有进行中的灰度'), { statusCode: 409, code: 'CANARY_NOT_ACTIVE' });
  const version = prompt.canary.version;
  const reason = clip(input.reason || '管理员停止灰度', 200);
  prompt.canary = null;
  writeJson(FILES.prompts, prompts);
  pushAuditEvent('canary_stop', input.actor, prompt.name, `${version}：${reason}`);
  return detail(prompt);
}

function promoteCanary(id, input = {}) {
  assertReleaseOpen();
  const prompts = getPrompts();
  const prompt = prompts.find(item => String(item.id) === String(id));
  if (!prompt) return null;
  if (!prompt.canary) throw Object.assign(new Error('该 Prompt 没有进行中的灰度'), { statusCode: 409, code: 'CANARY_NOT_ACTIVE' });
  const candidate = prompt.canary;
  const now = new Date().toISOString();
  Object.assign(prompt, candidate.snapshot);
  prompt.version = String(candidate.version).replace(/-canary$/, '');
  prompt.publishedSnapshot = { ...candidate.snapshot };
  prompt.publishedVersion = prompt.version;
  prompt.publishedAt = now;
  prompt.publishedBy = clip(input.actor || '管理员', 80);
  prompt.releaseStatus = 'published';
  prompt.reviewNote = clip(input.note, 200);
  prompt.updatedAt = now;
  prompt.updatedLabel = '刚刚';
  prompt.canary = null;
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'publish', input.actor, input.note || `灰度 ${candidate.version} 全量发布`);
  return detail(prompt);
}

function setCanaryTraffic(id, trafficPercent, actor) {
  const prompts = getPrompts();
  const prompt = prompts.find(item => String(item.id) === String(id));
  if (!prompt) return null;
  if (!prompt.canary) throw Object.assign(new Error('该 Prompt 没有进行中的灰度'), { statusCode: 409, code: 'CANARY_NOT_ACTIVE' });
  const value = Math.min(Math.max(Number(trafficPercent) || 0, 1), 100);
  prompt.canary.trafficPercent = value;
  writeJson(FILES.prompts, prompts);
  pushAuditEvent('canary_traffic', actor, prompt.name, `灰度流量调整为 ${value}%`);
  return detail(prompt);
}

function evaluateCanaries() {
  const prompts = getPrompts();
  const settings = getSettings();
  let changed = false;
  for (const prompt of prompts) {
    if (!prompt.canary || settings.canaryAutoStop !== true) continue;
    const metrics = canaryMetrics(prompt);
    if (metrics.calls < Number(settings.canaryMinCalls || 10)) continue;
    const failureLimit = Number(settings.canaryFailureRate || 30);
    const schemaLimit = Number(settings.canarySchemaErrorRate || 10);
    if ((failureLimit > 0 && metrics.failureRate >= failureLimit) || (schemaLimit > 0 && metrics.schemaErrorRate >= schemaLimit)) {
      const reason = `自动熔断：${metrics.calls} 次调用，失败率 ${metrics.failureRate}%，Schema 错误率 ${metrics.schemaErrorRate}%`;
      const version = prompt.canary.version;
      prompt.canary = null;
      pushAuditEvent('canary_auto_stop', '系统', prompt.name, `${version}：${reason}`);
      changed = true;
    }
  }
  if (changed) writeJson(FILES.prompts, prompts);
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
  const content = clip(input.content);
  const variables = validatePromptContent(content);
  const prompt = {
    id: Date.now(),
    stepKey: clip(input.stepKey || 'extension', 40) || 'extension',
    step: Number.isFinite(stepRaw) && stepRaw >= 1 && stepRaw <= 8 ? stepRaw : null,
    name: clip(input.name, 80) || '未命名 Prompt',
    type: input.type === 'system' ? 'system' : 'task',
    desc: clip(input.desc, 200),
    content, variables,
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
  if (input.content !== undefined) prompt.variables = validatePromptContent(clip(input.content));
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
  assertReleaseChecklist(prompt);
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
  const note = clip(input.note, 200).trim();
  if (!note) throw Object.assign(new Error('驳回审核必须填写理由'), { statusCode: 400, code: 'REJECTION_NOTE_REQUIRED' });
  prompt.releaseStatus = 'draft';
  prompt.reviewNote = note;
  prompt.updatedAt = new Date().toISOString();
  prompt.updatedLabel = '刚刚';
  writeJson(FILES.prompts, prompts);
  pushVersion(prompt, 'reject_review', input.actor, note);
  return detail(prompt);
}

function publishPrompt(id, input = {}) {
  assertReleaseOpen();
  const prompts = getPrompts();
  const prompt = prompts.find(p => String(p.id) === String(id));
  if (!prompt) return null;
  if (prompt.releaseStatus !== 'review') {
    throw Object.assign(new Error('只有待审核版本可以发布'), { statusCode: 409, code: 'NOT_IN_REVIEW' });
  }
  if (!String(prompt.content || '').trim()) {
    throw Object.assign(new Error('Prompt 内容为空，不能发布'), { statusCode: 400, code: 'EMPTY_PROMPT' });
  }
  assertReleaseChecklist(prompt);
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
  assertReleaseOpen();
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
  submit_review: '提交审核', reject_review: '审核驳回', publish: '发布生产', production_rollback: '生产回滚',
  test_case_create: '保存测试案例', test_case_delete: '删除测试案例', feedback_update: '更新质量反馈',
  auth_login_failed: '登录失败', auth_login_success: '登录成功', auth_logout: '退出登录',
  template_update: '编辑模板', template_archive: '归档模板', template_restore: '恢复模板', template_rollback: '回滚模板',
  alert_ack: '确认告警', canary_start: '启动灰度', canary_stop: '停止灰度', canary_traffic: '调整灰度流量', canary_auto_stop: '灰度自动熔断'
};

function pushAuditEvent(action, actor, subject, note) {
  const versions = readJson(FILES.versions, []);
  versions.push({
    vid: `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    promptId: null, promptName: subject, version: '-', action,
    actor: actor || '管理员', at: new Date().toISOString(), note: clip(note, 300)
  });
  writeJson(FILES.versions, versions);
}

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

function listChanges(options = {}) {
  const input = typeof options === 'number' ? { limit: options } : options;
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  const page = Math.max(Number(input.page) || 1, 1);
  const action = String(input.action || '').trim();
  const actor = String(input.actor || '').trim().toLowerCase();
  const from = input.from ? new Date(input.from).getTime() : 0;
  const to = input.to ? new Date(input.to).getTime() + 86400000 : 0;
  const all = listVersions(null, Number.MAX_SAFE_INTEGER).filter(item => {
    const at = new Date(item.at).getTime();
    return (!action || item.action === action) && (!actor || String(item.actor || '').toLowerCase().includes(actor)) && (!from || at >= from) && (!to || at < to);
  });
  const items = all.slice((page - 1) * limit, page * limit).map(item => { const { snapshot, ...safe } = item; return safe; });
  return { items, total: all.length, page, limit, pages: Math.max(1, Math.ceil(all.length / limit)) };
}

function changesInLastDays(days) {
  const since = Date.now() - days * 86400000;
  return readJson(FILES.versions, []).filter(v => new Date(v.at).getTime() >= since).length;
}

/* ---------- 设置 ---------- */

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(FILES.settings, {}) };
}

function assertReleaseOpen() {
  const settings = getSettings();
  if (settings.releaseFreeze === true) {
    throw Object.assign(new Error(settings.releaseFreezeReason || '发布已冻结，暂不允许生产变更'), { statusCode: 423, code: 'RELEASE_FROZEN' });
  }
}

function saveSettings(patch, actor) {
  const next = { ...getSettings(), ...patch };
  // 这些字段是服务端运行状态，只读，不能被管理端回写到配置文件。
  delete next.alertWebhookConfigured;
  delete next.notification;
  const numeric = {
    temperature: [0, 2], maxTokens: [256, 32000], timeoutMs: [5000, 300000], retries: [0, 5],
    promptMaxChars: [200, 60000], promptMaxCount: [1, 50], inputPricePerM: [0, 10000],
    outputPricePerM: [0, 10000], dailyCostBudget: [0, 100000], logRetentionDays: [1, 365], alertFailureRate: [0, 100],
    alertSchemaErrorRate: [0, 100], alertRetryRate: [0, 100], alertMinCalls: [1, 10000],
    canaryFailureRate: [0, 100], canarySchemaErrorRate: [0, 100], canaryMinCalls: [1, 10000]
  };
  for (const [key, [min, max]] of Object.entries(numeric)) {
    const value = Number(next[key]);
    next[key] = Number.isFinite(value) ? Math.min(Math.max(value, min), max) : DEFAULT_SETTINGS[key];
  }
  next.analyzeEnabled = next.analyzeEnabled !== false;
  next.alertNotificationsEnabled = next.alertNotificationsEnabled === true || next.alertNotificationsEnabled === 'true';
  next.canaryAutoStop = next.canaryAutoStop !== false && next.canaryAutoStop !== 'false';
  next.releaseFreeze = next.releaseFreeze === true || next.releaseFreeze === 'true';
  next.releaseFreezeReason = clip(next.releaseFreezeReason, 200).trim();
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

const LOG_FIELDS = new Set(['id', 'at', 'model', 'ok', 'code', 'error', 'latencyMs', 'attempts', 'usage', 'cost', 'modelReturned', 'role', 'prompts', 'promptVersions', 'riskHits', 'truncated', 'dropped', 'inputChars', 'validationErrors']);

function appendLog(entry) {
  const safeEntry = {
    at: entry?.at || new Date().toISOString(),
    model: entry?.model || null,
    ok: !!entry?.ok,
    code: entry?.code || null,
    error: entry?.error || null,
    latencyMs: Number(entry?.latencyMs || 0),
    attempts: Number(entry?.attempts || 1),
    usage: entry?.usage && typeof entry.usage === 'object' ? {
      prompt_tokens: Number(entry.usage.prompt_tokens || 0),
      completion_tokens: Number(entry.usage.completion_tokens || 0),
      total_tokens: Number(entry.usage.total_tokens || 0)
    } : null,
    cost: Number(entry?.cost || 0),
    modelReturned: entry?.modelReturned || null,
    role: entry?.role || null,
    prompts: Array.isArray(entry?.prompts) ? entry.prompts.slice(0, 30) : [],
    promptVersions: Array.isArray(entry?.promptVersions) ? entry.promptVersions : [],
    riskHits: Array.isArray(entry?.riskHits) ? entry.riskHits.slice(0, 20) : [],
    truncated: Array.isArray(entry?.truncated) ? entry.truncated.slice(0, 30) : [],
    dropped: Array.isArray(entry?.dropped) ? entry.dropped.slice(0, 30) : [],
    inputChars: Number(entry?.inputChars || 0),
    validationErrors: Array.isArray(entry?.validationErrors) ? entry.validationErrors : []
  };
  safeEntry.promptVersions = Array.isArray(safeEntry.promptVersions)
    ? safeEntry.promptVersions.map(item => ({ name: String(item?.name || '').slice(0, 80), version: String(item?.version || 'unknown').slice(0, 40) })).filter(item => item.name).slice(0, 30)
    : [];
  safeEntry.validationErrors = Array.isArray(safeEntry.validationErrors)
    ? safeEntry.validationErrors.map(item => String(item).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)).filter(Boolean).slice(0, 12)
    : [];
  if (!safeEntry.ok) safeEntry.error = ERROR_LABEL[safeEntry.code] || '调用失败';
  const row = { ...safeEntry, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
  const line = JSON.stringify(row);
  try {
    fs.appendFileSync(FILES.logs, line + '\n', 'utf8');
  } catch (error) {
    console.error(`[store] 写入日志失败：${error.message}`);
  }
  return row.id;
}

function readLogs({ limit = 200, days = 0, ok, code, model, prompt, role, minLatency = 0 } = {}) {
  const settings = getSettings();
  const since = days > 0 ? Date.now() - days * 86400000 : 0;
  const raw = fs.existsSync(FILES.logs) ? fs.readFileSync(FILES.logs, 'utf8') : '';
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      for (const key of Object.keys(entry)) if (!LOG_FIELDS.has(key)) delete entry[key];
      if (!entry.ok) entry.error = ERROR_LABEL[entry.code] || '调用失败';
      if (since && new Date(entry.at).getTime() < since) continue;
      if (ok !== undefined && !!entry.ok !== ok) continue;
      if (code && entry.code !== code) continue;
      if (model && entry.model !== model && entry.modelReturned !== model) continue;
      if (prompt && !(entry.prompts || []).includes(prompt)) continue;
      if (role && !String(entry.role || '').toLowerCase().includes(String(role).toLowerCase())) continue;
      if (Number(minLatency) > 0 && Number(entry.latencyMs || 0) < Number(minLatency)) continue;
      rows.push(entry);
    } catch { /* 跳过损坏行 */ }
  }
  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { rows: rows.slice(0, limit), total: rows.length, settings };
}

function findLog(id) {
  return readLogs({ limit: Number.MAX_SAFE_INTEGER }).rows.find(item => item.id === id) || null;
}

// 任务中心只从运行日志派生安全元数据；输入正文永不进入任务列表。
function listTasks({ page = 1, limit = 50, status, role, days = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const logs = readLogs({ limit: Number.MAX_SAFE_INTEGER, days, role }).rows;
  const retryableCodes = new Set(['RATE_LIMIT', 'UPSTREAM_TIMEOUT', 'MODEL_UNAVAILABLE', 'EMPTY_MODEL_OUTPUT', 'INVALID_MODEL_JSON', 'INVALID_MODEL_SCHEMA', 'ANALYZE_FAILED']);
  const tasks = logs.map(log => ({
    id: String(log.id || ''),
    at: log.at || null,
    status: log.ok ? 'succeeded' : 'failed',
    retryable: !log.ok && retryableCodes.has(log.code),
    code: log.code || null,
    errorLabel: log.code ? (ERROR_LABEL[log.code] || '调用失败') : null,
    role: log.role || null,
    model: log.model || log.modelReturned || null,
    promptVersions: Array.isArray(log.promptVersions) ? log.promptVersions.slice(0, 30) : [],
    latencyMs: Number(log.latencyMs || 0),
    attempts: Number(log.attempts || 1),
    totalTokens: Number(log.usage?.total_tokens || 0),
    cost: Number(log.cost || 0),
    inputChars: Number(log.inputChars || 0)
  })).filter(task => !status || task.status === status);
  const total = tasks.length;
  const start = (safePage - 1) * safeLimit;
  const items = tasks.slice(start, start + safeLimit);
  const summary = { total, succeeded: tasks.filter(task => task.status === 'succeeded').length, failed: tasks.filter(task => task.status === 'failed').length, retryable: tasks.filter(task => task.retryable).length, cost: Number(tasks.reduce((sum, task) => sum + task.cost, 0).toFixed(6)) };
  return { items, total, page: safePage, limit: safeLimit, pages: Math.max(Math.ceil(total / safeLimit), 1), summary };
}

// 日志详情只允许展示可运营的元数据，避免把输入、Prompt 或上游原始错误带回后台。
function safeLogDetail(entry) {
  if (!entry) return null;
  const usage = entry.usage && typeof entry.usage === 'object' ? {
    prompt_tokens: Number(entry.usage.prompt_tokens || 0),
    completion_tokens: Number(entry.usage.completion_tokens || 0),
    total_tokens: Number(entry.usage.total_tokens || 0)
  } : null;
  return {
    id: String(entry.id || ''),
    at: entry.at || null,
    ok: !!entry.ok,
    status: entry.ok ? 'success' : 'failed',
    code: entry.code || null,
    errorLabel: entry.code ? (ERROR_LABEL[entry.code] || '调用失败') : null,
    model: entry.model || null,
    modelReturned: entry.modelReturned || null,
    role: entry.role || null,
    prompts: Array.isArray(entry.prompts) ? entry.prompts.slice(0, 30) : [],
    promptVersions: Array.isArray(entry.promptVersions) ? entry.promptVersions.slice(0, 30) : [],
    latencyMs: Number(entry.latencyMs || 0),
    attempts: Number(entry.attempts || 1),
    usage,
    cost: Number(entry.cost || 0),
    inputChars: Number(entry.inputChars || 0),
    truncatedCount: Array.isArray(entry.truncated) ? entry.truncated.length : 0,
    droppedCount: Array.isArray(entry.dropped) ? entry.dropped.length : 0,
    schemaErrors: Array.isArray(entry.validationErrors) ? entry.validationErrors.slice(0, 12) : [],
    riskHits: Array.isArray(entry.riskHits) ? entry.riskHits.slice(0, 20) : []
  };
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
  INVALID_MODEL_JSON: '模型 JSON 不完整', INVALID_MODEL_SCHEMA: '模型输出结构无效', ANALYZE_FAILED: '分析失败', DISABLED: '后台已关闭分析',
  BAD_REQUEST: '请求参数缺失', PAYLOAD_TOO_LARGE: '请求内容过大', RATE_LIMIT: '限流',
  MODEL_UNAVAILABLE: '模型暂时不可用', MODEL_AUTH_ERROR: '模型鉴权失败', MODEL_REQUEST_REJECTED: '模型拒绝请求'
};

function costOf(usage, settings) {
  if (!usage) return 0;
  const input = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  return (input / 1e6) * settings.inputPricePerM + (output / 1e6) * settings.outputPricePerM;
}

function alertId(scope, metric, threshold, context = 'default') {
  const raw = [context, scope, metric, Number(threshold)].join('|');
  return `alert-${Buffer.from(raw).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 180)}`;
}

function readAlertStates() {
  const states = readJson(FILES.alertStates, []);
  const legacy = readJson(FILES.alertAcks, []);
  for (const item of legacy) if (!states.some(row => row.id === item.id)) states.push({ ...item, status: 'acknowledged' });
  return states;
}

function listAlertHistory(limit = 100) {
  return readAlertStates().sort((a, b) => new Date(b.lastSeenAt || b.acknowledgedAt || 0) - new Date(a.lastSeenAt || a.acknowledgedAt || 0)).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
}

function acknowledgeAlert(id, actor) {
  const safeId = String(id || '').trim();
  if (!/^alert-[A-Za-z0-9]{1,180}$/.test(safeId)) throw Object.assign(new Error('告警 ID 无效'), { statusCode: 400, code: 'INVALID_ALERT_ID' });
  const all = readAlertStates();
  const item = all.find(row => row.id === safeId);
  if (!item) throw Object.assign(new Error('告警不存在或已过期'), { statusCode: 404, code: 'ALERT_NOT_FOUND' });
  const now = new Date().toISOString();
  item.acknowledgedAt = item.acknowledgedAt || now;
  item.acknowledgedBy = item.acknowledgedBy || clip(actor || '管理员', 80);
  item.status = item.status === 'recovered' ? 'recovered' : 'acknowledged';
  writeJson(FILES.alertStates, all);
  pushAuditEvent('alert_ack', actor, `运行告警：${safeId}`, '管理员确认告警');
  return item;
}

function alertNotificationConfig() {
  const raw = String(process.env.ALERT_WEBHOOK_URL || '').trim();
  let parsed = null;
  try {
    const candidate = new URL(raw);
    if (candidate.protocol === 'http:' || candidate.protocol === 'https:') parsed = candidate;
  } catch {}
  return {
    enabled: getSettings().alertNotificationsEnabled === true,
    configured: !!parsed,
    scheme: parsed ? parsed.protocol.slice(0, -1) : null
  };
}

function listAlertNotifications(limit = 50) {
  return readJson(FILES.alertNotifications, [])
    .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

function alertNotificationStatus() {
  const config = alertNotificationConfig();
  const latest = listAlertNotifications(1)[0] || null;
  return { enabled: config.enabled, configured: config.configured, scheme: config.scheme, last: latest ? { status: latest.status, type: latest.type, at: latest.at, errorCode: latest.errorCode || null } : null };
}

function appendAlertNotification(item) {
  const rows = readJson(FILES.alertNotifications, []);
  rows.push(item);
  writeJson(FILES.alertNotifications, rows.slice(-500));
}

function updateAlertNotification(id, patch) {
  const rows = readJson(FILES.alertNotifications, []);
  const item = rows.find(row => row.id === id);
  if (!item) return;
  Object.assign(item, patch);
  writeJson(FILES.alertNotifications, rows);
}

function postAlertWebhook(payload) {
  const raw = String(process.env.ALERT_WEBHOOK_URL || '').trim();
  let target;
  try {
    target = new URL(raw);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Webhook 只支持 HTTP 或 HTTPS');
  } catch (error) {
    return Promise.reject(Object.assign(new Error('未配置有效的 ALERT_WEBHOOK_URL'), { code: 'ALERT_WEBHOOK_NOT_CONFIGURED' }));
  }
  const body = JSON.stringify(payload);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
      path: `${target.pathname}${target.search}`, method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(process.env.ALERT_WEBHOOK_TOKEN ? { Authorization: `Bearer ${String(process.env.ALERT_WEBHOOK_TOKEN).slice(0, 300)}` } : {}) }
    }, res => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode });
        else reject(Object.assign(new Error(`Webhook 返回 HTTP ${res.statusCode}`), { code: 'ALERT_WEBHOOK_HTTP_ERROR', statusCode: res.statusCode }));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Webhook 请求超时'), { code: 'ALERT_WEBHOOK_TIMEOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

function dispatchAlertNotification(event) {
  const config = alertNotificationConfig();
  if (!config.enabled || !config.configured) return { status: 'skipped', reason: config.enabled ? 'not_configured' : 'disabled' };
  const id = `notification-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const item = { id, eventId: event.eventId, alertId: event.alertId, type: event.type, scope: event.scope, metric: event.metric, rate: event.rate, threshold: event.threshold, calls: event.calls, status: 'pending', at: new Date().toISOString() };
  appendAlertNotification(item);
  const payload = { source: 'resume-expert', event: event.type, alertId: event.alertId, scope: event.scope, metric: event.metric, rate: event.rate, threshold: event.threshold, calls: event.calls, occurredAt: item.at };
  postAlertWebhook(payload).then(result => updateAlertNotification(id, { status: 'sent', statusCode: result.statusCode, completedAt: new Date().toISOString() }))
    .catch(error => updateAlertNotification(id, { status: 'failed', errorCode: error.code || 'ALERT_WEBHOOK_FAILED', error: clip(error.message || '通知发送失败', 160), completedAt: new Date().toISOString() }));
  return { status: 'pending', id };
}

function testAlertNotification() {
  const config = alertNotificationConfig();
  if (!config.enabled) throw Object.assign(new Error('告警通知未启用'), { statusCode: 409, code: 'ALERT_NOTIFICATIONS_DISABLED' });
  if (!config.configured) throw Object.assign(new Error('服务端未配置有效的 ALERT_WEBHOOK_URL'), { statusCode: 409, code: 'ALERT_WEBHOOK_NOT_CONFIGURED' });
  const event = { eventId: `test-${Date.now()}`, alertId: 'alert-test', type: 'alert_test', scope: 'test', metric: 'test', rate: 0, threshold: 0, calls: 0 };
  return dispatchAlertNotification(event);
}

function syncAlertStates(activeAlerts, context, eligible) {
  const all = readAlertStates();
  const now = new Date().toISOString();
  const activeIds = new Set(activeAlerts.map(item => item.id));
  const events = [];
  for (const alert of activeAlerts) {
    let state = all.find(item => item.id === alert.id);
    const wasRecovered = state?.status === 'recovered';
    if (!state) { state = { id: alert.id, scope: alert.scope, metric: alert.metric, threshold: alert.threshold, context, firstSeenAt: now, occurrences: 0 }; all.push(state); }
    state.scope = alert.scope; state.metric = alert.metric; state.threshold = alert.threshold; state.context = context;
    state.lastSeenAt = now; state.lastRate = alert.rate; state.lastCalls = alert.calls; state.occurrences = Number(state.occurrences || 0) + 1; state.status = state.acknowledgedAt ? 'acknowledged' : 'active';
    if (!state.notificationEventAt || wasRecovered) {
      state.notificationEventAt = now;
      events.push({ eventId: `${alert.id}:triggered:${now}`, alertId: alert.id, type: wasRecovered ? 'alert_reactivated' : 'alert_triggered', scope: alert.scope, metric: alert.metric, rate: alert.rate, threshold: alert.threshold, calls: alert.calls });
    }
  }
  if (eligible) for (const state of all) {
    if (state.context === context && state.status !== 'recovered' && !activeIds.has(state.id)) {
      state.status = 'recovered'; state.recoveredAt = now;
      events.push({ eventId: `${state.id}:recovered:${now}`, alertId: state.id, type: 'alert_recovered', scope: state.scope, metric: state.metric, rate: state.lastRate, threshold: state.threshold, calls: state.lastCalls });
    }
  }
  writeJson(FILES.alertStates, all);
  return { states: all, events };
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function logStats(days = 7, filters = {}) {
  const { rows: allRows } = readLogs({ limit: Number.MAX_SAFE_INTEGER, days });
  const models = [...new Set(allRows.flatMap(r => [r.model, r.modelReturned]).filter(Boolean))].sort();
  const prompts = [...new Set(allRows.flatMap(r => r.prompts || []))].sort();
  const { rows } = readLogs({ limit: Number.MAX_SAFE_INTEGER, days, ...filters });
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
  const schemaFields = {};
  const byModel = {};
  const byPrompt = {};
  const byPromptVersion = {};
  const promptVersionDaily = {};
  for (const r of rows) {
    const model = r.modelReturned || r.model || 'unknown';
    byModel[model] = byModel[model] || { model, total: 0, failed: 0, latencySum: 0, latencyCount: 0, tokens: 0, cost: 0 };
    const modelBucket = byModel[model];
    modelBucket.total += 1;
    if (!r.ok) modelBucket.failed += 1;
    if (r.ok) { modelBucket.latencySum += Number(r.latencyMs || 0); modelBucket.latencyCount += 1; }
    modelBucket.tokens += Number(r.usage?.total_tokens || 0);
    modelBucket.cost += costOf(r.usage, settings);
    for (const promptName of r.prompts || []) {
      byPrompt[promptName] = byPrompt[promptName] || { prompt: promptName, calls: 0, failed: 0, truncated: 0, dropped: 0 };
      byPrompt[promptName].calls += 1;
      if (!r.ok) byPrompt[promptName].failed += 1;
      if ((r.truncated || []).some(item => item.name === promptName)) byPrompt[promptName].truncated += 1;
      if ((r.dropped || []).some(item => item.name === promptName)) byPrompt[promptName].dropped += 1;
    }
    const promptVersions = Array.isArray(r.promptVersions) ? r.promptVersions : [];
    const callCost = costOf(r.usage, settings);
    const perPromptVersionCost = promptVersions.length ? callCost / promptVersions.length : 0;
    for (const item of promptVersions) {
      const key = `${item.name}@${item.version}`;
      byPromptVersion[key] = byPromptVersion[key] || { prompt: item.name, version: item.version, calls: 0, failed: 0, schemaErrors: 0, retries: 0, latencySum: 0, latencyCount: 0, cost: 0 };
      const bucket = byPromptVersion[key];
      bucket.calls += 1; if (!r.ok) bucket.failed += 1; if ((r.validationErrors || []).length) bucket.schemaErrors += 1;
      if (Number(r.attempts || 1) > 1) bucket.retries += 1;
      if (r.ok) { bucket.latencySum += Number(r.latencyMs || 0); bucket.latencyCount += 1; }
      bucket.cost += perPromptVersionCost;
      promptVersionDaily[key] = promptVersionDaily[key] || {};
      const day = String(r.at).slice(0, 10);
      const dailyBucket = promptVersionDaily[key][day] || { day, calls: 0, failed: 0, schemaErrors: 0, retries: 0 };
      dailyBucket.calls += 1;
      if (!r.ok) dailyBucket.failed += 1;
      if ((r.validationErrors || []).length) dailyBucket.schemaErrors += 1;
      if (Number(r.attempts || 1) > 1) dailyBucket.retries += 1;
      promptVersionDaily[key][day] = dailyBucket;
    }
    if (r.ok) continue;
    for (const field of r.validationErrors || []) schemaFields[field] = (schemaFields[field] || 0) + 1;
    const key = r.code || 'UNKNOWN';
    byCode[key] = byCode[key] || { code: key, label: ERROR_LABEL[key] || key, count: 0 };
    byCode[key].count += 1;
  }

  const alertMinCalls = Number(settings.alertMinCalls || DEFAULT_SETTINGS.alertMinCalls);
  const alerts = [];
  const context = [days, filters.model || '', filters.prompt || '', filters.role || '', Number(filters.minLatency || 0)].join('|');
  const ackMap = new Map(readAlertStates().map(item => [item.id, item]));
  const addAlert = (scope, metric, rate, threshold, calls, message, meta = {}) => {
    if (calls >= alertMinCalls && threshold > 0 && rate >= threshold) {
      const roundedRate = Number(rate.toFixed(1));
      const id = alertId(scope, metric, threshold, context);
      const ack = ackMap.get(id);
      alerts.push({ id, scope, metric, rate: roundedRate, threshold, calls, message, acknowledged: !!ack?.acknowledgedAt, acknowledgedAt: ack?.acknowledgedAt || null, acknowledgedBy: ack?.acknowledgedBy || null, drilldown: { days, prompt: meta.prompt || null, version: meta.version || null, ok: ['failureRate', 'schemaErrorRate'].includes(metric) ? 'false' : 'all' } });
    }
  };
  addAlert('overall', 'failureRate', total ? failed / total * 100 : 0, Number(settings.alertFailureRate), total, `整体失败率 ${total ? (failed / total * 100).toFixed(1) : '0.0'}% 超过阈值`);
  const schemaErrorCount = rows.filter(r => (r.validationErrors || []).length > 0).length;
  addAlert('overall', 'schemaErrorRate', total ? schemaErrorCount / total * 100 : 0, Number(settings.alertSchemaErrorRate), total, `整体 Schema 错误率 ${total ? (schemaErrorCount / total * 100).toFixed(1) : '0.0'}% 超过阈值`);
  const retryCount = rows.filter(r => Number(r.attempts || 1) > 1).length;
  addAlert('overall', 'retryRate', total ? retryCount / total * 100 : 0, Number(settings.alertRetryRate), total, `整体重试率 ${total ? (retryCount / total * 100).toFixed(1) : '0.0'}% 超过阈值`);
  for (const item of Object.values(byPromptVersion)) {
    const failureRate = item.calls ? item.failed / item.calls * 100 : 0;
    const schemaRate = item.calls ? item.schemaErrors / item.calls * 100 : 0;
    const retryRate = item.calls ? item.retries / item.calls * 100 : 0;
    const label = `${item.prompt}@${item.version}`;
    addAlert(label, 'failureRate', failureRate, Number(settings.alertFailureRate), item.calls, `${label} 失败率 ${failureRate.toFixed(1)}% 超过阈值`, { prompt: item.prompt, version: item.version });
    addAlert(label, 'schemaErrorRate', schemaRate, Number(settings.alertSchemaErrorRate), item.calls, `${label} Schema 错误率 ${schemaRate.toFixed(1)}% 超过阈值`, { prompt: item.prompt, version: item.version });
    addAlert(label, 'retryRate', retryRate, Number(settings.alertRetryRate), item.calls, `${label} 重试率 ${retryRate.toFixed(1)}% 超过阈值`, { prompt: item.prompt, version: item.version });
  }
  const alertSync = syncAlertStates(alerts, context, total >= alertMinCalls);
  for (const event of alertSync.events) dispatchAlertNotification(event);
  const alertHistory = alertSync.states;
  const promptVersionTrends = Object.entries(promptVersionDaily).map(([key, daysByDate]) => {
    const [prompt, ...versionParts] = key.split('@');
    return { prompt, version: versionParts.join('@'), daily: Object.values(daysByDate).sort((a, b) => a.day.localeCompare(b.day)).map(item => ({ ...item, failureRate: Number((item.failed / item.calls * 100).toFixed(1)), schemaErrorRate: Number((item.schemaErrors / item.calls * 100).toFixed(1)), retryRate: Number((item.retries / item.calls * 100).toFixed(1)) })) };
  });
  return {
    total, failed, successRate: total ? Number(((total - failed) / total * 100).toFixed(1)) : 100,
    avgLatency: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    p50Latency: percentile(latencies, 0.5), p95Latency: percentile(latencies, 0.95), p99Latency: percentile(latencies, 0.99),
    tokens, cost: Number(cost.toFixed(4)),
    truncatedCalls: rows.filter(r => (r.truncated || []).length).length,
    droppedCalls: rows.filter(r => (r.dropped || []).length).length,
    retryCalls: rows.filter(r => Number(r.attempts || 1) > 1).length,
    retryRate: total ? Number((rows.filter(r => Number(r.attempts || 1) > 1).length / total * 100).toFixed(1)) : 0,
    avgInputChars: total ? Math.round(rows.reduce((sum, r) => sum + Number(r.inputChars || 0), 0) / total) : 0,
    daily, byCode: Object.values(byCode).sort((a, b) => b.count - a.count),
    schemaFields: Object.entries(schemaFields).map(([field, count]) => ({ field, count })).sort((a, b) => b.count - a.count),
    byModel: Object.values(byModel).map(item => ({ ...item, successRate: item.total ? Number(((item.total - item.failed) / item.total * 100).toFixed(1)) : 100, avgLatency: item.latencyCount ? Math.round(item.latencySum / item.latencyCount) : 0, cost: Number(item.cost.toFixed(4)) })).sort((a, b) => b.total - a.total),
    byPrompt: Object.values(byPrompt).sort((a, b) => b.calls - a.calls),
    byPromptVersion: Object.values(byPromptVersion).map(item => ({ ...item, failureRate: item.calls ? Number((item.failed / item.calls * 100).toFixed(1)) : 0, retryRate: item.calls ? Number((item.retries / item.calls * 100).toFixed(1)) : 0, avgLatency: item.latencyCount ? Math.round(item.latencySum / item.latencyCount) : 0, cost: Number(item.cost.toFixed(4)) })).sort((a, b) => b.calls - a.calls),
    promptVersionTrends,
    slowest: rows.filter(r => r.ok).sort((a, b) => Number(b.latencyMs || 0) - Number(a.latencyMs || 0)).slice(0, 10).map(r => ({ id: r.id, at: r.at, latencyMs: r.latencyMs, model: r.modelReturned || r.model, role: r.role, prompts: r.prompts || [], inputChars: r.inputChars, attempts: r.attempts })),
    filters: { models, prompts },
    alerts: alerts.sort((a, b) => b.rate - a.rate),
    alertHistory: alertHistory.slice().sort((a, b) => new Date(b.lastSeenAt || b.acknowledgedAt || 0) - new Date(a.lastSeenAt || a.acknowledgedAt || 0)).slice(0, 100),
    settings: { inputPricePerM: settings.inputPricePerM, outputPricePerM: settings.outputPricePerM, alertFailureRate: settings.alertFailureRate, alertSchemaErrorRate: settings.alertSchemaErrorRate, alertRetryRate: settings.alertRetryRate, alertMinCalls: settings.alertMinCalls, alertNotificationsEnabled: settings.alertNotificationsEnabled, alertWebhookConfigured: alertNotificationConfig().configured },
    days
  };
}

function costBudgetStatus() {
  const settings = getSettings();
  const now = Date.now();
  const rows = readLogs({ limit: Number.MAX_SAFE_INTEGER, days: 1 }).rows;
  const spent = rows.reduce((sum, row) => sum + costOf(row.usage, settings), 0);
  const budget = Number(settings.dailyCostBudget || 0);
  const exhausted = budget > 0 && spent >= budget;
  return { enabled: budget > 0, budget: Number(budget.toFixed(4)), spent: Number(spent.toFixed(4)), remaining: budget > 0 ? Number(Math.max(0, budget - spent).toFixed(4)) : null, exceeded: exhausted, exhausted, period: { from: new Date(now - 86400000).toISOString(), to: new Date(now).toISOString() } };
}

function releaseComparison(id, version, beforeDays = 7, afterDays = 7) {
  const prompt = getPrompt(id);
  if (!prompt) return null;
  const safeBefore = Math.min(Math.max(Number(beforeDays) || 7, 1), 90);
  const safeAfter = Math.min(Math.max(Number(afterDays) || 7, 1), 90);
  const versions = readJson(FILES.versions, [])
    .filter(item => String(item.promptId) === String(id) && item.snapshot && item.version === version && ['seed', 'publish', 'production_rollback'].includes(item.action))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const release = versions[versions.length - 1];
  if (!release) return { status: 'not_found', prompt: { id: prompt.id, name: prompt.name }, version };
  const boundary = new Date(release.at).getTime();
  const all = readLogs({ limit: Number.MAX_SAFE_INTEGER }).rows;
  const matches = row => (row.promptVersions || []).some(item => item.name === prompt.name && item.version === version);
  const inWindow = (row, start, end) => { const at = new Date(row.at).getTime(); return matches(row) && at >= start && at < end; };
  const settings = getSettings();
  const aggregate = (rows) => {
    const failed = rows.filter(row => !row.ok).length;
    const schemaErrors = rows.filter(row => (row.validationErrors || []).length > 0).length;
    const retries = rows.filter(row => Number(row.attempts || 1) > 1).length;
    const successfulLatencies = rows.filter(row => row.ok).map(row => Number(row.latencyMs || 0)).sort((a, b) => a - b);
    const totalTokens = rows.reduce((sum, row) => sum + Number(row.usage?.total_tokens || 0), 0);
    const inputChars = rows.reduce((sum, row) => sum + Number(row.inputChars || 0), 0);
    const cost = rows.reduce((sum, row) => sum + costOf(row.usage, settings) / Math.max((row.promptVersions || []).length, 1), 0);
    const feedback = readJson(FILES.feedback, []).filter(item => rows.some(row => row.id === item.logId));
    const good = feedback.filter(item => item.rating === 'good').length;
    const bad = feedback.filter(item => item.rating === 'bad').length;
    return {
      calls: rows.length, failed, successRate: rows.length ? Number(((rows.length - failed) / rows.length * 100).toFixed(1)) : null,
      failureRate: rows.length ? Number((failed / rows.length * 100).toFixed(1)) : null,
      schemaErrors, schemaErrorRate: rows.length ? Number((schemaErrors / rows.length * 100).toFixed(1)) : null,
      retries, retryRate: rows.length ? Number((retries / rows.length * 100).toFixed(1)) : null,
      p50Latency: percentile(successfulLatencies, 0.5) || null, p95Latency: percentile(successfulLatencies, 0.95) || null,
      avgInputChars: rows.length ? Math.round(inputChars / rows.length) : null,
      tokens: totalTokens, cost: Number(cost.toFixed(4)), feedback: { total: feedback.length, good, bad, positiveRate: feedback.length ? Number((good / feedback.length * 100).toFixed(1)) : null }
    };
  };
  const before = aggregate(all.filter(row => inWindow(row, boundary - safeBefore * 86400000, boundary)));
  const after = aggregate(all.filter(row => inWindow(row, boundary, boundary + safeAfter * 86400000)));
  return {
    status: before.calls && after.calls ? 'ready' : 'insufficient_data',
    prompt: { id: prompt.id, name: prompt.name }, version,
    release: { at: release.at, actor: release.actor || null, action: release.action },
    windows: { beforeDays: safeBefore, afterDays: safeAfter, before: { from: new Date(boundary - safeBefore * 86400000).toISOString(), to: release.at }, after: { from: release.at, to: new Date(boundary + safeAfter * 86400000).toISOString() } },
    before, after
  };
}

/* ---------- 质量反馈 ---------- */

const FEEDBACK_STATUSES = new Set(['open', 'reviewing', 'resolved', 'dismissed']);
const FEEDBACK_RATINGS = new Set(['good', 'bad']);

function listFeedback({ status, rating, prompt, limit = 200 } = {}) {
  return readJson(FILES.feedback, [])
    .filter(item => !status || item.status === status)
    .filter(item => !rating || item.rating === rating)
    .filter(item => !prompt || (item.prompts || []).includes(prompt))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500));
}

function saveFeedback(input, actor) {
  const log = findLog(String(input.logId || ''));
  if (!log) throw Object.assign(new Error('运行记录不存在'), { statusCode: 404, code: 'LOG_NOT_FOUND' });
  if (!FEEDBACK_RATINGS.has(input.rating)) throw Object.assign(new Error('评价必须是 good 或 bad'), { statusCode: 400, code: 'INVALID_FEEDBACK_RATING' });
  const all = readJson(FILES.feedback, []);
  const now = new Date().toISOString();
  let item = all.find(row => row.logId === log.id);
  if (!item) {
    item = { id: `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, logId: log.id, createdAt: now, createdBy: actor };
    all.push(item);
  }
  Object.assign(item, {
    rating: input.rating,
    tags: Array.isArray(input.tags) ? input.tags.map(tag => clip(tag, 40).trim()).filter(Boolean).slice(0, 20) : [],
    comment: clip(input.comment, 1000).trim(),
    status: FEEDBACK_STATUSES.has(input.status) ? input.status : 'open',
    owner: clip(input.owner, 80).trim(),
    model: log.modelReturned || log.model || null,
    role: log.role || null,
    prompts: log.prompts || [],
    promptVersions: (log.promptVersions || []).map(item => ({ name: clip(item.name, 80), version: clip(item.version, 40) })),
    runAt: log.at,
    updatedAt: now,
    updatedBy: actor
  });
  writeJson(FILES.feedback, all);
  pushAuditEvent('feedback_update', actor, `质量反馈：${item.id}`, `${item.rating}/${item.status}，运行记录 ${item.logId}`);
  return item;
}

function updateFeedback(id, input, actor) {
  const all = readJson(FILES.feedback, []);
  const item = all.find(row => row.id === id);
  if (!item) return null;
  if (input.status !== undefined && !FEEDBACK_STATUSES.has(input.status)) throw Object.assign(new Error('反馈状态无效'), { statusCode: 400, code: 'INVALID_FEEDBACK_STATUS' });
  if (input.rating !== undefined && !FEEDBACK_RATINGS.has(input.rating)) throw Object.assign(new Error('反馈评价无效'), { statusCode: 400, code: 'INVALID_FEEDBACK_RATING' });
  if (input.status !== undefined) item.status = input.status;
  if (input.rating !== undefined) item.rating = input.rating;
  if (input.tags !== undefined) item.tags = Array.isArray(input.tags) ? input.tags.map(tag => clip(tag, 40).trim()).filter(Boolean).slice(0, 20) : [];
  if (input.comment !== undefined) item.comment = clip(input.comment, 1000).trim();
  if (input.owner !== undefined) item.owner = clip(input.owner, 80).trim();
  item.updatedAt = new Date().toISOString(); item.updatedBy = actor;
  writeJson(FILES.feedback, all);
  pushAuditEvent('feedback_update', actor, `质量反馈：${item.id}`, `${item.rating}/${item.status}，运行记录 ${item.logId}`);
  return item;
}

function linkFeedback(id, input, actor) {
  const all = readJson(FILES.feedback, []);
  const item = all.find(row => row.id === id);
  if (!item) return null;
  const promptId = String(input?.promptId || '').trim();
  const testCaseId = String(input?.testCaseId || '').trim();
  const prompt = promptId ? getPrompt(promptId) : null;
  if (!prompt) throw Object.assign(new Error('关联的 Prompt 不存在'), { statusCode: 400, code: 'FEEDBACK_PROMPT_NOT_FOUND' });
  const testCase = testCaseId ? readJson(FILES.testCases, []).find(row => String(row.id) === testCaseId) : null;
  if (testCaseId && !testCase) throw Object.assign(new Error('关联的测试案例不存在'), { statusCode: 400, code: 'FEEDBACK_TEST_CASE_NOT_FOUND' });
  if (testCase?.promptId && String(testCase.promptId) !== String(prompt.id)) {
    throw Object.assign(new Error('测试案例不属于所选 Prompt'), { statusCode: 400, code: 'FEEDBACK_CASE_PROMPT_MISMATCH' });
  }
  item.loop = {
    promptId: prompt.id,
    promptName: clip(prompt.name, 80),
    sourceVersion: prompt.version || null,
    publishedVersion: prompt.publishedVersion || null,
    testCaseId: testCase ? testCase.id : null,
    testCaseName: testCase ? clip(testCase.name, 100) : null,
    note: clip(input?.note, 500).trim(),
    status: input?.status === 'resolved' ? 'resolved' : 'planned',
    linkedAt: new Date().toISOString(),
    linkedBy: actor
  };
  item.updatedAt = new Date().toISOString(); item.updatedBy = actor;
  writeJson(FILES.feedback, all);
  pushAuditEvent('feedback_update', actor, `质量反馈：${item.id}`, `建立闭环：${prompt.name}${testCase ? `，测试案例 ${testCase.name}` : ''}`);
  return item;
}

function feedbackStats() {
  const items = readJson(FILES.feedback, []);
  const byTag = {};
  for (const item of items) for (const tag of item.tags || []) byTag[tag] = (byTag[tag] || 0) + 1;
  const good = items.filter(item => item.rating === 'good').length;
  const bad = items.filter(item => item.rating === 'bad').length;
  return { total: items.length, good, bad, positiveRate: items.length ? Number((good / items.length * 100).toFixed(1)) : 0, open: items.filter(item => ['open', 'reviewing'].includes(item.status)).length, resolved: items.filter(item => item.status === 'resolved').length, byTag: Object.entries(byTag).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count) };
}

/* ---------- Prompt 质量分析 ---------- */

function qualityStats(days = 7) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = Date.now() - safeDays * 86400000;
  const logs = readLogs({ limit: Number.MAX_SAFE_INTEGER, days: safeDays }).rows;
  const feedback = readJson(FILES.feedback, []).filter(item => new Date(item.updatedAt || item.createdAt || 0).getTime() >= since);
  const feedbackByLog = new Map(feedback.map(item => [String(item.logId), item]));
  const buckets = new Map();
  const roles = new Map();
  const add = (map, key, log, feedbackItem) => {
    if (!map.has(key)) map.set(key, { key, calls: 0, failed: 0, schemaErrors: 0, retries: 0, latency: 0, tokens: 0, cost: 0, feedback: 0, good: 0, bad: 0 });
    const row = map.get(key);
    row.calls += 1;
    row.failed += log.ok ? 0 : 1;
    row.schemaErrors += Array.isArray(log.validationErrors) && log.validationErrors.length ? 1 : 0;
    row.retries += Number(log.attempts || 1) > 1 ? 1 : 0;
    row.latency += Number(log.latencyMs || 0);
    row.tokens += Number(log.usage?.total_tokens || 0);
    row.cost += Number(log.cost || 0);
    if (feedbackItem) {
      row.feedback += 1;
      row.good += feedbackItem.rating === 'good' ? 1 : 0;
      row.bad += feedbackItem.rating === 'bad' ? 1 : 0;
    }
  };
  for (const log of logs) {
    const feedbackItem = feedbackByLog.get(String(log.id));
    const versions = Array.isArray(log.promptVersions) && log.promptVersions.length
      ? log.promptVersions
      : (log.prompts || []).map(name => ({ name, version: '-' }));
    for (const item of versions) add(buckets, `${item.name || '-'}@${item.version || '-'}`, log, feedbackItem);
    add(roles, String(log.role || '未填写'), log, feedbackItem);
  }
  const format = row => ({
    prompt: row.key.includes('@') ? row.key.slice(0, row.key.lastIndexOf('@')) : row.key,
    version: row.key.includes('@') ? row.key.slice(row.key.lastIndexOf('@') + 1) : '-',
    calls: row.calls, failed: row.failed,
    successRate: row.calls ? Number(((row.calls - row.failed) / row.calls * 100).toFixed(1)) : 0,
    failureRate: row.calls ? Number((row.failed / row.calls * 100).toFixed(1)) : 0,
    schemaErrorRate: row.calls ? Number((row.schemaErrors / row.calls * 100).toFixed(1)) : 0,
    retryRate: row.calls ? Number((row.retries / row.calls * 100).toFixed(1)) : 0,
    avgLatency: row.calls ? Math.round(row.latency / row.calls) : 0,
    tokens: row.tokens, cost: Number(row.cost.toFixed(4)),
    feedback: row.feedback, good: row.good, bad: row.bad,
    positiveRate: row.feedback ? Number((row.good / row.feedback * 100).toFixed(1)) : null
  });
  const all = { calls: 0, failed: 0, schemaErrors: 0, retries: 0, latency: 0, tokens: 0, cost: 0, feedback: 0, good: 0, bad: 0 };
  for (const log of logs) {
    all.calls += 1; all.failed += log.ok ? 0 : 1;
    all.schemaErrors += Array.isArray(log.validationErrors) && log.validationErrors.length ? 1 : 0;
    all.retries += Number(log.attempts || 1) > 1 ? 1 : 0;
    all.latency += Number(log.latencyMs || 0); all.tokens += Number(log.usage?.total_tokens || 0); all.cost += Number(log.cost || 0);
    const item = feedbackByLog.get(String(log.id));
    if (item) { all.feedback += 1; all.good += item.rating === 'good' ? 1 : 0; all.bad += item.rating === 'bad' ? 1 : 0; }
  }
  const overall = format({ key: '全部', ...all });
  return {
    days: safeDays, generatedAt: new Date().toISOString(), overall,
    byPrompt: [...buckets.values()].map(format).sort((a, b) => b.calls - a.calls || a.prompt.localeCompare(b.prompt)).slice(0, 100),
    byRole: [...roles.values()].map(row => ({ role: row.key, ...format(row) })).sort((a, b) => b.calls - a.calls).slice(0, 50)
  };
}

/* ---------- Prompt A/B 实验中心 ---------- */

function experimentGroup(rows, promptName, version, feedbackByLog, settings) {
  const matched = rows.filter(row => (row.promptVersions || []).some(item => String(item.name) === String(promptName) && String(item.version) === String(version)));
  const successfulLatencies = matched.filter(row => row.ok).map(row => Number(row.latencyMs || 0)).sort((a, b) => a - b);
  const failed = matched.filter(row => !row.ok).length;
  const schemaErrors = matched.filter(row => (row.validationErrors || []).length > 0).length;
  const retries = matched.filter(row => Number(row.attempts || 1) > 1).length;
  let feedback = 0; let good = 0; let bad = 0;
  for (const row of matched) {
    const item = feedbackByLog.get(String(row.id));
    if (!item) continue;
    feedback += 1; good += item.rating === 'good' ? 1 : 0; bad += item.rating === 'bad' ? 1 : 0;
  }
  const callCost = matched.reduce((sum, row) => {
    const count = Math.max((row.promptVersions || []).length, 1);
    return sum + costOf(row.usage, settings) / count;
  }, 0);
  const calls = matched.length;
  return {
    calls, failed,
    successRate: calls ? Number(((calls - failed) / calls * 100).toFixed(1)) : 0,
    failureRate: calls ? Number((failed / calls * 100).toFixed(1)) : 0,
    schemaErrors,
    schemaErrorRate: calls ? Number((schemaErrors / calls * 100).toFixed(1)) : 0,
    retries,
    retryRate: calls ? Number((retries / calls * 100).toFixed(1)) : 0,
    p50Latency: percentile(successfulLatencies, 0.5),
    p95Latency: percentile(successfulLatencies, 0.95),
    tokens: matched.reduce((sum, row) => sum + Number(row.usage?.total_tokens || 0), 0),
    cost: Number(callCost.toFixed(4)),
    feedback: { total: feedback, good, bad, positiveRate: feedback ? Number((good / feedback * 100).toFixed(1)) : null }
  };
}

function experiments(days = 7) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const rows = readLogs({ limit: Number.MAX_SAFE_INTEGER, days: safeDays }).rows;
  const since = Date.now() - safeDays * 86400000;
  const feedbackByLog = new Map(readJson(FILES.feedback, [])
    .filter(item => new Date(item.updatedAt || item.createdAt || 0).getTime() >= since)
    .map(item => [String(item.logId), item]));
  const settings = getSettings();
  const items = getPrompts().filter(prompt => prompt.canary).map(prompt => {
    const canary = prompt.canary;
    const sourceVersion = canary.sourceVersion || prompt.publishedVersion || '-';
    const control = experimentGroup(rows, prompt.name, sourceVersion, feedbackByLog, settings);
    const candidate = experimentGroup(rows, prompt.name, canary.version, feedbackByLog, settings);
    const minCalls = 10;
    const sufficientData = control.calls >= minCalls && candidate.calls >= minCalls;
    let status = 'insufficient_data';
    if (sufficientData) {
      const candidateBetter = candidate.failureRate <= control.failureRate && candidate.schemaErrorRate <= control.schemaErrorRate && (candidate.failureRate < control.failureRate || candidate.schemaErrorRate < control.schemaErrorRate);
      const candidateWorse = candidate.failureRate >= control.failureRate && candidate.schemaErrorRate >= control.schemaErrorRate && (candidate.failureRate > control.failureRate || candidate.schemaErrorRate > control.schemaErrorRate);
      status = candidateBetter ? 'candidate_better' : candidateWorse ? 'candidate_worse' : 'inconclusive';
    }
    return {
      promptId: prompt.id, promptName: prompt.name,
      sourceVersion, candidateVersion: canary.version,
      trafficPercent: Number(canary.trafficPercent || 0), startedAt: canary.startedAt || null, startedBy: canary.startedBy || null,
      minCalls, sufficientData, status, control, candidate
    };
  });
  return { days: safeDays, generatedAt: new Date().toISOString(), items };
}

/* ---------- 风险与规则 ---------- */

const RULE_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const RULE_TYPES = new Set(['forbidden_pattern', 'required_pattern']);

function listRules() { return readJson(FILES.rules, []).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); }

function createRule(input, actor) {
  const name = clip(input.name, 100).trim();
  const pattern = clip(input.pattern, 300).trim();
  const type = RULE_TYPES.has(input.type) ? input.type : 'forbidden_pattern';
  const severity = RULE_SEVERITIES.has(input.severity) ? input.severity : 'medium';
  if (!name || !pattern) throw Object.assign(new Error('规则名称和匹配模式不能为空'), { statusCode: 400, code: 'INVALID_RULE' });
  try { new RegExp(pattern, 'iu'); } catch { throw Object.assign(new Error('规则匹配模式不是合法正则表达式'), { statusCode: 400, code: 'INVALID_RULE_PATTERN' }); }
  const now = new Date().toISOString();
  const rule = { id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, type, pattern, severity, enabled: input.enabled !== false, createdAt: now, updatedAt: now, updatedBy: actor };
  const rules = readJson(FILES.rules, []); rules.push(rule); writeJson(FILES.rules, rules);
  pushAuditEvent('rule_create', actor, `风险规则：${name}`, `创建 ${rule.id}`);
  return rule;
}

function updateRule(id, input, actor) {
  const rules = readJson(FILES.rules, []); const rule = rules.find(item => item.id === id);
  if (!rule) return null;
  if (input.name !== undefined) rule.name = clip(input.name, 100).trim();
  if (input.pattern !== undefined) { const pattern = clip(input.pattern, 300).trim(); try { new RegExp(pattern, 'iu'); } catch { throw Object.assign(new Error('规则匹配模式不是合法正则表达式'), { statusCode: 400, code: 'INVALID_RULE_PATTERN' }); } rule.pattern = pattern; }
  if (input.type !== undefined && !RULE_TYPES.has(input.type)) throw Object.assign(new Error('规则类型无效'), { statusCode: 400, code: 'INVALID_RULE_TYPE' });
  if (input.severity !== undefined && !RULE_SEVERITIES.has(input.severity)) throw Object.assign(new Error('规则严重级别无效'), { statusCode: 400, code: 'INVALID_RULE_SEVERITY' });
  if (input.type !== undefined) rule.type = input.type;
  if (input.severity !== undefined) rule.severity = input.severity;
  if (input.enabled !== undefined) rule.enabled = input.enabled === true;
  rule.updatedAt = new Date().toISOString(); rule.updatedBy = actor; writeJson(FILES.rules, rules);
  pushAuditEvent('rule_update', actor, `风险规则：${rule.name}`, `更新 ${rule.id}`);
  return rule;
}

function removeRule(id, actor) {
  const rules = readJson(FILES.rules, []); const rule = rules.find(item => item.id === id);
  if (!rule) return false;
  writeJson(FILES.rules, rules.filter(item => item.id !== id));
  pushAuditEvent('rule_delete', actor, `风险规则：${rule.name}`, `删除 ${rule.id}`);
  return true;
}

function scanRisk(text) {
  const source = String(text || '');
  const violations = [];
  for (const rule of listRules().filter(item => item.enabled)) {
    let matched = false;
    try { matched = new RegExp(rule.pattern, 'iu').test(source); } catch { continue; }
    if ((rule.type === 'forbidden_pattern' && matched) || (rule.type === 'required_pattern' && !matched)) {
      violations.push({ ruleId: rule.id, ruleName: rule.name, severity: rule.severity, type: rule.type });
    }
  }
  return { passed: violations.length === 0, violations };
}

/* ---------- Prompt 测试台 ---------- */

function listTestCases(promptId) {
  return readJson(FILES.testCases, [])
    .filter(item => !promptId || String(item.promptId || '') === String(promptId))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function createTestCase(input, actor) {
  input = input && typeof input === 'object' ? input : {};
  const cases = readJson(FILES.testCases, []);
  const now = new Date().toISOString();
  const role = String(input.role ?? '').trim();
  const jd = String(input.jd ?? '').trim();
  const resume = String(input.resume ?? '').trim();
  const extra = String(input.extra ?? '').trim();
  const minScore = Number(input.minScore);
  const maxScoreDrop = Number(input.maxScoreDrop);
  if (jd.length > TEST_INPUT_MAX || resume.length > TEST_INPUT_MAX || extra.length > 10000) {
    throw Object.assign(new Error('测试案例输入过长：JD/简历各最多 120000 字符，补充信息最多 10000 字符'), {
      statusCode: 413, code: 'TEST_CASE_TOO_LARGE'
    });
  }
  const testCase = {
    id: `case-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: clip(input.name, 100) || `测试案例 ${cases.length + 1}`,
    promptId: input.promptId === undefined || input.promptId === null ? null : String(input.promptId),
    role: clip(role, 100),
    jd,
    resume,
    extra,
    minScore: Math.min(Math.max(Number.isFinite(minScore) ? minScore : 0, 0), 100),
    maxScoreDrop: Math.min(Math.max(Number.isFinite(maxScoreDrop) ? maxScoreDrop : 5, 0), 100),
    requiredTerms: String(input.requiredTerms || '').split(/[,，、\n]/).map(item => item.trim()).filter(Boolean).slice(0, 30),
    createdBy: clip(actor || '管理员', 80),
    createdAt: now,
    updatedAt: now
  };
  if (!testCase.role || !testCase.jd || !testCase.resume) {
    throw Object.assign(new Error('测试案例缺少目标岗位、JD 或简历'), { statusCode: 400, code: 'INVALID_TEST_CASE' });
  }
  cases.push(testCase);
  writeJson(FILES.testCases, cases);
  pushAuditEvent('test_case_create', actor, `测试案例：${testCase.name}`, `保存案例 ${testCase.id}，目标岗位：${testCase.role}`);
  return testCase;
}

function removeTestCase(id, actor) {
  const cases = readJson(FILES.testCases, []);
  const removed = cases.find(item => item.id === id);
  if (!removed) return false;
  const next = cases.filter(item => item.id !== id);
  writeJson(FILES.testCases, next);
  pushAuditEvent('test_case_delete', actor, `测试案例：${removed.name}`, `删除案例 ${removed.id}，目标岗位：${removed.role}`);
  return true;
}

function appendPromptTest(entry) {
  const row = {
    id: `ptest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    ...entry
  };
  fs.appendFileSync(FILES.promptTests, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function listPromptTests(promptId, limit = 50) {
  const raw = fs.existsSync(FILES.promptTests) ? fs.readFileSync(FILES.promptTests, 'utf8') : '';
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (promptId && String(row.promptId) !== String(promptId)) continue;
      rows.push(row);
    } catch { /* 跳过损坏行 */ }
  }
  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200));
}

function regressionSuiteKey(promptId) {
  return listTestCases(promptId).map(item => `${item.id}:${item.updatedAt}`).sort().join('|');
}

function appendRegression(entry) {
  const row = { id: `reg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...entry };
  fs.appendFileSync(FILES.regressions, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function listRegressions(promptId, limit = 30) {
  const raw = fs.existsSync(FILES.regressions) ? fs.readFileSync(FILES.regressions, 'utf8') : '';
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (promptId && String(row.promptId) !== String(promptId)) continue;
      rows.push(row);
    } catch { /* 跳过损坏行 */ }
  }
  return rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, Math.min(Math.max(Number(limit) || 30, 1), 100));
}

function regressionCenter() {
  return {
    generatedAt: new Date().toISOString(),
    items: getPrompts().map(prompt => {
      const cases = listTestCases(prompt.id);
      const latest = listRegressions(prompt.id, 1)[0] || null;
      const currentSuite = regressionSuiteKey(prompt.id);
      let status = 'no_cases';
      if (cases.length && !latest) status = 'not_run';
      else if (cases.length && latest) status = latest.passed && Number(latest.promptRevision) === Number(prompt.revision) && latest.suiteKey === currentSuite ? 'passed' : (latest.passed ? 'stale' : 'failed');
      return {
        promptId: prompt.id, promptName: prompt.name, step: prompt.step || null,
        releaseStatus: prompt.releaseStatus, version: prompt.version, publishedVersion: prompt.publishedVersion || null,
        caseCount: cases.length, status,
        latest: latest ? { id: latest.id, at: latest.at, promptVersion: latest.promptVersion, promptRevision: latest.promptRevision, passed: !!latest.passed, total: latest.total, failed: latest.failed, actor: latest.actor || null } : null
      };
    })
  };
}

function assertRegressionGate(prompt) {
  const cases = listTestCases(prompt.id);
  if (!cases.length) return;
  const latest = listRegressions(prompt.id, 1)[0];
  const currentSuite = regressionSuiteKey(prompt.id);
  if (!latest || !latest.passed || Number(latest.promptRevision) !== Number(prompt.revision) || latest.suiteKey !== currentSuite) {
    throw Object.assign(new Error('当前草稿尚未通过最新回归测试集，不能提交审核或发布'), {
      statusCode: 409, code: 'REGRESSION_GATE_FAILED'
    });
  }
}

function releaseChecklist(prompt) {
  if (!prompt) return null;
  const cases = listTestCases(prompt.id);
  const latest = listRegressions(prompt.id, 1)[0] || null;
  const suiteKey = regressionSuiteKey(prompt.id);
  let variablesPassed = true;
  let variableDetail = '无变量';
  try {
    // 老数据可能没有单独保存 variables，始终以当前内容重新校验，避免把旧 Prompt 误判为不可发布。
    const variables = Array.isArray(prompt.variables)
      ? prompt.variables
      : validatePromptContent(prompt.content);
    variableDetail = variables.length ? variables.join('、') : '无变量';
  } catch (error) {
    variablesPassed = false;
    variableDetail = error.message;
  }
  const regressionReady = !cases.length || !!(latest && latest.passed
    && Number(latest.promptRevision) === Number(prompt.revision)
    && latest.suiteKey === suiteKey);
  const checks = [
    { id: 'name', label: 'Prompt 名称已填写', passed: !!String(prompt.name || '').trim(), blocking: true, detail: String(prompt.name || '').trim() ? '已填写' : '名称不能为空' },
    { id: 'content', label: 'Prompt 内容非空', passed: !!String(prompt.content || '').trim(), blocking: true, detail: String(prompt.content || '').trim() ? `${String(prompt.content).length} 字` : '内容不能为空' },
    { id: 'variables', label: '变量校验通过', passed: variablesPassed, blocking: true, detail: variableDetail },
    { id: 'regression', label: '最新回归测试通过', passed: regressionReady, blocking: cases.length > 0, detail: !cases.length ? '未配置回归案例（警告）' : regressionReady ? `通过 ${latest.total || 0} 个案例` : '回归结果过期、失败或未运行' },
    { id: 'canary', label: '没有冲突的进行中灰度', passed: !prompt.canary, blocking: true, detail: prompt.canary ? `灰度 ${prompt.canary.version} 仍在进行` : '无进行中灰度' }
  ];
  return { promptId: prompt.id, version: prompt.version, releaseStatus: prompt.releaseStatus, ready: checks.filter(item => item.blocking).every(item => item.passed), checks };
}

function assertReleaseChecklist(prompt) {
  const checklist = releaseChecklist(prompt);
  if (!checklist.ready) {
    const regression = checklist.checks.find(item => item.id === 'regression');
    const error = Object.assign(new Error('发布检查清单未通过，请先处理阻断项'), { statusCode: 409, code: regression && !regression.passed ? 'REGRESSION_GATE_FAILED' : 'RELEASE_CHECKLIST_FAILED' });
    error.checklist = checklist;
    throw error;
  }
}

/* ---------- 供分析链路使用 ---------- */

/**
 * 把启用中的 Prompt 组装成发给模型的附加指令。
 * 同时回传截断信息——之前前端静默截断到 4000 字符且毫无提示，管理员根本不知道尾部丢了。
 */
function buildPromptConfig(settingsOverride, variables = {}) {
  const settings = { ...getSettings(), ...(settingsOverride || {}) };
  evaluateCanaries();
  const requestKey = [variables.role, variables.jd, variables.resume, variables.company].map(value => String(value || '')).join('|');
  const enabled = getPrompts()
    .filter(p => p.publishedSnapshot && p.publishedSnapshot.enabled && String(p.publishedSnapshot.content || '').trim())
    .map(p => {
      const canary = p.canary;
      const digest = canary ? crypto.createHash('sha256').update(`${p.id}|${requestKey}`).digest().readUInt32BE(0) % 100 : 100;
      const useCanary = !!canary && digest < Number(canary.trafficPercent || 0);
      const snapshot = useCanary ? canary.snapshot : p.publishedSnapshot;
      return { ...p, ...snapshot, version: useCanary ? canary.version : (p.publishedVersion || p.version), canary: useCanary };
    });
  const assembled = assemblePromptConfig(enabled, settings, variables);
  return { ...assembled, canary: assembled.config.filter(item => item.canary).map(item => ({ name: item.name, version: item.version })) };
}

function replacePromptVariables(content, variables) {
  return String(content).replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (full, name) => Object.prototype.hasOwnProperty.call(variables || {}, name) ? String(variables[name] ?? '') : full);
}

function assemblePromptConfig(selected, settings, variables = {}) {
  const sorted = selected.sort((a, b) => (a.step ?? 99) - (b.step ?? 99) || a.id - b.id);
  const picked = sorted.slice(0, settings.promptMaxCount);
  const truncated = [];

  const config = picked.map(p => {
    const content = replacePromptVariables(String(p.content), variables);
    if (content.length > settings.promptMaxChars) {
      truncated.push({ id: p.id, name: p.name, originalLength: content.length, sentLength: settings.promptMaxChars });
    }
    return {
      step: Number.isFinite(Number(p.step)) && p.step !== null ? Number(p.step) : null,
      stepKey: String(p.stepKey || 'extension').slice(0, 40),
      name: String(p.name || '自定义 Prompt').slice(0, 80),
      version: String(p.version || 'unknown').slice(0, 40),
      content: content.slice(0, settings.promptMaxChars),
      ...(p.canary ? { canary: true } : {})
    };
  });

  const dropped = sorted.slice(settings.promptMaxCount).map(p => ({ id: p.id, name: p.name }));
  return { config, truncated, dropped, enabledCount: selected.length };
}

function buildPromptConfigForTest(id, variant, settingsOverride, variables = {}) {
  const settings = { ...getSettings(), ...(settingsOverride || {}) };
  const prompts = getPrompts();
  const target = prompts.find(p => String(p.id) === String(id));
  if (!target) return null;
  if (variant === 'published' && !target.publishedSnapshot) {
    throw Object.assign(new Error('该 Prompt 尚无生产版本'), { statusCode: 409, code: 'NO_PUBLISHED_VERSION' });
  }

  const selected = prompts.map(prompt => {
    const snapshot = String(prompt.id) === String(id) && variant === 'draft'
      ? snapshotOf(prompt)
      : prompt.publishedSnapshot;
    return snapshot ? { ...prompt, ...snapshot, version: prompt.publishedVersion || prompt.version } : null;
  }).filter(Boolean).filter(prompt => prompt.enabled && String(prompt.content || '').trim());

  const assembled = assemblePromptConfig(selected, settings, variables);
  const targetSnapshot = variant === 'draft' ? snapshotOf(target) : target.publishedSnapshot;
  return { ...assembled, target: { id: target.id, variant, snapshot: targetSnapshot } };
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

function systemHealth() {
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const files = Object.entries(FILES);
  const missing = files.filter(([, file]) => !fs.existsSync(file)).map(([name]) => name);
  add('data_files', '运行数据文件', missing.length ? 'warn' : 'ok', missing.length ? `缺少 ${missing.join('、')}（首次启动会自动创建）` : `${files.length} 个数据文件可用`);
  try { fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK); add('data_dir', '数据目录读写', 'ok', '服务进程可读写 data 目录'); }
  catch { add('data_dir', '数据目录读写', 'fail', '服务进程无法读写 data 目录'); }
  const prompts = getPrompts();
  const enabledProduction = prompts.filter(item => item.publishedSnapshot?.enabled && String(item.publishedSnapshot.content || '').trim()).length;
  add('production_prompts', '生产 Prompt', enabledProduction ? 'ok' : 'fail', enabledProduction ? `${enabledProduction} 个已启用` : '没有可用的已发布 Prompt');
  const provider = String(process.env.AI_PROVIDER || 'deepseek').toLowerCase();
  const keyConfigured = provider === 'openai' ? !!String(process.env.OPENAI_API_KEY || '').trim() : !!String(process.env.DEEPSEEK_API_KEY || '').trim();
  const mockEnabled = process.env.NODE_ENV === 'test' && process.env.PROMPT_TEST_MOCK === 'true';
  add('model_provider', '模型服务配置', keyConfigured || mockEnabled ? 'ok' : 'warn', mockEnabled ? '当前使用测试 Mock' : keyConfigured ? `${provider} 凭据已配置（不显示密钥）` : `${provider} 凭据未配置`);
  const authConfigured = !!(process.env.ADMIN_PASSWORD || process.env.ADMIN_USERS_JSON || (process.env.ADMIN_DEV_AUTO_CREDENTIALS === 'true' && process.env.NODE_ENV !== 'production'));
  add('admin_auth', '后台鉴权配置', authConfigured ? 'ok' : 'fail', authConfigured ? '已配置账号来源' : '未配置后台账号');
  const failed = checks.filter(item => item.status === 'fail').length;
  const warnings = checks.filter(item => item.status === 'warn').length;
  return { status: failed ? 'fail' : warnings ? 'warn' : 'ok', generatedAt: new Date().toISOString(), checks };
}

function dependencyView() {
  const prompts = getPrompts();
  const rules = listRules().filter(rule => rule.enabled);
  const steps = Array.from({ length: 8 }, (_, index) => {
    const step = index + 1;
    const items = prompts.filter(prompt => Number(prompt.step) === step);
    return {
      step, prompts: items.map(prompt => ({ id: prompt.id, name: prompt.name, enabled: !!prompt.enabled, releaseStatus: prompt.releaseStatus, publishedVersion: prompt.publishedVersion, version: prompt.version, variables: prompt.variables || [], regressionCases: listTestCases(prompt.id).length, latestRegression: listRegressions(prompt.id, 1)[0]?.passed ?? null })),
      workspaceCount: items.filter(prompt => prompt.enabled).length,
      productionCount: items.filter(prompt => prompt.publishedSnapshot?.enabled).length,
      covered: items.some(prompt => prompt.publishedSnapshot?.enabled),
      hasDraft: items.some(prompt => prompt.releaseStatus !== 'published')
    };
  });
  return { steps, extensionPrompts: prompts.filter(prompt => prompt.step == null).map(prompt => ({ id: prompt.id, name: prompt.name, enabled: !!prompt.enabled, releaseStatus: prompt.releaseStatus })), enabledRules: rules.map(rule => ({ id: rule.id, name: rule.name, severity: rule.severity })) };
}

ensureData();
pruneLogs();

module.exports = {
  DATA_DIR, FILES, DEFAULT_SETTINGS, ACTION_LABEL, ERROR_LABEL, SEED,
  ensureData, getPrompts, getPrompt, listPrompts, queryPrompts, summarize, detail, createPrompt, updatePrompt, setEnabled,
  removePrompt, rollbackPrompt, submitPromptReview, rejectPromptReview, publishPrompt, rollbackProduction,
  listVersions, getVersion, listChanges, changesInLastDays,
  pushAuditEvent,
  getSettings, saveSettings, appendLog, readLogs, listTasks, pruneLogs, logStats, buildPromptConfig,
  listTestCases, createTestCase, removeTestCase, appendPromptTest, listPromptTests, buildPromptConfigForTest,
  regressionSuiteKey, appendRegression, listRegressions, regressionCenter,
  findLog, safeLogDetail, listFeedback, saveFeedback, updateFeedback, linkFeedback, feedbackStats, releaseComparison, qualityStats, experiments,
  listRules, createRule, updateRule, removeRule, scanRisk,
  listTemplates, updateTemplate, archiveTemplate, listTemplateVersions, rollbackTemplate, createPromptFromTemplate, batchPromptAction,
  dependencyView,
  validatePromptContent, replacePromptVariables, PROMPT_VARIABLES,
  overview, systemHealth, costBudgetStatus, costOf, bumpVersion, listAlertHistory, acknowledgeAlert,
  alertNotificationStatus, listAlertNotifications, testAlertNotification
  , startCanary, stopCanary, promoteCanary, setCanaryTraffic, canaryView, canaryMetrics,
  releaseChecklist
};
