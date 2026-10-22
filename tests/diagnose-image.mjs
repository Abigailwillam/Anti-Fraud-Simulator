/**
 * 诊断脚本：捕获「诈骗辨析」图片分析实际发出的请求体。
 * 目的：确认 image_url 多模态结构是否正确送达模型，
 * 从而区分「我们没把图片发对」与「模型/代理读不到图」。
 * 用法：node tests/diagnose-image.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'dist/scam-sim.html'), 'utf8');
const js = html.match(/<script>([\s\S]*)<\/script>/)[1];

const nodes = {};
function initialClasses(h) {
  const map = new Map();
  for (const m of h.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const cm = /\bclass="([^"]*)"/.exec(m[2]);
    if (cm) map.set(m[3], cm[1].split(/\s+/).filter(Boolean));
  }
  return map;
}
const initCls = initialClasses(html);
function mk(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, checked: false,
    dataset: {}, className: '', children: [], _kids: [],
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);},
      toggle(c,on){ on===undefined ? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (on?this._s.add(c):this._s.delete(c)); },
      contains(c){return this._s.has(c);} },
    appendChild(c){ this._kids.push(c); c._p=this; this.textContent=String(this.textContent||'')+String(c.textContent||''); return c; },
    remove(){ const p=this._p; if(p) p._kids=p._kids.filter(x=>x!==c); },
    set innerHTML(v){ this._html=String(v); this.textContent=String(v).replace(/<[^>]*>/g,'');
      this._els=[...String(v).matchAll(/<(\w+)([^>]*)>/g)].map(m=>{const a=m[2];
        const dm=/\bdata-([a-z]+)="([^"]*)"/.exec(a), cm=/\bclass="([^"]*)"/.exec(a), im=/\bid="([^"]*)"/.exec(a);
        return {tag:m[1],key:dm?dm[1]:'',val:dm?dm[2]:'',cls:cm?cm[1]:'',id:im?im[1]:'',onclick:null,
          get dataset(){const o={};if(dm)o[dm[1]]=dm[2];return o;},
          classList:{_s:new Set(cm?cm[1].split(/\s+/).filter(Boolean):[]),contains(c){return this._s.has(c);},
            add(c){this._s.add(c);},remove(c){this._s.delete(c);},
            toggle(c,on){on===undefined?(this._s.has(c)?this._s.delete(c):this._s.add(c)):(on?this._s.add(c):this._s.delete(c));}},
          click(){if(this.onclick)this.onclick();}};});
      this._els.forEach(e=>{e.parentElement=e.tag==='button'?(this._els.find(x=>x.tag==='article')||null):null;});
      this._els.forEach(e=>{if(e.tag==='article'&&e.key==='id'){const p=(this._prev||={});if(p[e.val])e.classList.add('open');}});
      this._els.forEach(e=>{if(e.tag==='article'&&e.key==='id'){const p=(this._prev||={});p[e.val]=e.classList.contains('open');}});
    },
    get innerHTML(){ return this._html||''; },
    querySelectorAll(sel){ const all=this._els||[]; if(!sel)return all;
      const dm=/\[data-([a-z]+)(?:="?([^"\]]*)"?)?\]/.exec(sel);
      if(dm)return all.filter(e=>e.key===dm[1]&&(dm[2]===undefined||!dm[2]||e.val===dm[2]));
      const cm=/^\.([\w-]+)$/.exec(sel); if(cm)return all.filter(e=>(e.cls||'').split(/\s+/).includes(cm[1]));
      return all.filter(e=>e.tag===sel); },
    querySelector(sel){ return this.querySelectorAll(sel)[0]||mk('sub'); },
    scrollTop:0, scrollHeight:0, onclick:null, _ls:{},
    addEventListener(k,fn){ (this._ls||={})[k]=fn; },
    dispatchEvent(ev){ const fn=(this._ls||{})[ev.type]; if(fn)fn({target:this}); return true; },
    focus(){},
  };
}
const document = {
  getElementById: (id) => { if(!nodes[id]){ const n=mk(id); n.classList._s=new Set(initCls.get(id)||[]); nodes[id]=n; } return nodes[id]; },
  createElement: (t) => mk(t),
  querySelector: (sel) => (nodes['sel:'+sel] ||= mk(sel)),
};

// 捕获请求体
let captured = null;
const ctx = vm.createContext({
  document, console, setTimeout, clearTimeout, Math, JSON, Date, window:{scrollTo(){}},
  Promise, AbortController, Object, Array, String, Number, RegExp, Error, Event, Uint8Array,
  localStorage: (()=>{const m=new Map();return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};})(),
  fetch: async (url, init) => {
    captured = { url, init };
    // 模拟一个「读不到图」的模型返回——这正是用户看到的现象
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      verdict: 'unknown', riskScore: 0, confidence: 10,
      signals: [], summary: '聊天截图为不可读内容，无法提取对话信息，因此无法判断是否存在诈骗特征。',
      advice: [],
    }) } }] }) };
  },
});

vm.runInContext(js + `
;globalThis.__t = {
  setCfg() {
    const e = id => document.getElementById(id);
    e('anaAiEnabled').checked = true;
    e('anaAiEnabled').dispatchEvent(new Event('change'));
    e('anaAiBase').value = 'https://api.example.com/v1';
    e('anaAiKey').value = 'sk-diagtest12345';
    e('anaAiModel').value = 'vision-model';
    e('anaAiModel').dispatchEvent(new Event('change'));
  },
  pickImage(dataUrl) {
    anaState.picked = { name: 'chat.jpg', kind: 'image', dataUrl, size: 155758 };
    anaRenderPicked();
  },
  run() { anaRun(); },
  result() { return $('anaResult').innerText || $('anaResult').textContent || ''; },
};`, ctx);

const t = ctx.__t;
t.setCfg();
t.pickImage('data:image/jpeg;base64,AAABBBCCC' + 'X'.repeat(200));
t.run();
await new Promise(r => setTimeout(r, 500));

console.log('═══ 捕获到的请求 ═══');
if (!captured) { console.log('!! 没有捕获到 fetch 调用 —— 说明请求根本没发出'); process.exit(1); }
console.log('URL:', captured.url);
const body = JSON.parse(captured.init.body);
console.log('model:', body.model);
console.log('max_tokens:', body.max_tokens);
console.log('请求体总字节:', captured.init.body.length);
const b64pos = captured.init.body.indexOf('base64,');
console.log('dataURL 载荷字节:', captured.init.body.length - b64pos);
console.log('body 字段:', Object.keys(body).join(','));
console.log('temperature:', body.temperature);
console.log('stream:', body.stream);
console.log('messages 数量:', body.messages.length);
console.log('\n── messages 结构（截断 data URL）──');
const shown = JSON.parse(JSON.stringify(body.messages));
for (const m of shown) {
  if (Array.isArray(m.content)) {
    m.content = m.content.map(p => p.type === 'image_url'
      ? { type: p.type, image_url: { url: String(p.image_url.url).slice(0, 60) + '...(截断)' } }
      : p);
  }
  console.log(JSON.stringify(m, null, 2).slice(0, 900));
}
console.log('\n═══ 界面显示的结果 ═══');
console.log(t.result().slice(0, 400));
