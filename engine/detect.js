/**
 * 诈骗辨析引擎 · 纯函数集合（可单元测试，无副作用）
 * ---------------------------------------------------------------
 * 输入：用户上传的聊天记录（文本 / 图片）
 * 输出：是否存在诈骗嫌疑的结论 + 风险等级 + 可疑点逐条说明 + 判断依据摘要 + 防骗建议
 *
 * 分工原则与本项目其余模块一致（见 engine/ai.js 顶部注释）：
 *   本地规则层 → 特征命中、风险分、等级判定、结论仲裁（确定性、可复现、可单测）
 *   AI 层→ 只负责语义研判的自然语言表述与规则未覆盖的语义线索
 * 因此换任何一家模型都不改变「结论口径」，AI 不可用时整体降级为纯规则结论，
 * 功能不中断（离线可用）。
 *
 * 安全约束：
 *   1. AI 的输出必须通过 parseAnalysis() 的严格结构校验，非法即丢弃并降级。
 *   2. AI 不能推翻本地规则的强信号：规则分 ≥ AI_OVERRIDE_SCORE 且 AI 判「否」时，
 *      结论被强制为「是」，冲突写入 notes（而不是偷偷改写 AI 的说法）。
 *   3. AI 只被要求「识别与劝阻」，越界给出可执行诈骗操作指引时按 unsafe 处理（纯函数判定）。
 *   4. 上传的文本不落盘、不持久化，仅存在于内存与本次请求。
 */

// 辨析引擎要用到 AI 层的「模型是否支持图片」判定（同一份口径，避免两处各说各话）
import { describeVisionSupport } from './ai.js';

/* ================================================================
 * 一、上传校验（格式与大小上限——界面上明示的同一份口径）
 * ============================================================== */

/** 允许的文本扩展名 */
export const TEXT_EXTS = ['.txt', '.md', '.log', '.csv', '.json'];
/** 允许的图片扩展名 */
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
/** 文本上限 200 KB */
export const MAX_TEXT_BYTES = 200 * 1024;
/** 图片上限 5 MB */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 取小写扩展名（含点），无扩展名时返回空串 */
export function extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i).toLowerCase();
}

/** 把字节数格式化为人类可读（KB/MB），与界面提示用同一函数避免文案漂移 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 界面上明示的格式说明（单一数据源，UI 直接渲染它） */
export const UPLOAD_SPEC = {
  textExts: TEXT_EXTS,
  imageExts: IMAGE_EXTS,
  maxText: MAX_TEXT_BYTES,
  maxImage: MAX_IMAGE_BYTES,
  accept: TEXT_EXTS.concat(IMAGE_EXTS).join(','),
};

/**
 * 校验上传文件。纯函数，输入只依赖 { name, size }，便于单测与冒烟测试注入。
 * @param {{name:string, size:number}} file
 * @returns {{ok:boolean, kind:'text'|'image'|null, error:string|null, size:number}}
 */
export function validateUpload(file) {
  const name = file && file.name ? String(file.name) : '';
  const size = file && Number.isFinite(Number(file.size)) ? Number(file.size) : 0;
  if (!name) return { ok: false, kind: null, error: '没有读到文件名，请重新选择文件。', size: 0 };

  const ext = extOf(name);
  const isText = TEXT_EXTS.includes(ext);
  const isImage = IMAGE_EXTS.includes(ext);

  if (!isText && !isImage) {
    return {
      ok: false,
      kind: null,
      size,
      error: `不支持的文件格式「${ext || '（无扩展名）'}」。文本支持 ${TEXT_EXTS.join('、')}，图片支持 ${IMAGE_EXTS.join('、')}。`,
    };
  }
  if (isText && size > MAX_TEXT_BYTES) {
    return { ok: false, kind: 'text', size, error: `文本文件 ${humanSize(size)} 超过上限 ${humanSize(MAX_TEXT_BYTES)}，请截取相关片段后重试。` };
  }
  if (isImage && size > MAX_IMAGE_BYTES) {
    return { ok: false, kind: 'image', size, error: `图片 ${humanSize(size)} 超过上限 ${humanSize(MAX_IMAGE_BYTES)}，请压缩或截图后重试。` };
  }
  if (size === 0) {
    return { ok: false, kind: isText ? 'text' : 'image', size, error: '文件是空的（0 字节），请确认导出成功后再上传。' };
  }
  return { ok: true, kind: isText ? 'text' : 'image', error: null, size };
}

/**
 * 聊天文本有效性检查：内容为空 / 有效字符过少 时给出可理解的提示。
 * 有效字符用 Unicode 字母与数字统计（\p{L}\p{N}）：
 * 注意不能用 \w / \W 过滤——JS 的 \w 只覆盖 ASCII 字母数字下划线，
 * 会把中文全部剥掉，导致任何纯中文聊天记录都被误判为「内容为空」。
 * @param {string} text
 * @returns {{ok:boolean, error:string|null, chars:number}}
 */
export function validateText(text) {
  const t = String(text || '');
  if (!t.trim()) return { ok: false, error: '聊天记录内容为空，请粘贴文字或上传文件后再分析。', chars: 0 };
  const chars = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (chars < 8) {
    return { ok: false, error: `有效内容仅 ${chars} 个字，太短了。请至少提供 8 个字以上的聊天片段。`, chars };
  }
  return { ok: true, error: null, chars };
}

/* ================================================================
 * 二、诈骗特征规则表（确定性检测，不依赖运行时 AI 推断）
 * ============================================================== */

/**
 * 每类特征对应案例库的一个分类（catId），用于结果页「看同类案例」——复用 kb/cases.js。
 * weight 为该特征的风险权重（累加后归一化为 0-100 分）。
 */
