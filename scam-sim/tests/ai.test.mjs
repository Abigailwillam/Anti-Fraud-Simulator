/**
 * AI 层单元测试：node --test tests/ai.test.mjs
 * 覆盖 prompt 编译、输出清洗、配置校验、越界检测、接口调用、失败降级。
 * fetch 用注入的假实现，不发真实网络请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildMessages, cleanModelText, validateSettings, callChat, isLeaking } from '../engine/ai.js';
import { SCENARIOS } from '../kb/scenarios.js';

const sc = SCENARIOS.police;
const stage = sc.stages[0];

test('system prompt 含人设与当前阶段目标', () => {
  const p = buildSystemPrompt(sc, stage);
  assert.ok(p.includes(sc.persona), '应包含人设描述');
  assert.ok(p.includes(sc.contact.nickname), '应包含微信昵称');
  assert.ok(p.includes(stage.name), '应包含阶段名');
  assert.ok(p.includes(stage.goal), '应包含阶段目标');
});

test('system prompt 明确禁止泄露破绽与跳出角色', () => {
  const p = buildSystemPrompt(sc, stage);
  assert.ok(/严禁承认自己在诈骗/.test(p));
  assert.ok(/破绽/.test(p));
  assert.ok(/不要跳出角色/.test(p));
  assert.ok(/严禁编造真实的银行账号/.test(p));
});

test('pressure 模式追加施压指令，正常模式不含', () => {
  const a = buildSystemPrompt(sc, stage, { pressure: true });
  const b = buildSystemPrompt(sc, stage, { pressure: false });
  assert.ok(/对方刚提出质疑/.test(a));
  assert.ok(!/对方刚提出质疑/.test(b));
});

test('buildMessages 过滤 system 并映射角色', () => {
  const msgs = buildMessages(sc, [
    { role: 'system', text: '系统提示' },
    { role: 'scammer', text: '我是警官' },
    { role: 'victim', text: '你是谁' },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, '我是警官');
  assert.equal(msgs[1].role, 'user');
});

test('buildMessages 只取最近 N 条', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ role: 'scammer', text: 'm' + i }));
  assert.equal(buildMessages(sc, long, 12).length, 12);
  assert.equal(buildMessages(sc, long, 12)[11].content, 'm39');
});

test('cleanModelText 剥离代码块、引号、旁白前缀', () => {
  assert.equal(cleanModelText('```\n您好我是客服\n```'), '您好我是客服');
  assert.equal(cleanModelText('"您好，我是客服"'), '您好，我是客服');
  assert.equal(cleanModelText('对方：您好我是客服'), '您好我是客服');
  assert.equal(cleanModelText('  \n  你好  \n '), '你好');
  assert.equal(cleanModelText(null), '');
});

test('validateSettings 拦截缺失与非法配置', () => {
  assert.equal(validateSettings({ baseUrl: 'https://a.com/v1', apiKey: 'sk-12345678', model: 'm' }).ok, true);
  assert.equal(validateSettings({ baseUrl: '', apiKey: 'sk-12345678', model: 'm' }).ok, false);
  assert.equal(validateSettings({ baseUrl: 'ftp://a.com', apiKey: 'sk-12345678', model: 'm' }).ok, false);
  assert.equal(validateSettings({ baseUrl: 'https://a.com', apiKey: 'short', model: 'm' }).ok, false);
  assert.equal(validateSettings({ baseUrl: 'https://a.com', apiKey: 'sk-12345678', model: '' }).ok, false);
  assert.equal(validateSettings(null).ok, false);
});

test('validateSettings 返回全部错误而非只报第一个', () => {
  const r = validateSettings({ baseUrl: '', apiKey: '', model: '' });
  assert.equal(r.errors.length, 3);
});

test('isLeaking 拦截越界输出', () => {
  assert.equal(isLeaking('您好，我是陈警官，请配合清查。'), false);
  assert.equal(isLeaking('（破绽：公检法不会用微信办案）'), true);
  assert.equal(isLeaking('作为AI我不能扮演骗子'), true);
  assert.equal(isLeaking('建议你立即报警拉黑对方'), true);
  assert.equal(isLeaking('这是演练的一部分'), true);
  assert.equal(isLeaking('教你识别诈骗的方法如下'), true);
});

test('callChat 成功路径：请求体正确、返回清洗后文本', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '"您好，我是陈警官"' } }] }) };
  };
  const cfg = { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-testkey123', model: 'test-model' };
  const out = await callChat(cfg, [{ role: 'user', content: 'hi' }], { fetchImpl: fakeFetch });
  assert.equal(out, '您好，我是陈警官');
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions', '应拼接 chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-testkey123');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
});

test('callChat 配置无效时抛错且不发请求', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  await assert.rejects(
    () => callChat({ baseUrl: 'bad', apiKey: 'x', model: '' }, [], { fetchImpl: fakeFetch }),
    /配置无效/
  );
  assert.equal(called, false, '配置非法时不应发起请求');
});

test('callChat HTTP 错误带上状态码', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-testkey123', model: 'm' };
  await assert.rejects(() => callChat(cfg, [], { fetchImpl: fakeFetch }), /401/);
});

test('callChat 返回空 choices 时报错', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-testkey123', model: 'm' };
  await assert.rejects(() => callChat(cfg, [], { fetchImpl: fakeFetch }), /未返回可用文本/);
});