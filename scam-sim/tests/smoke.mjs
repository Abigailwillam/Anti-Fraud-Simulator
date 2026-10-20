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
          return {
            tag: m[1], key: dm ? dm[1] : '', val: dm ? dm[2] : '',
            cls: cm ? cm[1] : '', onclick: null,
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
       onScreen() { return ['s-home','s-library','s-drill'].filter(s => $(s).classList.contains('on')); },
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
       globalSearch(kw) { return searchCases(kw).map(c => c.catId); }
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
async function withAI(fetchImpl, cfg, fn) {
  ctx.fetch = fetchImpl;
  await vm.runInContext(
    `(() => {
       const e = id => document.getElementById(id);
       e('aiEnabled').checked = true;
       e('aiEnabled').dispatchEvent(new Event('change'));
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
