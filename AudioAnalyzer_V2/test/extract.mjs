// ═══════════════════════════════════════════════════════════════
//  test/extract.mjs — 从 renderer/app.js 抽出纯函数以便 Node 端测试
//
//  为什么需要它：renderer/app.js 是 ES Module，模块级会访问 document /
//  AudioContext / Worker，Node 里无法直接 import。这里用花括号配平把目标
//  函数原样切出来（不做任何改写），配合最小桩即可在 Node 中实跑。
//
//  注意：函数内部若新增了对浏览器 API 的调用，需要在 $stubs 里补桩。
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_PATH = path.resolve(__dirname, '..', 'renderer', 'app.js');

// ── 退出钩子 ──
// 即使测试中途抛错或提前 process.exit，也保证临时文件被清掉，
// 避免仓库里堆积 .tmp-extract-*.mjs
const __pending = new Set();
process.on('exit', () => {
  for (const p of __pending) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

/** 登记一个需要在本进程退出时自动清理的文件路径，返回该路径 */
export function autoCleanup(p) {
  __pending.add(p);
  return p;
}

/** 按名字抽出一个顶层函数（含 async），返回其源码文本 */
export function extractFunction(name, srcPath = APP_PATH) {
  const src = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/);
  const start = src.findIndex(l => new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`).test(l));
  if (start < 0) throw new Error(`找不到函数: ${name}`);
  let depth = 0, started = false;
  for (let i = start; i < src.length; i++) {
    for (const ch of src[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) return src.slice(start, i + 1).join('\n');
  }
  throw new Error(`函数未闭合: ${name}`);
}

/**
 * 把若干函数拼成一个可在 Node 中 import 的临时模块。
 * 返回可直接交给 `import()` 的 file:// URL（Windows 上绝对路径不能直接 import）。
 * @param {string[]} names 需要的函数名（按依赖顺序）
 * @param {object} [opts]
 * @param {string} [opts.stubs] 额外注入的桩代码
 * @param {string} [opts.exports] 导出语句内容，默认导出全部 names
 * @param {string} [opts.file] 临时文件名
 */
export function buildModule(names, opts = {}) {
  const { stubs = '', exports, file = `.tmp-extract-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs` } = opts;
  const defaultStub = `
const D = { ok(){}, info(){}, warn(){}, err(){} };
const __noop = () => {};
`;
  const code = [
    defaultStub,
    stubs,
    ...names.map(n => extractFunction(n)),
    `export { ${exports || names.join(', ')} };`,
  ].join('\n\n');
  const outPath = path.resolve(path.dirname(APP_PATH), '..', file);
  fs.writeFileSync(outPath, code);
  autoCleanup(outPath);   // 任何退出路径都会清掉
  return pathToFileURL(outPath).href;
}

/** 生成正弦测试信号（立体声同相） */
export function tone(freq, sr = 44100, secs = 3, amp = 0.5) {
  const n = Math.round(sr * secs);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin(2 * Math.PI * freq * i / sr);
    L[i] = v; R[i] = v;
  }
  return [L, R];
}

/** 极简断言器 */
export function createAsserter() {
  const fails = [];
  return {
    ok(cond, msg) { if (!cond) fails.push(msg); return !!cond; },
    near(actual, expected, tol, msg) {
      const good = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
      if (!good) fails.push(`${msg}（实际 ${actual}，期望 ${expected}±${tol}）`);
      return good;
    },
    get fails() { return fails; },
    report(title) {
      if (fails.length) {
        console.log(`\n❌ ${title} — 失败 ${fails.length} 项:`);
        fails.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
      } else {
        console.log(`\n✅ ${title} — 全部通过`);
      }
      return fails.length === 0;
    },
  };
}

/** 清理 buildModule 产生的临时文件（接受路径或 file:// URL） */
export function cleanup(...paths) {
  for (const p of paths) {
    try {
      const f = typeof p === 'string' && p.startsWith('file:') ? fileURLToPath(p) : p;
      fs.unlinkSync(f);
    } catch (_) {}
  }
}
