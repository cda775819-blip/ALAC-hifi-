// ═══════════════════════════════════════════════════════════════
//  test/worker.test.mjs — Worker 分片统计回归测试
//
//  守护的 bug（真实修复过的）：
//   1. 逐采样统计（peak/RMS/DC/削波）被写在 50% 重叠的 FFT 帧循环里，
//      导致每个采样点被统计两次 —— 削波计数正好翻倍
//   2. sampleCount 与实际统计口径不一致，reduceResults 加权会歪
//   3. stereoCorrelation 用 1 - sideRMS/midRMS 宽度启发式代替真正的
//      归一化互相关系数，恒为非负，反相音频会被误判为正常
//
//  跑法：node test/worker.test.mjs
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAsserter } from './extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(__dirname, '..', 'worker', 'analyze.worker.js');

// worker 文件用 self.onmessage / self.postMessage，在 Node 里换成全局桩后导出函数
const wsrc = fs.readFileSync(WORKER, 'utf8');
const tmpPath = path.resolve(__dirname, `..`, `.tmp-worker-${process.pid}.mjs`);
fs.writeFileSync(tmpPath,
  'const self = { onmessage: null, postMessage: null };\n'
  + wsrc.replace(/self\.postMessage\(/g, 'globalThis.__post(')
  + '\nexport { analyzeChunk };\n');
const { analyzeChunk } = await import(pathToFileURL(tmpPath).href);

const A = createAsserter();
const SR = 44100;
const CLIP = 0.999;

function signal(kind, secs = 5) {
  const n = SR * secs;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (kind === 'sine') { const v = 0.5 * Math.sin(2 * Math.PI * 1000 * t); L[i] = v; R[i] = v; }
    else if (kind === 'inphase') { L[i] = R[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t); }
    else if (kind === 'antiphase') { L[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t); R[i] = -L[i]; }
    else if (kind === 'uncorrelated') { L[i] = 0.4 * (Math.random() * 2 - 1); R[i] = 0.4 * (Math.random() * 2 - 1); }
    else if (kind === 'silence') { L[i] = R[i] = 0; }
    else if (kind === 'dc') { L[i] = R[i] = 0.25; }
    else if (kind === 'clip') {
      const v = Math.max(-CLIP, Math.min(CLIP, 2.0 * Math.sin(2 * Math.PI * 220 * t)));
      L[i] = v; R[i] = v;
    } else if (kind === 'leftOnly') { L[i] = 0.5 * Math.sin(2 * Math.PI * 500 * t); R[i] = 0; }
  }
  return [L, R];
}

// 独立真值：直接逐样本算，不复用被测实现的任何逻辑
function truth(channels) {
  const len = channels[0].length;
  let peak = 0, clip = 0, dcSum = 0, sq = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(channels[0][i]);
    if (a > peak) peak = a;
    if (a >= CLIP) clip++;
    dcSum += channels[0][i];
    sq += channels[0][i] * channels[0][i];
  }
  for (let c = 1; c < channels.length; c++) {
    for (let i = 0; i < len; i++) {
      const a = Math.abs(channels[c][i]);
      if (a > peak) peak = a;
      if (a >= CLIP) clip++;
    }
  }
  return { peak, rms: Math.sqrt(sq / len), dcOffset: dcSum / len, clippedSamples: clip };
}

// ── 1. 逐采样统计与真值一致 ──
console.log('=== 1) 逐采样统计 vs 独立真值 ===');
console.log('信号          指标        真值            worker         判定');
console.log('-'.repeat(66));
for (const kind of ['sine', 'dc', 'clip', 'silence']) {
  const ch = signal(kind);
  const t = truth(ch);
  const r = analyzeChunk(ch, SR);
  const rows = [
    ['peak', t.peak, r.peak, 1e-6],
    ['rms', t.rms, r.rms, 1e-6],
    ['dcOffset', t.dcOffset, r.dcOffset, 1e-6],
    ['clippedSamples', t.clippedSamples, r.clippedSamples, 0],
  ];
  for (const [name, tv, rv, tol] of rows) {
    const good = Math.abs(tv - rv) <= tol;
    A.ok(good, `${kind}.${name}: worker=${rv}, 真值=${tv}`);
    // 削波翻倍是本测试要守护的核心回归点
    if (name === 'clippedSamples' && kind === 'clip') {
      A.ok(rv === tv, `削波计数翻倍回归！worker=${rv}, 真值=${tv}（重叠帧循环重复统计）`);
    }
    console.log(`${kind.padEnd(13)} ${name.padEnd(11)} ${String(tv).padEnd(14)} ${String(rv).padEnd(14)} ${good ? '✅' : '❌'}`);
  }
}

// ── 2. sampleCount 口径 ──
console.log('\n=== 2) sampleCount 与实际统计口径一致 ===');
{
  const ch = signal('sine', 5);
  const r = analyzeChunk(ch, SR);
  A.ok(r.sampleCount === ch[0].length, `sampleCount=${r.sampleCount} 应等于样本数 ${ch[0].length}`);
  A.ok(r.numFrames > 0, 'numFrames 应为正');
  // 统计口径按 len 归一，因此 RMS 应独立于 FFT 帧数
  const r2 = analyzeChunk([ch[0].slice(0, ch[0].length - 1000), ch[1].slice(0, ch[1].length - 1000)], SR);
  A.near(r2.rms, r.rms, 0.01, '截断 1000 样本后 RMS 不应显著变化（说明未被 FFT 帧数影响）');
  console.log(`  sampleCount=${r.sampleCount}, numFrames=${r.numFrames}, spectrum.length=${r.spectrum.length}`);
}

