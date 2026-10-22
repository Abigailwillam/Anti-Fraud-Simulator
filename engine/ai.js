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

/* ================================================================
 * 三、模型能力（是否支持图片输入）
 * ---------------------------------------------------------------
 * 为什么需要这一层：截图辨析完全依赖模型的视觉能力，
 * 而「模型不支持视觉」与「这张图难辨」在界面上长得一模一样（都是「无法判断」）。
 * 只要在发请求前就能判定模型支不支持图片，就能把 90% 的「读不出图」挡在请求之前。
 *
 * 依据（各家官方能力表，不是猜的）：
 *   - DeepSeek：图像理解仅 deepseek-flash 支持；
 *     deepseek-v4-pro / deepseek-chat / deepseek-reasoner / deepseek-r1 均为纯文本模型。
 *   - OpenAI：gpt-4o / gpt-4.1 / gpt-4.5 / gpt-4-turbo 支持视觉，gpt-3.5 不支持。
 * 名单刻意保守：只有明确有官方依据的系列才下结论，其余一律返回 unknown，不打扰用户。
 */

/** DeepSeek 官方 API 域名（只有官方域名才会自动带上 DeepSeek 专属参数） */
const DEEPSEEK_HOSTS = ['api.deepseek.com'];
/** 建议替换用的视觉模型（DeepSeek 官方唯一支持图像理解的模型） */
export const DEEPSEEK_VISION_MODEL = 'deepseek-flash';

/** 已知「纯文本、不支持图片输入」的模型系列 */
const TEXT_ONLY_MODEL_PATTERNS = [
  /^deepseek-(chat|reasoner|r1|v3|v3\.1|v3\.2|v4-pro|v4-preview)/i,
  /^gpt-3\.5/i,
  /^text-davinci/i,
];

/** 已知「支持图片输入」的模型系列 */
const VISION_MODEL_PATTERNS = [
  /^deepseek-(flash|v4-flash)/i,
  /^gpt-4o/i,
  /^gpt-4\.1/i,
  /^gpt-4\.5/i,
  /^gpt-4-turbo/i,
  /^qwen.*vl/i,
  /^qwen2\.5-vl/i,
  /^qwen3-vl/i,
  /^gemini/i,
  /^claude-[3-9]/i,
  /^glm-4v/i,
  /^kimi-vl/i,
  /^ernie.*vl/i,
  /^doubao.*vision/i,
  /^hunyuan-vision/i,
];

/** 常见视觉模型示例（提示文案用） */
export const VISION_MODEL_EXAMPLES = ['deepseek-flash', 'gpt-4o', 'gpt-4o-mini', 'qwen-vl'];

/**
 * baseUrl 是否指向 DeepSeek 官方 API（纯函数）。
 */
