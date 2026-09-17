// ═══════════════════════════════════════════════════════════════
//  test/cutoff.test.mjs — 截止频率 / THD 的数据类型回归测试
//
//  守护的 bug（真实修复过的）：
//   computeDistortion 与 detectCutoff 内部都按 **dB 谱** 处理：
//     - computeDistortion 用 Math.pow(10, harmonics[i]/20) 还原线性幅度
//     - detectCutoff 用「噪底 + 15dB」作阈值、用「峰值 - 35dB」找降落
//   但渲染层曾经把 **线性归一化幅度谱**（0~1）传进去，后果：
//     - THD 恒定偏高：所有谐波经 10^(0.x/20) ≈ 1 被压成相等，
//       纯正弦也会报 178%，且与信号无关（换文件数值不变）
//     - 截止频率恒等于奈奎斯特：线性谱最大只有 1，
//       `spectrum[i] > ultraNoiseFloor + 15` 永远不成立
//
//  跑法：node test/cutoff.test.mjs
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { createAsserter } from './extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AM = path.resolve(__dirname, '..', 'utils', 'audioMath.js');

// audioMath.js 依赖 utils/logger，Node 里换成桩
const tmp = path.resolve(__dirname, '..', `.tmp-am-${process.pid}.mjs`);
fs.writeFileSync(tmp, fs.readFileSync(AM, 'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*logger[^'"]*['"];?/g, 'const D={ok(){},info(){},warn(){},err(){}};')
  .replace(/^let D\s*=.*$/m, ''));
const { detectCutoff, computeDistortion } = await import(pathToFileURL(tmp).href + '?v=' + Date.now());

const A = createAsserter();
const SR = 44100, NYQ = SR / 2, BINS = 1024, BINHZ = NYQ / BINS;
const freqs = Array.from({ length: BINS }, (_, i) => i * BINHZ);

/** 平顶 0dB 到 cutoffHz，之后降落到 rolloffDb；再叠 1kHz 音乐峰 */
function makeSpectrum(cutoffHz, rolloffDb) {
  const db = new Array(BINS).fill(0);
  for (let i = 0; i < BINS; i++) db[i] = freqs[i] <= cutoffHz ? 0 : rolloffDb;
  const k = Math.round(1000 / BINHZ);
  db[k] = 0; db[k - 1] = -3; db[k + 1] = -3; db[k - 2] = -12; db[k + 2] = -12;
  return db;
}

// ── 1. detectCutoff 必须吃 dB 谱 ──
console.log('=== 1) detectCutoff 对 dB 谱的准确性 ===');
console.log('真实截止   后段电平   报告值        误差      判定');
console.log('-'.repeat(56));
for (const cutoff of [6000, 8000, 11000, 15000, 18000]) {
  for (const roll of [-60, -80]) {
    const db = makeSpectrum(cutoff, roll);
    const r = detectCutoff(freqs, db, SR);
    const ok = r && r.freq >= cutoff * 0.8 && r.freq <= cutoff * 1.25;
    A.ok(ok, `截止 ${cutoff}Hz/后段 ${roll}dB：报告 ${r ? r.freq.toFixed(0) : 'null'}Hz，超出 ±20% 容差`);
    const err = r ? ((r.freq - cutoff) / cutoff * 100) : NaN;
    console.log(`${String(cutoff).padStart(7)}Hz ${String(roll).padStart(8)}dB ${String(r ? r.freq.toFixed(0) : '-').padStart(12)}Hz ${String(err.toFixed(1) + '%').padStart(9)}   ${ok ? '✅' : '❌'}`);
  }
}

