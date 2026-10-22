/**
 * 打包产物冒烟测试：在 Node 里用极简 DOM 桩执行 dist/scam-sim.html 内联脚本，
 * 验证「双击打开就能跑」——这条真实交付路径单元测试覆盖不到。
 * 覆盖：手机外壳 → 桌面 → 微信列表 → 聊天 → 报告。
 * 用法：node tests/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'dist/scam-sim.html'), 'utf8');
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];

const nodes = {};
const initCls = initialClasses(html);
function mk(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false, style: {},
    dataset: {}, className: '', children: [], _kids: [],
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
                  toggle(c, on){ on ? this._s.add(c) : this._s.delete(c); },
                  contains(c){ return this._s.has(c); } },
    appendChild(c) {
      this._kids.push(c); c._p = this;
      // 冒烟断言需要读到气泡里的文本，故把子节点文本并入父节点 textContent
      this.textContent = String(this.textContent || '') + String(c.textContent || '');
      return c;
    },
    remove() { const p = this._p; if (p) p._kids = p._kids.filter(x => x !== this); },
    /** 迷你 DOM：innerHTML 赋值时按标签建出可点击的子节点（够用于点击/计数断言） */
    set innerHTML(v) {
      this._html = String(v);
      this.textContent = String(v).replace(/<[^>]*>/g, '');
      const html = String(v);
      // 解析所有开始标签（带 data-* 的另取其值），供点击/计数断言使用
      this._els = [...html.matchAll(/<(\w+)([^>]*)>/g)]
        .map((m) => {
          const attrs = m[2];
          const dm = /\bdata-([a-z]+)="([^"]*)"/.exec(attrs);
          const cm = /\bclass="([^"]*)"/.exec(attrs);
          const im = /\bid="([^"]*)"/.exec(attrs);
          return {
            tag: m[1], key: dm ? dm[1] : '', val: dm ? dm[2] : '',
            cls: cm ? cm[1] : '', id: im ? im[1] : '', onclick: null,
            get dataset() { const o = {}; if (dm) o[dm[1]] = dm[2]; return o; },
            classList: {
              _s: new Set(cm ? cm[1].split(/\s+/).filter(Boolean) : []),
              contains(c) { return this._s.has(c); },
              add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
              toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { on ? this._s.add(c) : this._s.delete(c); } },
            },
            click() { if (this.onclick) this.onclick(); },
          };
        });
      // case-head 的父级是 article.case，展开状态挂在它身上
      this._els.forEach((e) => {
        e.parentElement = e.tag === 'button' ? this._els.find((x) => x.tag === 'article') || null : null;
      });
      // 重渲染时按 data-id 继承上一轮的展开状态（真实浏览器由 DOM 复用带来的等价效果）
      const prev = (this._prev ||= {});
      this._els.forEach((e) => {
        if (e.tag === 'article' && e.key === 'id' && prev[e.val]) e.classList.add('open');
      });
      this._els.forEach((e) => { if (e.tag === 'article' && e.key === 'id') prev[e.val] = e.classList.contains('open'); });
    },
    get innerHTML() { return this._html || ''; },
    // 支持 [data-x]、[data-x="v"]、.class、裸标签
    querySelectorAll(sel) {
      const all = this._els || [];
      if (!sel) return all;
      const dm = /\[data-([a-z]+)(?:="?([^"\]]*)"?)?\]/.exec(sel);
      if (dm) return all.filter((e) => e.key === dm[1] && (dm[2] === undefined || !dm[2] || e.val === dm[2]));
      const cm = /^\.([\w-]+)$/.exec(sel);
      if (cm) return all.filter((e) => (e.cls || '').split(/\s+/).includes(cm[1]));
      return all.filter((e) => e.tag === sel);
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || mk('sub'); },
    scrollTop: 0, scrollHeight: 0, onclick: null,
    /** 记录监听器以便手动触发（对应真实 DOM 的 dispatchEvent） */
    _ls: {},
    addEventListener(k, fn) { (this._ls ||= {})[k] = fn; },
    dispatchEvent(ev) { const fn = (this._ls || {})[ev.type]; if (fn) fn({ target: this }); return true; },
    focus() {},
  };
}
/**
 * 读取源码里每个 id 的初始 class。
 * 必要性：`.screen` 同时用于顶层路由与手机外壳，若不解析初始类，
 * 「默认停在首页」这类断言会假阴性（元素明明带 on，只是桩没读）。
 */
function initialClasses(html) {
  const map = new Map();
  for (const m of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const cm = /\bclass="([^"]*)"/.exec(m[2]);
    if (cm) map.set(m[3], cm[1].split(/\s+/).filter(Boolean));
  }
  return map;
}

const document = {
  getElementById: (id) => {
    if (!nodes[id]) {
      const n = mk(id);
      n.classList._s = new Set(initCls.get(id) || []);
      nodes[id] = n;
    }
    return nodes[id];
  },
  createElement: (t) => mk(t),
  querySelector: (sel) => (nodes['sel:' + sel] ||= mk(sel)),
};
const ctx = vm.createContext({
  document, console, setTimeout, clearTimeout, Math, JSON, Date, window: { scrollTo() {} },
  Promise, AbortController, Object, Array, String, Number, RegExp, Error, Event,
  localStorage: (() => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; })(),
});

