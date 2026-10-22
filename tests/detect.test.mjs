/**
 * 诈骗辨析引擎单元测试：node --test tests/detect.test.mjs
 * 覆盖上传校验、内容校验、特征检测、规则评分、等级判定、AI 输出解析、结论仲裁、降级。
 * AI 调用用注入的假实现，不发真实网络请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXT_EXTS, IMAGE_EXTS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES,
  validateUpload, validateText, humanSize, extOf,
  detectSignals, ruleScore, ruleVerdict, levelOf, SIGNAL_TYPES, SIGNAL_INDEX,
  parseAnalysis, extractJson, isUnsafeAnalysis, mergeVerdict,
  buildAnalysisPrompt, buildAnalysisMessages, analyze, analyzeLocally,
  VERDICTS, AI_OVERRIDE_SCORE,
  TEXT_MAX_TOKENS, IMAGE_MAX_TOKENS,
  saysCannotReadImage, imageReadFailureAdvice, modelLacksVision,
  buildVisionProbeMessages, judgeVisionProbe, VISION_PROBE_IMAGE,
} from '../engine/detect.js';
import { callChat } from '../engine/ai.js';
import { CASES } from '../kb/cases.js';

/** 测试用聊天样本：冒充客服 + 索取验证码 + 诱导转账 + 制造紧迫，命中多类特征 */
const ANA = '我是蚂蚁客服 编号 A8821，您的花呗账单已逾期，请把短信验证码发给我，并转账 500 元到安全账户，今天之内必须处理。';

/* ---------------- 上传校验 ---------------- */

test('validateUpload 接受文本与图片', () => {
  assert.deepEqual(validateUpload({ name: 'chat.txt', size: 1000 }),
    { ok: true, kind: 'text', error: null, size: 1000 });
  assert.deepEqual(validateUpload({ name: 'a.PNG', size: 2048 }),
    { ok: true, kind: 'image', error: null, size: 2048 });
  assert.equal(validateUpload({ name: 'x.md', size: 10 }).kind, 'text');
  assert.equal(validateUpload({ name: 'x.webp', size: 10 }).kind, 'image');
});

