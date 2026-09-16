const steps = [
  ['input', '输入材料'], ['jd', 'JD 解析'], ['diagnosis', '简历诊断'], ['match', '匹配分析'],
  ['questions', '经历追问'], ['optimize', '简历优化'], ['interview', '面试准备'], ['export', '导出结果']
];

const example = {
  role: 'AI 产品经理', industry: '企业服务 / 人工智能', company: '成长型科技公司', stage: '在职看机会',
  highlights: ['复杂业务抽象', 'ToB 产品设计', '数据分析能力'],
  jd: `岗位职责：\n1. 负责企业级 AI 产品的规划与落地，结合大模型能力设计智能工作流、知识库及 Copilot 类产品；\n2. 深入业务场景，完成需求洞察、产品方案、原型设计及项目推进；\n3. 与算法、研发、设计和业务团队协作，推动产品从 0 到 1 上线并持续迭代；\n4. 建立数据指标体系，基于用户反馈与产品数据优化效果。\n\n任职要求：\n1. 本科及以上学历，3 年以上 B 端产品经验；\n2. 熟悉大模型、RAG、Agent 等基本原理，有 AI 产品实践优先；\n3. 具备复杂业务抽象、数据分析和跨团队项目推动能力；\n4. 能独立完成 PRD、原型及产品规划，结果导向，沟通能力强。`,
  resume: `林晓｜产品经理｜5 年经验\n\n工作经历\n某企业软件公司｜产品经理｜2021.06 - 至今\n- 负责 ERP 采购及库存模块的需求分析、产品设计和版本迭代。\n- 参与 WMS 系统建设，与研发和实施团队沟通，推动产品上线。\n- 负责经营数据报表，整理业务需求并输出产品方案。\n- 日常收集客户反馈，提升用户体验。\n\n某互联网公司｜产品专员｜2019.07 - 2021.05\n- 负责后台产品功能设计，协助完成项目推进。\n- 跟进数据并输出周报。\n\n技能\nAxure、Figma、SQL、Excel、XMind\n\n教育背景\n某大学｜信息管理与信息系统｜本科｜2015 - 2019`,
  extra: `ERP 项目主要服务制造业客户；WMS 项目参与过出入库流程重构和移动端扫码功能。会使用 ChatGPT、Coze 做过个人知识库 Demo，了解 RAG 基本流程，但没有正式商业化 AI 产品上线经验。希望保留真实边界，不夸大 AI 经历。`
};

