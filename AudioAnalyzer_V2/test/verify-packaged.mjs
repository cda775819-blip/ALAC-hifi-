// 验证打包后的 app.asar 内资源完整性与路径解析逻辑
// 直接读 asar 头部（不依赖 Electron 运行时），确认 main.js 的解析路径成立
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'dist', 'win-unpacked');
const ASAR = path.join(APP_DIR, 'resources', 'app.asar');

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); return !!c; };

console.log('=== 打包产物校验 ===\n');
if (!fs.existsSync(ASAR)) { console.error('❌ 找不到 ' + ASAR); process.exit(1); }
console.log('app.asar: ' + (fs.statSync(ASAR).size / 1048576).toFixed(1) + ' MB');

// ── 用 asar 库读取文件清单 ──
let asar = null;
try { asar = require('@electron/asar'); } catch (_) {
  try { asar = require('asar'); } catch (_) {}
}
if (!asar) { console.error('❌ asar 库不可用'); process.exit(1); }

const list = asar.listPackage(ASAR);
console.log('asar 内文件总数: ' + list.length);

// ── 1) 打包必需的应用文件 ──
console.log('\n【1】应用文件是否齐全');
const required = [
  '\\main.js', '\\preload.js', '\\package.json',
  '\\renderer\\app.js', '\\renderer\\library.js', '\\renderer\\index.html', '\\renderer\\styles.css',
  '\\core\\analyzeEngine.js', '\\core\\workerPool.js', '\\core\\chunkManager.js', '\\core\\reduceResults.js',
  '\\worker\\analyze.worker.js', '\\utils\\audioMath.js',
];
for (const f of required) {
  const hit = list.some(x => x.replace(/\//g, '\\') === f);
  ok(hit, 'asar 缺少 ' + f);
  console.log('  ' + (hit ? '✅' : '❌') + ' ' + f);
}

// ── 2) 内置 FFmpeg 二进制 ──
console.log('\n【2】内置 FFmpeg / FFprobe');
for (const [name, key] of [['ffmpeg.exe', '\\assets\\ffmpeg.exe'], ['ffprobe.exe', '\\assets\\ffprobe.exe']]) {
  const hit = list.some(x => x.replace(/\//g, '\\') === key);
  ok(hit, 'asar 缺少 ' + key);
  let size = 0;
  if (hit) {
    try { size = asar.extractFile(ASAR, key.replace(/^\\/, '')).length; } catch (_) {}
  }
  console.log('  ' + (hit ? '✅' : '❌') + ' ' + name + (size ? '  (' + (size / 1048576).toFixed(1) + ' MB)' : ''));
  if (hit) ok(size > 100 * 1048576, name + ' 体积异常（' + (size / 1048576).toFixed(1) + ' MB，期望 >100MB）');
}

// ── 3) 复现 main.js 的解析路径 ──
console.log('\n【3】main.js 路径解析逻辑（在打包环境下）');
// 打包后 __dirname === asar 根；path.join 结果应命中 asar 内条目
const joined = path.join(ASAR, 'assets', 'ffmpeg.exe');
const joinedProbe = path.join(ASAR, 'assets', 'ffprobe.exe');
const norm = (p) => p.replace(/\//g, '\\');
const hitFf = list.some(x => norm(path.join(ASAR, x.replace(/^\//, ''))) === norm(joined));
const hitFp = list.some(x => norm(path.join(ASAR, x.replace(/^\//, ''))) === norm(joinedProbe));
console.log('  path.join(__dirname, "assets", "ffmpeg.exe")  →  ' + (hitFf ? '✅ 命中' : '❌ 未命中'));
console.log('    ' + joined);
console.log('  path.join(__dirname, "assets", "ffprobe.exe") →  ' + (hitFp ? '✅ 命中' : '❌ 未命中'));
console.log('    ' + joinedProbe);
ok(hitFf && hitFp, 'main.js 的路径解析在打包环境下无法命中内置二进制');

// ── 4) 安装包与解包目录 ──
console.log('\n【4】产物体积');
const setup = path.join(ROOT, 'dist', 'Audio Analyzer Pro Setup 9.0.0.exe');
if (fs.existsSync(setup)) {
  const mb = fs.statSync(setup).size / 1048576;
  console.log('  安装包: ' + mb.toFixed(1) + ' MB');
  ok(mb > 150, '安装包体积偏小（' + mb.toFixed(1) + ' MB），可能未包含 FFmpeg');
} else {
  console.log('  ⚠ 未找到安装包（只打包了 win-unpacked？）');
  fails.push('找不到安装包 dist/Audio Analyzer Pro Setup 9.0.0.exe');
}

// ── 5) asar 内不应包含的东西 ──
console.log('\n【5】asar 内是否误打包了不该有的内容');
for (const bad of ['node_modules', 'dist', 'test']) {
  const hit = list.some(x => x.replace(/\\/g, '/').startsWith('/' + bad));
  console.log('  ' + (hit ? '⚠ 包含' : '✅ 不含') + ' ' + bad);
  if (bad === 'dist') ok(!hit, 'asar 内误含 dist/（会自我嵌套膨胀）');
}

console.log('\n' + (fails.length ? '❌ 校验失败:\n - ' + fails.join('\n - ') : '✅ 打包产物校验全部通过'));
process.exit(fails.length ? 1 : 0);
