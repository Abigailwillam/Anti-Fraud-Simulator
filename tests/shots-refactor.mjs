/**
 * 改版视觉核对：逐屏截图（桌面 + 移动），用于和设计图比对。
 * 用法：node tests/shots-refactor.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9377;
const OUT = resolve(root, 'shots');
mkdirSync(OUT, { recursive: true });
const fileUrl = 'file:///' + resolve(root, 'dist/scam-sim.html').replace(/\\/g, '/').replace(/^\//, '');

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + resolve(root, '.edge-profile3'),
  '--window-size=1440,1000', 'about:blank',
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
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((resolve2, reject) => {
  const mid = ++id; pending.set(mid, { resolve: resolve2, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: fileUrl });
await sleep(2200);

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(resolve(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('截图', name);
};
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log('JS 异常:', JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
};

await shot('rf-1-home.png');
await evalJs("goto('s-library')"); await sleep(700);
await shot('rf-2-library.png');
await evalJs("goto('s-drill')"); await sleep(700);
await shot('rf-3-drill.png');
// 起一局，让手机里有对话、风险环有数值
await evalJs("start(); openChat(); userInput.value='好的，我按你说的做'; send();"); await sleep(900);
await shot('rf-3b-drill-live.png');
await evalJs("goto('s-analyze')"); await sleep(600);
await evalJs("document.getElementById('anaDemo').click(); anaRun();"); await sleep(1200);
await shot('rf-4-analyze.png');

// 移动端
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await evalJs("goto('s-home')"); await sleep(700);
await shot('rf-5-mobile-home.png');
await evalJs("goto('s-library')"); await sleep(700);
await shot('rf-6-mobile-library.png');
await evalJs("goto('s-analyze')"); await sleep(700);
await shot('rf-7-mobile-analyze.png');

// 溢出检查
const overflow = await evalJs(`(() => {
  const bad = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible') {
      bad.push((el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
  });
  return JSON.stringify({ docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, bad: bad.slice(0, 8) });
})()`);
console.log('移动端溢出检查:', overflow);
edge.kill();
process.exit(0);