let analysis = {
  duties: ['规划企业级 AI 产品，设计知识库、智能工作流与 Copilot 场景', '深入业务完成需求洞察、方案和原型设计', '协同算法、研发与业务团队推动产品从 0 到 1', '建立指标体系，以数据和反馈驱动迭代'],
  hard: ['3 年以上 B 端产品经验', '可独立完成 PRD、原型和产品规划', '复杂业务抽象、数据分析、跨团队推动', '了解大模型、RAG、Agent 基本原理'],
  implicit: ['能把模型能力转译为可交付业务方案', '理解 AI 效果评估与不确定性管理', '既能做产品定义，也能推动技术交付', '有企业客户场景理解和商业敏感度'],
  keywords: ['AI 产品', '大模型', 'RAG', 'Agent', '知识库', '智能工作流', 'ToB', '0-1', '业务抽象', '指标体系', '跨团队协作'],
  capabilities: [
    ['复杂业务抽象', '高', 'ERP/WMS 复杂流程经验可迁移'], ['AI 产品理解', '高', 'JD 明确要求，当前仅有 Demo'], ['产品全流程', '高', '需证明独立规划到上线'],
    ['跨团队推动', '中高', '算法协作是新增要求'], ['数据驱动迭代', '中高', '经营报表是相关证据']
  ],
  dimensions: [['岗位相关性',72],['ToB 产品能力',82],['AI 产品证据',38],['成果量化',42],['关键词覆盖',64],['面试可信度',78]],
  issues: [
    ['P0','AI 实践证据不足','目前只有个人 Demo，不能写成商业化 AI 产品经验。应把它定位为“主动验证与能力补齐”。','red'],
    ['P0','经历停留在职责描述','大量使用“负责、参与、跟进”，缺少业务问题、关键动作、交付结果。','red'],
    ['P1','成果缺少口径','ERP、WMS 与报表均无规模、效率或采用情况，无法判断影响力。','amber'],
    ['P1','转型叙事未建立','ToB 经验与 AI 岗位之间的可迁移逻辑没有被清晰表达。','amber']
  ],
  matches: [
    ['3 年以上 B 端产品经验','5 年产品经验；ERP、WMS 企业软件','强','否','摘要中前置 ToB 年限及企业业务场景'],
    ['复杂业务抽象','采购、库存、出入库流程相关经验','中','是','补充具体流程难点、角色规则和方案取舍'],
    ['AI 产品实践','ChatGPT / Coze 个人知识库 Demo','弱','是','明确为个人实践；补充语料、召回、评测方法'],
    ['0-1 产品落地','参与 WMS 系统建设并推动上线','中','是','核实个人职责、起始阶段、交付范围与上线结果'],
    ['跨团队推动','与研发、实施团队沟通','中','是','补充协作对象、冲突与推进机制；无算法协作证据'],
    ['数据驱动迭代','经营数据报表、SQL/Excel','中','是','补充指标口径、使用对象和决策价值'],
    ['PRD / 原型能力','需求分析、产品方案；Axure/Figma','中','否','用代表项目体现实际交付物'],
    ['RAG / Agent 原理','了解 RAG 基本流程','弱','是','准备架构说明与 Demo 验证记录，不写“精通”']
  ],
  questions: [
    ['WMS 出入库流程重构前，最具体的业务问题是什么？涉及哪些角色、节点与异常场景？','用于证明复杂业务抽象能力'],
    ['你在 WMS 项目中独立负责了哪些决策和交付物？哪些是团队共同完成？','用于校准个人责任边界'],
    ['移动端扫码功能上线后，减少了哪些步骤或错误？统计周期、基线和数据来源是什么？','用于补全可验证结果'],
    ['ERP 采购与库存模块服务了多少客户或用户？你主导过最复杂的一次迭代是什么？','用于证明产品规模与主导能力'],
    ['经营数据报表面向哪些决策者？核心指标如何定义，最终影响了什么业务动作？','用于证明数据驱动能力'],
    ['知识库 Demo 解决什么问题？语料量、切分策略、召回方式与评测方法分别是什么？','用于补强真实 AI 实践'],
    ['项目中出现需求冲突或延期时，你如何判断优先级并推动研发、实施与业务达成一致？','用于证明跨团队推动'],
    ['你为什么从企业软件转向 AI 产品？既有 ToB 经验能降低 AI 产品落地中的什么风险？','用于形成可信的转型叙事']
  ],
  comparisons: [
    ['ERP 采购/库存','负责 ERP 采购及库存模块的需求分析、产品设计和版本迭代。','围绕制造业采购与库存场景，梳理关键角色、业务规则与异常流程，输出需求方案并协同研发完成模块迭代。【待补充：客户规模与结果】','补充业务对象与方法，保留结果缺口','结果数据待确认'],
    ['WMS 建设','参与 WMS 系统建设，与研发和实施团队沟通，推动产品上线。','参与 WMS 出入库流程重构，负责【待确认：具体范围】的需求分析与方案设计，协同研发、实施推动移动扫码功能上线。【待补充：上线效果】','把“参与”拆成可核验责任和交付物','主导程度待确认'],
    ['经营报表','负责经营数据报表，整理业务需求并输出产品方案。','面向【待补充：使用角色】梳理经营分析场景，定义【待补充：核心指标】口径并设计报表方案，支持业务进行【待补充：决策动作】。','从功能描述转为决策价值','指标与使用结果待确认'],
    ['AI 实践','会使用 ChatGPT、Coze 做过个人知识库 Demo。','基于 Coze 搭建个人知识库 Demo，实践文档处理、检索召回与回答调优流程，形成对 RAG 产品链路的基础理解；项目性质为个人验证，未用于商业上线。','展示主动实践并明确事实边界','不可表述为商业项目']
  ],
  interview: [
    ['你没有商业 AI 产品经验，为什么认为自己能胜任？','准备 ToB 复杂场景迁移逻辑，以及 Demo 的真实学习过程。'],
    ['请画出你的知识库 Demo 的 RAG 链路。','准备语料、切分、向量检索、召回和生成环节说明。'],
    ['你的 Demo 如何评估回答质量？','准备测试问题集、准确性判断方法；没有数据就明确说明。'],
    ['WMS 流程重构中你到底主导了什么？','拆分个人决策、交付物和团队成果。'],
    ['说一个复杂业务规则被你抽象为产品方案的例子。','准备角色、规则、异常、取舍与验证全过程。'],
    ['移动扫码功能带来了什么量化结果？','准备基线、上线后数据、统计周期与数据来源。'],
    ['你如何和算法工程师合作？','当前无直接证据；回答认知框架，不虚构合作经历。'],
    ['AI 产品与传统 SaaS 产品最大的差异是什么？','从能力边界、概率输出、评测和持续运营回答。'],
    ['需求冲突时你如何做优先级？','准备一次真实冲突案例和判断依据。'],
    ['入职 90 天你会如何推进第一个 AI 场景？','按业务价值、数据可得性、模型可行性和评测闭环拆解。']
  ]
};

