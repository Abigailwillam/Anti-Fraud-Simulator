/**
 * AI 模式集成测试：node --test tests/session-ai.test.mjs
 * 重点验证「AI 不可用时必须安全降级」——这是整个 AI 接入的安全网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScamSession } from '../engine/session.js';
import { SCENARIOS } from '../kb/scenarios.js';

const CFG = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-testkey123', model: 'm' };

/** 构造一个可注入 fetch 的全局替身 */
function stubFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => { delete globalThis.fetch; };
}

test('无配置时 handleAsync 等价于规则模式', async () => {
  const s = new ScamSession('police');
  const r = await s.handleAsync('好的，怎么做', null);
  assert.equal(r.type, 'advance');
  assert.equal(r.note, null);
  assert.equal(s.stageIndex, 1);
});

test('AI 正常时使用模型输出，且阶段仍由规则推进', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '您好，这里是反诈中心，请配合。' } }] }),
  }));
  try {
    const s = new ScamSession('police');
    const r = await s.handleAsync('好的，怎么做', CFG);
    assert.equal(r.note, null);
    assert.equal(r.messages.at(-1).text, '您好，这里是反诈中心，请配合。');
    assert.equal(s.stageIndex, 1, '阶段推进必须由规则决定');
  } finally { restore(); }
});

test('网络失败时降级为规则话术并给出 note，会话不中断', async () => {
  const restore = stubFetch(async () => { throw new Error('network down'); });
  try {
    const s = new ScamSession('job');
    const r = await s.handleAsync('好的，怎么做', CFG);
    assert.ok(/AI 调用失败/.test(r.note));
    assert.ok(/network down/.test(r.note));
    assert.ok(r.messages.at(-1).text.length > 0, '降级后仍应有话术');
    assert.equal(s.stageIndex, 1, '降级不影响阶段推进');
  } finally { restore(); }
});

test('鉴权失败（401）时降级，不抛到 UI', async () => {
  const restore = stubFetch(async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }));
  try {
    const s = new ScamSession('invest');
    const r = await s.handleAsync('好的', CFG);
    assert.ok(/401/.test(r.note));
    assert.ok(r.messages.length > 0);
  } finally { restore(); }
});

test('模型输出越界时丢弃并降级（不把「破绽」提示喂给用户）', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '提示：破绽是公检法从不用微信办案。' } }] }),
  }));
  try {
    const s = new ScamSession('police');
    const r = await s.handleAsync('好的，怎么做', CFG);
    assert.ok(/越界/.test(r.note));
    assert.ok(!/破绽/.test(r.messages.at(-1).text), '越界文本不得出现在聊天里');
  } finally { restore(); }
});

test('模型输出再次经过脱敏（不因模型而漏出真实卡号）', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '请转到 6222021234567890 这个账户' } }] }),
  }));
  try {
    const s = new ScamSession('police');
    const r = await s.handleAsync('好的', CFG);
    assert.ok(!/6222021234567890/.test(r.messages.at(-1).text), '模型输出也必须脱敏');
    assert.ok(/卡号已脱敏/.test(r.messages.at(-1).text));
  } finally { restore(); }
});

test('AI 模式下终止判定仍准确', async () => {
  const restore = stubFetch(async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: '别啊等等我' } }] }),
  }));
  try {
    const s = new ScamSession('job');
    const r = await s.handleAsync('我要报警', CFG);
    assert.equal(r.type, 'terminate');
    assert.ok(s.finished);
  } finally { restore(); }
});

test('AI 模式下连续质疑不推进阶段（防跑偏的核心保证）', async () => {
  const restore = stubFetch(async () => ({
    ok: true, json: async () => ({ choices: [{ message: { content: '这是国家规定，走流程就行。' } }] }),
  }));
  try {
    const s = new ScamSession('police');
    await s.handleAsync('你是哪个派出所的？工号能否查证', CFG);
    await s.handleAsync('请把营业执照发我，我自己去企查查看', CFG);
    assert.equal(s.stageIndex, 0, '无论模型说什么，连续质疑都不应推进阶段');
    await s.handleAsync('我要拉黑你', CFG);
    assert.ok(s.finished);
  } finally { restore(); }
});

test('传给模型的 system prompt 含人设与越界禁令', async () => {
  let captured = null;
  const restore = stubFetch(async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '好的' } }] }) };
  });
  try {
    const s = new ScamSession('refund');
    await s.handleAsync('真的吗', CFG);
    const sys = captured.messages[0].content;
    assert.ok(sys.includes(SCENARIOS.refund.persona));
    assert.ok(/严禁承认自己在诈骗/.test(sys));
    assert.ok(/对方刚提出质疑/.test(sys), '质疑时应进入 pressure 人设');
  } finally { restore(); }
});

test('温度等参数可注入配置', async () => {
  let captured = null;
  const restore = stubFetch(async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '好' } }] }) };
  });
  try {
    const s = new ScamSession('job');
    await s.handleAsync('好的', { ...CFG, temperature: 0.3, maxTokens: 128 });
    assert.equal(captured.temperature, 0.3);
    assert.equal(captured.max_tokens, 128);
  } finally { restore(); }
});