export const SIGNAL_TYPES = [
  {
    id: 'impersonate_authority',
    label: '冒充公检法 / 政府机关',
    icon: '👮',
    catId: 'police',
    weight: 22,
    patterns: [
      /(公安局| police |公安|民警|警官|经侦|刑侦|反诈中心|检察院|法院|法官|检察|公诉人)/i,
      /(涉嫌(洗钱|诈骗|犯罪)|洗钱嫌疑|案件(已经)?(立案|侦查)|通缉|逮捕令|传唤|冻结(账户|资金))/,
      /(安全账户|国家账户|监管账户|清查资金|资金清查)/,
      /(不要(告诉|联系)|保密|此案(涉及|正在)(保密|侦查)|会牵连(你|家人))/,
    ],
    detail: '自称公检法办案，用「涉嫌犯罪」「资金清查」「安全账户」制造恐惧，诱导你主动配合转账。',
    advice: '公检法不会通过社交软件办案，更不会让你把钱转到「安全账户」。接到此类电话或消息，直接挂断并拨打 96110 核实。',
  },
  {
    id: 'impersonate_service',
    label: '冒充客服 / 银行 / 平台官方',
    icon: '🎧',
    catId: 'shopping',
    weight: 18,
    patterns: [
      // 允许「客服」前夹品牌/平台名（如「我是蚂蚁客服」「我是微信支付客服」）
      /(客服(小妹|小哥哥|编号|专员)?(你好|您好)|我是[\u4e00-\u9fa5A-Za-z0-9]{0,6}(客服|银行)|本人(电话|来电)|官方(客服|渠道))/,
      /(订单(异常|失效)|退款(理赔|到账)|多扣了(你)?钱|会员(到期|扣费)|自动续费|开通(白条|会员)|注销(会员|账户))/,
      /(花呗|白条|借呗|信用卡|账单|扣款|银行)[\s\S]{0,12}(退款|返还|理赔|扣除)/,
      /(工号|服务编号|工单号)/,
    ],
    detail: '利用你真实的订单、账单信息制造紧迫感，把「退款」变成需要你先垫付、转账的流程。',
    advice: '任何声称要「退款、理赔、注销会员」的客服都必须通过官方 App 内的客服入口联系。回拨官方电话自行核实，不要点击对方发来的链接。',
  },
  {
    id: 'impersonate_social',
    label: '冒充熟人 / 领导',
    icon: '👔',
    catId: 'familiar',
    weight: 20,
    patterns: [
      /(我是(你)?(老板|领导|王总|张总|李总|老师)|我是[\u4e00-\u9fa5]{1,2}(哥|姐|叔|姨))/,
      /(领导|老板)[\s\S]{0,10}(开会|出差|不便|手机(快没电|没信号))/,
      /(我(加|换)了(个)?新(号|手机号|微信))/,
    ],
    detail: '盗用熟人身份，编造「开会中不方便」「手机没电」等理由阻止你核实，声音视频也可能是伪造的。',
    advice: '熟人借钱、领导要求转账，一律挂断后用你原有的号码回拨核实。任何「视频里是我」的证明都不足以确认身份。',
  },
  {
    id: 'money_transfer',
    label: '诱导转账 / 汇款',
    icon: '💸',
    catId: 'police',
    weight: 20,
    patterns: [
      /(转账|汇款|打款|付款|垫付|先付|借钱|还钱)/,
      /(安全账户|指定账户|私人账户|公司账户|对公账户|收款码|银行卡号)/,
      /(交(手续费|保证金|押金|定金|认证金|解冻费)|解冻(资金|账户)|需要(先)?(缴纳|支付))/,
    ],
    detail: '以各种名目要求你把钱转到指定账户或第三方账户，是所有诈骗的最终变现环节。',
    advice: '只要提到转账，立刻停止操作。凡是要求把钱转给「个人账户 / 安全账户」的都是诈骗，不要因为对方催促而跳过核实。',
  },
  {
    id: 'fake_link',
    label: '虚假链接 / 二维码 / APP',
    icon: '🔗',
    catId: 'shopping',
    weight: 16,
    patterns: [
      /(https?:\/\/|www\.)[^\s，。！？]+/i,
      /(点(这个|下面|开)|点击链接|扫码|扫描二维码|短链|t\.cn|bit\.ly|weixin110|链接已失效)/,
      /(下载(这个)?(APP|app|软件|客户端)|安装(一下|这个)|apk|未知来源|允许安装)/,
    ],
    detail: '引导你点击钓鱼链接、扫描带病毒的二维码，或下载用于盗号的仿冒 APP。',
    advice: '不要点击对方私发的任何链接，不要扫描来历不明的二维码，不要安装「内部专用」APP。装软件一律去官方应用商店。',
  },
  {
    id: 'otp_request',
    label: '索取验证码 / 密码 / 密钥',
    icon: '🔑',
    catId: 'shopping',
    weight: 25,
    patterns: [
      /(验证码|短信验证码|动态码|口令|密码|支付密码|取款密码|密钥|token|口令码)/i,
      /(截图(给我|看下)|把(验证码|密码|口令)(发|报)(给我|一下))/,
    ],
    detail: '索要验证码、密码或密钥，等同于交出账户控制权，这是盗号与盗刷的直接手段。',
    advice: '任何人（包括自称客服、公检法）索要验证码都应立即拒绝。验证码只在你本人主动操作时使用，任何人索取一律挂断。',
  },
  {
    id: 'screen_share',
    label: '诱导屏幕共享 / 远程控制',
    icon: '🖥️',
    catId: 'police',
    weight: 18,
    patterns: [
      /(屏幕共享|共享屏幕|远程控制|远程协助|云控|远程(指导|操作)|投屏)/,
      /(我(来)?(教你|教你操作|帮你(点|填|操作))|按我说的(点|操作))/,
    ],
    detail: '要求共享屏幕或开启远程控制，对方即可看到你的一切操作并代替你输入。',
    advice: '任何屏幕共享、远程协助请求都要拒绝。银行、公检法、平台官方都不会要求你开启远程控制。',
  },
  {
    id: 'fake_invest',
    label: '虚假投资理财 / 博彩',
    icon: '📈',
    catId: 'invest',
    weight: 20,
    patterns: [
      /(投资|理财|基金|股票|期货|虚拟币|数字货币|USDT|泰达|博彩|彩票|下注|带单|跟单)/i,
      /(稳赚|保本|零风险|收益(率|可观)|翻(倍|番)|内幕|内部消息|老师带单|日入过千)/,
      /(先(小额)?(投|充|入)一笔|提现(失败|不了)|无法出金|(投资|资金)群)/,
    ],
    detail: '先用小额获利建立信任，再诱导加大投入，所谓「投资群」「老师带单」最终无法出金。',
    advice: '承诺高额回报或稳赚不赔的一律是骗局。凡是让你先投钱参与的项目，先问自己：钱为什么这么好赚？',
  },
  {
    id: 'brush_task',
    label: '刷单返利 / 兼职做任务',
    icon: '🛒',
    catId: 'brush',
    weight: 16,
    patterns: [
      /(刷单|做任务|拍(商品|单)|点赞(任务|兼职)|关注公众号|推广(任务|app)|试玩|兼职(群|做))/,
      /(返(利|现|佣金)|日结|结算|三单|连单|垫付(本金|货款)|拍下(后)?(商品))/,
    ],
    detail: '以做任务返佣金为诱饵，前几单给真钱建立信任，随后以「连单」「垫付」为名骗取大额资金。',
    advice: '所有需要你先垫资的兼职都是诈骗。刷单本身违反法律，不要参与，更不要为它投入任何资金。',
  },
  {
    id: 'credit_repair',
    label: '征信修复 / 债务代办',
    icon: '📄',
    catId: 'credit',
    weight: 16,
    patterns: [
      /(征信(修复|洗白|优化|异议处理)|不良记录|逾期记录|征信(报告|花了)|信用(修复|提升))/,
      /(代办(债务|还款|征信)|停息挂账|债务(优化|重组)|法务(咨询)?(帮你|退))/,
      /(内部渠道|走关系|专业(人士)?处理|交钱(就能|即可)消除)/,
    ],
    detail: '冒充平台或金融机构代理，称能「花钱消除不良记录」，实为诈骗，或诱导你借新还旧。',
    advice: '征信记录只能通过正规渠道提出异议，任何「内部渠道花钱洗白」都是骗局。债务问题请咨询正规金融机构或专业律师。',
  },
  {
    id: 'prize_tax',
    label: '中奖 / 退税 / 礼品诱导',
    icon: '🎁',
    catId: 'prize',
    weight: 14,
    patterns: [
      /(中奖|恭喜(您)?(中奖|获得)|抽奖(结果|通知)|领奖|奖品|中奖信息)/,
      /(退税|退税补贴|返还税款|免税|补贴款|社保补贴|医保补贴|领取补贴)/,
      /(先交(税费|保证金|手续费)|缴(纳)?(税|税金)|解冻(奖|礼)金)/,
    ],
    detail: '凭空送大奖或补贴，但要你先交钱、缴税、提供银行卡。',
    advice: '中奖要先交钱的都是诈骗。正规抽奖、税务退税不会要求你转账或提供银行卡密码。',
  },
  {
    id: 'emotional',
    label: '情感培养（杀猪盘）',
    icon: '💘',
    catId: 'pig',
    weight: 12,
    patterns: [
      /(网恋|谈恋爱|做我(女朋友|男朋友)|奔现|培养感情|每天(关心|问候|想你))/,
      /(带你(赚钱|投资)|我们(一起|合伙)(做|投资)|内部(渠道|消息|福利))/,
    ],
    detail: '长期以感情建立信任，再把话题导向投资、博彩或借钱，通常伴随数周至数月的铺垫。',
    advice: '未见过面的网友引导你投资、借钱，一律拒绝。感情关系与金钱往来要分开，不要混在同一个聊天里。',
  },
  {
    id: 'urgency',
    label: '制造紧迫与恐吓',
    icon: '⏳',
    catId: 'police',
    weight: 12,
    patterns: [
      /(今天(之内|之内必须)|马上|立刻|最后(一次)?(机会|期限)|过了(今天|今晚)|限时|抓紧|尽快)/,
      /(不(能|敢)马上|后果自负|影响(你的)?(征信|子女|家人)|坐牢|判刑|起诉你)/,
      /(只(能)?给你(\d+分钟|一次机会)|别磨蹭|别考虑了)/,
    ],
    detail: '用时间压力和后果恐吓压缩你的思考时间，让你在没核实的情况下先行动。',
    advice: '越是催你「马上转账」，越要停下来。真机构不会用倒计时逼你。拖延反而是诈骗的破绽，骗子最怕你冷静核实。',
  },
  {
    id: 'identity_info',
    label: '索取身份证 / 银行卡等敏感信息',
    icon: '🪪',
    catId: 'police',
    weight: 18,
    patterns: [
      /(身份证(号)?|银行卡(号)?|人脸|正反面|手持照|照片|签名|开户)/,
      /(发(一下|我)(身份证|银行卡|人脸|正反面)|拍(一下|张)(证件|身份证))/,
      /(信息(核对|登记)|实名(认证|登记)|完善(资料|信息))/,
    ],
    detail: '索要证件照片、银行卡号等敏感信息，为盗刷、贷款或冒名开户做准备。',
    advice: '不要把身份证正反面、银行卡照片、手持照发给任何非官方渠道。官方办理业务会在官方 App 内完成，不需要私下传照片。',
  },
];

