import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9451;
const URL = 'file:///' + resolve(root, 'dist', 'scam-sim.html').replace(/\\/g, '/');
const PROFILE = resolve(root, '.edge-dockcheck');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  (' + extra + ')' : ''));
  if (!cond) fails++;
};

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });

async function getWS() {
  for (let i = 0; i < 60; i++) {
    try {
      const arr = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      if (arr && arr[0] && arr[0].webSocketDebuggerUrl) return arr[0].webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('no ws');
}
const ws = new WebSocket(await getWS());
let id = 0; const pending = new Map();
function send(m, p = {}) {
  return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
}
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? { __cdpError: m.error } : m.result); pending.delete(m.id); } };
ws.onerror = (e) => { console.error('ws err', e.message); edge.kill('SIGKILL'); process.exit(1); };
ws.onopen = () => main();

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r && r.__cdpError) throw new Error(JSON.stringify(r.__cdpError));
  if (r && r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

// 卡片带几何 + 当前状态
const STATE = `(function(){
  var strip=document.getElementById('scnStrip');
  var sr=strip.getBoundingClientRect();
  var act=document.querySelector('#scnTrack .scn-card.active');
  var conf=document.querySelector('#scnTrack .scn-card.confirmed');
  var d=act?Math.abs((act.getBoundingClientRect().left+act.getBoundingClientRect().width/2)-(sr.left+sr.width/2)):9999;
  return {stripCx:sr.left+sr.width/2, stripCy:sr.top+sr.height/2,
          active:act?act.dataset.id:null, confirmed:conf?conf.dataset.id:null,
          centerDelta:Math.round(d), scrollLeft:Math.round(strip.scrollLeft),
          selected:(typeof selected!=='undefined')?selected:null,
          name:(document.getElementById('scnName')||{}).textContent};
})()`;

async function state() { return JSON.parse(await ev(`JSON.stringify(${STATE})`)); }

async function mouseDrag(fromX, fromY, dx) {
  const steps = 6;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX, y: fromY, button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fromX + (dx * i) / steps, y: fromY, button: 'left', buttons: 1 });
    await sleep(20);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fromX + dx, y: fromY, button: 'left', buttons: 0, clickCount: 1 });
}
async function touchDrag(fromX, fromY, dx) {
  const steps = 6;
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY }] });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + (dx * i) / steps, y: fromY }] });
    await sleep(20);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function main() {
  await sleep(600);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 1000 });
  await send('Page.navigate', { url: URL });
  // 等页面就绪（首次启动 Edge 冷启动较慢，轮询到脚本执行完成为止）
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const probe = JSON.parse(await ev(`(function(){return JSON.stringify({url:location.href.slice(-24), ok:!!(document.querySelector('#scnStrip') && typeof goto==='function')});})()`));
      if (i === 0 || i % 20 === 0) console.log('  wait[' + i + ']', probe.url, 'ready=' + probe.ok);
      if (probe.ok) { ready = true; break; }
    } catch (e) { if (i === 0) console.log('  wait[0] err', e.message.slice(0, 160)); }
    await sleep(250);
  }
  if (!ready) throw new Error('page never became ready');
  await ev(`goto('s-drill')`);
  await sleep(900);

  console.log('── 桌面端：位置与初始状态 ──');
  let s = await state();
  ok(s.active === 'job' && s.confirmed === 'job', '默认选中剧本同时是 active 与 confirmed', s.active + '/' + s.confirmed);
  ok(s.centerDelta <= 2, '默认剧本已居中', '偏差 ' + s.centerDelta + 'px');
  const geo = JSON.parse(await ev(`(function(){var p=document.querySelector('.phone').getBoundingClientRect();
    var d=document.getElementById('scnDock').getBoundingClientRect();
    return JSON.stringify({phoneBottom:Math.round(p.bottom), dockTop:Math.round(d.top), inside:!!document.querySelector('.phone #scnStrip'), picker:!!document.getElementById('picker')});})()`));
  ok(geo.dockTop >= geo.phoneBottom, '卡片带在手机下方', 'phoneBottom=' + geo.phoneBottom + ' dockTop=' + geo.dockTop);
  ok(!geo.inside, '卡片带已不在手机屏内');
  ok(!geo.picker, '左侧「挑一个剧本」面板已删除');

  console.log('── 桌面端：鼠标拖动 ──');
  // 卡片带在 1000px 视口之下，先滚进视口，否则鼠标坐标落在窗口外
  await ev(`document.getElementById('scnDock').scrollIntoView({block:'center'})`);
  await sleep(500);
  s = await state();
  const before = await state();
  // 初始停在最后一张（job），向左拖没有可滚动空间；向右拖才看得到换卡
  await mouseDrag(s.stripCx, s.stripCy, 260);
  await sleep(1200);
  let after = await state();
  ok(after.active !== before.active, '鼠标拖动后 active 卡片改变', before.active + ' → ' + after.active);
  ok(after.scrollLeft < before.scrollLeft, '拖动改变了卡片带滚动位置', before.scrollLeft + ' → ' + after.scrollLeft);
  ok(after.centerDelta <= 3, '拖动吸附后卡片居中', '偏差 ' + after.centerDelta + 'px');

  console.log('── 桌面端：点击居中卡片确认 ──');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: after.stripCx, y: after.stripCy, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: after.stripCx, y: after.stripCy, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(600);
  let clicked = await state();
  ok(clicked.confirmed === clicked.active, '点击后该卡进入确认态', 'confirmed=' + clicked.confirmed);
  ok(clicked.selected === clicked.active, 'selected 与 active 一致', 'selected=' + clicked.selected);
  ok(!!clicked.name, '确认条显示剧本名', clicked.name);

  console.log('── 桌面端：生成微信好友按钮仍可用 ──');
  const chatLen = await ev(`(function(){document.getElementById('startBtn').click();
    return document.getElementById('chatList').innerText.length;})()`);
  ok(chatLen > 0, '点「生成微信好友」生成好友列表', 'len=' + chatLen);

  console.log('── 移动端：触摸拖动 ──');
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: 414, screenHeight: 900 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  await ev(`goto('s-drill')`);
  await sleep(900);
  await ev(`document.getElementById('scnDock').scrollIntoView({block:'center'})`);
  await sleep(400);
  const mBefore = await state();
  await touchDrag(mBefore.stripCx, mBefore.stripCy, 220);
  await sleep(1200);
  const mAfter = await state();
  ok(mAfter.active !== mBefore.active, '触摸拖动后 active 卡片改变', mBefore.active + ' → ' + mAfter.active);
  ok(mAfter.centerDelta <= 3, '触摸拖动吸附后卡片居中', '偏差 ' + mAfter.centerDelta + 'px');
  const mob = JSON.parse(await ev(`JSON.stringify({ov:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    phoneBottom:Math.round(document.querySelector('.phone').getBoundingClientRect().bottom),
    dockTop:Math.round(document.getElementById('scnDock').getBoundingClientRect().top)})`));
  ok(mob.ov === 0, '移动端无横向溢出', 'overflow=' + mob.ov);
  ok(mob.dockTop >= mob.phoneBottom, '移动端卡片带也在手机下方');

  console.log(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
  ws.close(); edge.kill('SIGKILL'); process.exit(fails === 0 ? 0 : 1);
}