// ── 3. 立体声相关度 ──
console.log('\n=== 3) stereoCorrelation 应为归一化互相关系数 ===');
{
  const cases = [
    ['inphase', 1, '同相应为 +1'],
    ['antiphase', -1, '反相应为 -1（旧实现恒为非负，会漏判）'],
    ['silence', 0, '静音应回退 0'],
  ];
  for (const [kind, expect, desc] of cases) {
    const r = analyzeChunk(signal(kind), SR);
    const got = r.stereoCorrelation;
    const good = Math.abs(got - expect) <= 0.02;
    A.ok(good, `${kind}: stereoCorrelation=${got}，期望 ${expect} —— ${desc}`);
    console.log(`  ${kind.padEnd(12)} ${String(got).padEnd(10)} 期望 ${String(expect).padEnd(5)} ${good ? '✅' : '❌'}  ${desc}`);
  }
  // 不相关信号：相关度应接近 0（绝对值小）
  const ru = analyzeChunk(signal('uncorrelated'), SR);
  A.ok(Math.abs(ru.stereoCorrelation) < 0.05, `不相关信号相关度 ${ru.stereoCorrelation} 应接近 0`);
  console.log(`  uncorrelated ${ru.stereoCorrelation.toFixed(4)}   期望 ~0    ${Math.abs(ru.stereoCorrelation) < 0.05 ? '✅' : '❌'}  随机左右声道`);
  // 只有左声道：相关度应为 0（R 全零 → 分母 0 → 回退 0）
  const rl = analyzeChunk(signal('leftOnly'), SR);
  A.ok(Number.isFinite(rl.stereoCorrelation), `leftOnly 相关度非有限: ${rl.stereoCorrelation}`);
  console.log(`  leftOnly     ${rl.stereoCorrelation}         有限值     ${Number.isFinite(rl.stereoCorrelation) ? '✅' : '❌'}  R 全零`);
}

// ── 4. 频谱 bin 与频率轴自洽 ──
console.log('\n=== 4) 频谱：bin↔Hz 口径与渲染层一致 ===');
{
  const FFT_SIZE = 2048, SPECTRUM_BINS = FFT_SIZE / 2;
  const r = analyzeChunk(signal('sine', 5), SR);
  // 不变式：格数必须等于 FFT_SIZE/2，否则渲染层的 i/n*sr/2 会整体缩放错位
  A.ok(r.spectrum.length === FFT_SIZE / 2,
    `spectrum.length=${r.spectrum.length} 应等于 FFT_SIZE/2=${FFT_SIZE / 2}（渲染层频率轴依赖此不变式）`);
  A.ok(r.spectrum.length === SPECTRUM_BINS, 'spectrum.length 应与 SPECTRUM_BINS 一致');
  // 覆盖到奈奎斯特：最后一格应接近 sr/2
  const axisMax = (r.spectrum.length - 1) * SR / FFT_SIZE;
  A.near(axisMax, SR / 2, SR / FFT_SIZE, `频率轴上界应接近奈奎斯特 ${SR / 2}Hz`);

  let mi = 0;
  for (let i = 1; i < r.spectrum.length; i++) if (r.spectrum[i] > r.spectrum[mi]) mi = i;
  // spectrum[b] 对应 FFT bin b → 频率 = b * sr / FFT_SIZE
  const binHz = SR / FFT_SIZE;
  const gotHz = mi * binHz;
  const good = Math.abs(gotHz - 1000) < 40;
  A.ok(good, `1kHz 正弦的频谱峰值在 bin ${mi} = ${gotHz.toFixed(0)}Hz，期望 ~1000Hz（binHz=${binHz.toFixed(2)}）`);
  console.log(`  峰值 bin=${mi} → ${gotHz.toFixed(0)}Hz  (期望 1000Hz, binHz=${binHz.toFixed(2)})  ${good ? '✅' : '❌'}`);
  A.ok(r.spectrum.every(v => Number.isFinite(v) && v >= 0), 'spectrum 含非法值');
}

// ── 5. 多声道峰值 ──
console.log('\n=== 5) 多声道峰值应取全声道最大 ===');
{
  const n = 1000;
  const L = new Float32Array(n).fill(0.1);
  const R = new Float32Array(n).fill(0.9);
  const r = analyzeChunk([L, R], SR);
  A.near(r.peak, 0.9, 1e-6, `峰值应取 R 声道的 0.9，实际 ${r.peak}`);
  console.log(`  峰值 = ${r.peak}  期望 0.9  ${Math.abs(r.peak - 0.9) < 1e-6 ? '✅' : '❌'}`);
}

try { fs.unlinkSync(tmpPath); } catch (_) {}
process.exit(A.report('Worker 分片统计回归测试') ? 0 : 1);