/** 特征 id → 定义，便于 O(1) 查表 */
export const SIGNAL_INDEX = Object.fromEntries(SIGNAL_TYPES.map((s) => [s.id, s]));

/**
 * 特征命中检测（确定性）。
 * 对每类特征，取命中处原文的一小段作为「证据」——展示给用户的是原话，
 * 不是内部正则表达式（后者对用户无意义，且暴露实现细节）。
 * @param {string} text
 * @returns {Array<{id:string,label:string,icon:string,catId:string,weight:number,detail:string,advice:string,evidence:string,pattern:string}>}
 */
export function detectSignals(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const hits = [];
  for (const sig of SIGNAL_TYPES) {
    let matched = null;
    for (const p of sig.patterns) {
      if (p.test(t)) {
        matched = p;
        break;
      }
    }
    if (matched) {
      hits.push({
        id: sig.id,
        label: sig.label,
        icon: sig.icon,
        catId: sig.catId,
        weight: sig.weight,
        detail: sig.detail,
        advice: sig.advice,
        evidence: excerptAround(t, matched),
        // 保留正则对象本身：ruleScore 的逐行统计与证据截取都要按同一正则重新匹配，
        // 若只存字符串再 new RegExp() 重建，字面斜杠会被当成待匹配字符而永远失配。
        re: matched,
        pattern: String(matched),
      });
    }
  }
  // 高权重特征排前面，输出顺序稳定可复现
  return hits.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}

/**
 * 从原文里截取命中该特征的一句作为证据（纯函数）。
 * 传入的是正则对象本身，不用字符串重建——重建会因字面斜杠而失配。
 * @param {string} text 原文
 * @param {RegExp} re 命中的正则
 */
export function excerptAround(text, re) {
  const t = String(text || '');
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // 逐行找命中该正则的行
  for (const line of lines) {
    if (line.length > 0 && re.test(line)) {
      return line.length > 60 ? line.slice(0, 60) + '…' : line;
    }
  }
  const m = re.exec(t);
  if (m && m[0]) {
    const start = Math.max(0, m.index - 12);
    const piece = t.slice(start, m.index + m[0].length + 12);
    return (start > 0 ? '…' : '') + piece.trim() + (m.index + m[0].length + 12 < t.length ? '…' : '');
  }
  return '';
}

/* ================================================================
 * 三、结论 / 风险等级判定
 * ============================================================== */

export const VERDICTS = {
  scam: { id: 'scam', label: '是', color: '#d93025', desc: '存在诈骗嫌疑，建议立即停止往来并保留证据' },
  clean: { id: 'clean', label: '否', color: '#1e8e3e', desc: '未发现明显诈骗特征，但请保持常规警惕' },
  unknown: { id: 'unknown', label: '无法判断', color: '#5d6472', desc: '信息不足或规则与 AI 均未能给出可靠判断' },
};

export const RISK_LEVELS = {
  high: { id: 'high', label: '高危', color: '#d93025', min: 70 },
  mid_high: { id: 'mid_high', label: '中高危', color: '#e08600', min: 45 },
  mid: { id: 'mid', label: '中危', color: '#a16207', min: 25 },
  low: { id: 'low', label: '低危', color: '#1e8e3e', min: 1 },
  none: { id: 'none', label: '未发现风险', color: '#188038', min: 0 },
  /**
   * 「无法评估」——专门给「结论是未知」用的。
   * 结论未知时风险分必然是 0，若沿用 none 就会显示成绿色的「未发现风险」，
   * 等于对着一段没读懂的聊天记录给出安全保证——这是最危险的一种误导，必须单独一档。
   */
  unknown: { id: 'unknown', label: '无法评估', color: '#5d6472', min: 0 },
};