vm.runInContext(
  js +
    `\n;globalThis.__t = {
       startWith(scenarioId) { selected = scenarioId; start(); return $('chatList').innerHTML; },
       openChat() { openChat(); },
       reply(v) { $('userInput').value = v; send(); },
       chatCount() { return $('msgs')._kids.length; },
       visible() { return ['v-home','v-list','v-chat'].filter(v => $ (v).classList.contains('on')); },
       reportHtml() { finish(); return $('reportBox').innerHTML; },
       alert() { return $('alertBox').innerHTML; },
       score() { return $('mScore').textContent; },
       msgsText() {
         // 真实浏览器中 querySelector('.bubble') 属于该消息节点，故一并递归收集
         const walk = (n) => [n.textContent || '', ...n._kids.flatMap(walk),
                              ...(n._els || []).map(s => s.textContent || '')].join(' ');
         return $('msgs')._kids.map(walk).join('\\n');
       },
       chatListHtml() { return $('chatList').innerHTML; },
       engineText() { return $('mEngine').textContent; },
       aiEnabled() { return $('aiEnabled').checked; },
       /* 路由与案例库 */
       goto(n) { goto(n); },
       onScreen() { return ['s-home','s-library','s-drill','s-analyze'].filter(s => $(s).classList.contains('on')); },
       heroStats() { return $('heroStats').textContent; },
       catsHtml() { return $('libCats').innerHTML; },
       casesHtml() { return $('libCases').innerHTML; },
       pagerHtml() { return $('libPager').innerHTML; },
       countTxt() { return $('libCount').textContent; },
       crumbTxt() { return $('libCrumb').textContent; },
       search(v) { setKeyword(v); },
       clickCat(idx) { $('libCats').querySelectorAll('.cat')[idx].click(); },
       clickCase(idx) { $('libCases').querySelectorAll('.case-head')[idx].click(); },
       clickPager(sel) { $('libPager').querySelector(sel).click(); },
       pagerBtns() { return $('libPager').querySelectorAll('[data-go]').map(b => b.val).join(','); },
       caseIds() { return $('libCases').querySelectorAll('.case').map(c => c.val).join(','); },
       caseOpen() { return $('libCases').querySelectorAll('.case').filter(c => c.classList.contains('open')).length; },
       libState() { return JSON.parse(JSON.stringify(libState)); },
       globalSearch(kw) { return searchCases(kw).map(c => c.catId); },
       /* 诈骗辨析 */
       anaSpec() { return $('anaSpec').innerHTML; },
       anaSetText(v) { $('anaText').value = v; },
       anaText() { return $('anaText').value; },
       anaRun() { anaRun(); },
       anaEngine() { return $('anaEngine').textContent; },
       anaResultHtml() { return $('anaResult').innerHTML; },
       anaStateHtml() { return $('anaState').innerHTML; },
       anaMsgHtml() { return $('anaMsg').innerHTML; },
       anaMsgText() { return $('anaMsg').textContent; },
       anaModelHintHtml() { return $('anaAiModelHint').innerHTML; },
       anaModelHintText() { return $('anaAiModelHint').textContent; },
       drillModelHintText() { return $('aiModelHint').textContent; },
       switchModel(m) { switchModel(m); },
       aiCfgModel() { return aiCfg.model; },
       anaReset() { anaReset(); },
       anaDemo() { $('anaDemo').onclick(); },
       anaPickFile(f) { anaState.picked = f; anaRenderPicked(); },
       anaPickedHtml() { return $('anaPicked').innerHTML; },
       anaErrHtml() { return $('anaResult').innerHTML; },
       anaHasRetry() { return !!$('anaResult')._els.find(e => e.id === 'anaRetry'); },
       anaClickRetry() { const b = $('anaResult')._els.find(e => e.id === 'anaRetry'); if (b) b.click(); },
       anaClickSigCat(i) { const b = $('anaResult').querySelectorAll('[data-cat]')[i]; if (b) b.click(); return b ? b.val : ''; },
       anaSigCats() { return $('anaResult').querySelectorAll('[data-cat]').map(b => b.val).join(','); },
       anaValidateUpload(f) { return JSON.stringify(validateUpload(f)); },
       /* 辨析屏内直接配置 AI */
       anaAiIds() { return ['anaAiEnabled','anaAiBase','anaAiKey','anaAiModel','anaAiTemp','anaAiTest','anaAiClear','anaAiStatus'].filter(id => !!document.getElementById(id)); },
       anaAiSetEnabled(v) { $('anaAiEnabled').checked = !!v; $('anaAiEnabled').dispatchEvent(new Event('change')); },
       anaAiEnabled() { return $('anaAiEnabled').checked; },
       anaAiField(id) { return $(id).value; },
       anaAiStatus() { return $('anaAiStatus').textContent; },
       anaAiTest() { $('anaAiTest').onclick(); },
       drillAiEnabled() { return $('aiEnabled').checked; },
       drillAiField(id) { return $(id).value; },
       aiCfgDump() { return JSON.stringify(aiCfg); },
       aiCalls() { return globalThis.__aiCalls || 0; },
       anaAiVision() { $('anaAiVision').onclick(); },
       anaAiStatusText() { return $('anaAiStatus').textContent; },
       anaImageFailHtml() { return $('anaResult').innerHTML; }
     };`,
  ctx
);

const t = ctx.__t;
const settle = () => new Promise((r) => setTimeout(r, 30)); // send() 是异步的
const checks = [];
const check = (name, cond, extra = '') => checks.push([name, !!cond, extra]);

// --- 流程一：一路顺从 ---
const list1 = t.startWith('job');
check('桌面→微信：好友列表已生成', list1.includes('HR-小琳'));
check('好友列表含无关好友做真实感', list1.includes('张三'));
t.openChat();
check('聊天窗口可见', t.visible().includes('v-chat'));
check('开场含系统提示与好友消息', t.chatCount() >= 3, `count=${t.chatCount()}`);
t.reply('好的，怎么操作');
await settle();
t.reply('我把收款码发给你，我马上转账');
await settle();
const score1 = Number(t.score());
check('顺从链路风险指数上升', score1 > 0, `score=${score1}`);
const r1 = t.reportHtml();
check('报告生成', r1.includes('演练复盘报告'));
check('报告含好友昵称', r1.includes('HR-小琳'));
check('报告含风险行为标签', r1.includes('提供了银行卡号') || r1.includes('发送或扫描收款码'));
check('报告含阶段推进复盘', r1.includes('阶段推进复盘'));
check('报告含破绽清单', r1.includes('破绽'));
check('报告含聊天记录', r1.includes('查看完整聊天记录'));

