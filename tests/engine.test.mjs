/**
 * 单元测试：node --test tests/engine.test.mjs
 * 覆盖脱敏、意图分类、风险检测、阶段推进、风险评分、微信场景特性（确定性校验）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, PLACEHOLDER_CARD, PLACEHOLDER_PHONE, PLACEHOLDER_URL, SCENARIOS } from '../kb/scenarios.js';
import { classifyIntent, detectRisks, nextStep, scoreRisk, riskLevel } from '../engine/rules.js';
import { ScamSession } from '../engine/session.js';

test('sanitize 脱敏卡号/手机号/链接', () => {
  assert.ok(sanitize('我的卡号 6222021234567890').includes(PLACEHOLDER_CARD));
  assert.ok(sanitize('我手机号 13800138000').includes(PLACEHOLDER_PHONE));
  assert.ok(sanitize('请访问 https://fake.example.com/a').includes(PLACEHOLDER_URL));
});

test('sanitize 不误伤普通数字', () => {
  const s = sanitize('金额是 500 元，期限 3 天');
  assert.ok(s.includes('500') && s.includes('3'));
});

test('知识库所有话术均不含未脱敏的敏感串', () => {
  for (const sc of Object.values(SCENARIOS)) {
    for (const st of sc.stages) {
      for (const line of [...st.lines, ...st.pressure, ...(st.systemMsg ? [st.systemMsg] : [])]) {
        assert.equal(sanitize(line), line, `剧本 ${sc.id}/${st.id} 存在可识别敏感串：${line}`);
      }
    }
  }
});

test('每个剧本都定义了微信好友设定', () => {
  for (const sc of Object.values(SCENARIOS)) {
    assert.ok(sc.contact, `${sc.id} 缺 contact`);
    assert.ok(sc.contact.nickname && sc.contact.avatar && sc.contact.avatarBg, `${sc.id} contact 字段不全`);
    assert.ok(sc.contact.lastMsg, `${sc.id} 缺 lastMsg`);
  }
});

test('意图分类：终止/质疑/顺从/中性', () => {
  assert.equal(classifyIntent('我要报警了').intent, 'terminate');
  assert.equal(classifyIntent('你就是骗子，别费劲').intent, 'terminate');
  assert.equal(classifyIntent('我现在就拉黑你并举报').intent, 'terminate');
  assert.equal(classifyIntent('请问您是哪个派出所？工号多少').intent, 'suspicious');
  assert.equal(classifyIntent('请把营业执照发我，我自己去企查查看').intent, 'suspicious');
  assert.equal(classifyIntent('好的，我怎么做').intent, 'comply');
  assert.equal(classifyIntent('嗯今天天气不错').intent, 'neutral');
});

test('风险检测：卡号/验证码/转账/装APP/收款码', () => {
  assert.deepEqual(detectRisks('我卡号是 6222021234567890'), ['card']);
  assert.deepEqual(detectRisks('验证码是 123456'), ['otp']);
  assert.ok(detectRisks('我马上转账给你').includes('transfer'));
  assert.ok(detectRisks('链接我已经下载安装了').includes('install'));
  assert.ok(detectRisks('我把收款码发给你').includes('qrcode'));
  assert.ok(detectRisks('我同意屏幕共享了').includes('screen'));
  assert.deepEqual(detectRisks('我需要考虑一下'), []);
});

test('阶段推进规则', () => {
  assert.equal(nextStep(0, 'comply', 4).action, 'advance');
  assert.equal(nextStep(3, 'comply', 4).action, 'hold');
  assert.equal(nextStep(1, 'suspicious', 4).action, 'pressure');
  assert.equal(nextStep(1, 'terminate', 4).action, 'terminate');
  assert.equal(nextStep(1, 'neutral', 4).index, 1);
});

test('风险评分单调且封顶 100', () => {
  const low = scoreRisk({ turns: 4, complied: 0, risks: [], stageIndex: 0 });
  const high = scoreRisk({ turns: 4, complied: 4, risks: ['card', 'otp', 'transfer'], stageIndex: 3 });
  assert.ok(low < high);
  assert.ok(high <= 100);
  assert.equal(scoreRisk({ turns: 100, complied: 100, risks: ['a','b','c','d','e','f','g'], stageIndex: 9 }), 100);
});

test('风险等级阈值边界', () => {
  assert.equal(riskLevel(70).level, '危险');
  assert.equal(riskLevel(69).level, '偏高');
  assert.equal(riskLevel(40).level, '偏高');
  assert.equal(riskLevel(39).level, '谨慎');
  assert.equal(riskLevel(14).level, '安全');
});

test('开场即包含系统提示与好友首条消息（微信场景）', () => {
  const s = new ScamSession('police');
  assert.equal(s.transcript[0].role, 'system');
  assert.equal(s.transcript[1].role, 'system');
  assert.equal(s.transcript[2].role, 'scammer');
  assert.equal(s.transcript[1].text, SCENARIOS.police.contact.lastMsg);
});

test('会话全流程：顺从推进到收网，报警后终止并生成报告', () => {
  const s = new ScamSession('job');
  assert.equal(s.stageIndex, 0);
  s.handle('好的，怎么操作');
  assert.equal(s.stageIndex, 1);
  s.handle('链接我已经下载安装了');
  assert.equal(s.stageIndex, 2);
  s.handle('我卡号是 6222021234567890，我马上转账');
  assert.equal(s.stageIndex, 3);
  assert.ok(s.risks.has('card') && s.risks.has('transfer') && s.risks.has('install'));
  const rep = s.report();
  assert.ok(rep.score >= 70);
  assert.equal(rep.level, '危险');
  const r = s.handle('我要报警');
  assert.equal(r.type, 'terminate');
  assert.ok(s.finished);
  assert.ok(rep.contact.nickname);
});

test('推进新阶段时会附带系统提示（链接/屏幕共享）', () => {
  const s = new ScamSession('police');
  const r = s.handle('好的，我配合');
  assert.equal(s.stageIndex, 1);
  assert.ok(r.messages.some((m) => m.role === 'system'), '进入第二阶段应出现系统提示');
});

test('全程质疑不会被推进阶段（反套路有效）', () => {
  const s = new ScamSession('police');
  s.handle('你是哪个派出所的？工号能不能查');
  s.handle('请提供官方文件编号');
  assert.equal(s.stageIndex, 0, '连续质疑不应让诈骗方进入下一阶段');
  s.handle('我要报警');
  assert.ok(s.finished);
});

test('拉黑被识别为终止', () => {
  const s = new ScamSession('invest');
  const r = s.handle('我要拉黑你并举报');
  assert.equal(r.type, 'terminate');
  assert.ok(s.finished);
});

test('未知剧本报错', () => {
  assert.throws(() => new ScamSession('not-exist'));
});