/** 风险分 → 等级（确定性，含颜色，便于 UI 直接使用） */
export function levelOf(score) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  if (s >= 70) return RISK_LEVELS.high;
  if (s >= 45) return RISK_LEVELS.mid_high;
  if (s >= 25) return RISK_LEVELS.mid;
  if (s >= 1) return RISK_LEVELS.low;
  return RISK_LEVELS.none;
}

/**
 * 规则分：由命中特征的权重累加（首条满权重，后续递减），再叠加紧迫度等强度项，归一化到 0-100。
 * 纯计算，可单测；不依赖任何模型输出。
 * @param {Array} hits detectSignals 的结果
 * @param {string} text 原文，用于强度微调
 */
export function ruleScore(hits, text = '') {
  if (!hits || hits.length === 0) return 0;
  let sum = 0;
  hits.forEach((h, i) => {
    // 首条特征按满权重计，后续每条打 7 折，避免特征堆砌导致分数虚高
    sum += h.weight * (i === 0 ? 1 : Math.pow(0.7, i));
  });
  // 同一句话里命中特征越多，说明组合套路越完整，加成（上限 12 分）
  // 注意用 h.re（正则对象）而非 h.pattern（字符串）：字符串重建会失配，
  // 导致这项加成恒为 0，变成一条永不生效的死代码。
  const lines = String(text || '').split(/\n+/).filter((l) => l.trim());
  const maxPerLine = lines.reduce((acc, l) => {
    const c = hits.filter((h) => h.re && h.re.test(l)).length;
    return Math.max(acc, c);
  }, 0);
  sum += Math.min(12, Math.max(0, maxPerLine - 1) * 4);
  return Math.min(100, Math.round(sum));
}

/** 规则层直接给出的结论（图片无本地 OCR，hasText=false 时恒为 unknown） */
export function ruleVerdict(score, hasText) {
  if (!hasText) return 'unknown';
  if (score >= 25) return 'scam';
  if (score === 0) return 'clean';
  return 'unknown';
}

/** AI 判为「是」但规则零命中时的置信度上限——避免一条弱 AI 结论独占高置信 */
const CAPPED_CONFIDENCE = 72;
/** 规则分达到该值时，AI 不得把结论判为「否」 */
export const AI_OVERRIDE_SCORE = 45;

/* ================================================================
 * 四、AI 研判层（prompt 编译 + 输出结构校验）
 * ============================================================== */

/** 送入模型的最大字符数，超出截断（避免超长上下文与费用失控） */
export const MAX_MODEL_CHARS = 4000;

/**
 * 纯文本研判的输出预算（token）。JSON 结果本身不长，800 足够。
 *
 * 但接口默认开思考模式时，思维链也吃这份预算（实测一次图片研判：思维链 770 token、
 * 答案 482 token）。若预算只够答案，一旦模型多想两句就会把答案挤空，
 * 表现为「接口未返回可用文本」。因此留出余量，取 2000。
 */
export const TEXT_MAX_TOKENS = 2000;

/**
 * 多模态（截图）研判的输出预算（token）。
 * 视觉模型要先「读图」再输出 JSON，长截图 / 多宫格拼图的读图过程本身消耗大量推理额度。
 * 沿用纯文本的 400 会在读图阶段就截断响应，表现为模型声称「图片不可读」——
 * 实测这是图片分析失败的主因，因此这里给足预算。
 */
export const IMAGE_MAX_TOKENS = 4000;

/**
 * 编译辨析 system prompt（纯函数，可单测）。
 * 明确要求模型只输出 JSON，并对「无法判断」给出条件，避免模型为了给结论而编造。
 * @param {Array} hits 规则层已命中的特征
 * @param {{isImage?:boolean}} [opts] isImage=true 时追加「不许编造引文」的硬约束
 */
export function buildAnalysisPrompt(hits, opts = {}) {
  const hitHint = hits.length
    ? hits.map((h) => `- ${h.id}：${h.label}`).join('\n')
    : '-（本地规则未命中任何特征，请不要顺着「可能有诈骗」的预设下结论）';
  return [
    `你是一名反诈研判助手。你的任务是阅读一段聊天记录，判断对方是否存在诈骗嫌疑。`,
    ``,
    `【本地规则层已命中的特征】`,
    hitHint,
    ``,
    `【输出格式】只输出一个 JSON 对象，不要输出任何解释文字、不要用 markdown 代码块。字段如下：`,
    `{"verdict":"scam|clean|unknown","riskScore":0到100的整数,"confidence":0到100的整数,`,
    `"signals":[{"type":"特征id","name":"特征名称","quote":"原文中最能说明问题的片段"}],`,
    `"summary":"判断依据摘要，80字以内","advice":["防骗建议，每条一句话"]}`,
    ``,
    `【判定口径】`,
    `1. verdict 只有三种取值：scam=存在诈骗嫌疑；clean=未发现诈骗特征；unknown=信息不足无法判断。`,
    `2. 信息不足以判断时必须用 unknown，不要为了给结论而编造。`,
    `3. quote 必须摘自原文（图片输入时为图片里看到的原话），不得改写或虚构。`,
    `4. type 优先使用下面这些特征id；确有规则未覆盖的新特征时才使用自拟id，并改用简短中文名。`,
    `   可用特征id：${SIGNAL_TYPES.map((s) => s.id).join(', ')}`,
    `5. advice 必须是防范劝阻内容。严禁输出任何可执行的诈骗操作手法、话术模板或规避检测方法。`,
    `6. 本任务仅用于识别与防范，不得推测或输出与研判无关的个人隐私信息。`,
    opts.isImage
      ? `7. **图片场景的最高原则：只报告你真正看到的内容。**`
        + `只有确实在图里看到了对应的话术，才能使用该特征类型并在 quote 里抄下原话；`
        + `如果你看不到这张图、或看不清文字，就把 verdict 设为 unknown，并在 summary 里写明你实际看到了什么（或直说看不到图）。`
        + `**绝不允许根据上面的特征id列表去推测、拼凑、编造图里没有的话或引文**——编造的证据比“无法判断”危害更大。`
      : '',
  ].join('\n');
}

/**
 * 图片场景的专用指令（纯函数，可单测）。
 *
 * 为什么需要单独一套：聊天截图常见形态是「多宫格拼图」——一张图里并排好几屏对话，
 * 每屏字号很小。如果不明确告诉模型「逐格去读文字」「读不清也要尽力判断」，
 * 模型很容易一看到拼图就整体判定「不可读」并放弃，直接给 unknown。
 * 实战中这一句话比任何参数调整都更有效。
 */