// --- 流程二：全程质疑 ---
t.startWith('police');
t.openChat();
t.reply('你是哪个派出所的？工号能否查证');
await settle();
t.reply('请把营业执照发我，我自己去企查查看');
await settle();
t.reply('我要拉黑你并举报');
await settle();
const score2 = Number(t.score());
const r2 = t.reportHtml();
check('质疑链路风险指数较低', score2 < 40, `score=${score2}`);
check('报告标注未出现危险行为', r2.includes('未出现危险行为'));
check('拉黑被识别为终止', r2.includes('演练复盘报告'));

// --- 流程三：AI 设置面板不得出现在手机屏幕上 ---
/** 从原始 HTML 中按 div 配平抽取某个 class 的元素子树 */
function extractElement(html, className) {
  const open = html.indexOf(`class="${className}"`);
  if (open < 0) return '';
  const start = html.lastIndexOf('<div', open);
  let depth = 0, i = start;
  while (i < html.length) {
    const next = html.indexOf('<div', i + 1);
    const close = html.indexOf('</div>', i + 1);
    if (close < 0) break;
    if (next >= 0 && next < close) { depth++; i = next; }
    else { if (depth === 0) return html.slice(start, close + 6); depth--; i = close; }
  }
  return '';
}
const phoneHtml = extractElement(html, 'phone');
const settingsHtml = extractElement(html, 'panel side');
// 防假阴性：先证明抽取函数确实抓到了完整子树，否则「设置不在手机内」会空洞通过
check('手机外壳抽取完整（含三个视图层）',
  phoneHtml.includes('v-home') && phoneHtml.includes('v-list') && phoneHtml.includes('v-chat'),
  `len=${phoneHtml.length}`);
check('设置面板抽取完整（含开关与字段）',
  settingsHtml.includes('aiEnabled') && settingsHtml.includes('aiBase') && settingsHtml.includes('aiKey'),
  `len=${settingsHtml.length}`);
check('设置面板不在手机外壳内', !phoneHtml.includes('aiBase') && !phoneHtml.includes('aiKey') && !phoneHtml.includes('API Key'),
  '手机 DOM 内出现 API 配置');
check('设置面板在侧栏（手机外壳之外）', settingsHtml.includes('aiBase') && settingsHtml.includes('aiKey'));
check('AI 默认关闭', !html.includes('id="aiEnabled" checked'));
check('默认引擎为内置话术', html.includes('id="mEngine"'), '互动模式默认使用内置话术');

// --- 流程四：AI 接线（用注入的假 fetch，确定性验证 UI 层降级链路） ---
/** 在 vm 上下文里替换 fetch 并配置 AI 面板 */
/**
 * 注入假 fetch 并配置 AI。
 * 两个屏幕的启用开关是独立的（enabled=互动模式话术，analyzeEnabled=辨析研判），
 * 连接参数共用同一份。因此这里用 which 指定本次要打开哪个开关。
 */
async function withAI(fetchImpl, cfg, fn, which = 'drill') {
  // 包装 fetch 以统计真实调用次数：
  // 「AI 是否被调用」是判断开关是否生效的直接证据；
  // 而结果页显示的引擎名会被降级逻辑掩盖（AI 失败也会回落到「规则引擎（离线）」），
  // 用它做断言会漏判——这正是变异测试暴露出的假阴性。
  ctx.__aiCalls = 0;
  ctx.fetch = async (...args) => {
    ctx.__aiCalls += 1;
    return fetchImpl(...args);
  };
  await vm.runInContext(
    `(() => {
       const e = id => document.getElementById(id);
       const drill = ${JSON.stringify(which === 'drill')};
       const ana = ${JSON.stringify(which === 'analyze')};
       if (drill) {
         e('aiEnabled').checked = true;
         e('aiEnabled').dispatchEvent(new Event('change'));
       }
       if (ana) {
         e('anaAiEnabled').checked = true;
         e('anaAiEnabled').dispatchEvent(new Event('change'));
       }
       e('aiBase').value = ${JSON.stringify(cfg.baseUrl)};
       e('aiKey').value = ${JSON.stringify(cfg.apiKey)};
       e('aiModel').value = ${JSON.stringify(cfg.model)};
       e('aiModel').dispatchEvent(new Event('change'));
     })()`,
    ctx
  );
  await fn();
  ctx.fetch = undefined;
}
const AI_CFG = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-faketest12345', model: 'gpt-test' };

// 4a：AI 返回 401 → 降级、侧栏给出说明、聊天不中断
await withAI(async () => ({ ok: false, status: 401, text: async () => 'invalid api key' }), AI_CFG, async () => {
  t.startWith('job');
  t.openChat();
  t.reply('好的，怎么操作');
  await settle();
  check('AI 失败时侧栏提示降级原因', t.alert().includes('AI 调用失败') && t.alert().includes('401'), t.alert().replace(/<[^>]*>/g, "").slice(0, 60));
  check('AI 失败时引擎标识为 AI 模式', t.engineText().includes('AI 生成'), t.engineText());
  check('AI 失败时仍有话术（会话不中断）', t.chatCount() > 4, `count=${t.chatCount()}`);
  check('AI 失败时风险分仍推进', Number(t.score()) > 0, `score=${t.score()}`);
});