export function isDeepSeekOfficial(baseUrl) {
  const s = String(baseUrl || '').trim().toLowerCase();
  if (!s) return false;
  const m = /^[a-z]+:\/\/([^/:?#]+)/.exec(s);
  return !!m && DEEPSEEK_HOSTS.includes(m[1]);
}

/**
 * 判定当前模型是否支持图片输入（纯函数，可单测）。
 * @param {string} model 模型名
 * @param {string} [baseUrl] 接口地址：用于决定能否给出「一键换模型」的具体建议
 * @returns {{state:'yes'|'no'|'unknown', reason:string, suggestModel:string, examples:string[]}}
 */
export function describeVisionSupport(model, baseUrl) {
  const m = String(model || '').trim();
  const examples = VISION_MODEL_EXAMPLES.slice();
  if (!m) {
    return { state: 'unknown', reason: '尚未填写模型名，无法判断是否支持图片输入。', suggestModel: '', examples };
  }
  if (TEXT_ONLY_MODEL_PATTERNS.some((p) => p.test(m))) {
    // 官方 DeepSeek 接口能给出确定可用的替换模型；中转站只给通用示例
    const suggestModel = isDeepSeekOfficial(baseUrl) ? DEEPSEEK_VISION_MODEL : '';
    return {
      state: 'no',
      reason: `模型「${m}」是纯文本模型，不支持图片输入（多模态）——截图辨析必然读不到内容。`,
      suggestModel,
      examples,
    };
  }
  if (VISION_MODEL_PATTERNS.some((p) => p.test(m))) {
    return { state: 'yes', reason: `模型「${m}」支持图片输入，截图辨析可用。`, suggestModel: '', examples };
  }
  return {
    state: 'unknown',
    reason: `无法从模型名「${m}」判断是否支持图片输入，可用面板里的「测试视觉」一秒验证。`,
    suggestModel: '',
    examples,
  };
}

/**
 * 组装请求体（纯函数，可单测）。
 *
 * DeepSeek 官方接口默认开启「思考模式」：思维链会占用 max_tokens 预算，
 * 预算不够时最终答案为空——实测一次截图辨析的思维链吃掉 770 token、答案只占 482 token，
 * 若 max_tokens 偏小就会表现为「接口未返回可用文本」。
 * 因此对 DeepSeek 官方接口显式关闭思考模式：token 减半、延迟更低，且答案不会被预算截断。
 * 只对官方域名 + 当前在售的 V4 系列模型生效，中转站与其他厂商一律不受影响。
 */
export function buildChatBody(cfg, messages, tokenBudget) {
  const body = {
    model: cfg.model,
    messages,
    temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.9,
    max_tokens: tokenBudget,
    stream: false,
  };
  if (isDeepSeekOfficial(cfg.baseUrl) && /^deepseek-(flash|v4-pro)/i.test(String(cfg.model || ''))) {
    body.thinking = { type: 'disabled' };
  }
  return body;
}

/**
 * 调用 OpenAI 兼容的 chat/completions 接口。
 * @param {{baseUrl:string, apiKey:string, model:string, temperature?:number, maxTokens?:number}} cfg
 * @param {Array<{role:string, content:string}>} messages
 * @param {{timeoutMs?:number, fetchImpl?:Function, maxTokens?:number}} [opts]
 *   maxTokens 优先于 cfg.maxTokens：用于按场景覆盖输出预算（多模态读图需要远大于纯文本的额度）。
 * @returns {Promise<string>} 模型回复文本
 */
export async function callChat(cfg, messages, { timeoutMs = 30000, fetchImpl, maxTokens } = {}) {
  const { ok, errors } = validateSettings(cfg);
  if (!ok) throw new Error('配置无效：' + errors.join('；'));

  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('当前环境没有 fetch，无法调用 API');

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  // 输出预算：请求级 > 配置级 > 默认 400
  // 默认 400 对纯文本生成够用，但多模态读图（长截图、多宫格拼图）需要大量推理额度，
  // 400 会在「还没读完图」时就把响应截断，表现为模型声称「图片不可读」。
  const tokenBudget = Number(maxTokens) || Number(cfg.maxTokens) || 400;

  try {
    const res = await f(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(buildChatBody(cfg, messages, tokenBudget)),
      signal: controller ? controller.signal : undefined,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`接口返回 ${res.status}${detail ? '：' + detail.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    const choice = (data && data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    const content = typeof msg.content === 'string' ? msg.content : '';
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';

    if (!content.trim()) {
      // 开了思考模式的接口，思维链在 reasoning_content 里；
      // 若 max_tokens 预算被思维链吃光，最终答案就是空的——这不是「模型没话说」，
      // 报「接口未返回可用文本」会让人完全摸不着头脑，必须说清楚。
      if (reasoning.trim()) {
        throw new Error('模型只返回了思考过程（reasoning_content），最终答案为空——通常是思考模式占满了输出预算。'
          + '请调大输出预算，或在模型侧关闭思考模式（DeepSeek：thinking.type=disabled）。');
      }
      if (choice.finish_reason === 'length') {
        throw new Error('输出被截断：已达到 max_tokens 上限，仍未产生完整回答。请调大输出预算。');
      }
      throw new Error('接口未返回可用文本');
    }
    return cleanModelText(content);
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