export function buildImageInstruction() {
  return [
    `请辨析上面这张聊天记录截图，判断对方是否存在诈骗嫌疑，按要求的 JSON 格式回答。`,
    ``,
    `【如何读这张图】`,
    `1. 图片可能是一张聊天记录截图，也可能是**多屏对话拼在一起的长图**（上下或左右并排若干屏）。`,
    `   遇到拼图时，请**逐格分别阅读每一屏的文字**，不要只看其中一格就下结论。`,
    `2. 图中文字较小。请仔细辨认气泡里的汉字，包括对方发来的文件名、链接、邀请码、金额、账号等。`,
    `3. 只要能读出**部分**内容，就基于读到的内容做判断，并在 summary 里说明你读到了哪些关键信息。`,
    `4. **如果你确实看不到这张图**（图片没有送达、只剩下这段文字说明），必须把 verdict 设为 unknown，`,
    `   并在 summary 里直说「看不到图片」。**不要根据提示词里列出的特征类型去推测或编造图里没有的话**——`,
    `   编造的引文会让误判看起来像铁证，危害远大于「无法判断」。`,
    `5. 仅当整张图确实完全无法辨认（纯黑、纯白、严重变形、完全没有文字）时，才用 unknown，`,
    `   并在 summary 里说明你看到的是什么。`,
    `   **不要因为文字小、图是拼图、或者只看清了几屏就整体放弃——但也不要为了给结论而编造。**`,
    `6. quote 填图片里出现过的**原话片段**（照抄看到的文字），用于回溯你依据的是哪一句。`,
    `   抄不出来就留空，不要凭印象写。`,
    `7. 截图中出现的文件（如 .apk / .exe）、链接、邀请码、二维码、"加好友/下载/填写"等要求，`,
    `   都是重要线索，请如实识别并归入对应的特征类型。`,
  ].join('\n');
}

/** 把上传内容编译成 messages（纯函数）。isImage 时走多模态 image_url。 */
export function buildAnalysisMessages(text, imageDataUrl, hits) {
  const msgs = [{ role: 'system', content: buildAnalysisPrompt(hits, { isImage: !!imageDataUrl }) }];
  if (imageDataUrl) {
    // 若用户同时粘贴了文字，图片与文字一起给模型，文字可作为读图的补充线索
    const extra = String(text || '').trim()
      ? `\n\n【用户同时提供的文字内容（可与图片互为印证）】\n${String(text).slice(0, MAX_MODEL_CHARS)}`
      : '';
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: buildImageInstruction() + extra },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    });
    return msgs;
  }
  const clipped = String(text || '').slice(0, MAX_MODEL_CHARS);
  const tail = String(text || '').length > MAX_MODEL_CHARS ? '\n（内容过长，已截取前 4000 字）' : '';
  msgs.push({ role: 'user', content: '请辨析以下聊天记录，按要求的 JSON 格式回答：\n\n' + clipped + tail });
  return msgs;
}

/** 模型输出里越界（提供可执行诈骗操作指引）的判定，纯函数 */
export function isUnsafeAnalysis(text) {
  const t = String(text || '');
  return [
    /(如何|怎样|教你|步骤|第一步|第二步)[\s\S]{0,20}(实施|进行|操作)[\s\S]{0,10}(诈骗|骗局|行骗)/,
    // 距离放宽到 20：话术模板常带标点与换行（如「照着说：你好我是客服」），过窄会漏网
    /(话术模板|话术脚本|照着说|复制粘贴|按以下台词)[\s\S]{0,20}(骗|转账|冒充|客服|警官|老板)/,
    /(规避(警方|侦查|追查|检测|冻结)|躲避(警方|侦查|冻结)|反侦查|逃逸|跑分|洗钱手法)/,
    /(绕过(风控|验证|审核)|破解(验证码|密码|风控)|盗刷)/,
  ].some((r) => r.test(t));
}

const VERDICT_IDS = ['scam', 'clean', 'unknown'];
const TYPE_ID_SET = new Set(SIGNAL_TYPES.map((s) => s.id));

/**
 * 视觉能力探测用的测试图（64×64 四宫格：左上红、右上蓝、左下绿、右下黄，base64 PNG）。
 *
 * 为什么不用「1×1 纯白图问什么颜色」：那种问法瞎猜就能答对（实测 deepseek-v4-pro
 * 也能顺口答出个颜色），区分度太差。四宫格要求按「左上、右上、左下、右下」报出
 * 四个颜色——看不见图的模型只能瞎猜，而瞎猜恰好排对的概率只有 1/256。
 * 实测：deepseek-flash 稳定答「红色、蓝色、绿色、黄色」，纯文本模型答成「灰色、灰色、灰色、灰色」。
 */
export const VISION_PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAVUlEQVR42u3PsQkAMBADMe8/T/ZzZvjCneDqA6XJtPG+AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAC497a12wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzn0jsMEPV8vtMQAAAABJRU5ErkJggg==';

/** 测试图的正确答案（按左上、右上、左下、右下） */
export const VISION_PROBE_EXPECTED = ['红', '蓝', '绿', '黄'];
/** 另一种同样正确的排列（按列读），一并接受，避免误伤 */
export const VISION_PROBE_EXPECTED_COL = ['红', '绿', '蓝', '黄'];

/**
 * 构造一次「视觉能力探测」请求（纯函数，可单测）。
 * 模型只需按顺序报出四个方块的颜色，能答对说明它真的读到了图。
 */
export function buildVisionProbeMessages() {
  return [
    {
      role: 'system',
      content: '你只回答图片里看到的颜色，不要解释，不要猜测。',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图由四个颜色方块组成（2×2 排列）。请按左上、右上、左下、右下的顺序回答四个颜色，用顿号分隔，只回答颜色，不要解释。' },
        { type: 'image_url', image_url: { url: VISION_PROBE_IMAGE } },
      ],
    },
  ];
}

/** 中英文颜色词 → 单字 */
const COLOR_MAP = [
  [/^(红|red)$/i, '红'],
  [/^(蓝|blue)$/i, '蓝'],
  [/^(绿|green)$/i, '绿'],
  [/^(黄|yellow)$/i, '黄'],
];

/**
 * 判定视觉探测的返回是否说明模型真的看到了图（纯函数）。
 *
 * 三态而不是两态：'yes' 确认能读图；'no' 明确说读不了；'unknown' 是「答不出来/答错了」，
 * 无法确认。两者的区别很重要——'no' 是模型自己说的，'unknown' 是我们没验出来。
 * @param {string} text 模型回复
 * @returns {{state:'yes'|'no'|'unknown', supported:boolean, reason:string}}
 */
export function judgeVisionProbe(text) {
  const t = String(text || '').trim();
  if (!t) return { state: 'unknown', supported: false, reason: '模型没有返回任何内容，无法确认是否读图' };
  if (/(不支持|无法处理|不能处理|没有(收到|提供|上传|附带|看到)?图片|未(收到|提供|上传)图片|纯文本|看不到图|无法识别图片|不能识别图片|无法确定|无法看到|没有图像|看不到图片|没有图)/.test(t)) {
    return { state: 'no', supported: false, reason: `模型表示无法处理图片（回复：${t.slice(0, 60)}）` };
  }
  // 按出现顺序抽取颜色词
  const found = [];
  const re = /(红|red|蓝|blue|绿|green|黄|yellow)/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    for (const [pat, zh] of COLOR_MAP) if (pat.test(m[0])) { found.push(zh); break; }
  }
  if (found.length >= 4) {
    const seq = found.slice(0, 4);
    const rowOk = seq.every((c, i) => c === VISION_PROBE_EXPECTED[i]);
    const colOk = seq.every((c, i) => c === VISION_PROBE_EXPECTED_COL[i]);
    if (rowOk || colOk) {
      return { state: 'yes', supported: true, reason: `模型准确读出了测试图的四色顺序（回复：${t.slice(0, 40)}）` };
    }
    return { state: 'unknown', supported: false, reason: `模型读到的颜色顺序与测试图不符（回复：${t.slice(0, 40)}）——没真正看到图` };
  }
  return { state: 'unknown', supported: false, reason: `模型回复无法确认是否读图（回复：${t.slice(0, 60)}）` };
}

