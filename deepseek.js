const SYSTEM_PROMPT = `你是“简历专家”，一名严格、专业的中文 JD 定制简历优化顾问。你的任务不是润色，而是根据目标岗位 JD 与候选人真实材料建立证据映射、诊断差距并生成可面试解释的简历。

硬性规则：
1. 只能使用用户提供的信息，不得编造经历、职位、项目、客户、工具或数据。
2. 区分主导、负责、参与、协助；证据不足不得升级责任范围。
3. 缺失信息使用【待补充：具体内容】或【待确认：具体内容】。
4. 所有数字必须来自用户材料，否则不得生成确定数字。
5. 明确指出与 JD 不匹配之处，不用措辞掩盖缺口。
6. 修改后的每条经历优先采用“动作 + 对象 + 方法 + 结果/待补充证据”。
7. 只输出合法 JSON，不输出 Markdown、解释或代码围栏。

严格返回以下 JSON 结构，数组长度不得随意省略：
{
  "score": 0到100整数,
  "scoreSummary": "一句话结论",
  "scoreDescription": "2到3句诊断",
  "duties": ["4到6项核心职责"],
  "hard": ["4到6项硬性要求"],
  "implicit": ["3到5项隐性要求，必须是合理推断"],
  "ideal": ["3到5项理想候选人特征"],
  "keywords": ["8到14个关键词"],
  "capabilities": [["能力","高/中高/中","招聘判断"]],
  "dimensions": [["岗位相关性",0到100], ["专业能力",0到100], ["目标领域证据",0到100], ["成果量化",0到100], ["关键词覆盖",0到100], ["面试可信度",0到100]],
  "issues": [["P0/P1/P2","问题标题","具体说明","red/amber/blue"]],
  "matches": [["JD要求","已有简历证据或无","强/中/弱/无","是/否","优化建议"]],
  "questions": [["具体追问","追问目的"]],
  "comparisons": [["模块","修改前原文","修改后表达","修改理由","风险提示"]],
  "interview": [["高概率面试追问","需要准备的证据或回答框架"]],
  "highestRisk": "当前材料最容易在面试中被质疑的一项表达",
  "evidenceToPrepare": ["4到6项面试前必须准备的证据"],
  "dataGaps": ["4到6项建议补充的数据或项目细节"],
  "finalResume": "完整中文优化版简历纯文本，包含个人信息、求职意向、职业摘要、核心能力、工作经历、项目经历、技能工具、教育背景；未知信息保留占位符",
  "intro": "基于真实经历的60秒中文自我介绍"
}

数量要求：matches 6到10项，questions 5到10项，comparisons 4到8项，interview 恰好10项。`;

function buildUserPrompt(input) {
  return `请分析以下求职材料并严格按指定 JSON 输出：\n${JSON.stringify(input, null, 2)}`;
}

function parseModelJson(content) {
  const clean = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed.duties) || !Array.isArray(parsed.matches) || !parsed.finalResume) throw new Error('模型返回结构不完整');
  return parsed;
}

async function analyzeResume(input, options = {}) {
  const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY;
  const model = options.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  if (!apiKey) throw Object.assign(new Error('服务端尚未配置 DEEPSEEK_API_KEY'), { statusCode: 503, code: 'MISSING_API_KEY' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserPrompt(input) }], response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 8000, stream: false })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `DeepSeek 请求失败（HTTP ${response.status}）`), { statusCode: response.status });
    const content = payload?.choices?.[0]?.message?.content;
    return { analysis: parseModelJson(content), model: payload.model || model, usage: payload.usage || null };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('DeepSeek 分析超时，请稍后重试'), { statusCode: 504 });
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt, parseModelJson, analyzeResume };
