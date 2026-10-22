/**
 * 真机联调脚本：用**真实接口**跑一次「图片辨析」全链路。
 * 目的：单元测试只能证明代码逻辑对，证明不了「换模型后真的读得出图」。
 * 这个脚本直接调用仓库里的引擎函数（buildAnalysisMessages → callChat → analyze），
 * 走的是和网页里完全相同的请求体，因此它跑通了，网页里就跑得通。
 *
 * 用法（PowerShell / cmd）：
 *   set DEEPSEEK_API_KEY=sk-xxxxxxxx
 *   set DEEPSEEK_MODEL=deepseek-flash
 *   node tests/live-vision-check.mjs "C:\Users\xxx\Pictures\Screenshots\shot.png"
 *
 * 可选环境变量：
 *   DEEPSEEK_BASE_URL  默认 https://api.deepseek.com
 *   DEEPSEEK_MODEL     默认 deepseek-flash
 *
 * 注意：API Key 只从环境变量读取，仓库里不存任何密钥。
 */
import { readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { analyze } from '../engine/detect.js';
import { callChat, describeVisionSupport } from '../engine/ai.js';

const args = process.argv.slice(2);
const imgPath = args[0] ? resolve(args[0]) : '';
if (!imgPath) {
  console.error('用法：node tests/live-vision-check.mjs <图片路径>');
  process.exit(1);
}

const cfg = {
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  temperature: 0.9,
};
if (!cfg.apiKey) {
  console.error('缺少环境变量 DEEPSEEK_API_KEY');
  process.exit(1);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const ext = extname(imgPath).toLowerCase();
if (!MIME[ext]) {
  console.error(`不支持的图片格式：${ext}（支持 ${Object.keys(MIME).join('、')}）`);
  process.exit(1);
}

const stat = statSync(imgPath);
const dataUrl = `data:${MIME[ext]};base64,${readFileSync(imgPath).toString('base64')}`;

const vision = describeVisionSupport(cfg.model, cfg.baseUrl);
console.log('═══ 配置 ═══');
console.log('接口    :', cfg.baseUrl);
console.log('模型    :', cfg.model, `（视觉能力：${vision.state} — ${vision.reason}）`);
console.log('图片    :', imgPath, `(${(stat.size / 1024).toFixed(1)} KB)`);
console.log('载荷    :', `${(dataUrl.length / 1024 / 1024).toFixed(2)} MB (base64)`);

console.log('\n═══ 正在辨析（真实请求）… ═══');
const t0 = Date.now();
const r = await analyze(
  { imageDataUrl: dataUrl, name: imgPath.split(/[\\/]/).pop(), kind: 'image' },
  cfg,
  { callChat, timeoutMs: 120000 },
);
const sec = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n═══ 结果（${sec}s）═══`);
console.log('结论      :', r.verdictInfo.label, '|', r.verdictInfo.desc);
console.log('风险等级  :', r.level.label, `(${r.riskScore}/100)`);
console.log('置信度    :', r.confidence + '%');
console.log('研判方式  :', r.engine === 'hybrid' ? 'AI 研判 + 规则引擎' : '规则引擎（离线）');
console.log('读图失败  :', r.imageReadFailed ? '是' : '否', '| 视觉自检:', r.visionSupported === null ? '未探测' : r.visionSupported ? '模型能读图' : '模型读不了图');
console.log('判断依据  :', r.summary);
if (r.signals.length) {
  console.log('\n可疑点：');
  for (const s of r.signals) console.log(`  · [${s.label}] ${s.evidence || s.detail}`);
}
if (r.advice.length) {
  console.log('\n防骗建议：');
  for (const a of r.advice) console.log('  ·', a);
}
if (r.notes.length) {
  console.log('\n备注：');
  for (const n of r.notes) console.log('  ·', n);
}
process.exit(r.imageReadFailed ? 2 : 0);
