/**
 * AI 话术层：把知识库里的阶段信息编译成 system prompt，并调用 OpenAI 兼容接口。
 * ---------------------------------------------------------------
 * 分工原则（重要）：
 *   规则引擎  → 决定剧情走到第几阶段、风险评分、是否终止（确定性、可复现、可单测）
 *   AI        → 只负责把当前阶段的话术「说成人话」，保持人设
 * 这样换任何一家模型都不影响演练的可评估性。
 *
 * 安全约束：
 *   1. system prompt 明确禁止 AI 泄露破绽提示、禁止提供任何可执行的诈骗操作指引。
 *   2. 模型输出仍会经过 kb/scenarios.js 的 sanitize() 二次脱敏。
 *   3. baseUrl / key 由用户在设置面板填写，代码里不含任何默认密钥。
 */

/** 编译人设 system prompt（纯函数，可单测） */
export function buildSystemPrompt(scenario, stage, opts = {}) {
  const { pressure = false, personaName = scenario.contact.nickname } = opts;
  const samples = stage.lines.map((l) => `示例：${l.replace(/\n/g, ' / ')}`).join('\n');
  return [
    `你现在扮演一个正在实施诈骗的人，在微信里与「受害者」聊天。你就是对方本人，不要跳出角色。`,
    ``,
    `【你的身份】${scenario.persona}`,
    `微信昵称：${scenario.contact.nickname}`,
    `与受害者的关系：${scenario.contact.source}`,
    ``,
    `【当前剧情阶段】${stage.name}`,
    `本阶段你的目标：${stage.goal}`,
    ``,
    `【本阶段你的话术风格参考】`,
    samples,
    ``,
    `【硬性规则】`,
    `1. 只输出发给对方的微信消息正文，不要加引号、不要写"对方说"之类的旁白、不要用 markdown。`,
    `2. 长度控制在 1-3 句，像真人随手打字；可换行分段，不要长篇大论。`,
    `3. 严禁承认自己在诈骗，严禁提到"演练""剧本""教学""破绽""风险提示"等字样。`,
    `4. 严禁提供任何可实际执行的诈骗操作指引、工具推荐或规避检测方法。`,
    `5. 严禁编造真实的银行账号、手机号、链接、二维码等；需要指代时用"我发你""点这个链接"这类说法。`,
    pressure ? `6. 对方刚提出质疑或索要证据。你要急于自证、回避核心问题、用流程和规定压他，但绝不能给出可查证的凭证。` : `6. 按本阶段目标自然推进对话。`,
    ``,
    `现在以「${personaName}」的身份回复对方最后一句话。`,
  ].join('\n');
}

/** 把会话历史编译成 messages 数组（纯函数） */
export function buildMessages(scenario, transcript, limit = 12) {
  const recent = transcript.slice(-limit);
  return recent
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'scammer' ? 'assistant' : 'user', content: m.text }));
}

/** 从模型返回内容里剥掉可能的引号/旁白（纯函数） */
export function cleanModelText(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  t = t.replace(/^["'「『](.*)["'」』]$/s, '$1').trim();
  // 去掉模型偶尔加的「对方：」「回复：」前缀
  t = t.replace(/^(对方|回复|assistant|AI)\s*[:：]\s*/i, '').trim();
  return t;
}

/** 校验用户填写的设置（纯函数）→ { ok, errors } */
export function validateSettings(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['配置为空'] };
  if (!cfg.baseUrl || !/^https?:\/\/.+/i.test(cfg.baseUrl)) errors.push('Base URL 必须是 http(s) 开头的地址');
  if (!cfg.apiKey || String(cfg.apiKey).trim().length < 8) errors.push('API Key 长度不足');
  if (!cfg.model || String(cfg.model).trim().length === 0) errors.push('模型名不能为空');
  return { ok: errors.length === 0, errors };
}

/**
 * 调用 OpenAI 兼容的 chat/completions 接口。
 * @param {{baseUrl:string, apiKey:string, model:string, temperature?:number, maxTokens?:number}} cfg
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Promise<string>} 模型回复文本
 */
export async function callChat(cfg, messages, { timeoutMs = 30000, fetchImpl } = {}) {
  const { ok, errors } = validateSettings(cfg);
  if (!ok) throw new Error('配置无效：' + errors.join('；'));

  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('当前环境没有 fetch，无法调用 API');

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.9,
        max_tokens: cfg.maxTokens || 400,
        stream: false,
      }),
      signal: controller ? controller.signal : undefined,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`接口返回 ${res.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('接口未返回可用文本');
    return cleanModelText(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 判定模型输出是否越界（泄露破绽 / 自称演练 / 提供可执行指令）。
 * 命中则丢弃该条输出，退回规则话术。纯函数，可单测。
 */
const LEAK_PATTERNS = [
  /破绽|风险提示|教学|演练|剧本|知识点|反诈提示/,
  /\b(提示|注意)：?你(应该|可以)/,
  /(这是(演练|模拟|测试))/,
  /(教你|教你识别|如何识别诈骗|防骗指南)/,
  /(建议(你|您)(立即)?(报警|拉黑|举报))/,
  /作为(一个)?(AI|人工智能|助手|语言模型)/,
];

export function isLeaking(text) {
  const t = String(text || '');
  return LEAK_PATTERNS.some((p) => p.test(t));
}