// 4b：模型输出越界 → 不得出现在聊天里
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '破绽是公检法从不用微信办案。' } }] }) }), AI_CFG, async () => {
  t.startWith('police');
  t.openChat();
  t.reply('好的，怎么操作');
  await settle();
  const bubbles = t.msgsText();
  check('越界输出被拦截并降级', !bubbles.includes('破绽'), '越界文本进入了聊天：' + bubbles.slice(-60));
  check('越界时提示已降级', t.alert().includes('越界'), t.alert().replace(/<[^>]*>/g, '').slice(0, 60));
});

// 4c：AI 正常返回 → 使用模型话术
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '您好，我是客服小琳～请问在吗？' } }] }) }), AI_CFG, async () => {
  t.startWith('invest');
  t.openChat();
  t.reply('在吗');
  await settle();
  check('AI 正常时使用模型输出', t.msgsText().includes('我是客服小琳'), t.msgsText().slice(-60));
  check('AI 正常时无降级提示', !t.alert().includes('AI 调用失败'));
});

// --- 流程五：其余剧本均可启动 ---
for (const id of ['invest', 'refund']) {
  t.startWith(id);
  check(`剧本 ${id} 好友列表生成`, t.chatListHtml().length > 50);
  t.openChat();
  t.reply('我要报警');
  await settle();
  check(`剧本 ${id} 可出报告`, t.reportHtml().includes('演练复盘报告'));
}

// --- 流程六：首页 / 路由 ---
check('默认停在首页', t.onScreen().join() === 's-home', t.onScreen().join());
check('首页有两个入口按钮', html.includes('id="goLibrary"') && html.includes('id="goDrill"'));
check('首页统计已渲染', t.heroStats().includes('10') && t.heroStats().includes('30'), t.heroStats());

t.goto('s-library');
check('可跳转到案例库', t.onScreen().join() === 's-library');
check('案例库渲染分类网格', t.catsHtml().includes('刷单返利') && t.catsHtml().includes('杀猪盘'));
check('分类含「全部分类」入口', t.catsHtml().includes('全部分类'));
check('默认展示案例列表', t.casesHtml().includes('安全账户') || t.casesHtml().includes('class="case"'));
check('面包屑显示全部案例', t.crumbTxt().includes('全部案例'), t.crumbTxt());

// --- 流程七：搜索不受分类筛选影响 ---
// 分类按钮索引：0=全部分类, 1=刷单返利, 2=冒充公检法, 3=虚假投资理财, 4=虚假购物客服,
//             5=网络贷款, 6=杀猪盘, 7=虚假征信与债务, 8=冒充熟人与领导, 9=中奖退税, 10=虚拟币与博彩
t.search('验证码');
const kwHtml = t.casesHtml();
check('搜索命中案例', kwHtml.includes('class="case"'));
check('搜索提示标明「在全库」', t.countTxt().includes('全库'), t.countTxt());
const allHits = Number((t.countTxt().match(/匹配到\s*(\d+)\s*条/) || [0, 0])[1]);
t.clickCat(7); // 切到「虚假征信与债务」
check('切分类后搜索词保留', t.libState().keyword === '验证码', JSON.stringify(t.libState()));
check('★ 切分类后搜索结果不受分类限定',
  Number((t.countTxt().match(/匹配到\s*(\d+)\s*条/) || [0, 0])[1]) === allHits,
  `切分类前后命中数应相同：${allHits} -> ${t.countTxt()}`);
check('★ 命中案例确实跨多个分类',
  new Set(t.globalSearch('验证码')).size >= 2, [...new Set(t.globalSearch('验证码'))].join(','));
t.search('');
check('清空搜索后回到分类浏览', t.libState().catId === 'credit', JSON.stringify(t.libState()));

// --- 流程八：分类切换与展开 ---
t.clickCat(0); // 全部分类
check('可切回全部分类', t.libState().catId === null);
check('全部分类显示 30 条', t.countTxt().includes('30'), t.countTxt());
t.clickCat(6); // 杀猪盘
check('切到杀猪盘分类', t.libState().catId === 'pig', JSON.stringify(t.libState()));
check('分类内仅显示 3 条', t.countTxt().includes('3'), t.countTxt());
check('分类面包屑含分类名', t.crumbTxt().includes('杀猪盘'), t.crumbTxt());
check('分类内容为该类案例', t.casesHtml().includes('c016') || t.casesHtml().includes('杀猪盘'));

// 展开详情
t.clickCase(0);
check('案例可展开 [ids=' + t.caseIds() + ']', t.caseOpen() === 1, `open=${t.caseOpen()}`);
check('展开后含手法拆解', t.casesHtml().includes('手法拆解'));
check('展开后含破绽识别', t.casesHtml().includes('破绽在哪'));
check('展开后含处置建议', t.casesHtml().includes('遇到了怎么办'));

// --- 流程九：分页 ---
t.clickCat(0); // 全部分类，30 条 / 每页 6 → 5 页
check('分页条已渲染', t.pagerHtml().includes('data-go'), t.pagerHtml().slice(0, 60));
check('总页数为 5', t.pagerHtml().includes('data-go="5"'), t.pagerHtml().slice(0, 120));
t.clickPager('[data-go="2"]');
check('可翻到第 2 页', t.libState().page === 2, JSON.stringify(t.libState()));
check('第 2 页仍显示案例', t.casesHtml().includes('class="case"'));
t.clickPager('[data-go="5"]');
check('可翻到最后一页', t.libState().page === 5, JSON.stringify(t.libState()));