/**
 * 检测模型「声称读不到图」的表述（纯函数）。
 *
 * 背景：多模态接口有两种完全不同的失败，输出长得很像，必须区分开：
 *   a) 模型不支持视觉输入（如纯文本模型收到了 image_url）→ 换模型才能解决
 *   b) 模型能看图但这张图确实没读出来（分辨率过低 / 被截断 / 内容模糊）
 * 两者的表现都是「不可读」「无法识别」这类措辞，因此用关键词覆盖常见说法。
 *
 * 措辞覆盖是踩过坑之后补的：实测 deepseek-v4-pro 收到图片时会说
 * 「图片未能成功上传或格式不受支持」，模型也会说「图片显示为不支持或缺失」——
 * 这两种说法都不含「无法识别」类的词，早先的规则漏掉了它们，
 * 结果是失败横幅不弹，用户只看到「无法判断」。
 *
 * @param {string} text 模型返回的 summary 等文本
 * @returns {boolean}
 */
export function saysCannotReadImage(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return [
    /(不可读|无法读取|读取失败|读不出|读不到|看不到|无法识别|识别不了|识别不出|未能识别|无法提取|不能识别|不可识别)/,
    /(不清晰|过于模糊|分辨率(过低|太低)|无法看清|看不清)/,
    /(没有图片|未提供图片|图片(为空|缺失|不存在|未提供)|不含图片|没有收到图片|未收到(任何)?图片|图片未上传|未上传图片|没有上传图片|没有附带图片|未附带图片)/,
    /(不是图片|无法解析图片|图片格式(不受支持|无法解析))/,
    /(作为(一个)?(纯)?文本(模型|助手)|我不支持图片|无法处理图片|不支持(图片|图像|多模态))/,
    // 「图片送到了但对方不收」类表述（实测 deepseek-v4-pro 的原话）
    /(图片(未能|未能)成功上传|未成功上传|格式不受支持|不受支持的图片|unsupported\s*image|image\s+(is|was)\s+not\s+supported|no\s+image\s+(was\s+)?(received|provided|attached))/i,
    /(图片显示为(不支持|缺失)|没有(可用的)?图片(数据|内容|输入)|无法(获取|访问|加载)图片|图中没有(任何)?文字)/,
  ].some((r) => r.test(t));
}

/**
 * 判断模型这次的「读不到图」是不是因为**模型本身没有视觉能力**（纯函数）。
 *
 * 与「图确实难辨」的区分很重要：前者换模型就能解决，后者要改图或改用文字分析。
 * @param {string} text 模型返回文本
 * @returns {boolean}
 */
export function modelLacksVision(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return [
    /(不支持(图片|图像|多模态|图片输入)|unsupported\s*image|image\s+(is|was)\s+not\s+supported)/i,
    /(纯文本(模型|助手)|只能(处理|识别|理解)(纯)?文本|无(视觉|图像)(理解|输入)?能力)/,
    /(无法处理图片|不能处理图片|不能识别图片|无法识别图片)/,
    /(图片(未能|未能)成功上传|未成功上传|格式不受支持|不受支持的图片)/,
    /(没有(收到|获取到|附带|提供)(任何)?图片|未收到(任何)?图片|图片显示为(不支持|缺失)|没有(可用的)?图片(数据|内容|输入))/,
    /(no\s+image|image\s+(is\s+)?missing|unable\s+to\s+(view|access|read)\s+the\s+image)/i,
  ].some((r) => r.test(t));
}

/**
 * 当模型声称读不到图时，给出可操作的提示（区分「模型不支持视觉」与「图本身难辨」）。
 * 纯函数，可单测。
 * @param {string} text 模型返回文本
 * @param {boolean} hasImage 是否为图片输入
 * @param {{model?:string, suggestModel?:string, examples?:string[], lacksVision?:boolean}} [opts] 补充信息
 *   lacksVision：显式指定「模型确实没有视觉能力」（视觉自检已确认），
 *   传 true/false 时以它为准，不传则按文本措辞推断。
 * @returns {string} 提示文案；不适用时返回空串
 */
export function imageReadFailureAdvice(text, hasImage, opts = {}) {
  if (!hasImage) return '';
  const model = String(opts.model || '').trim();
  const suggest = String(opts.suggestModel || '').trim();
  const examples = (opts.examples && opts.examples.length ? opts.examples : ['deepseek-flash', 'gpt-4o', 'gpt-4o-mini', 'qwen-vl']);
  const lacks = opts.lacksVision === undefined ? modelLacksVision(text) : !!opts.lacksVision;
  // 视觉自检已确认「模型读不了图」时，措辞再模糊也要给结论——此时不再依赖关键词
  if (!lacks && !saysCannotReadImage(text)) return '';

  if (lacks) {
    const who = model ? `当前模型「${model}」` : '当前模型';
    const fix = suggest
      ? `请把模型改成「${suggest}」后重试`
      : `请改用支持视觉的模型（如 ${examples.join('、')} 等）后重试`;
    return `${who}没有成功读取这张截图：所填模型很可能不支持图片输入（多模态），截图辨析无法进行。${fix}。`;
  }
  return '当前模型没有成功读取这张截图：可能是图片分辨率过低、聊天记录被遮挡，或拼图过长导致内容识别不全。建议裁剪到单个对话窗口、提高清晰度后重试，或直接把聊天文字粘贴到文本框分析。';
}

/** 把任意文本里的 JSON 对象抠出来（模型常包 markdown 代码块或前后废话） */
export function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/** 收紧为合法区间整数 */
function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * 严格校验并归一化 AI 输出。校验不过抛错，由上层降级为规则结论。
 * @param {string} raw 模型原文
 * @returns {{verdict:string,riskScore:number,confidence:number,signals:Array,summary:string,advice:string[]}}
 */
