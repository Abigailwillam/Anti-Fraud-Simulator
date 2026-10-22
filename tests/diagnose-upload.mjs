/**
 * 真实文件上传验证：用 CDP 的 DOM.setFileInputFiles 把真实图片喂进 <input type=file>，
 * 走完整的 FileReader → dataURL → 多模态请求链路，并捕获实际请求体。
 * 目的：确认「图片是否真的以 data URL 送到了请求里」——这决定问题出在链路还是模型侧。
 * 用法：node tests/diagnose-upload.mjs
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9334;
const IMG = 'C:/Users/15515/.workbuddy/clipboard-images/clipboard-2026-10-22T08-36-12-479Z-40e1cc68.jpg';

const fileUrl = 'file:///' + resolve(root, 'dist/scam-sim.html').replace(/\\/g, '/').replace(/^\//, '');
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + resolve(root, '.edge-profile2'),
  '--window-size=1440,1200', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch (e) { /* 还没起来 */ }
}
if (!target) { console.error('CDP 未就绪'); edge.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve: rs, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else rs(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
});
const send = (method, params = {}) => new Promise((rs, reject) => {
  const mid = ++id; pending.set(mid, { resolve: rs, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((rs, rj) => { ws.addEventListener('open', rs, { once: true }); ws.addEventListener('error', rj, { once: true }); });
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable');
await send('Page.navigate', { url: fileUrl });
await sleep(2500);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

// 拦截 fetch，记录请求体
await evalJs(`
  window.__cap = null;
  const orig = window.fetch;
  window.fetch = async function(url, init) {
    if (String(url).includes('/chat/completions')) {
      window.__cap = { url: String(url), body: init && init.body ? init.body : null,
                       headers: init && init.headers ? init.headers : null };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      verdict: 'scam', riskScore: 80, confidence: 85,
      signals: [{ type: 'fake_link', name: '诱导安装APK', quote: '蜜桃(1).apk' }],
      summary: '对方发送APK安装包并索要邀请码', advice: ['不要安装陌生APP'],
    }) } }] }) };
  };
  true;
`);

// 进入辨析屏
await evalJs(`document.getElementById('goAnalyze').click()`);
await sleep(400);

// 配置 AI
await evalJs(`(() => {
  const e = id => document.getElementById(id);
  e('anaAiEnabled').checked = true;
  e('anaAiEnabled').dispatchEvent(new Event('change'));
  e('anaAiBase').value = 'https://api.example.com/v1';
  e('anaAiKey').value = 'sk-uploadtest12345';
  e('anaAiModel').value = 'vision-model';
  e('anaAiModel').dispatchEvent(new Event('change'));
})()`);
await sleep(200);

// ★ 真实文件上传：走 DOM.setFileInputFiles
const doc = await send('DOM.getDocument');
const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#anaFile' });
console.log('找到 file input:', !!node.nodeId);
await send('DOM.setFileInputFiles', { files: [IMG], nodeId: node.nodeId });
// 触发 change 事件
await evalJs(`(() => {
  const i = document.getElementById('anaFile');
  i.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(1500);

const picked = await evalJs(`document.getElementById('anaPicked').innerText`);
console.log('\n═══ 上传后选中的文件条 ═══');
console.log(picked || '(空)');

const pickedState = await evalJs(`JSON.stringify(anaState.picked ? {
  name: anaState.picked.name, kind: anaState.picked.kind, size: anaState.picked.size,
  dataUrlLen: (anaState.picked.dataUrl || '').length,
  dataUrlHead: (anaState.picked.dataUrl || '').slice(0, 40),
} : null)`);
console.log('\n═══ anaState.picked 实际内容 ═══');
console.log(pickedState);

await evalJs(`document.getElementById('anaRun').click()`);
await sleep(2000);

const cap = await evalJs(`(() => {
  if (!window.__cap) return null;
  const b = JSON.parse(window.__cap.body);
  const m = b.messages[b.messages.length - 1];
  const parts = Array.isArray(m.content) ? m.content : [];
  const imgPart = parts.find(p => p.type === 'image_url');
  return JSON.stringify({
    url: window.__cap.url,
    model: b.model,
    max_tokens: b.max_tokens,
    messagesCount: b.messages.length,
    lastRole: m.role,
    contentIsArray: Array.isArray(m.content),
    partTypes: parts.map(p => p.type),
    imageUrlHead: imgPart ? String(imgPart.image_url.url).slice(0, 60) : null,
    imageUrlLen: imgPart ? String(imgPart.image_url.url).length : 0,
    imageUrlIsDataUrl: imgPart ? /^data:image\\//.test(imgPart.image_url.url) : false,
    textPart: parts.find(p => p.type === 'text')?.text?.slice(0, 60),
  }, null, 2);
})()`);
console.log('\n═══ 实际发出的请求体结构 ═══');
console.log(cap || '(未捕获到请求)');

console.log('\n═══ 界面结果 ═══');
console.log((await evalJs(`document.getElementById('anaResult').innerText`)).slice(0, 500));
if (logs.length) console.log('\n控制台:', logs.slice(0, 5).join(' | '));

ws.close(); edge.kill();
await sleep(300);
process.exit(0);