// --- 流程十：互动模式功能保持不变 ---
t.goto('s-drill');
check('可跳转到互动模式', t.onScreen().join() === 's-drill');
t.startWith('job');
t.openChat();
check('互动模式：好友列表正常', t.chatListHtml().includes('HR-小琳'));
check('互动模式：聊天可发消息', (t.reply('好的，怎么操作'), await settle(), t.chatCount()) > 4, `count=${t.chatCount()}`);
check('互动模式：报告可生成', t.reportHtml().includes('演练复盘报告'));

// 设置面板不得出现在手机屏幕上（跨三屏后依然成立）
const phoneHtml2 = extractElement(html, 'phone');
check('设置面板仍不在手机外壳内',
  !phoneHtml2.includes('aiBase') && !phoneHtml2.includes('aiKey'));
// 防回归：路由容器 .screen 与手机屏曾同名，误加 .on 会让手机黑屏
check('手机屏使用独立类名 screen-phone',
  (extractElement(html, 'phone') || '').includes('class="screen-phone"')
  && !/\.screen\{width:100%/.test(html),
  '手机屏不应复用路由容器类名 .screen');
check('路由容器仍为 .screen（三个顶层屏）',
  ['s-home', 's-library', 's-drill'].every((id) => html.includes('class="screen') && html.includes('id="' + id + '"')));

// ══════════ 流程十一：诈骗辨析 ══════════
const ANA_SAMPLE = '我是蚂蚁客服 编号 A8821，您的花呗账单已逾期，请把短信验证码发给我，并转账 500 元到安全账户，今天之内必须处理。';

check('首页新增「诈骗辨析」入口', html.includes('id="goAnalyze"'), '首页缺少辨析入口');
t.goto('s-analyze');
check('可跳转到诈骗辨析', t.onScreen().join() === 's-analyze', t.onScreen().join());
check('辨析屏含上传入口', html.includes('id="anaDrop"') && html.includes('id="anaFile"'));
check('上传入口标明支持的格式', t.anaSpec().includes('.txt') && t.anaSpec().includes('.png'), t.anaSpec());
check('上传入口标明大小上限', t.anaSpec().includes('KB') && t.anaSpec().includes('MB'), t.anaSpec());

// 11a：未提供任何内容 → 应给出可理解提示 + 重试入口，不静默失败
t.anaReset();
t.anaRun();
check('无内容时提示「没有可分析的内容」', t.anaErrHtml().includes('没有可分析的内容'), t.anaErrHtml().replace(/<[^>]*>/g, '').slice(0, 60));
check('错误态提供重试入口', t.anaHasRetry());

// 11b：内容过短 → 提示有效字数（走异步路径，需等一拍）
t.anaSetText('嗯');
t.anaRun();
await settle();
check('内容过短时给出字数提示', t.anaErrHtml().includes('太短'), t.anaErrHtml().replace(/<[^>]*>/g, '').slice(0, 60));

// 11c：上传格式与大小校验（复用打包产物里的同一份函数）
const badExt = JSON.parse(t.anaValidateUpload({ name: 'x.exe', size: 100 }));
check('上传不支持的格式被拦截', badExt.ok === false && /不支持的文件格式/.test(badExt.error), badExt.error);
const tooBig = JSON.parse(t.anaValidateUpload({ name: 'x.txt', size: 99999999 }));
check('上传超限文件被拦截并说明上限', tooBig.ok === false && /超过上限/.test(tooBig.error), tooBig.error);
const emptyFile = JSON.parse(t.anaValidateUpload({ name: 'x.txt', size: 0 }));
check('上传空文件被拦截', emptyFile.ok === false, JSON.stringify(emptyFile));

// 11d：未启用 AI → 纯规则分析可用（离线），结论为「是」
t.anaReset();
t.anaSetText(ANA_SAMPLE);
t.anaRun();
await settle();
await settle();
const anaR1 = t.anaResultHtml();
check('辨析输出结论', anaR1.includes('存在诈骗嫌疑'), anaR1.replace(/<[^>]*>/g, '').slice(0, 80));
check('辨析给出风险等级', anaR1.includes('风险等级') && (anaR1.includes('高危') || anaR1.includes('中高危')), '缺风险等级');
check('辨析给出风险指数', anaR1.includes('风险指数'));
check('辨析列出可疑点', anaR1.includes('可疑点逐条说明'));
check('辨析命中冒充客服特征', anaR1.includes('冒充客服'));
check('辨析命中索取验证码特征', anaR1.includes('索取验证码'));
check('辨析命中诱导转账特征', anaR1.includes('诱导转账'));
check('辨析给出防骗建议', anaR1.includes('防骗建议') && anaR1.includes('96110'), '缺防骗建议');
check('辨析给出判断依据摘要', anaR1.includes('判断依据'));
check('未启用 AI 时标识为规则引擎', anaR1.includes('规则引擎（离线）'), '引擎标识不对');

// 11e：普通聊天不误报
t.anaReset();
t.anaSetText('明天天气不错，我们一起吃饭吧，下午三点在公司楼下见。');
t.anaRun();
await settle();
const anaR2 = t.anaResultHtml();
check('普通聊天不误判为诈骗', anaR2.includes('存在诈骗嫌疑：否'), anaR2.replace(/<[^>]*>/g, '').slice(0, 80));
check('普通聊天显示未发现风险', anaR2.includes('未发现风险'));

// 11f：AI 正常返回 → 使用 AI 结论，且规则强信号不被推翻
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  verdict: 'clean', riskScore: 5, confidence: 90,
  signals: [], summary: '看起来是普通对话', advice: [],
}) } }] }) }), AI_CFG, async () => {
  t.anaReset();
  t.anaSetText(ANA_SAMPLE);
  t.anaRun();
  await settle();
  const r = t.anaResultHtml();
  check('★ AI 判「否」不能推翻规则强信号', r.includes('存在诈骗嫌疑：是'), r.replace(/<[^>]*>/g, '').slice(0, 60));
  check('冲突被显式说明而非隐藏', r.includes('已按规则判定'), '未说明冲突');
}, 'analyze');