test('validateUpload 拒绝不支持的扩展名并说明支持哪些', () => {
  const r = validateUpload({ name: 'virus.exe', size: 100 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('.exe'), r.error);
  assert.ok(r.error.includes('.txt') && r.error.includes('.png'), '应说明支持的格式');
});

test('validateUpload 按类型分别卡大小上限', () => {
  const t = validateUpload({ name: 'chat.txt', size: MAX_TEXT_BYTES + 1 });
  assert.equal(t.ok, false);
  assert.ok(t.error.includes('超过上限'), t.error);
  // 图片允许到 5MB，同等大小对文本而言超限、对图片仍合法
  assert.equal(validateUpload({ name: 'a.png', size: MAX_TEXT_BYTES + 1 }).ok, true);
  const i = validateUpload({ name: 'a.png', size: MAX_IMAGE_BYTES + 1 });
  assert.equal(i.ok, false);
  assert.ok(i.error.includes('超过上限'), i.error);
  // 恰好等于上限应通过（边界不含等号）
  assert.equal(validateUpload({ name: 'chat.txt', size: MAX_TEXT_BYTES }).ok, true);
  assert.equal(validateUpload({ name: 'a.png', size: MAX_IMAGE_BYTES }).ok, true);
});

test('validateUpload 拒绝空文件与无文件名', () => {
  assert.equal(validateUpload({ name: 'chat.txt', size: 0 }).ok, false);
  assert.equal(validateUpload({ name: '', size: 10 }).ok, false);
  assert.equal(validateUpload(null).ok, false);
});

test('extOf 与 humanSize', () => {
  assert.equal(extOf('a.TXT'), '.txt');
  assert.equal(extOf('noext'), '');
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
});

/* ---------------- 内容校验 ---------------- */

test('validateText 拦截空白与过短内容', () => {
  assert.equal(validateText('').ok, false);
  assert.equal(validateText('   \n\t ').ok, false);
  assert.equal(validateText('嗯嗯嗯').ok, false);
  assert.ok(validateText('嗯嗯嗯').error.includes('太短'), validateText('嗯嗯嗯').error);
  // 标点与空白不算有效字符
  assert.equal(validateText('，，，。！').ok, false);
  assert.equal(validateText('你好我是你的客服').ok, true);
});

/* ---------------- 特征检测 ---------------- */

test('detectSignals 命中冒充客服、验证码、诱导转账、紧迫施压', () => {
  const t = '我是蚂蚁客服，您的花呗账单已逾期，把短信验证码发给我，并转账 500 元到安全账户，今天之内必须处理';
  const ids = detectSignals(t).map((h) => h.id);
  assert.ok(ids.includes('impersonate_service'), ids.join(','));
  assert.ok(ids.includes('otp_request'), ids.join(','));
  assert.ok(ids.includes('money_transfer'), ids.join(','));
  assert.ok(ids.includes('urgency'), ids.join(','));
});

test('detectSignals 命中公检法类特征', () => {
  const ids = detectSignals('我是公安局民警，你涉嫌洗钱，请把钱转入安全账户接受清查').map((h) => h.id);
  assert.ok(ids.includes('impersonate_authority'), ids.join(','));
  assert.ok(ids.includes('money_transfer'), ids.join(','));
});

test('detectSignals 命中虚假链接与刷单', () => {
  const ids = detectSignals('点这里 https://x.cc/verify 刷单返利，日结佣金').map((h) => h.id);
  assert.ok(ids.includes('fake_link'), ids.join(','));
  assert.ok(ids.includes('brush_task'), ids.join(','));
});

test('detectSignals 对普通寒暄零命中（不制造假阳性）', () => {
  assert.deepEqual(detectSignals('明天天气不错，一起吃饭吗'), []);
  assert.deepEqual(detectSignals(''), []);
  assert.equal(ruleScore([], ''), 0);
});

test('detectSignals 按权重降序且结果可复现', () => {
  const t = '我是客服，把验证码发我，同时点这里 http://a.cc 转账';
  const a = detectSignals(t).map((h) => h.id);
  const b = detectSignals(t).map((h) => h.id);
  assert.deepEqual(a, b);
  assert.equal(a[0], 'otp_request', '验证码类权重 25 应排第一：' + a.join(','));
});

test('证据片段取自原文原话，不暴露内部正则', () => {
  const t = '我是蚂蚁客服 编号 A8821，您的花呗账单已逾期，请把短信验证码发给我';
  const hits = detectSignals(t);
  hits.forEach((h) => {
    assert.ok(h.evidence.length > 0, `${h.id} 缺少证据片段`);
    assert.ok(!h.evidence.includes('/'), '证据里不应出现正则源码：' + h.evidence);
    assert.ok(!h.evidence.includes('(') && !h.evidence.includes(')'), '证据里不应出现正则括号：' + h.evidence);
    // 证据的关键词必须真的出现在原文中
    assert.ok(t.includes(h.evidence.replace(/…$/, '').slice(0, 6)), '证据应摘自原文：' + h.evidence);
  });
});

test('证据片段过长时截断', () => {
  const long = 'x'.repeat(300);
  const hits = detectSignals(long + ' 我是公安局');
  const h = hits.find((x) => x.id === 'impersonate_authority');
  assert.ok(h, '应命中冒充公检法');
  assert.ok(h.evidence.length <= 62, '过长证据应截断，实际 ' + h.evidence.length);
});

test('每类特征的 catId 都指向真实存在的案例分类', () => {
  const catIds = new Set(Object.values(CASES).map((c) => c.catId));
  for (const s of SIGNAL_TYPES) {
    assert.ok(catIds.has(s.catId), `${s.id} 的 catId=${s.catId} 不存在于案例库`);
    assert.ok(s.label && s.detail && s.advice, `${s.id} 缺少 label/detail/advice`);
  }
});

test('每类特征都有可触发的示例（规则表非死代码）', () => {
  const samples = {
    impersonate_authority: '我是公安局民警',
    impersonate_service: '我是蚂蚁客服',
    impersonate_social: '我是你老板',
    money_transfer: '请你转账',
    fake_link: '点这里 www.a.cn',
    otp_request: '把验证码发我',
    screen_share: '我们开屏幕共享',
    fake_invest: '跟着老师投资稳赚',
    brush_task: '刷单日结',
    credit_repair: '征信修复',
    prize_tax: '恭喜您中奖，先交税费',
    emotional: '做我女朋友吧，带你投资',
    urgency: '今天之内必须马上',
    identity_info: '把身份证正反面发我',
  };
  for (const s of SIGNAL_TYPES) {
    const ids = detectSignals(samples[s.id]).map((h) => h.id);
    assert.ok(ids.includes(s.id), `${s.id} 用示例「${samples[s.id]}」未命中：${ids.join(',') || '(空)'}`);
  }
});

/* ---------------- 规则评分与等级 ---------------- */

test('ruleScore 单调性：命中特征越多分越高', () => {
  const one = ruleScore(detectSignals('我是客服，把验证码发我'), '我是客服，把验证码发我');
  const two = ruleScore(detectSignals('我是客服，把验证码发我，并转账到安全账户'), '我是客服，把验证码发我，并转账到安全账户');
  assert.ok(two > one, `${two} 应 > ${one}`);
});

test('ruleScore 落在 0-100', () => {
  const all = SIGNAL_TYPES.map((s) => s.detail).join('；');
  const s = ruleScore(detectSignals(all), all);
  assert.ok(s >= 0 && s <= 100, String(s));
});

test('ruleScore 同一行多特征有加成（逐行统计不是死代码）', () => {
  // 同一行同时命中三类特征 → 分数应高于把这三类拆到三行的分数
  const oneLine = '我是客服，把验证码发我，并转账 500 元到安全账户';
  const threeLines = '我是客服\n把验证码发我\n并转账 500 元到安全账户';
  const s1 = ruleScore(detectSignals(oneLine), oneLine);
  const s3 = ruleScore(detectSignals(threeLines), threeLines);
  assert.ok(s1 > s3, `同行 ${s1} 应大于分行 ${s3}`);
  // 加成上限 12 分
  const all = SIGNAL_TYPES.map((s) => s.detail).join('；');
  const sAll = ruleScore(detectSignals(all), all);
  assert.ok(sAll <= 100, String(sAll));
});

test('levelOf 边界值分档正确', () => {
  assert.equal(levelOf(100).id, 'high');
  assert.equal(levelOf(70).id, 'high');
  assert.equal(levelOf(69).id, 'mid_high');
  assert.equal(levelOf(45).id, 'mid_high');
  assert.equal(levelOf(44).id, 'mid');
  assert.equal(levelOf(25).id, 'mid');
  assert.equal(levelOf(24).id, 'low');
  assert.equal(levelOf(1).id, 'low');
  assert.equal(levelOf(0).id, 'none');
  assert.equal(levelOf(-5).id, 'none');
  assert.equal(levelOf(999).id, 'high');
});

test('ruleVerdict：无文本恒为 unknown', () => {
  assert.equal(ruleVerdict(90, false), 'unknown');
  assert.equal(ruleVerdict(30, true), 'scam');
  assert.equal(ruleVerdict(0, true), 'clean');
  assert.equal(ruleVerdict(10, true), 'unknown');
});

/* ---------------- AI 输出解析 ---------------- */

test('extractJson 能从代码块与前后废话中抠出 JSON', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```').a, 1);
  assert.equal(extractJson('好的，结果如下：{"a":2} 希望有帮助').a, 2);
  assert.equal(extractJson('没有JSON'), null);
  assert.equal(extractJson(null), null);
});

test('parseAnalysis 正常解析并收紧数值区间', () => {
  const r = parseAnalysis(JSON.stringify({
    verdict: 'scam', riskScore: 999, confidence: -5,
    signals: [{ type: 'otp_request', name: '索取验证码', quote: '把验证码发我' }],
    summary: '对方以客服名义索取验证码', advice: ['不要提供验证码'],
  }));
  assert.equal(r.verdict, 'scam');
  assert.equal(r.riskScore, 100, '999 应夹到 100');
  assert.equal(r.confidence, 0, '-5 应夹到 0');
  assert.equal(r.signals[0].known, true);
  assert.deepEqual(r.advice, ['不要提供验证码']);
});

test('parseAnalysis 对非法结构抛错（必须降级而非放行）', () => {
  assert.throws(() => parseAnalysis('这不是JSON'), /JSON/);
  assert.throws(() => parseAnalysis('{"verdict":"maybe","summary":"x"}'), /取值非法/);
  assert.throws(() => parseAnalysis('{"verdict":"scam"}'), /依据摘要/);
  assert.throws(() => parseAnalysis('{"verdict":"scam","summary":"  "}'), /依据摘要/);
});

test('parseAnalysis 容忍缺失的可选字段', () => {
  const r = parseAnalysis('{"verdict":"clean","summary":"无异常"}');
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.advice, []);
  assert.equal(r.riskScore, 0);
});

test('isUnsafeAnalysis 拦截可执行诈骗指引', () => {
  assert.equal(isUnsafeAnalysis('建议不要提供验证码'), false);
  assert.equal(isUnsafeAnalysis('第一步实施诈骗，先取得信任'), true);
  assert.equal(isUnsafeAnalysis('照着说：你好我是客服'), true);
  assert.equal(isUnsafeAnalysis('教你如何规避警方追查'), true);
  assert.equal(isUnsafeAnalysis('绕过风控的操作是…'), true);
});

test('buildAnalysisPrompt 含输出格式与不得编造的约束', () => {
  const p = buildAnalysisPrompt(detectSignals('我是客服'));
  assert.ok(p.includes('JSON'), '应要求 JSON 输出');
  assert.ok(p.includes('unknown'), '应给出无法判断这一取值');
  assert.ok(p.includes('不得改写或虚构'), '应要求 quote 摘自原文');
  assert.ok(p.includes('严禁输出任何可执行的诈骗操作手法'), '应禁止输出可执行指引');
  assert.ok(p.includes('impersonate_service'), '应把规则命中特征告知模型');
});

test('buildAnalysisPrompt 在规则零命中时要求模型不要顺着预设下结论', () => {
  const p = buildAnalysisPrompt([]);
  assert.ok(p.includes('未命中任何特征'), p.slice(0, 200));
});

test('buildAnalysisMessages 文本走纯文本、多模态走 image_url', () => {
  const a = buildAnalysisMessages('聊天内容', null, []);
  assert.equal(a[0].role, 'system');
  assert.equal(typeof a[1].content, 'string');
  const b = buildAnalysisMessages('', 'data:image/png;base64,AAA', []);
  assert.ok(Array.isArray(b[1].content), '图片应使用多模态数组');
  assert.equal(b[1].content[1].type, 'image_url');
});

test('★ 图片指令要求逐格读拼图、且不因文字小就放弃', () => {
  const m = buildAnalysisMessages('', 'data:image/jpeg;base64,AAA', []);
  const t = m[1].content[0].text;
  assert.ok(t.includes('逐格'), '应要求逐格阅读拼图：' + t.slice(0, 80));
  assert.ok(t.includes('拼图'), '应说明可能是多屏拼图');
  assert.ok(t.includes('不要因为文字小'), '应禁止因文字小整体放弃');
  assert.ok(t.includes('apk'), '应提示识别文件类型等线索');
  // 图片场景不应再使用「截图」这种会暗示只有一屏的说法
  assert.ok(!/^请辨析这张聊天截图/.test(t), '不应再用旧的一句话提示');
});

test('图片场景附带用户粘贴的文字作为补充线索', () => {
  const m = buildAnalysisMessages('对方发了 apk 安装包', 'data:image/jpeg;base64,AAA', []);
  assert.ok(m[1].content[0].text.includes('对方发了 apk 安装包'), '粘贴文字应进入提示');
  assert.ok(m[1].content[0].text.includes('互为印证'));
});

test('图片场景无粘贴文字时不添加空段落', () => {
  const m = buildAnalysisMessages('   ', 'data:image/jpeg;base64,AAA', []);
  assert.ok(!m[1].content[0].text.includes('用户同时提供的文字内容'), '不应出现空的补充段落');
});

test('system prompt 的 quote 口径覆盖图片场景', () => {
  const p = buildAnalysisPrompt([]);
  assert.ok(p.includes('图片输入时为图片里看到的原话'), p.slice(0, 200));
});

/* ---------------- 视觉能力探测（区分「模型不支持」与「图难辨」） ---------------- */

test('buildVisionProbeMessages 发出一张四宫格测试图', () => {
  const m = buildVisionProbeMessages();
  const parts = m[1].content;
  assert.ok(Array.isArray(parts));
  const img = parts.find((p) => p.type === 'image_url');
  assert.ok(img, '应包含图片部分');
  assert.ok(String(img.image_url.url).startsWith('data:image/png;base64,'), '应为 data URL');
  assert.ok(String(img.image_url.url).length < 400, '测试图应极小（几百字节）');
  assert.ok(parts[0].text.includes('左上'), '问题应要求按位置顺序回答');
});

test('judgeVisionProbe 能区分「读到了图」与「读不到图」', () => {
  // 探测图是四宫格，正确答案 = 红、蓝、绿、黄（按左上/右上/左下/右下）
  assert.equal(judgeVisionProbe('红色、蓝色、绿色、黄色').state, 'yes');
  assert.equal(judgeVisionProbe('红色、蓝色、绿色、黄色').supported, true);
  assert.equal(judgeVisionProbe('红、蓝、绿、黄').state, 'yes');
  assert.equal(judgeVisionProbe('red, blue, green, yellow').state, 'yes');
  // 按列读也是对的，不该误伤
  assert.equal(judgeVisionProbe('红色、绿色、蓝色、黄色').state, 'yes');
  assert.equal(judgeVisionProbe('我是一个纯文本模型，无法处理图片').state, 'no');
  assert.equal(judgeVisionProbe('没有收到图片').state, 'no');
  assert.equal(judgeVisionProbe('无法确定，因为你没有提供图片。').state, 'no');
  assert.equal(judgeVisionProbe('').state, 'unknown');
  assert.equal(judgeVisionProbe('不知道').state, 'unknown');
});

test('judgeVisionProbe：瞎猜出来的顺序不算读图成功', () => {
  // 实测纯文本模型 deepseek-v4-pro 对四宫格探测图的回答
  assert.equal(judgeVisionProbe('灰色、灰色、灰色、灰色').state, 'unknown');
  assert.equal(judgeVisionProbe('灰色、灰色、灰色、灰色').supported, false);
  // 顺序错了也不算
  assert.equal(judgeVisionProbe('蓝色、红色、绿色、黄色').state, 'unknown');
});

test('judgeVisionProbe 返回可读的原因说明', () => {
  const ok = judgeVisionProbe('红色、蓝色、绿色、黄色');
  assert.ok(ok.reason.length > 0, ok.reason);
  const no = judgeVisionProbe('纯文本模型不支持图片');
  assert.ok(no.reason.includes('无法处理图片'), no.reason);
});

test('buildAnalysisMessages 超长文本被截断', () => {
  const long = '啊'.repeat(9000);
  const m = buildAnalysisMessages(long, null, []);
  assert.ok(m[1].content.includes('已截取前 4000 字'));
  assert.ok(m[1].content.length < 4200);
});

/* ---------------- 结论仲裁 ---------------- */

const ruleScam = () => {
  const hits = detectSignals('我是公安局，你涉嫌洗钱，请转入安全账户');
  const score = ruleScore(hits, '我是公安局，你涉嫌洗钱，请转入安全账户');
  return { score, hits, hasText: true };
};

test('mergeVerdict：AI 说否不能推翻规则强信号', () => {
  const r = mergeVerdict(ruleScam(), { verdict: 'clean', riskScore: 5, confidence: 90, signals: [], summary: '看起来正常', advice: [] }, { engine: 'hybrid', notes: [] });
  assert.equal(r.verdict, 'scam');
  assert.ok(r.notes.some((n) => n.includes('已按规则判定')), r.notes.join('|'));
});

test('mergeVerdict：AI 说是否而规则零命中时保留结论但压低置信度', () => {
  const hits = detectSignals('你好啊在吗');
  const r = mergeVerdict({ score: 0, hits, hasText: true },
    { verdict: 'scam', riskScore: 40, confidence: 95, signals: [], summary: '疑似', advice: [] },
    { engine: 'hybrid', notes: [] });
  assert.equal(r.verdict, 'scam');
  assert.ok(r.confidence <= 72, '置信度应被上限压制，实际 ' + r.confidence);
  assert.ok(r.notes.some((n) => n.includes('人工复核')), r.notes.join('|'));
});

test('mergeVerdict：规则与 AI 一致判否时结论为否', () => {
  const hits = detectSignals('明天一起吃饭吗');
  const r = mergeVerdict({ score: 0, hits, hasText: true },
    { verdict: 'clean', riskScore: 0, confidence: 80, signals: [], summary: '普通寒暄', advice: [] },
    { engine: 'hybrid', notes: [] });
  assert.equal(r.verdict, 'clean');
  assert.equal(r.level.id, 'none');
});

test('mergeVerdict：AI 补充的特征与规则特征并存且按 id 去重', () => {
  const r = mergeVerdict(ruleScam(),
    { verdict: 'scam', riskScore: 80, confidence: 90,
      signals: [{ type: 'impersonate_authority', name: '冒充公检法', quote: '我是公安局' },
                { type: 'odd_request', name: '异常索求', quote: '帮我做件事' }],
      summary: '综合判定', advice: [] },
    { engine: 'hybrid', notes: [] });
  const auth = r.signals.filter((s) => s.id === 'impersonate_authority');
  assert.equal(auth.length, 1, '同一 id 不应重复');
  const odd = r.signals.find((s) => s.id === 'odd_request');
  assert.ok(odd, 'AI 补充特征应保留');
  assert.equal(odd.fromAI, true);
});

test('mergeVerdict：无 AI 时走规则结论且置信度合理', () => {
  const r = mergeVerdict(ruleScam(), null, { engine: 'rule', notes: [] });
  assert.equal(r.verdict, 'scam');
  assert.ok(r.summary.includes('规则层结论'), r.summary);
  assert.ok(r.confidence >= 45);
});

test('mergeVerdict：图片无本地规则时结论完全交给 AI', () => {
  const r = mergeVerdict({ score: 0, hits: [], hasText: false },
    { verdict: 'scam', riskScore: 75, confidence: 70, signals: [], summary: '截图显示索要验证码', advice: [] },
    { engine: 'hybrid', notes: [] });
  assert.equal(r.verdict, 'scam');
  assert.equal(r.riskScore, 75);
  assert.ok(r.notes.some((n) => n.includes('视觉')), r.notes.join('|'));
});

test('mergeVerdict：图片且无 AI 时为无法判断', () => {
  const r = mergeVerdict({ score: 0, hits: [], hasText: false }, null, { engine: 'rule', notes: [] });
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.summary.includes('视觉'), r.summary);
});

test('mergeVerdict：建议去重且规则建议优先', () => {
  const r = mergeVerdict(ruleScam(),
    { verdict: 'scam', riskScore: 90, confidence: 90, signals: [], summary: 'x', advice: ['新建议一', '新建议二'] },
    { engine: 'hybrid', notes: [] });
  assert.ok(r.advice.length >= 2);
  assert.equal(new Set(r.advice).size, r.advice.length, '建议不应重复');
  assert.ok(!r.advice.includes(''), '不应出现空建议');
});

/* ---------------- 主入口 analyze ---------------- */

const CFG = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test123456', model: 'm' };

test('analyze 无 AI 配置时纯规则可用（离线）', async () => {
  const r = await analyze({ text: ANA, name: 'c.txt', kind: 'text' }, null);
  assert.equal(r.engine, 'rule');
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, 'scam');
  assert.ok(r.signals.length > 0);
});

test('analyze 内容为空抛带 code 的错误', async () => {
  await assert.rejects(() => analyze({ text: '   ' }, null), (e) => {
    assert.equal(e.code, 'empty');
    assert.ok(e.message.includes('内容为空'));
    return true;
  });
});

test('analyze AI 正常返回时标记 hybrid 并给出结论', async () => {
  const callChat = async () => JSON.stringify({
    verdict: 'scam', riskScore: 85, confidence: 88,
    signals: [{ type: 'otp_request', name: '索取验证码', quote: '把验证码发我' }],
    summary: '冒充客服索取验证码', advice: ['立即终止往来'],
  });
  const r = await analyze({ text: ANA, name: 'c.txt' }, CFG, { callChat });
  assert.equal(r.engine, 'hybrid');
  assert.equal(r.degraded, false);
  assert.equal(r.verdict, 'scam');
  assert.equal(r.riskScore, Math.max(ruleScore(detectSignals(ANA), ANA), 85));
  assert.ok(r.advice.includes('立即终止往来'));
});

test('analyze AI 超时/网络失败降级为规则结论并写入 notes', async () => {
  const callChat = async () => { throw new Error('请求超时'); };
  const r = await analyze({ text: ANA, name: 'c.txt' }, CFG, { callChat });
  assert.equal(r.degraded, true);
  assert.equal(r.engine, 'rule');
  assert.equal(r.verdict, 'scam', '降级后仍须给出规则结论');
  assert.ok(r.notes.some((n) => n.includes('AI 研判失败') && n.includes('超时')), r.notes.join('|'));
});

test('analyze AI 返回非法 JSON 时降级', async () => {
  const callChat = async () => '我觉得这不像是诈骗';
  const r = await analyze({ text: ANA, name: 'c.txt' }, CFG, { callChat });
  assert.equal(r.degraded, true);
  assert.equal(r.verdict, 'scam');
  assert.ok(r.notes.some((n) => n.includes('JSON')), r.notes.join('|'));
});

test('analyze AI 越界输出被拒绝并降级', async () => {
  const callChat = async () => JSON.stringify({
    verdict: 'scam', riskScore: 90, confidence: 90, signals: [],
    summary: '第一步实施诈骗，先取得信任', advice: [],
  });
  const r = await analyze({ text: ANA, name: 'c.txt' }, CFG, { callChat });
  assert.equal(r.degraded, true);
  assert.ok(r.notes.some((n) => n.includes('越界')), r.notes.join('|'));
});

test('analyze AI 字段合法但 summary 越界同样被拒', async () => {
  const callChat = async () => JSON.stringify({
    verdict: 'scam', riskScore: 90, confidence: 90, signals: [],
    summary: '照着说：你好我是客服', advice: ['好的'],
  });
  const r = await analyze({ text: ANA, name: 'c.txt' }, CFG, { callChat });
  assert.equal(r.degraded, true);
});

test('analyze 图片输入走多模态且不要求本地文本', async () => {
  let captured = null;
  let n = 0;
  const callChat = async (cfg, msgs) => {
    n++;
    // 第 1 次是视觉自检（前置闸门），第 2 次才是真正的研判请求
    if (n === 1) return '红色、蓝色、绿色、黄色';
    captured = msgs;
    return JSON.stringify({ verdict: 'scam', riskScore: 70, confidence: 65, signals: [], summary: '截图显示索要验证码', advice: [] });
  };
  const r = await analyze({ imageDataUrl: 'data:image/png;base64,AAA', name: 'a.png', kind: 'image' }, CFG, { callChat });
  assert.ok(Array.isArray(captured[1].content));
  assert.equal(r.verdict, 'scam');
  assert.ok(r.source.kind === 'image');
});

test('analyze 图片且无 AI 时结论为无法判断而非崩溃', async () => {
  const r = await analyze({ imageDataUrl: 'data:image/png;base64,AAA', name: 'a.png', kind: 'image' }, null);
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.summary.includes('视觉'));
});

test('analyze 未注入 callChat 时报错（不静默假成功）', async () => {
  await assert.rejects(() => analyze({ text: ANA }, CFG, {}), /未注入/);
});

test('analyzeLocally 纯函数给出结论与来源信息', () => {
  const r = analyzeLocally({ text: ANA, name: 'demo.txt' });
  assert.equal(r.verdict, 'scam');
  assert.equal(r.source.name, 'demo.txt');
  assert.equal(r.source.chars, ANA.length);
  assert.ok(r.level.id === 'high' || r.level.id === 'mid_high', r.level.id);
});

/* ---------------- 与既有模块的一致性 ---------------- */

test('VERDICTS 三种取值齐全且与需求口径一致', () => {
  assert.deepEqual(Object.keys(VERDICTS).sort(), ['clean', 'scam', 'unknown']);
  assert.equal(VERDICTS.scam.label, '是');
  assert.equal(VERDICTS.clean.label, '否');
  assert.equal(VERDICTS.unknown.label, '无法判断');
});

test('每条 AI 建议都来自可核对的来源（规则建议或模型输出）', () => {
  const r = mergeVerdict(ruleScam(), null, { engine: 'rule', notes: [] });
  const allowed = new Set(Object.values(SIGNAL_INDEX).map((s) => s.advice));
  r.advice.forEach((a) => assert.ok(allowed.has(a), `出现了无来源的建议：${a}`));
});

test('AI_OVERRIDE_SCORE 落在中等风险区间（保证「是」不被轻易推翻）', () => {
  assert.ok(AI_OVERRIDE_SCORE >= 25 && AI_OVERRIDE_SCORE <= 70);
});

/* ---------------- 多模态（截图）研判：输出预算与读图失败识别 ---------------- */

test('callChat 的 max_tokens 可由调用方覆盖（请求级 > 配置级 > 默认）', async () => {
  let body = null;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) };
  };
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'm' };
  // 默认
  await callChat(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch });
  assert.equal(body.max_tokens, 400, '未指定时沿用默认 400');
  // 请求级覆盖
  await callChat(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch, maxTokens: 4000 });
  assert.equal(body.max_tokens, 4000, '请求级 maxTokens 应生效');
  // 配置级
  await callChat({ ...cfg, maxTokens: 2000 }, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch });
  assert.equal(body.max_tokens, 2000, 'cfg.maxTokens 应生效');
  // 请求级优先于配置级
  await callChat({ ...cfg, maxTokens: 2000 }, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch, maxTokens: 8000 });
  assert.equal(body.max_tokens, 8000, '请求级应覆盖配置级');
});

test('★ 截图研判的输出预算远大于纯文本（读图需要更多推理额度）', async () => {
  // analyze() 的 deps.callChat 签名为 (cfg, messages, opts)，
  // 因此这里在 opts 里取 maxTokens，再委托给真正的 callChat 去打 fetch
  let body = null;
  let n = 0;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    n++;
    // 第 1 次是视觉自检：答对四色顺序才放行真正的研判请求
    if (n === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: '红色、蓝色、绿色、黄色' } }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      verdict: 'scam', riskScore: 80, confidence: 90, signals: [], summary: '识别到诱导安装APP', advice: [],
    }) } }] }) };
  };
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'vision' };
  await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' }, cfg,
    { callChat: (c, msgs, opts) => callChat(c, msgs, { ...opts, fetchImpl: fakeFetch }) });
  assert.equal(body.max_tokens, IMAGE_MAX_TOKENS, '截图应使用 IMAGE_MAX_TOKENS');
  assert.ok(IMAGE_MAX_TOKENS >= 2000, '读图预算不应低于 2000');
  assert.ok(IMAGE_MAX_TOKENS > TEXT_MAX_TOKENS, '截图预算应大于纯文本预算');
});

test('纯文本研判使用较小的输出预算', async () => {
  let body = null;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      verdict: 'clean', riskScore: 0, confidence: 80, signals: [], summary: '普通聊天', advice: [],
    }) } }] }) };
  };
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'm' };
  await analyze({ text: ANA, name: 'a.txt', kind: 'text' }, cfg,
    { callChat: (c, msgs, opts) => callChat(c, msgs, { ...opts, fetchImpl: fakeFetch }) });
  assert.equal(body.max_tokens, TEXT_MAX_TOKENS);
});

test('saysCannotReadImage 识别模型声称读不到图的各类表述', () => {
  assert.equal(saysCannotReadImage('聊天截图为不可读内容，无法提取对话信息'), true);
  assert.equal(saysCannotReadImage('这张图片无法识别'), true);
  assert.equal(saysCannotReadImage('我看不到图片中的内容'), true);
  assert.equal(saysCannotReadImage('图片过于模糊，无法看清'), true);
  assert.equal(saysCannotReadImage('作为纯文本模型，我无法处理图片'), true);
  assert.equal(saysCannotReadImage('未收到图片'), true);
  // 正常结论不应被误判
  assert.equal(saysCannotReadImage('对方要求转账并索要验证码'), false);
  assert.equal(saysCannotReadImage(''), false);
});

test('imageReadFailureAdvice 区分「模型不支持视觉」与「图本身难辨」', () => {
  const noVision = imageReadFailureAdvice('作为纯文本模型，我无法处理图片', true);
  assert.ok(noVision.includes('不支持图片输入'), noVision);
  assert.ok(noVision.includes('gpt-4o'), '应给出可用模型示例');
  const blurry = imageReadFailureAdvice('图片过于模糊，无法看清', true);
  assert.ok(blurry.includes('分辨率') || blurry.includes('裁剪'), blurry);
  assert.ok(blurry.includes('文字'), '应提示可改用文字分析');
  // 非图片输入不产出该提示
  assert.equal(imageReadFailureAdvice('无法识别', false), '');
  // 正常结论不产出该提示
  assert.equal(imageReadFailureAdvice('对方索要验证码', true), '');
});

test('★ 模型声称读不到图时，analyze 标记 imageReadFailed 并给出指引', async () => {
  const callChat = async () => JSON.stringify({
    verdict: 'unknown', riskScore: 0, confidence: 10,
    signals: [], summary: '聊天截图为不可读内容，无法提取对话信息，因此无法判断是否存在诈骗特征。',
    advice: [],
  });
  const r = await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' },
    { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'm' }, { callChat });
  assert.equal(r.imageReadFailed, true, '应被识别为读图失败');
  assert.ok(r.notes.some((n) => n.includes('截图')), r.notes.join('|'));
  assert.ok(r.notes.some((n) => n.includes('gpt-4o') || n.includes('裁剪')), r.notes.join('|'));
});

test('正常识别图片时不标记 imageReadFailed', async () => {
  let n = 0;
  const callChat = async () => {
    n++;
    if (n === 1) return '红色、蓝色、绿色、黄色';   // 视觉自检
    return JSON.stringify({
      verdict: 'scam', riskScore: 85, confidence: 90,
      signals: [{ type: 'fake_link', name: '诱导安装APP', quote: '蜜桃(1).apk' }],
      summary: '对方发送 APK 安装包诱导下载', advice: ['不要安装陌生APP'],
    });
  };
  const r = await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' },
    { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'm' }, { callChat });
  assert.equal(r.imageReadFailed, false);
  assert.equal(r.verdict, 'scam');
  assert.equal(r.degraded, false);
});

test('纯文本输入不因内容含「无法识别」而误标读图失败', async () => {
  const callChat = async () => JSON.stringify({
    verdict: 'scam', riskScore: 70, confidence: 80, signals: [],
    summary: '对方称无法识别二维码，让我改发银行卡号', advice: [],
  });
  const r = await analyze({ text: ANA, name: 'a.txt', kind: 'text' },
    { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'm' }, { callChat });
  assert.equal(r.imageReadFailed, false, '纯文本不应标记读图失败');
});
/* ================================================================
 * 读图失败的三种成因（模型不支持视觉 / 图难辨 / 措辞漏判）
 * ================================================================ */

test('★ saysCannotReadImage 覆盖实测到的真实措辞', () => {
  // 这两句是实跑 deepseek-v4-pro 时模型原话，之前都没被识别到，
  // 结果失败横幅不弹，用户只看到一句「无法判断」
  assert.equal(saysCannotReadImage('抱歉，我无法读取这张图片，因为图片未能成功上传或格式不受支持。'), true);
  assert.equal(saysCannotReadImage('未获取到可识别的聊天内容，图片显示为不支持或缺失，无法判断是否存在诈骗特征。'), true);
  assert.equal(saysCannotReadImage('Unsupported image: the model received an image it cannot process'), true);
  // 正常结论不应误判
  assert.equal(saysCannotReadImage('对方要求转账并索要验证码，疑似诈骗'), false);
});

test('★ modelLacksVision 区分「模型没视觉能力」与「图难辨」', () => {
  assert.equal(modelLacksVision('作为纯文本模型，我无法处理图片'), true);
  assert.equal(modelLacksVision('图片未能成功上传或格式不受支持'), true);
  assert.equal(modelLacksVision('图片显示为不支持或缺失'), true);
  // 图难辨不属于「模型不支持」
  assert.equal(modelLacksVision('图片过于模糊，无法看清'), false);
  assert.equal(modelLacksVision('分辨率过低'), false);
});

test('★ 结论为「无法判断」时风险等级不是「未发现风险」', () => {
  const r = mergeVerdict({ score: 0, hits: [], hasText: false },
    { verdict: 'unknown', riskScore: 0, confidence: 10, signals: [], summary: '读不到图', advice: [] },
    { engine: 'hybrid', notes: [] });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.level.id, 'unknown', '未知结论必须显示「无法评估」');
  assert.equal(r.level.label, '无法评估');
  assert.notEqual(r.level.label, '未发现风险');
  // 明确的「否」仍然是未发现风险
  const clean = mergeVerdict({ score: 0, hits: [], hasText: true },
    { verdict: 'clean', riskScore: 0, confidence: 80, signals: [], summary: '普通寒暄', advice: [] },
    { engine: 'hybrid', notes: [] });
  assert.equal(clean.level.id, 'none');
});

test('★ imageReadFailureAdvice 能指名道姓地给出替换模型', () => {
  const a = imageReadFailureAdvice('图片未能成功上传或格式不受支持', true,
    { model: 'deepseek-v4-pro', suggestModel: 'deepseek-flash' });
  assert.ok(a.includes('deepseek-v4-pro'), a);
  assert.ok(a.includes('deepseek-flash'), a);
  assert.ok(a.includes('不支持图片输入'), a);
  // 视觉自检已确认模型没视觉能力时，即使措辞不含关键词也走「换模型」分支
  const b = imageReadFailureAdvice('随便一句抱怨', true, { model: 'm', lacksVision: true, suggestModel: 'deepseek-flash' });
  assert.ok(b.includes('deepseek-flash'), b);
});

test('★ 视觉自检通过但仍读不出图时，判定为「图难辨」而非「模型不支持」', async () => {
  let calls = 0;
  const callChat = async () => {
    calls++;
    if (calls === 1) return '红色、蓝色、绿色、黄色';   // 视觉自检：模型确实能读图
    return JSON.stringify({
      verdict: 'unknown', riskScore: 0, confidence: 10, signals: [],
      summary: '图片未能成功上传或格式不受支持，无法判断。', advice: [],
    });
  };
  const r = await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test12345', model: 'deepseek-flash' }, { callChat });
  assert.equal(r.imageReadFailed, true);
  assert.equal(calls, 2, '自检 1 次 + 研判 1 次');
  assert.equal(r.visionSupported, 'yes', '自检通过 → 模型支持视觉');
  assert.ok(r.notes.some((n) => n.includes('问题出在这张图本身')), r.notes.join('|'));
});

test('★ 视觉自检读不出测试图时，确认是模型不支持视觉', async () => {
  const callChat = async () => '我是纯文本模型，无法处理图片';
  const r = await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test12345', model: 'my-unknown-model' }, { callChat });
  assert.equal(r.visionSupported, false);
  assert.equal(r.imageReadFailed, true, '自检不通过 → 不采信图片结论');
  assert.equal(r.verdict, 'unknown', '不得给出任何结论');
  assert.ok(r.notes.some((n) => n.includes('deepseek-flash') || n.includes('支持视觉的模型')), r.notes.join('|'));
});

test('★ 已知纯文本模型时本地直接拦下，一个请求都不发', async () => {
  let calls = 0;
  const callChat = async () => { calls++; return 'x'; };
  const r = await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test12345', model: 'deepseek-v4-pro' }, { callChat });
  assert.equal(calls, 0, '已知纯文本模型不应浪费请求');
  assert.equal(r.imageReadFailed, true);
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.notes.some((n) => n.includes('deepseek-flash')), r.notes.join('|'));
});

test('★ 图片场景下 AI 调用失败也算读图失败（不是「无法判断」）', async () => {
  const callChat = async () => { throw new Error('接口返回 400'); };
  const r = await analyze({ imageDataUrl: 'data:image/jpeg;base64,AAA', name: 'a.png', kind: 'image' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test12345', model: 'deepseek-v4-pro' }, { callChat });
  assert.equal(r.imageReadFailed, true, '图片没读出来就是失败');
  assert.ok(r.notes.some((n) => n.includes('截图')), r.notes.join('|'));
  assert.equal(r.level.id, 'unknown');
});

test('纯文本场景下 AI 失败仍走「AI 研判失败」降级措辞', async () => {
  const callChat = async () => { throw new Error('请求超时'); };
  const r = await analyze({ text: ANA, name: 'c.txt' }, { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345', model: 'm' },
    { callChat });
  assert.equal(r.imageReadFailed, false, '文本场景不应标记读图失败');
  assert.ok(r.notes.some((n) => n.includes('AI 研判失败')), r.notes.join('|'));
});
