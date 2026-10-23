import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9393;
const b64 = readFileSync('C:/Users/15515/Pictures/Screenshots/微信图片_20261023103649_77_61.jpg').toString('base64');
const imgUrl = 'data:image/jpeg;base64,' + b64;

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + resolve(root, '.edge-measure'),
  '--window-size=400,400', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = list.find((t) => t.type === 'page'); if (target) break; } catch (e) {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
await new Promise((r) => ws.addEventListener('open', r));
await send('Page.enable'); await send('Runtime.enable');
const html = `data:text/html,<body><img id=i src="${imgUrl}"></body>`;
await send('Page.navigate', { url: html });
await sleep(1500);
const out = await send('Runtime.evaluate', {
  expression: `(async()=>{
    try{
      const img=document.getElementById('i'); await img.decode();
      const w=img.naturalWidth,h=img.naturalHeight;
      const c=document.createElement('canvas');c.width=w;c.height=h;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
      const d=ctx.getImageData(0,0,w,h).data;
      const px=(x,y)=>{const i=(y*w+x)*4;return [d[i],d[i+1],d[i+2]];};
      // 采样角点/边点，推断背景色
      const samples={cornerTL:px(4,4),cornerBR:px(w-5,h-5),topMid:px((w/2)|0,4),botMid:px((w/2)|0,h-5),leftMid:px(4,(h/2)|0),rightMid:px(w-5,(h/2)|0)};
      // 统计最亮的众数色作为背景
      const hist={};
      for(let y=0;y<h;y+=3){for(let x=0;x<w;x+=3){const i=(y*w+x)*4;const r=d[i],g=d[i+1],b=d[i+2];if(r>200&&g>200&&b>200){const k=(r>>4)+','+(g>>4)+','+(b>>4);hist[k]=(hist[k]||0)+1;}}}
      let bgk=null,bgn=0;for(const k in hist){if(hist[k]>bgn){bgn=hist[k];bgk=k;}}
      const bgRGB=bgk?bgk.split(',').map(v=>+v*16+8):null;
      let minX=w,minY=h,maxX=0,maxY=0;
      if(bgRGB){
        const [br,bg,bb]=bgRGB;
        for(let y=0;y<h;y++){for(let x=0;x<w;x++){
          const i=(y*w+x)*4;const r=d[i],g=d[i+1],b=d[i+2];
          if(Math.abs(r-br)>40||Math.abs(g-bg)>40||Math.abs(b-bb)>40){ if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y; }
        }}
      }
      const bw=maxX-minX,bh=maxY-minY;
      return {w,h,samples,bgRGB,minX,minY,maxX,maxY,fw:bw/w,fh:bh/h,fx:minX/w,fy:minY/h,cx:(minX+bw/2)/w,headBottomFrac:(minY+bh*0.40)/h};
    }catch(e){return {err:String(e)};}
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log(JSON.stringify(out.result ? out.result.value : out, null, 2));
ws.close(); edge.kill();