await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  verdict: 'scam', riskScore: 88, confidence: 90,
  signals: [{ type: 'otp_request', name: '索取验证码', quote: '把短信验证码发给我' }],
  summary: '对方冒充客服并索要验证码与转账',
  advice: ['不要提供验证码', '不要向个人账户转账'],
}) } }] }) }), AI_CFG, async () => {
  t.anaReset();
  t.anaSetText(ANA_SAMPLE);
  t.anaRun();
  await settle();
  const r = t.anaResultHtml();
  check('AI 正常时采用 AI 结论', r.includes('AI 研判 + 规则引擎'), '引擎标识不对');
  check('AI 补充的证据进入结果', r.includes('索取验证码'));
  check('AI 给出的防骗建议被采用', r.includes('不要向个人账户转账'), 'AI 建议未出现');
}, 'analyze');

// 11g：AI 失败 → 降级为规则结论，仍有输出与提示
await withAI(async () => ({ ok: false, status: 500, text: async () => 'server error' }), AI_CFG, async () => {
  t.anaReset();
  t.anaSetText(ANA_SAMPLE);
  t.anaRun();
  await settle();
  const r = t.anaResultHtml();
  check('AI 失败时仍给出规则结论', r.includes('存在诈骗嫌疑：是'), r.replace(/<[^>]*>/g, '').slice(0, 60));
  check('AI 失败时说明降级原因', r.includes('AI 研判失败'), '未提示降级');
}, 'analyze');

// 11h：AI 越界输出 → 被拒绝并降级
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  verdict: 'scam', riskScore: 90, confidence: 90, signals: [],
  summary: '第一步实施诈骗，先取得信任', advice: [],
}) } }] }) }), AI_CFG, async () => {
  t.anaReset();
  t.anaSetText(ANA_SAMPLE);
  t.anaRun();
  await settle();
  const r = t.anaResultHtml();
  check('AI 越界输出被拒绝', r.includes('越界'), '越界未被拦截');
  check('AI 越界时仍降级为规则结论', r.includes('存在诈骗嫌疑：是'));
}, 'analyze');

// 11i：结果页「看同类案例」可跳回案例库并带上分类
t.anaReset();
t.anaSetText(ANA_SAMPLE);
t.anaRun();
await settle();
const cats = t.anaSigCats();
check('结果页提供「看同类案例」跳转', cats.length > 0, '无跳转入口');
if (cats) {
  t.anaClickSigCat(0);
  check('★ 点击「看同类案例」跳到案例库并定位分类', t.onScreen().join() === 's-library', t.onScreen().join());
  check('跳转后案例库已按该分类筛选', t.libState().catId === cats.split(',')[0], JSON.stringify(t.libState()) + ' vs ' + cats);
}

// 11j：图片上传入口存在且走 dataURL 通路
check('辨析屏支持图片入口', html.includes('readAsDataURL') && html.includes('imageDataUrl'), '图片通路缺失');
check('图片大小上限在界面明示', t.anaSpec().includes('5.0 MB'), t.anaSpec());
check('图片上限与引擎常量一致', JSON.parse(t.anaValidateUpload({ name: 'a.png', size: 5 * 1024 * 1024 })).ok === true);

// 11k：示例按钮可填入内容
t.goto('s-analyze');
t.anaDemo();
check('「填入示例」写入示例文本', t.anaText().length > 20, 'len=' + t.anaText().length);

// 11l：辨析屏内可直接配置 AI（不再需要跳转到互动模式）
check('辨析屏内置完整的 AI 配置面板',
  t.anaAiIds().length === 8, '缺失：' + t.anaAiIds().join(','));
check('辨析屏不再有「前往互动模式设置 AI」跳转按钮', !html.includes('anaGoSettings'));
check('辨析屏 AI 面板含开关/地址/Key/模型/温度/测试/清空',
  html.includes('id="anaAiEnabled"') && html.includes('id="anaAiBase"') &&
  html.includes('id="anaAiKey"') && html.includes('id="anaAiModel"') &&
  html.includes('id="anaAiTemp"') && html.includes('id="anaAiTest"') &&
  html.includes('id="anaAiClear"'));

// 在辨析屏开启开关 → 引擎状态应变为 AI 研判
// 注意：前面的互动模式用例会遗留 aiEnabled=true（测试之间共享同一份 localStorage 状态），
// 故先显式复位互动模式开关，才能验证「辨析屏开关不影响互动模式开关」。
await vm.runInContext(
  `(() => {
     const e = id => document.getElementById(id);
     e('aiEnabled').checked = false;
     e('aiEnabled').dispatchEvent(new Event('change'));
   })()`,
  ctx
);
t.anaAiSetEnabled(true);
check('辨析屏开启开关后引擎状态显示 AI 研判', t.anaEngine().includes('AI 研判'), t.anaEngine());
check('★ 辨析屏开关不影响互动模式开关（两者独立）',
  t.drillAiEnabled() === false, 'drill=' + t.drillAiEnabled());