export function parseAnalysis(raw) {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') throw new Error('AI 返回的不是可解析的 JSON');
  if (!VERDICT_IDS.includes(obj.verdict)) throw new Error('AI 返回的结论取值非法：' + JSON.stringify(obj.verdict));
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) throw new Error('AI 未给出判断依据摘要');

  const signals = Array.isArray(obj.signals) ? obj.signals.slice(0, 8).map((s) => ({
    type: String(s && s.type ? s.type : '').slice(0, 40),
    name: String(s && s.name ? s.name : '').slice(0, 40),
    quote: String(s && s.quote ? s.quote : '').slice(0, 160),
    known: TYPE_ID_SET.has(String(s && s.type)),
  })) : [];

  const advice = Array.isArray(obj.advice)
    ? obj.advice.map((a) => String(a || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6)
    : [];

  return {
    verdict: obj.verdict,
    riskScore: clampInt(obj.riskScore, 0, 100, 0),
    confidence: clampInt(obj.confidence, 0, 100, 60),
    signals,
    summary: obj.summary.trim().slice(0, 300),
    advice,
  };
}

/* ================================================================
 * 五、合并与降级（结论仲裁）
 * ============================================================== */

/** 组装最终的「特征列表」：规则命中 + AI 补充的未知特征，同一 id 去重 */
function mergeSignals(hits, aiSignals) {
  const seen = new Set(hits.map((h) => h.id));
  const out = hits.slice();
  for (const s of aiSignals || []) {
    if (!s.name || seen.has(s.type)) continue;
    seen.add(s.type);
    out.push({
      id: s.type,
      label: s.name,
      icon: '🔎',
      catId: null,
      weight: 0,
      detail: s.quote ? `原文片段：${s.quote}` : '由 AI 补充识别，本地规则未覆盖该特征。',
      advice: '',
      evidence: s.quote || '',
      fromAI: true,
    });
  }
  return out;
}

/** 去重合并建议，规则建议优先 */
function mergeAdvice(hits, aiAdvice) {
  const out = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (s && !out.some((x) => x === s)) out.push(s);
  };
  hits.forEach((h) => push(h.advice));
  (aiAdvice || []).forEach(push);
  return out.slice(0, 8);
}

/**
 * 合并规则层与 AI 层结论（纯函数，仲裁规则全部在此，便于单测）。
 * 仲裁原则：规则强信号不可被 AI 推翻；AI 独有结论受置信度上限约束。
 * @param {{score:number, hits:Array, hasText:boolean}} rule
 * @param {object|null} ai parseAnalysis 的结果；null 表示未启用或已降级
 * @param {{engine:string, notes:string[]}} meta
 */
export function mergeVerdict(rule, ai, meta) {
  const notes = (meta && meta.notes ? meta.notes.slice() : []);
  const hits = mergeSignals(rule.hits, ai && ai.signals);
  const ruleVerdictId = ruleVerdict(rule.score, rule.hasText);

  let verdict = ruleVerdictId;
  let score = rule.score;
  let confidence = 0;
  let summary = '';
  let advice = [];

  if (!rule.hasText) {
    // 图片：本地无 OCR，规则层无结论，只能由 AI 视觉模型判定
    if (ai) {
      verdict = ai.verdict;
      score = ai.riskScore;
      confidence = clampInt(ai.confidence, 0, 100, 60);
      summary = ai.summary;
      notes.push('本地规则无法直接读取图片文字，结论完全来自 AI 视觉识别，请以人工复核为准。');
    } else {
      verdict = 'unknown';
      score = 0;
      confidence = 0;
      summary = '图片场景下的结论完全依赖 AI 视觉识别；本次没有拿到可用的识别结果，因此无法判断。';
    }
  } else if (ai) {
    summary = ai.summary;
    if (ruleVerdictId === 'scam') {
      verdict = 'scam';
      score = Math.max(rule.score, ai.riskScore);
      confidence = clampInt(Math.max(ai.confidence, 70), 0, 100, 70);
      if (ai.verdict !== 'scam') {
        notes.push(`AI 给出的结论是「${VERDICTS[ai.verdict].label}」，但本地规则命中了强特征（规则分 ${rule.score}），已按规则判定为「是」。`);
      }
    } else if (ai.verdict === 'scam') {
      // AI 说「是」而规则零命中：保留结论，但压低置信度并说明依据仅为 AI
      verdict = 'scam';
      score = Math.max(rule.score, ai.riskScore, 25);
      confidence = Math.min(clampInt(ai.confidence, 0, 100, 60), CAPPED_CONFIDENCE);
      notes.push(`AI 判定存在诈骗嫌疑但本地规则未命中特征（规则分 ${rule.score}），置信度已下调，请结合原文人工复核。`);
    } else if (ai.verdict === 'clean' && ruleVerdictId !== 'clean') {
      verdict = ruleVerdictId === 'unknown' ? 'unknown' : ruleVerdictId;
      confidence = 50;
      notes.push('AI 与本地规则结论不一致，已按更保守的一方给出结论。');
    } else {
      verdict = ai.verdict === 'clean' && rule.score === 0 ? 'clean' : ai.verdict;
      confidence = clampInt(ai.confidence, 0, 100, 60);
    }
  } else {
    verdict = ruleVerdictId;
    score = rule.score;
    confidence = ruleVerdictId === 'unknown' ? 0 : Math.min(95, 45 + rule.score);
    summary = ruleVerdictId === 'scam'
      ? `本地规则命中 ${rule.hits.length} 类诈骗特征（规则分 ${rule.score}），未启用 AI，以下为规则层结论。`
      : ruleVerdictId === 'clean'
        ? '本地规则未命中任何诈骗特征（规则分 0），未启用 AI，以下为规则层结论。'
        : '本地规则仅命中零散特征，不足以定性，未启用 AI，建议人工判断。';
  }

  const level = verdict === 'unknown' ? RISK_LEVELS.unknown : levelOf(score);
  advice = mergeAdvice(hits, ai && ai.advice);

  return {
    verdict,
    verdictInfo: VERDICTS[verdict],
    riskScore: score,
    level,
    confidence,
    summary,
    signals: hits,
    advice,
    engine: (meta && meta.engine) || 'rule',
    notes,
  };
}

/**
 * 纯规则分析（未配置 AI 时使用，保证离线可用）。纯函数、可单测。
 * @param {{text?:string, name?:string, kind?:string}} input
 */
export function analyzeLocally(input) {
  const text = input && input.text ? String(input.text) : '';
  const hits = detectSignals(text);
  const score = ruleScore(hits, text);
  const merged = mergeVerdict({ score, hits, hasText: true }, null, { engine: 'rule', notes: [] });
  return {
    ...merged,
    source: { name: (input && input.name) || '（未命名）', kind: (input && input.kind) || 'text', chars: text.length },
  };
}

/**
 * 主入口：辨析聊天记录。
 * 无 AI 配置 → 纯规则（离线可用）；AI 失败/超时/越界/结构非法 → 降级为规则结论并写入 notes。
 * @param {{text?:string, imageDataUrl?:string, name?:string, kind?:string}} input
 * @param {null|{baseUrl:string, apiKey:string, model:string, temperature?:number}} cfg
 * @param {{callChat?:Function, timeoutMs?:number}} [deps] 依赖注入，便于单测与冒烟测试
 */