const state = {
  current: 'input', analyzed: false, answers: Array(8).fill(''), bullets: Array(8).fill(''), style: 'balanced', provider: null, form: {...example, role:'',industry:'',company:'',stage:'',highlights:[],jd:'',resume:'',extra:''}
};

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const escapeHtml = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function renderNav() {
  $('#stepNav').innerHTML = steps.map(([id,label],i) => {
    const available = id === 'input' || state.analyzed;
    const currentIndex = steps.findIndex(s=>s[0]===state.current);
    return `<button class="step-link ${state.current===id?'active':''} ${state.analyzed && i<currentIndex?'complete':''}" data-step="${id}" ${available?'':'disabled'}><span class="step-index">${i+1}</span><span>${label}</span></button>`;
  }).join('');
}

function pageHead(step, title, desc, meta='') {
  return `<div class="eyebrow">Step ${step} / 8</div><div class="page-head"><div><h1 class="page-title">${title}</h1><p class="page-desc">${desc}</p></div>${meta?`<div class="head-meta">${meta}</div>`:''}</div>`;
}

function render() {
  renderNav();
  const views = { input: renderInput, jd: renderJD, diagnosis: renderDiagnosis, match: renderMatch, questions: renderQuestions, optimize: renderOptimize, interview: renderInterview, export: renderExport };
  $('#pageContent').innerHTML = `<section class="page">${views[state.current]()}</section>`;
  window.scrollTo({top:0, behavior:'smooth'});
}

