/**
 * 构建脚本：把 ES 模块源码打包成一个可双击打开的单文件 HTML。
 * 之所以做打包：ES module 在 file:// 协议下会被 CORS 拦截，
 * 而「双击就能用」是这个演练工具的基本要求。
 * 用法：node build.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(root, p), 'utf8');

// 1) 去掉 import/export 语句，按依赖顺序拼接
// 顺序即依赖顺序：知识库 → 规则 → AI → 会话引擎 → 案例库
const files = ['kb/scenarios.js', 'engine/rules.js', 'engine/ai.js', 'engine/session.js', 'kb/cases.js', 'engine/library.js'];
let bundle = '';
for (const f of files) {
  bundle +=
    `\n/* ===== ${f} ===== */\n` +
    read(f)
      .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
      .replace(/^export\s+/gm, '');
}

const html = read('src/page.html')
  .replace('/*__BUNDLE__*/', () => bundle);

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/scam-sim.html'), html, 'utf8');
console.log('已生成 dist/scam-sim.html');
