/**
 * 规则引擎 · 纯函数集合（可单元测试，无副作用）
 * 所有判定均为「关键词/正则 + 明确规则表」，不依赖运行时 AI 推断。
 */

/** 规则表：受骗者回复 → 意图分类。顺序即优先级，先匹配先赢。 */
export const INTENT_RULES = [
  {
    intent: 'terminate',
    weight: 100,
    patterns: [
      /(挂断|挂了|再见|结束|不聊了|停止|不说了|别说了)/,
      /(报警|110|96110|12315|12395|反诈中心|找警察|曝光|举报|维权|起诉|律师|市场监管)/,
      /(拉黑|删了?好友|删除好友|屏蔽|举报|不再理|不聊了|关掉)/,
      /(我是不会|不可能|休想|想骗我|别费劲|我早就看穿|你就是骗子|骗子)/i,
    ],
  },
  {
    intent: 'suspicious',
    weight: 60,
    patterns: [
      /(真的吗|确定吗|凭什么|为什么|有没有工号|哪个单位|哪个部门|派出所|能查证|核实|验证一下|怎么证明)/,
      /(安全账户|国家|公安|法院|检察院|工信部|银监|证监会|监管|三包|规定|反诈中心|经侦)/,
      /(免费的|要钱|收费|手续费|保证金|解冻|提现|垫付|先转|先付|刷单|兼职|日结)/,
      // 微信场景下的反问：索要资质证明、要求走官方渠道核实
      /(营业执照|资格证|从业资格|执业编号|备案|企查查|天眼查|官方客服电话|自己查)/,
    ],
  },
  {
    intent: 'comply',
    weight: 40,
    patterns: [
      // 配合类动作：做了/要给钱/装好了，即使不说「好的」也算顺从
      /(已经?下载|装好了|安装了?|打开了?|屏幕共享|远程控制|授权了)/,
      /(我转|已转|转账|打款|付款|扫了|扫码|付了|充值了|垫付|借钱)/,
      /(验证码是|密码是|卡号是|手机号是|我住在|我叫)/,
      // 礼貌应答：需带词边界，避免「嗯今天」「行不」误伤
      /(?:^|[^\u4e00-\u9fa5])(好的|好呀|可以|OK|ok|收到|明白|知道了|在的|我在|同意|愿意)(?:[^\u4e00-\u9fa5]|$)/,
      /(怎么做|怎么办|怎么操作|怎么弄|发我|给我|听你的|你说|我信|我相信)/,
    ],
  },
];

/**
 * 判定用户回复意图。
 * @param {string} input
 * @returns {{intent:string, matched:string|null}}
 */
export function classifyIntent(input) {
  const text = String(input || '');
  for (const rule of INTENT_RULES) {
    for (const p of rule.patterns) {
      if (p.test(text)) return { intent: rule.intent, matched: String(p) };
    }
  }
  return { intent: 'neutral', matched: null };
}

/**
 * 受骗者「危险行为」检测：是否已交出敏感信息 / 表示愿意转账。
 * 返回命中的风险项列表（用于实时告警与复盘评分）。
 */
export const RISK_PATTERNS = [
  { id: 'card', label: '提供了银行卡号', patterns: [/\d[\d\s-]{13,21}\d/, /银行卡号?\s*(是|为)?\s*\d{6,}/] },
  { id: 'phone', label: '提供了手机号/住址等身份信息', patterns: [/\b1[3-9]\d{9}\b/, /(我住在|我家在|身份证号|姓名是|我叫)/] },
  { id: 'otp', label: '透露了验证码/密码', patterns: [/(验证码|密码|支付密码|取款密码)/] },
  { id: 'transfer', label: '表示愿意转账/付款', patterns: [/(我转|已转|转账|打款|付款|扫了|扫码|付了|充值了|垫付|借钱)/] },
  { id: 'install', label: '同意下载安装对方指定的 APP / 打开对方发的链接', patterns: [/(下载了|装好了|打开了?那个?链接|安装了|已下载|点开了|我在里面)/] },
  { id: 'screen', label: '同意屏幕共享/远程控制', patterns: [/(屏幕共享|远程控制|共享屏幕|授权了|同意了共享)/] },
  { id: 'qrcode', label: '发送或扫描收款码/二维码', patterns: [/(收款码|二维码|微信转账|发你收款|扫了?收款)/] },
  { id: 'keepalive', label: '继续配合并要求隐藏通话', patterns: [/(不挂电话|继续说|别挂|我配合|我不说|不会告诉)/] },
];

/** @returns {string[]} 命中的风险 id 列表 */
export function detectRisks(input) {
  const text = String(input || '');
  return RISK_PATTERNS.filter((r) => r.patterns.some((p) => p.test(text))).map((r) => r.id);
}

/** 命中风险的中文说明 */
export const RISK_LABELS = Object.fromEntries(RISK_PATTERNS.map((r) => [r.id, r.label]));

/**
 * 阶段推进规则：诈骗方读到用户意图后如何推进。
 * - comply   → 前进一阶段（危险度升级）
 * - neutral  → 原地重复当前阶段话术（骗子不会因为你沉默就收手）
 * - suspicious→ 停留在当前阶段并加压（试图用话术化解质疑）
 * - terminate→ 进入复盘
 */
export function nextStep(currentIndex, intent, totalStages) {
  if (intent === 'terminate') return { action: 'terminate', index: currentIndex };
  if (intent === 'comply') {
    const next = Math.min(currentIndex + 1, totalStages - 1);
    return { action: next > currentIndex ? 'advance' : 'hold', index: next };
  }
  if (intent === 'suspicious') return { action: 'pressure', index: currentIndex };
  return { action: 'hold', index: currentIndex };
}

/**
 * 风险评分（0-100，越高越危险）。纯计算，便于测试。
 * @param {{turns:number, complied:number, risks:string[], stageIndex:number}} s
 */
export function scoreRisk({ turns, complied, risks, stageIndex }) {
  const base = 20;
  const complyPenalty = Math.round((complied / Math.max(turns, 1)) * 40);
  const riskPenalty = risks.length * 10;
  const stagePenalty = stageIndex * 10;
  return Math.min(100, base + complyPenalty + riskPenalty + stagePenalty);
}

/** 风险等级判定（确定性） */
export function riskLevel(score) {
  if (score >= 70) return { level: '危险', color: '#d93025', advice: '你在演练中表现得很顺从，真实环境里这几乎必然造成损失。' };
  if (score >= 40) return { level: '偏高', color: '#e08600', advice: '你有警觉但仍在配合，骗子只需要再加一轮压力就会突破。' };
  if (score >= 15) return { level: '谨慎', color: '#1e8e3e', advice: '你保持了 questioning 的态度，继续练习把它变成条件反射。' };
  return { level: '安全', color: '#188038', advice: '你成功打断了诈骗节奏，这是最理想的结果。' };
}