function renderInput() {
  const f=state.form, tags=['复杂业务抽象','ToB 产品设计','数据分析能力','AI 产品理解','0-1 产品落地','跨团队推动'];
  return `${pageHead(1,'输入求职材料','提供目标岗位与真实经历。DeepSeek 会建立 JD 要求与简历证据的逐项映射。','预计分析耗时 30–90 秒')}
  <div class="form-card card"><h2 class="form-section-title"><span class="section-number">1</span>目标岗位</h2>
    <div class="grid two">
      <div class="field"><label>目标岗位 *</label><input id="role" value="${escapeHtml(f.role)}" placeholder="例如：AI 产品经理"></div>
      <div class="field"><label>目标行业</label><input id="industry" value="${escapeHtml(f.industry)}" placeholder="例如：企业服务 / 人工智能"></div>
      <div class="field"><label>公司类型</label><select id="company"><option value="">请选择</option>${['成长型科技公司','大厂 / 上市公司','创业公司','传统企业数字化部门'].map(x=>`<option ${f.company===x?'selected':''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>求职阶段</label><select id="stage"><option value="">请选择</option>${['准备转型','在职看机会','集中投递中','已有面试'].map(x=>`<option ${f.stage===x?'selected':''}>${x}</option>`).join('')}</select></div>
    </div>
    <div class="field" style="margin-top:18px"><label>希望突出能力 <span class="hint">可多选</span></label><div class="tag-picker">${tags.map(x=>`<label class="tag-check"><input type="checkbox" name="highlight" value="${x}" ${f.highlights.includes(x)?'checked':''}><span>${x}</span></label>`).join('')}</div></div>
  </div>
  <div class="grid two">
    <div class="form-card card"><h2 class="form-section-title"><span class="section-number">2</span>目标 JD</h2><div class="field"><label>完整岗位描述 *</label><textarea id="jd" placeholder="粘贴岗位职责与任职要求…">${escapeHtml(f.jd)}</textarea></div></div>
    <div class="form-card card"><h2 class="form-section-title"><span class="section-number">3</span>原始简历</h2><div class="field"><label>当前简历内容 *</label><textarea id="resume" placeholder="粘贴简历全文…">${escapeHtml(f.resume)}</textarea></div></div>
  </div>
  <div class="form-card card"><h2 class="form-section-title"><span class="section-number">4</span>补充信息</h2><div class="field"><label>项目、数据与事实边界 <span class="hint">选填</span></label><textarea id="extra" style="min-height:110px" placeholder="补充代表项目、成果数据、不希望夸大的内容…">${escapeHtml(f.extra)}</textarea></div></div>
  <div class="form-actions"><p>API Key 仅存在服务端 · 简历内容将发送至 DeepSeek 分析</p><div class="action-group"><button class="button secondary" data-action="example">使用示例数据</button><button class="button primary" data-action="analyze">使用 DeepSeek 分析 <span>→</span></button></div></div>`;
}

function renderJD() {
  return `${pageHead(2,'JD 解析','区分招聘方明示要求与合理推断，定位真正决定候选人质量的能力证据。','分析置信度：高')}
  <div class="grid two" style="margin-bottom:16px">
    ${[['核心职责',analysis.duties,'blue'],['硬性要求',analysis.hard,''],['隐性要求',analysis.implicit,'amber'],['理想候选人', analysis.ideal || ['具备目标岗位核心能力','能够提供可验证的成果证据','经历与业务场景高度相关'],'green']].map(([t,items,color])=>`<div class="card card-pad"><div class="card-title-row"><h3 class="card-title">${t}</h3><span class="badge ${color}">${t==='隐性要求'?'合理推断':'JD 依据'}</span></div><ul class="list-clean">${items.map(x=>`<li>${x}</li>`).join('')}</ul></div>`).join('')}
  </div>
  <div class="card card-pad" style="margin-bottom:16px"><div class="card-title-row"><div><h3 class="card-title">高频关键词</h3><p class="card-subtitle">建议自然嵌入，禁止机械堆砌</p></div><span class="badge">ATS 相关</span></div><div class="keyword-row">${analysis.keywords.map(x=>`<span class="keyword">${x}</span>`).join('')}</div></div>
  <div class="table-wrap"><table><thead><tr><th>核心能力</th><th>重要度</th><th>招聘判断</th><th>置信度</th></tr></thead><tbody>${analysis.capabilities.map(r=>`<tr><td><strong>${r[0]}</strong></td><td><span class="badge ${r[1]==='高'?'red':'amber'}">${r[1]}</span></td><td>${r[2]}</td><td>高</td></tr>`).join('')}</tbody></table></div>${nextButton('diagnosis','查看简历诊断')}`;
}

function renderDiagnosis() {
  const score = Math.max(0, Math.min(100, Number(analysis.score ?? 64)));
  return `${pageHead(3,'简历诊断','评分反映当前简历对这份 JD 的证据覆盖程度，不等同于录用概率。','基于 6 个维度')}
  <div class="card score-hero"><div class="score-ring" style="--score:${score}"><div class="score-value"><strong>${score}</strong><span>当前匹配度</span></div></div><div class="score-summary"><span class="badge ${score>=75?'green':score>=55?'amber':'red'}">${score>=75?'较高匹配':score>=55?'中等匹配 · 有明显缺口':'低匹配 · 关键证据不足'}</span><h3>${escapeHtml(analysis.scoreSummary || '岗位证据需要进一步补强')}</h3><p>${escapeHtml(analysis.scoreDescription || '评分基于当前 JD 与简历证据，不代表录用概率。')}</p><div class="score-metrics"><div class="metric-mini"><span>分析模型</span><strong>${escapeHtml(state.provider?.model || 'DeepSeek')}</strong></div><div class="metric-mini"><span>证据映射</span><strong>${analysis.matches.length} 项</strong></div><div class="metric-mini"><span>修改优先项</span><strong>${analysis.issues.length} 项</strong></div><div class="metric-mini"><span>判断置信度</span><strong>中</strong></div></div></div></div>
  <div class="grid two" style="margin-bottom:16px"><div class="card card-pad"><h3 class="card-title">维度评分</h3>${analysis.dimensions.map(([n,v])=>`<div class="dimension-row"><span>${n}</span><div class="progress"><i style="width:${v}%"></i></div><strong>${v}</strong></div>`).join('')}</div><div class="card card-pad"><h3 class="card-title" style="margin-bottom:14px">评分口径</h3><ul class="list-clean"><li><strong>加分：</strong>5 年 ToB、ERP/WMS 场景、具备数据工具基础</li><li><strong>扣分：</strong>AI 仅个人 Demo、结果量化不足、主导程度模糊</li><li><strong>边界：</strong>仅基于用户提供的 JD 与简历文本</li><li><strong>置信度：</strong>中；关键项目结果尚待追问确认</li></ul></div></div>
  <div class="grid two">${analysis.issues.map(([p,t,d,c])=>`<div class="card issue-card"><div class="priority"><span class="badge ${c}">${p}</span><span class="badge">置信度：高</span></div><h4>${t}</h4><p>${d}</p></div>`).join('')}</div>${nextButton('match','查看匹配分析')}`;
}

function renderMatch() {
  return `${pageHead(4,'JD × 简历匹配分析','逐项检查 JD 要求是否有真实简历证据，并给出补强路径。','覆盖 8 项要求')}
  <div class="risk-strip">结论：${escapeHtml(analysis.scoreDescription || '现有材料存在关键证据缺口，必须正面呈现并补充。')}</div>
  <div class="table-wrap"><table><thead><tr><th>JD 要求</th><th>简历证据</th><th>证据强度</th><th>是否补充</th><th>优化建议</th></tr></thead><tbody>${analysis.matches.map(r=>`<tr><td><strong>${r[0]}</strong></td><td>${r[1]}</td><td><span class="badge ${r[2]==='强'?'green':r[2]==='中'?'amber':'red'}">${r[2]}</span></td><td>${r[3]==='是'?'<span class="badge red">需要</span>':'<span class="badge green">暂不</span>'}</td><td>${r[4]}</td></tr>`).join('')}</tbody></table></div>${nextButton('questions','进入经历追问')}`;
}

function renderQuestions() {
  const completed=state.answers.filter(x=>x.trim()).length;
  return `${pageHead(5,'经历追问','回答最能改变简历质量的问题。回答会被整理成可用于简历的证据型表达。',`已回答 ${completed} / ${analysis.questions.length}`)}
  <div class="risk-strip">请只填写可以在面试中解释清楚的事实。没有准确数据时，可以描述可验证的流程结果，不要估算百分比。</div>
  ${analysis.questions.map(([q,w],i)=>`<div class="card question-card"><div class="question-head"><span class="question-no">${String(i+1).padStart(2,'0')}</span><div><p class="question-text">${q}</p><p class="question-why">${w}</p></div></div><textarea data-answer="${i}" placeholder="填写真实回答；可暂时留空…">${escapeHtml(state.answers[i])}</textarea>${state.bullets[i]?`<div class="generated-bullet"><strong>可用于简历的表达</strong>${escapeHtml(state.bullets[i])}</div>`:''}</div>`).join('')}
  <div class="form-actions"><p>回答越具体，生成表达的可信度越高</p><div class="action-group"><button class="button secondary" data-action="skip-questions">暂时跳过</button><button class="button primary" data-action="generate-bullets">生成优化表达</button></div></div>`;
}

function renderOptimize() {
  const labels={balanced:'专业平衡',concise:'更简洁',safe:'降低夸张',ai:'更偏 AI 产品',saas:'更偏 ToB SaaS'};
  return `${pageHead(6,'简历优化','对照查看每处修改的依据与风险，并切换表达策略。','当前风格：'+labels[state.style])}
  <div class="card style-bar"><span class="label">表达策略</span>${Object.entries(labels).map(([k,v])=>`<button class="style-chip ${state.style===k?'active':''}" data-style="${k}">${v}</button>`).join('')}</div>
  <div class="table-wrap" style="margin-bottom:24px"><table><thead><tr><th style="width:11%">模块</th><th style="width:22%">修改前</th><th style="width:31%">修改后</th><th style="width:20%">修改理由</th><th>风险提示</th></tr></thead><tbody>${analysis.comparisons.map(r=>`<tr><td><strong>${r[0]}</strong></td><td class="compare-before">${r[1]}</td><td class="compare-after">${stylize(r[2])}</td><td>${r[3]}</td><td><span class="badge amber">${r[4]}</span></td></tr>`).join('')}</tbody></table></div>
  <div class="card-title-row"><div><h2 class="page-title" style="font-size:20px;margin-bottom:4px">完整优化版简历</h2><p class="card-subtitle">基于当前材料生成 · 占位信息需本人确认</p></div><button class="button secondary small" data-action="copy-final">复制全文</button></div>${resumeHtml()}${nextButton('interview','查看面试准备')}`;
}

function stylize(text) {
  if(state.style==='concise') return text.replace(/围绕|基于|形成对/g,'').replace(/，/g,'，').split('。')[0]+'。';
  if(state.style==='safe') return text.replace(/负责/g,'参与').replace(/推动/g,'协同推进');
  if(state.style==='ai') return text.replace('个人知识库 Demo','RAG 知识库产品原型').replace('基础理解','产品链路理解');
  if(state.style==='saas') return text.replace('AI 产品','企业级 AI 产品').replace('客户','企业客户');
  return text;
}

function resumeHtml() {
  if (analysis.finalResume) return `<article class="resume-paper" id="finalResume"><div class="resume-plain">${escapeHtml(analysis.finalResume)}</div></article>`;
  return `<article class="resume-paper" id="finalResume"><div class="resume-header"><h2>林 晓</h2><p>产品经理 · 5 年经验　|　电话：【待填写】　|　邮箱：【待填写】　|　城市：【待填写】</p></div>
  <section class="resume-section"><h3>求职意向</h3><p><strong>${escapeHtml(state.form.role || 'AI 产品经理')}</strong>｜企业服务 / 人工智能｜${escapeHtml(state.form.company || '成长型科技公司')}</p></section>
  <section class="resume-section"><h3>职业摘要</h3><p>5 年 ToB 产品经验，持续负责 ERP 采购、库存及 WMS 等复杂企业业务场景的需求分析、方案设计与迭代推进。具备业务流程抽象、跨团队协作和数据报表设计经验；主动实践 RAG 知识库 Demo，理解从文档处理、检索召回到回答调优的基础链路。希望将企业软件场景积累迁移至 AI 产品落地。【AI 实践为个人项目，无商业化上线经验】</p></section>
  <section class="resume-section"><h3>核心能力</h3><p>ToB 产品设计　·　复杂业务流程抽象　·　需求分析与 PRD　·　跨团队项目推进　·　数据分析　·　RAG 基础实践</p></section>
  <section class="resume-section"><h3>工作经历</h3><div class="resume-item-head"><span>某企业软件公司｜产品经理</span><span>2021.06 - 至今</span></div><ul><li>围绕制造业采购与库存场景，梳理关键角色、业务规则与异常流程，输出需求方案并协同研发完成模块迭代。【待补充：客户规模与结果】</li><li>参与 WMS 出入库流程重构，负责【待确认：具体范围】的需求分析与方案设计，协同研发、实施推动移动扫码功能上线。【待补充：上线效果】</li><li>面向【待补充：使用角色】梳理经营分析场景，定义【待补充：核心指标】口径并设计报表方案，支持业务进行【待补充：决策动作】。</li></ul><div class="resume-item-head" style="margin-top:16px"><span>某互联网公司｜产品专员</span><span>2019.07 - 2021.05</span></div><ul><li>参与后台产品功能设计，协助完成需求分析、方案输出与项目跟进。【待补充：业务场景和结果】</li><li>跟进业务数据并输出周报，为团队日常运营提供信息支持。【待补充：指标与使用方式】</li></ul></section>
  <section class="resume-section"><h3>项目经历</h3><div class="resume-item-head"><span>个人知识库 Demo｜个人实践</span><span>【待补充：时间】</span></div><ul><li>基于 Coze 搭建个人知识库 Demo，实践文档处理、检索召回与回答调优流程，形成对 RAG 产品链路的基础理解；项目未用于商业上线。</li><li>【待补充：使用场景、语料规模、切分策略、测试问题与评测结果】</li></ul></section>
  <section class="resume-section"><h3>技能工具</h3><p>产品设计：Axure、Figma、XMind　｜　数据分析：SQL、Excel　｜　AI 工具：ChatGPT、Coze</p></section>
  <section class="resume-section"><h3>教育背景</h3><div class="resume-item-head"><span>某大学｜信息管理与信息系统｜本科</span><span>2015 - 2019</span></div></section></article>`;
}

function renderInterview() {
  return `${pageHead(7,'面试准备','围绕证据缺口与高风险表达，提前准备可验证、可追溯的回答。','10 个高概率追问')}
  <div class="risk-strip"><strong>最高风险：</strong>${escapeHtml(analysis.highestRisk || analysis.issues?.[0]?.[2] || '面试中无法解释简历中的关键表达。')}</div>
  <div class="grid two" style="margin-bottom:22px">${analysis.interview.map(([q,p],i)=>`<div class="card interview-card"><span class="num">${String(i+1).padStart(2,'0')}</span><div><h4>${q}</h4><p>${p}</p></div></div>`).join('')}</div>
  <div class="grid two" style="margin-bottom:22px"><div class="card card-pad"><div class="card-title-row"><h3 class="card-title">面试前必须准备的证据</h3><span class="badge red">${(analysis.evidenceToPrepare||[]).length || 4} 项</span></div><ul class="list-clean">${(analysis.evidenceToPrepare||['个人职责与团队成果的边界','代表项目的交付物与结果','关键数据的口径与来源','岗位核心能力的真实案例']).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div><div class="card card-pad"><div class="card-title-row"><h3 class="card-title">建议补充的数据</h3><span class="badge amber">待确认</span></div><ul class="list-clean">${(analysis.dataGaps||['项目规模与统计时间','关键结果及数据来源','个人贡献与协作范围','业务背景与方案取舍']).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div></div>
  <div class="card card-pad"><div class="card-title-row"><div><h3 class="card-title">60 秒自我介绍</h3><p class="card-subtitle">不回避缺口，先建立可迁移能力</p></div><button class="button secondary small" data-action="copy-intro">复制</button></div><div class="intro-box" id="intro">${escapeHtml(analysis.intro || '请根据真实经历准备自我介绍。')}</div></div>${nextButton('export','进入导出结果')}`;
}

function renderExport() {
  return `${pageHead(8,'导出结果','将优化结果复制到剪贴板，或使用预留导出入口。','分析流程已完成')}
  <div class="card card-pad" style="margin-bottom:16px"><div class="card-title-row"><div><h3 class="card-title">交付完整度</h3><p class="card-subtitle">仍有 12 处信息需要本人补充确认</p></div><span class="badge green">8 / 8 已完成</span></div><div class="progress" style="height:8px"><i style="width:100%"></i></div></div>
  <div class="grid two">
    <div class="card export-card"><div class="export-icon">文</div><div class="export-info"><h3>优化版完整简历</h3><p>纯文本格式，可粘贴到 Word / Notion</p></div><button class="button primary small" data-action="copy-final">复制</button></div>
    <div class="card export-card"><div class="export-icon">问</div><div class="export-info"><h3>面试准备清单</h3><p>10 个追问、证据与风险提示</p></div><button class="button secondary small" data-action="copy-interview">复制</button></div>
    <div class="card export-card"><div class="export-icon">JD</div><div class="export-info"><h3>岗位匹配报告</h3><p>JD 解析、评分与证据映射</p></div><button class="button secondary small" data-action="placeholder">导出 PDF</button></div>
    <div class="card export-card"><div class="export-icon">包</div><div class="export-info"><h3>全部分析结果</h3><p>简历、分析与面试材料打包</p></div><button class="button secondary small" data-action="placeholder">下载</button></div>
  </div>
  <div class="risk-strip" style="margin-top:18px">投递前检查：删除所有【待补充 / 待确认】占位符，并确保每个数字都能说明数据来源、统计周期和个人贡献。</div>`;
}

function nextButton(step,label){ return `<div style="display:flex;justify-content:flex-end;margin-top:20px"><button class="button primary" data-step="${step}">${label} →</button></div>`; }

function collectForm(){
  ['role','industry','company','stage','jd','resume','extra'].forEach(id=>{const el=$('#'+id); if(el) state.form[id]=el.value.trim();});
  state.form.highlights=$$('input[name=highlight]:checked').map(x=>x.value);
}

/* Prompt 配置以服务端为准（管理后台维护，data/prompts.json）。
 * 启动时拉一次缓存；若接口不可用（例如纯静态部署），退回旧的 localStorage 方案，
 * 保证前端在任何部署形态下都能工作。 */
let serverPromptConfig = null;

async function loadPromptConfig(){
  try {
    const response=await fetch('/api/prompts/active');
    if(!response.ok) return;
    const data=await response.json();
    if(Array.isArray(data.prompts)){
      serverPromptConfig=data.prompts;
      if(data.truncated?.length) console.warn('[prompts] 以下 Prompt 超出长度上限，已截断：',data.truncated);
      if(data.dropped?.length) console.warn('[prompts] 以下 Prompt 超出条数上限，未注入：',data.dropped);
    }
  } catch { /* 静默退回本地配置 */ }
}

function getActivePromptConfig(){
  if(Array.isArray(serverPromptConfig)&&serverPromptConfig.length) return serverPromptConfig;
  try {
    const items=JSON.parse(localStorage.getItem('resume-expert-prompts-v2')||'[]');
    if(!Array.isArray(items)) return [];
    return items.filter(p=>p&&p.enabled&&p.content).slice(0,20).map(p=>({step:Number.isFinite(Number(p.step))?Number(p.step):null,stepKey:String(p.stepKey||'extension').slice(0,40),name:String(p.name||'自定义 Prompt').slice(0,80),content:String(p.content)}));
  } catch { return []; }
}

function showToast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>t.classList.remove('show'),2200); }
function showDialog(){ const d=$('#dialog'); d.innerHTML=`<div class="dialog"><h3>导出功能即将开放</h3><p>当前版本已支持复制到剪贴板。PDF 与文件下载将在接入服务端后开放。</p><div class="dialog-actions"><button class="button primary" data-action="close-dialog">知道了</button></div></div>`; d.classList.add('open'); d.setAttribute('aria-hidden','false'); }
async function copyText(text,msg='已复制到剪贴板'){ try{ await navigator.clipboard.writeText(text); showToast(msg); }catch{ const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();showToast(msg); } }
function getResumeText(){ const el=$('#finalResume'); if(el) return el.innerText; const previous=state.current; state.current='optimize'; const box=document.createElement('div');box.innerHTML=resumeHtml();const text=box.innerText;state.current=previous;return text; }
function interviewText(){ return '面试准备清单\n\n'+analysis.interview.map((x,i)=>`${i+1}. ${x[0]}\n准备：${x[1]}`).join('\n\n'); }

document.addEventListener('click', async e=>{
  const step=e.target.closest('[data-step]'); if(step && !step.disabled){ if(state.current==='input') collectForm(); state.current=step.dataset.step; render(); return; }
  const btn=e.target.closest('[data-action]'); if(!btn) return;
  const action=btn.dataset.action;
  if(action==='example'){ state.form={...example,highlights:[...example.highlights]}; render(); showToast('示例数据已填入'); }
  if(action==='analyze'){
    collectForm();
    if(!state.form.role||!state.form.jd||!state.form.resume){ showToast('请先填写目标岗位、JD 和原始简历'); return; }
    btn.disabled=true; btn.innerHTML='DeepSeek 正在分析，可能需要 30–90 秒…';
    try {
      const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...state.form,promptConfig:getActivePromptConfig()})});
      const result=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(result.error||`分析请求失败（HTTP ${response.status}）`);
      analysis={...analysis,...result.analysis};
      state.provider={model:result.model,usage:result.usage};
      state.answers=Array(analysis.questions.length).fill(''); state.bullets=Array(analysis.questions.length).fill('');
      state.analyzed=true; state.current='jd'; render(); showToast(`DeepSeek 分析完成 · ${result.model||'模型'}`);
    } catch(error) { btn.disabled=false; btn.innerHTML='使用 DeepSeek 分析 <span>→</span>'; showErrorDialog(error.message); }
  }
  if(action==='generate-bullets'){ $$('[data-answer]').forEach(x=>state.answers[+x.dataset.answer]=x.value.trim()); state.bullets=state.answers.map((a,i)=>a?`${a.replace(/[。！？]+$/,'')}；由此形成可验证的${analysis.questions[i][1].replace('用于','')}证据。`:''); state.current='optimize'; render(); showToast(state.answers.some(Boolean)?'已基于回答生成表达':'已按现有材料生成保守表达'); }
  if(action==='skip-questions'){ state.current='optimize';render(); }
  if(action==='copy-final') copyText(getResumeText(),'最终简历已复制');
  if(action==='copy-intro') copyText($('#intro')?.innerText||'','自我介绍已复制');
  if(action==='copy-interview') copyText(interviewText(),'面试清单已复制');
  if(action==='placeholder') showDialog();
  if(action==='close-dialog'){ $('#dialog').classList.remove('open');$('#dialog').setAttribute('aria-hidden','true'); }
  if(action==='reset'){ showResetDialog(); }
});

document.addEventListener('click', e=>{
  const style=e.target.closest('[data-style]'); if(style){state.style=style.dataset.style;render();showToast('表达策略已切换');}
});
document.addEventListener('input', e=>{ if(e.target.matches('[data-answer]')) state.answers[+e.target.dataset.answer]=e.target.value; });

function showResetDialog(){ const d=$('#dialog'); d.innerHTML=`<div class="dialog"><h3>重新开始？</h3><p>当前填写内容和分析结果将被清空。</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">取消</button><button class="button primary" id="confirmReset">确认清空</button></div></div>`; d.classList.add('open'); $('#confirmReset').onclick=()=>{state.current='input';state.analyzed=false;state.answers=Array(8).fill('');state.bullets=Array(8).fill('');state.form={...example,role:'',industry:'',company:'',stage:'',highlights:[],jd:'',resume:'',extra:''};d.classList.remove('open');render();showToast('已清空');}; }

function showErrorDialog(message){ const d=$('#dialog'); d.innerHTML=`<div class="dialog"><h3>DeepSeek 分析未完成</h3><p>${escapeHtml(message)}</p><div class="dialog-actions"><button class="button primary" data-action="close-dialog">返回修改</button></div></div>`; d.classList.add('open'); d.setAttribute('aria-hidden','false'); }

render();
loadPromptConfig();
