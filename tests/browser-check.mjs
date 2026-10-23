/**
 * 真实浏览器验证：用本机 Edge 的 CDP（DevTools 协议）打开打包产物，
 * 实跑「诈骗辨析」的用户路径并截图。
 * 依赖：Node 22 内置全局 WebSocket + fetch，无需任何 npm 包。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const OUT = resolve(root, 'shots');
/** 真实测试图片：一张多宫格微信聊天截图，用于验证完整的上传→读图链路 */
const USER_IMG = 'C:/Users/15515/.workbuddy/clipboard-images/clipboard-2026-10-22T08-36-12-479Z-40e1cc68.jpg';
mkdirSync(OUT, { recursive: true });

const fileUrl = 'file:///' + resolve(root, 'dist/scam-sim.html').replace(/\\/g, '/').replace(/^\//, '');
console.log('目标：', fileUrl);

// 1) 启动 Edge（headless，带远程调试端口）
const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + resolve(root, '.edge-profile'),
  '--window-size=1440,1000',
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 2) 等 CDP 端点就绪
let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch (e) { /* 还没起来 */ }
}
if (!target) { console.error('CDP 未就绪'); edge.kill(); process.exit(1); }
console.log('CDP 已就绪：', target.webSocketDebuggerUrl);

// 3) 连 CDP
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: rs, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else rs(msg.result);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
  }
});