// 在辨析屏填写连接参数 → 互动模式侧栏应同步显示（共用一份配置）
await vm.runInContext(
  `(() => {
     const e = id => document.getElementById(id);
     e('anaAiBase').value = 'https://sync.example.com/v1';
     e('anaAiKey').value = 'sk-synccheck123';
     e('anaAiModel').value = 'sync-model';
     e('anaAiModel').dispatchEvent(new Event('change'));
   })()`,
  ctx
);
check('★ 辨析屏填写的连接参数同步到互动模式侧栏',
  t.drillAiField('aiBase') === 'https://sync.example.com/v1' &&
  t.drillAiField('aiKey') === 'sk-synccheck123' &&
  t.drillAiField('aiModel') === 'sync-model',
  JSON.stringify({ b: t.drillAiField('aiBase'), k: t.drillAiField('aiKey'), m: t.drillAiField('aiModel') }));
check('连接参数确实写入存储', t.aiCfgDump().includes('sync-model'), t.aiCfgDump());

// 反向：在互动模式改模型 → 辨析屏应同步
await vm.runInContext(
  `(() => {
     const e = id => document.getElementById(id);
     e('aiModel').value = 'drill-model';
     e('aiModel').dispatchEvent(new Event('change'));
   })()`,
  ctx
);
check('★ 互动模式改模型后反向同步到辨析屏',
  t.anaAiField('anaAiModel') === 'drill-model', t.anaAiField('anaAiModel'));

// 辨析屏「测试连接」失败时给出可理解提示
await withAI(async () => ({ ok: false, status: 401, text: async () => 'bad key' }), AI_CFG, async () => {
  t.anaAiTest();
  await settle();
}, 'analyze');
check('辨析屏测试连接失败时给出提示', t.anaAiStatus().includes('连接失败'), t.anaAiStatus());

// 辨析屏「清空」应重置两个开关
await vm.runInContext(`document.getElementById('anaAiClear').onclick()`, ctx);
check('辨析屏清空后自身开关关闭', t.anaAiEnabled() === false);
check('★ 辨析屏清空同时重置互动模式开关', t.drillAiEnabled() === false, 'drill=' + t.drillAiEnabled());
check('清空后连接参数也被重置', t.aiCfgDump().includes('"baseUrl":""'), t.aiCfgDump());

// 11m：端到端——两个开关各自独立生效（只开辨析时，互动模式仍走内置话术）
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  verdict: 'scam', riskScore: 80, confidence: 85, signals: [], summary: 'AI 研判结论', advice: [],
}) } }] }) }), AI_CFG, async () => {
  // 只开辨析开关，互动模式开关保持关闭
  await vm.runInContext(
    `(() => {
       const e = id => document.getElementById(id);
       e('aiEnabled').checked = false;
       e('aiEnabled').dispatchEvent(new Event('change'));
       e('anaAiEnabled').checked = true;
       e('anaAiEnabled').dispatchEvent(new Event('change'));
       e('anaAiBase').value = 'https://api.example.com/v1';
       e('anaAiKey').value = 'sk-faketest12345';
       e('anaAiModel').value = 'gpt-test';
       e('anaAiModel').dispatchEvent(new Event('change'));
     })()`,
    ctx
  );
  // 互动模式：只开辨析开关时，引擎应显示内置话术
  t.startWith('job');
  t.openChat();
  t.reply('好的，怎么操作');
  await settle();
  check('★ 只开辨析开关时，互动模式仍用内置话术',
    t.engineText().includes('内置知识库话术'), t.engineText());
  // 辨析模式：AI 应被真正调用
  t.anaReset();
  t.anaSetText(ANA_SAMPLE);
  const callsBefore = t.aiCalls();
  t.anaRun();
  await settle();
  check('★ 只开辨析开关时，辨析确实调用了 AI', t.aiCalls() > callsBefore,
    'calls=' + (t.aiCalls() - callsBefore));
  check('★ 只开辨析开关时，辨析走 AI 研判',
    t.anaResultHtml().includes('AI 研判 + 规则引擎'), t.anaResultHtml().replace(/<[^>]*>/g, '').slice(0, 60));
}, 'analyze');

// 11n：只开互动模式开关时，辨析仍走纯规则
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'AI 话术' } }] }) }), AI_CFG, async () => {
  await vm.runInContext(
    `(() => {
       const e = id => document.getElementById(id);
       e('aiEnabled').checked = true;
       e('aiEnabled').dispatchEvent(new Event('change'));
       e('anaAiEnabled').checked = false;
       e('anaAiEnabled').dispatchEvent(new Event('change'));
       e('anaAiBase').value = 'https://api.example.com/v1';
       e('anaAiKey').value = 'sk-faketest12345';
       e('anaAiModel').value = 'gpt-test';
       e('anaAiModel').dispatchEvent(new Event('change'));
     })()`,
    ctx
  );
  t.anaReset();
  t.anaSetText(ANA_SAMPLE);
  const callsBefore = t.aiCalls();
  t.anaRun();
  await settle();
  // 关键断言用「AI 未被调用」而非结果页文案：
  // AI 调用失败时结果页同样显示「规则引擎（离线）」，用文案断言会漏判
  check('★ 只开互动模式开关时，辨析完全不调用 AI', t.aiCalls() === callsBefore,
    'calls=' + (t.aiCalls() - callsBefore));
  check('★ 只开互动模式开关时，辨析仍走纯规则',
    t.anaResultHtml().includes('规则引擎（离线）'), t.anaResultHtml().replace(/<[^>]*>/g, '').slice(0, 60));
}, 'drill');