export async function analyze(input, cfg, deps = {}) {
  const text = input && input.text ? String(input.text) : '';
  const imageDataUrl = (input && input.imageDataUrl) || null;
  const name = (input && input.name) || '（未命名）';
  const kind = (input && input.kind) || (imageDataUrl ? 'image' : 'text');

  const source = { name, kind, chars: text.length };

  // 图片没有本地 OCR 能力，必须走 AI；此时不做文本校验
  if (!imageDataUrl) {
    const v = validateText(text);
    if (!v.ok) {
      const err = new Error(v.error);
      err.code = 'empty';
      throw err;
    }
  }

  const hits = detectSignals(text);
  const score = ruleScore(hits, text);
  const rule = { score, hits, hasText: !imageDataUrl };

  const notes = [];
  if (!cfg || !cfg.apiKey) {
    if (imageDataUrl) {
      const merged = mergeVerdict(rule, null, { engine: 'rule', notes: [] });
      return { ...merged, source, degraded: true };
    }
    const merged = mergeVerdict(rule, null, { engine: 'rule', notes: [] });
    return { ...merged, source, degraded: false };
  }

  const call = deps.callChat;
  if (typeof call !== 'function') throw new Error('未注入 AI 调用实现');

  // ── 图片场景：先确认模型真的能读图，再让它分析 ──────────────────────
  // 为什么必须前置：看不见图的模型照样能输出一个「像模像样」的结论——
  // 实测 deepseek-v4-pro 收不到图时，照样编出了「我是客服」「投资返利」「转账到指定账户」
  // 这样图里根本不存在的引文，还给了 85 分高危。
  // 对反诈工具来说，编造的证据比「无法判断」危险得多：前者会让用户白转账，后者在提醒他小心。
  let visionSupported = null;
  if (imageDataUrl) {
    const vinfo = describeVisionSupport(cfg.model, cfg.baseUrl);
    // 已知纯文本模型：本地直接拦下，一个请求都不发
    if (vinfo.state === 'no') {
      const notes0 = [imageReadFailureAdvice('模型不支持图片输入', true, {
        model: cfg.model,
        suggestModel: vinfo.suggestModel,
        examples: vinfo.examples,
        lacksVision: true,
      })];
      const merged0 = mergeVerdict(rule, null, { engine: 'rule', notes: notes0 });
      return { ...merged0, source, degraded: true, imageReadFailed: true, visionSupported: false };
    }
    const probe = await probeVision(cfg, call, deps);
    visionSupported = probe ? probe.state : 'unknown';
    // 明确说读不了图 → 拦下；模型名不认识（无法查表）→ 失败关闭（验不过就不采信）
    if (probe && probe.state === 'no') {
      const notes0 = [imageReadFailureAdvice('模型不支持图片输入', true, {
        model: cfg.model,
        suggestModel: vinfo.suggestModel,
        examples: vinfo.examples,
        lacksVision: true,
      })];
      const merged0 = mergeVerdict(rule, null, { engine: 'rule', notes: notes0 });
      return { ...merged0, source, degraded: true, imageReadFailed: true, visionSupported: false };
    }
    if (probe && probe.state === 'unknown' && vinfo.state !== 'yes') {
      // 认不出的模型 + 自检没通过 → 不采信它的图片结论（宁可说「无法确认」，也不给假证据）
      const notes0 = [`没能验证当前模型是否真的能读图（自检回复与测试图不符），因此本次不采信 AI 对这张截图的结论——`
        + `它可能根本没看到截图，却照样能编出像模像样的分析（实测纯文本模型会编出「我是客服」「投资返利」这种图里根本没有的引文）。`
        + `请改用支持视觉的模型（如 ${vinfo.examples.join('、')} 等）后重试。`];
      const merged0 = mergeVerdict(rule, null, { engine: 'rule', notes: notes0 });
      return { ...merged0, source, degraded: true, imageReadFailed: true, visionSupported: null };
    }
  }

  let ai = null;
  let imageReadFailed = false;
  try {
    // 输出预算按输入类型给足：读图比读字耗得多
    const maxTokens = imageDataUrl ? IMAGE_MAX_TOKENS : TEXT_MAX_TOKENS;
    const raw = await call(
      cfg,
      buildAnalysisMessages(text, imageDataUrl, hits),
      { timeoutMs: deps.timeoutMs || 45000, maxTokens }
    );
    if (!raw || !String(raw).trim()) throw new Error('AI 返回空内容');
    if (isUnsafeAnalysis(raw)) throw new Error('AI 输出越界（疑似提供可执行诈骗指引），已拒绝采用');
    ai = parseAnalysis(raw);
    if (isUnsafeAnalysis(ai.summary + ai.advice.join(' '))) throw new Error('AI 输出越界（疑似提供可执行诈骗指引），已拒绝采用');
    // 模型声称读不到图：这不是一个「无法判断」的结论，而是一次读图失败，
    // 必须单独识别出来并给出可操作的指引（换模型 / 换图片 / 改用文字）。
    if (imageDataUrl && saysCannotReadImage(ai.summary + ' ' + ai.advice.join(' '))) {
      imageReadFailed = true;
      const vinfo = describeVisionSupport(cfg.model, cfg.baseUrl);
      const advice = imageReadFailureAdvice(ai.summary, true, {
        model: cfg.model,
        suggestModel: vinfo.state === 'no' ? vinfo.suggestModel : '',
        examples: vinfo.examples,
        // 自检已证明模型能读图 → 这次读不到是「这张图难辨」，不能反过来怪模型
        lacksVision: visionSupported === 'yes' ? false : undefined,
      });
      // 自检已证明模型能读图 → 这次读不到是「这张图难辨」，不是模型的问题
      const tail = visionSupported === 'yes'
        ? ' 视觉自检已确认模型能读图，因此问题出在这张图本身（分辨率/内容），不是模型不支持视觉。'
        : '';
      notes.push(advice + tail);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (imageDataUrl) {
      // 图片场景下 AI 没出结果 = 这张图根本没读出来，同样属于读图失败，
      // 不能只留一条普通 note 让人以为「结论就是无法判断」。
      imageReadFailed = true;
      notes.push('截图分析失败：AI 研判未产出可用结果——' + msg
        + '。图片场景下本地规则无法替代，请确认模型支持视觉、接口连通后重试。');
    } else {
      notes.push('AI 研判失败，已降级为本地规则结论：' + msg);
    }
    ai = null;
  }

  const merged = mergeVerdict(rule, ai, { engine: ai ? 'hybrid' : 'rule', notes });
  return { ...merged, source, degraded: !ai, imageReadFailed, visionSupported };
}

/**
 * 视觉能力自检：用一张四宫格测试图让模型按顺序报出四个颜色。
 * 用来把「模型不支持图片输入」与「这张图难辨」分开——前者换模型即可，后者要改图。
 * 探测本身失败（网络等）时返回 null，不影响主流程。
 */
async function probeVision(cfg, call, deps = {}) {
  try {
    const raw = await call(cfg, buildVisionProbeMessages(), {
      timeoutMs: Math.min(20000, deps.timeoutMs || 20000),
      maxTokens: 200,
    });
    return judgeVisionProbe(raw);
  } catch (e) {
    return null;
  }
}