const send = (method, params = {}) => new Promise((rs, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve: rs, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await new Promise((rs, rj) => {
  ws.addEventListener('open', rs, { once: true });
  ws.addEventListener('error', rj, { once: true });
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');

// 4) 打开页面
await send('Page.navigate', { url: fileUrl });
await sleep(2500);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const p = resolve(OUT, name + '.png');
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('截图：', p);
};

const checks = [];
const check = (name, cond, extra = '') => {
  checks.push([name, !!cond, extra]);
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  (' + extra + ')' : ''));
};

// --- 首页 ---
check('首页加载无 JS 异常', logs.filter((l) => l.startsWith('EXCEPTION')).length === 0, logs.join(' | ').slice(0, 200));
const homeTxt = await evalJs('document.body.innerText');
check('首页出现「诈骗辨析」入口', homeTxt.includes('诈骗辨析'), homeTxt.slice(0, 120));
await shot('01-home');

// --- 顶栏导航（改版后新增的全局导航）---
const navInfo = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('#nav button')];
  return JSON.stringify({
    count: btns.length,
    labels: btns.map(b => b.textContent.trim()),
    active: btns.filter(b => b.classList.contains('on')).map(b => b.textContent.trim()),
  });
})()`);
const nav = JSON.parse(navInfo || '{}');
check('顶栏导航有 4 个入口', nav.count === 4, navInfo);
check('顶栏默认高亮「首页」', (nav.active || []).join() === '首页', navInfo);
await evalJs(`document.querySelector('#nav button[data-go="s-library"]').click()`);
await sleep(400);
const libOn = await evalJs(`document.getElementById('s-library').classList.contains('on')`);
check('★ 顶栏可切到案例库', libOn === true, '点击后未切换');
const navActive2 = await evalJs(`[...document.querySelectorAll('#nav button.on')].map(b=>b.textContent.trim()).join()`);
check('★ 切换后顶栏高亮跟随', navActive2 === '战术图鉴', navActive2);
await evalJs(`document.querySelector('#nav button[data-go="s-home"]').click()`);
await sleep(300);

// --- 进入辨析屏 ---
await evalJs('document.getElementById("goAnalyze").click()');
await sleep(600);
check('切换到辨析屏', await evalJs('document.getElementById("s-analyze").classList.contains("on")'));
const anaTxt = await evalJs('document.getElementById("s-analyze").innerText');
check('显示支持的格式与大小上限', anaTxt.includes('.txt') && anaTxt.includes('5.0 MB') && anaTxt.includes('200.0 KB'), anaTxt.slice(0, 200));
await shot('02-analyze-empty');

// --- 空内容 → 错误提示 + 重试 ---
await evalJs('document.getElementById("anaRun").click()');
await sleep(500);
const errTxt = await evalJs('document.getElementById("anaResult").innerText');
check('空内容给出可理解提示', errTxt.includes('没有可分析的内容'), errTxt.slice(0, 100));
check('错误态提供重试按钮', await evalJs('!!document.getElementById("anaRetry")'));
await shot('03-error-empty');

// --- 正常分析（纯规则） ---
await evalJs('document.getElementById("anaText").value = "我是蚂蚁客服 编号 A8821，您的花呗账单已逾期，请把短信验证码发给我，并转账 500 元到安全账户，今天之内必须处理。";');
await evalJs('document.getElementById("anaRun").click()');
await sleep(1500);
const resTxt = await evalJs('document.getElementById("anaResult").innerText');
check('输出结论「是」', resTxt.includes('存在诈骗嫌疑：是'), resTxt.slice(0, 100));
check('给出风险等级与指数', resTxt.includes('风险等级') && resTxt.includes('风险指数'), resTxt.slice(0, 200));
check('列出可疑点', resTxt.includes('可疑点逐条说明'));
check('命中冒充客服', resTxt.includes('冒充客服'), '');
check('命中索取验证码', resTxt.includes('索取验证码'), '');
check('命中诱导转账', resTxt.includes('诱导转账'), '');
check('给出防骗建议', resTxt.includes('防骗建议') && resTxt.includes('96110'), '');
check('给出判断依据摘要', resTxt.includes('判断依据'), '');
await shot('04-result-scam');

// --- 普通聊天不误报 ---
await evalJs('document.getElementById("anaReset").click()');
await evalJs('document.getElementById("anaText").value = "明天天气不错，我们一起吃饭吧，下午三点在公司楼下见。";');
await evalJs('document.getElementById("anaRun").click()');
await sleep(1200);
const cleanTxt = await evalJs('document.getElementById("anaResult").innerText');
check('普通聊天判为「否」', cleanTxt.includes('存在诈骗嫌疑：否'), cleanTxt.slice(0, 100));
check('普通聊天显示未发现风险', cleanTxt.includes('未发现风险'));
await shot('05-result-clean');

// --- 「看同类案例」跳转 ---
await evalJs('document.getElementById("anaReset").click()');
await evalJs('document.getElementById("anaText").value = "我是公安局民警，你涉嫌洗钱，请把钱转入安全账户接受清查";');
await evalJs('document.getElementById("anaRun").click()');
await sleep(1200);
const hasCat = await evalJs('!!document.querySelector("#anaResult [data-cat]")');
check('结果页提供「看同类案例」', hasCat);
if (hasCat) {
  await evalJs('document.querySelector("#anaResult [data-cat]").click()');
  await sleep(600);
  check('跳转到案例库', await evalJs('document.getElementById("s-library").classList.contains("on")'));
  const crumb = await evalJs('document.getElementById("libCrumb").innerText');
  check('案例库已定位到对应分类', crumb.includes('冒充公检法'), crumb);
  await shot('06-case-jump');
}

// --- 读图失败时的界面表现（模拟模型声称读不到图） ---
// 注意：必须走真实图片路径——读图失败标记只在 imageDataUrl 存在时生效，
// 用纯文本输入测不出这个分支。
// 前一个用例把页面跳到了案例库，这里先切回辨析屏再测。
await evalJs(`(() => {
  ['s-home','s-library','s-drill'].forEach(id => document.getElementById(id).classList.remove('on'));
  document.getElementById('s-analyze').classList.add('on');
})()`);
await sleep(300);
await evalJs(`(() => {
  window.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
    verdict: 'unknown', riskScore: 0, confidence: 10, signals: [],
    summary: '聊天截图为不可读内容，无法提取对话信息，因此无法判断是否存在诈骗特征。', advice: [],
  }) } }] }) });
  const e = id => document.getElementById(id);
  e('anaAiEnabled').checked = true;
  e('anaAiEnabled').dispatchEvent(new Event('change'));
  e('anaAiBase').value = 'https://api.example.com/v1';
  e('anaAiKey').value = 'sk-browsercheck123';
  e('anaAiModel').value = 'vision-model';
  e('anaAiModel').dispatchEvent(new Event('change'));
})()`);
// 真实上传一张图片（走 FileReader → dataURL 完整链路）
const docFail = await send('DOM.getDocument');
const nodeFail = await send('DOM.querySelector', { nodeId: docFail.root.nodeId, selector: '#anaFile' });
await send('DOM.setFileInputFiles', { files: [USER_IMG], nodeId: nodeFail.nodeId });
await evalJs(`document.getElementById('anaFile').dispatchEvent(new Event('change', { bubbles: true }));`);
await sleep(1200);
await evalJs(`document.getElementById('anaRun').click()`);
await sleep(1500);
const failTxt = await evalJs(`document.getElementById('anaResult').innerText`);
check('读图失败时界面给出明确失败提示', failTxt.includes('模型没能读出这张截图'), failTxt.slice(0, 140));
check('读图失败时给出可操作指引', failTxt.includes('裁剪') || failTxt.includes('gpt-4o'), failTxt.slice(0, 240));
check('读图失败时不谎报「无法判断」为唯一结论', failTxt.includes('结论不可用'), failTxt.slice(0, 200));
await shot('10-image-read-fail');
// 复位开关，避免影响后续用例
await evalJs(`(() => {
  const e = id => document.getElementById(id);
  e('anaAiEnabled').checked = false;
  e('anaAiEnabled').dispatchEvent(new Event('change'));
  e('anaFile').value = '';
  anaState.picked = null;
})()`);

// --- 辨析屏内直接配置 AI（不跳转互动模式） ---
await evalJs('document.getElementById("goAnalyze") && document.getElementById("goAnalyze").click()');
await evalJs('document.getElementById("s-home").classList.remove("on")');
await evalJs('document.getElementById("s-analyze").classList.add("on")');
await sleep(400);
check('辨析屏内含 AI 配置面板（无需跳转）',
  await evalJs('!!document.getElementById("anaAiEnabled") && !!document.getElementById("anaAiBase") && !!document.getElementById("anaAiKey") && !!document.getElementById("anaAiModel")'));
check('辨析屏不再需要跳转到互动模式', await evalJs('!document.getElementById("anaGoSettings")'));
check('辨析屏 AI 开关默认关闭', !(await evalJs('document.getElementById("anaAiEnabled").checked')));

// 在辨析屏内填写配置并开启开关
await evalJs(`(() => {
  const e = id => document.getElementById(id);
  e('anaAiEnabled').checked = true;
  e('anaAiEnabled').dispatchEvent(new Event('change'));
  e('anaAiBase').value = 'https://api.example.com/v1';
  e('anaAiKey').value = 'sk-browsercheck123';
  e('anaAiModel').value = 'browser-model';
  e('anaAiModel').dispatchEvent(new Event('change'));
})()`);
await sleep(300);
const anaEngineTxt = await evalJs('document.getElementById("anaEngine").innerText');
check('辨析屏开启后引擎状态显示 AI 研判', anaEngineTxt.includes('AI 研判'), anaEngineTxt);
check('★ 连接参数同步到互动模式侧栏',
  (await evalJs('document.getElementById("aiModel").value')) === 'browser-model',
  await evalJs('document.getElementById("aiModel").value'));
check('★ 辨析屏开关不改变互动模式开关',
  !(await evalJs('document.getElementById("aiEnabled").checked')));
await shot('09-analyze-ai-config');

// 在辨析屏点「测试连接」→ 失败应有可理解提示（此处无真实 API）
await evalJs('document.getElementById("anaAiTest").click()');
await sleep(2500);
const testStatus = await evalJs('document.getElementById("anaAiStatus").innerText');
check('辨析屏测试连接有状态反馈', testStatus.length > 0, testStatus.slice(0, 80));

// 清空后应复位
await evalJs('document.getElementById("anaAiClear").click()');
await sleep(300);
check('辨析屏清空后开关关闭', !(await evalJs('document.getElementById("anaAiEnabled").checked')));
check('辨析屏清空后连接参数也清空', (await evalJs('document.getElementById("anaAiModel").value')) === '');

// --- 移动端响应式 ---
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await evalJs('document.getElementById("s-analyze").classList.remove("on")');
await evalJs('document.getElementById("s-home").classList.add("on")');
await evalJs('document.getElementById("goAnalyze") && document.getElementById("goAnalyze").click()');
await sleep(500);
const overflow = await evalJs('document.documentElement.scrollWidth - document.documentElement.clientWidth');
check('移动端无横向溢出', overflow <= 1, 'overflow=' + overflow);
await shot('07-mobile');

// --- 桌面端恢复 + 交互模式回归 ---
await send('Emulation.clearDeviceMetricsOverride');
await sleep(300);
await evalJs('document.getElementById("s-analyze").classList.remove("on")');
await evalJs('document.getElementById("s-home").classList.add("on")');
await evalJs('document.getElementById("goDrill").click()');
await sleep(600);
check('互动模式仍可进入', await evalJs('document.getElementById("s-drill").classList.contains("on")'));
const drillOk = await evalJs('(function(){document.getElementById("startBtn").click();return document.getElementById("chatList").innerText.length;})()');
check('互动模式好友列表仍生成', drillOk > 20, 'len=' + drillOk);
await shot('08-drill');

const realErrors = logs.filter((l) => l.startsWith('EXCEPTION') || l.startsWith('error'));
check('全程无 JS 运行时异常', realErrors.length === 0, realErrors.join(' | ').slice(0, 300));

const failed = checks.filter((c) => !c[1]).length;
console.log(`\n真实浏览器验证：${checks.length - failed}/${checks.length} 通过`);
if (logs.length) console.log('控制台输出：', logs.slice(0, 10).join(' | '));

ws.close();
edge.kill();
await sleep(300);
process.exit(failed ? 1 : 0);