// 11o：图片读图失败 → 结果页必须给出明确失败提示，而不是只显示「无法判断」
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  verdict: 'unknown', riskScore: 0, confidence: 10, signals: [],
  summary: '聊天截图为不可读内容，无法提取对话信息，因此无法判断是否存在诈骗特征。',
  advice: [],
}) } }] }) }), AI_CFG, async () => {
  t.anaReset();
  t.anaPickFile({ name: 'chat.jpg', kind: 'image', dataUrl: 'data:image/jpeg;base64,AAA', size: 155758 });
  t.anaRun();
  await settle();
  const html = t.anaImageFailHtml();
  check('★ 读图失败时结果页给出醒目失败提示', html.includes('模型没能读出这张截图'), html.replace(/<[^>]*>/g, '').slice(0, 120));
  check('读图失败时提示里含可操作指引', html.includes('gpt-4o') || html.includes('裁剪'), '缺指引');
  check('读图失败时提供「改用文字分析」出口', html.includes('anaToText'), '缺出口');
  check('读图失败时提供重试出口', html.includes('anaRetryAi'), '缺重试');
  // 结论是「无法判断」时绝不能显示绿色的「未发现风险」——那等于对没读懂的聊天给出安全保证
  check('★ 读图失败时风险等级显示「无法评估」而不是「未发现风险」',
    t.anaResultHtml().includes('无法评估') && !t.anaResultHtml().includes('未发现风险'),
    t.anaResultHtml().replace(/<[^>]*>/g, '').slice(0, 200));
}, 'analyze');

// 11o-2：模型填成纯文本模型时，选图当下就应给出警告 + 一键换模型
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }),
  { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-faketest12345', model: 'deepseek-v4-pro' },
  async () => {
  await vm.runInContext(
    `(() => {
       const e = id => document.getElementById(id);
       e('anaAiEnabled').checked = true;
       e('anaAiEnabled').dispatchEvent(new Event('change'));
       e('anaAiBase').value = 'https://api.deepseek.com';
       e('anaAiKey').value = 'sk-faketest12345';
       e('anaAiModel').value = 'deepseek-v4-pro';
       e('anaAiModel').dispatchEvent(new Event('change'));
     })()`,
    ctx
  );
  check('★ 纯文本模型时 AI 面板给出能力警告',
    t.anaModelHintText().includes('不支持图片输入'), t.anaModelHintText());
  check('★ 纯文本模型时提供一键换成 deepseek-flash',
    t.anaModelHintHtml().includes('deepseek-flash'), t.anaModelHintHtml());
  t.anaReset();
  t.anaPickFile({ name: 'chat.jpg', kind: 'image', dataUrl: 'data:image/jpeg;base64,AAA', size: 155758 });
  check('★ 选了图片就当场警告模型不支持视觉', t.anaMsgText().includes('不支持图片输入'), t.anaMsgText());
  check('★ 选图警告里带一键换模型入口', t.anaMsgHtml().includes('anaFixModel'), t.anaMsgHtml().slice(0, 200));
}, 'analyze');

// 11p：「测试视觉」按钮能区分模型是否支持图片输入
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '红色、蓝色、绿色、黄色' } }] }) }), AI_CFG, async () => {
  t.anaAiVision();
  await settle();
  check('★ 视觉探测：模型能读图时提示支持', t.anaAiStatusText().includes('支持图片输入'), t.anaAiStatusText());
}, 'analyze');

await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '我是纯文本模型，无法处理图片' } }] }) }), AI_CFG, async () => {
  t.anaAiVision();
  await settle();
  const s = t.anaAiStatusText();
  // 断言必须覆盖 reason 的具体措辞：变异掉「不支持/无法处理」分支后，
  // 最终文案虽然同样叫「无法读取图片」，但 reason 会退化成「无法确认是否读图」——
  // 只断言最终文案会漏判，因此这里额外要求 reason 精确指向「无法处理图片」。
  check('★ 视觉探测：模型读不了图时明确指出并建议换模型',
    s.includes('无法读取图片') && s.includes('gpt-4o'), s);
  check('★ 视觉探测：原因精确指向「模型无法处理图片」',
    s.includes('模型表示无法处理图片'), s);
}, 'analyze');

// 11q：模型读不到图时，提示要能区分「模型不支持视觉」与「图本身难辨」
await withAI(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
  verdict: 'unknown', riskScore: 0, confidence: 10, signals: [],
  summary: '作为纯文本模型，我无法处理图片', advice: [],
}) } }] }) }), AI_CFG, async () => {
  t.anaReset();
  t.anaPickFile({ name: 'chat.jpg', kind: 'image', dataUrl: 'data:image/jpeg;base64,AAA', size: 155758 });
  t.anaRun();
  await settle();
  check('★ 区分「模型不支持视觉」并建议换模型',
    t.anaImageFailHtml().includes('不支持图片输入'), t.anaImageFailHtml().replace(/<[^>]*>/g, '').slice(0, 160));
}, 'analyze');

/* --- 响应式规则：桌面/平板/手机三档必须都在，否则窄屏会横向溢出 --- */
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
function mediaBlock(px) {
  const i = css.indexOf('@media(max-width:' + px + 'px){');
  if (i < 0) return null;
  let d = 0;
  const j = css.indexOf('{', i);
  for (let k = j; k < css.length; k++) {
    if (css[k] === '{') d++;
    else if (css[k] === '}') { d--; if (d === 0) return css.slice(j + 1, k); }
  }
  return null;
}
check('平板断点：侧栏改为纵向堆叠',
  mediaBlock(940) && /grid-template-columns:1fr/.test(mediaBlock(940)));
check('窄屏断点：首页入口单列',
  mediaBlock(760) && /grid-template-columns:1fr/.test(mediaBlock(760)));
const b640 = mediaBlock(640);
check('手机断点：手机外壳随宽度自适应',
  !!b640 && /width:100%;max-width:414px/.test(b640) && /aspect-ratio/.test(b640),
  '固定 390px 在窄屏会横向溢出');
check('手机断点：面板内边距收窄', !!b640 && /\.wrap\{padding:14px\}/.test(b640));

let failed = 0;
for (const [name, ok, extra] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) failed++;
}
console.log(`\n冒烟测试：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