// ── 2. 传线性幅度谱必然失败（这就是原 bug 的形态）──
console.log('\n=== 2) 反例：传线性幅度谱会导致检测失效 ===');
{
  const cutoff = 11000;
  const db = makeSpectrum(cutoff, -60);
  const linear = db.map(v => Math.pow(10, v / 20)); // 线性化后最大值 = 1
  const rDb = detectCutoff(freqs, db, SR);
  const rLin = detectCutoff(freqs, linear, SR);
  console.log(`  dB 谱   → ${rDb ? rDb.freq.toFixed(0) : 'null'}Hz  (期望 ~${cutoff}Hz)`);
  console.log(`  线性谱  → ${rLin ? rLin.freq.toFixed(0) : 'null'}Hz  (期望失效 → 奈奎斯特 ${NYQ}Hz)`);
  A.ok(rDb && Math.abs(rDb.freq - cutoff) / cutoff < 0.25, 'dB 谱应能正确检出截止');
  // 线性谱无法通过「噪底+15dB」判据，必然退化
  A.ok(!rLin || rLin.freq === NYQ || rLin.freq > cutoff * 1.5,
    `线性谱本应检测失效（这是原 bug 的形态），实际却报 ${rLin && rLin.freq.toFixed(0)}Hz`);
}

// ── 3. computeDistortion 必须吃 dB 谱 ──
console.log('\n=== 3) computeDistortion：纯正弦的 THD 应接近 0 ===');
{
  const secs = 2;
  const n = SR * secs;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = 0.8 * Math.sin(2 * Math.PI * 1000 * i / SR);

  // 构造该信号的 dB 谱：1kHz 处 0dB，其余 -100dB（含 2~5 次谐波位置）
  const spec = new Array(BINS).fill(-100);
  const k1 = Math.round(1000 / BINHZ);
  spec[k1] = 0; spec[k1 - 1] = -6; spec[k1 + 1] = -6;

  const r = computeDistortion(data, SR, freqs, spec);
  A.ok(!!r, 'computeDistortion 返回 null（基频未检出）');
  if (r) {
    console.log(`  thdPct=${r.thdPct}%, fundamentalHz=${r.fundamentalHz}, harmonics=${JSON.stringify(r.harmonics.map(v => +v.toFixed(1)))}`);
    A.ok(r.thdPct < 1, `纯正弦 THD 应接近 0%，实际 ${r.thdPct}%`);
    A.near(r.fundamentalHz, 1000, 100, '基频应被识别为 ~1000Hz');
  }

  // 反例：传线性谱会被压平，谐波与基频被压成同一量级。
  // 修复前这会产出「恒定偏高」的 THD（曾实测 178%）。
  // 引入「谐波须单调递减」的方法论门槛后，这种情况会被判为不可测量 ——
  // 这比报一个假数字更好，所以这里断言的是「不再给出误导性数值」。
  const linear = spec.map(v => Math.pow(10, v / 20));
  const rLin = computeDistortion(data, SR, freqs, linear);
  const linDesc = rLin === null ? 'null'
    : (rLin.unmeasurable ? `unmeasurable (${rLin.reason})` : `thdPct=${rLin.thdPct}%`);
  console.log(`  传入线性谱时 → ${linDesc}`);
  if (rLin) {
    A.ok(rLin.unmeasurable === true || rLin.thdPct < 1,
      `线性谱不应产出误导性 THD，实际 ${rLin.thdPct}%（unmeasurable=${rLin.unmeasurable}）`);
  }
}

// ── 4. 边界与健壮性 ──
console.log('\n=== 4) 边界与健壮性 ===');
{
  A.ok(detectCutoff([], [], SR) === null, '空输入应返回 null');
  A.ok(detectCutoff(freqs.slice(0, 5), new Array(5).fill(0), SR) === null, '数据不足应返回 null');
  const flat = new Array(BINS).fill(-60);
  const r = detectCutoff(freqs, flat, SR);
  A.ok(r && Number.isFinite(r.freq), '全平坦谱不应崩溃');
  console.log(`  空输入 → null ✅   全平坦谱 → ${r ? r.freq.toFixed(0) + 'Hz' : 'null'} ✅`);
}

try { fs.unlinkSync(tmp); } catch (_) {}
process.exit(A.report('截止频率 / THD 数据类型回归测试') ? 0 : 1);
