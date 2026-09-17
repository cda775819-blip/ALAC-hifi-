// ═══════════════════════════════════════════════════════════════
//  test/kweighting.test.mjs — K-weighting 滤波器精度回归
//
//  守护的 bug（真实修复过的）：
//   1. 高架滤波器的 b1 用了「低架」的形式
//      （2A·((A−1)−(A+1)cos) 而非 −2A·((A−1)+(A+1)cos)），
//      导致滤波器变成「低频 +4dB、高频 0dB」——与预期完全相反，
//      K-weighting 整体抬高 3.3dB，LUFS 长期偏高。
//   2. RLB 高通用 38Hz / Butterworth Q，官方的正确参数是 f0≈38.9Hz / Q=0.5，
//      低频段（20-100Hz）原本偏差达 +2.5dB，重低音素材 LUFS 被高估 2-3dB。
//   3. 额外插了一级 preEmphasis 一阶高通（BS.1770 中没有这一级），
//      1kHz 偏低 13.6dB、100Hz 偏低 27.6dB。
//
//  验证方式：以官方 BS.1770-4 公布的 48kHz 数字系数为真值，
//  用解析法（传递函数）算参考频响，与实现做时域扫频实测对比。
//
//  跑法：node test/kweighting.test.mjs
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAsserter } from './extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 48000;

// ITU-R BS.1770-4 官方 48kHz 数字系数（真值基准）
const OFF_SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] };
const OFF_RLB   = { b: [1.0, -2.0, 1.0], a: [1, -1.99004745483398, 0.99007225036621] };

const tmp = path.join(ROOT, `.tmp-kw-${process.pid}.mjs`);
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, 'utils', 'audioMath.js'), 'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*logger[^'"]*['"];?/g, 'const D={ok(){},info(){},warn(){},err(){}};')
  .replace(/^let D\s*=.*$/m, '')
  + '\nexport { rlbHighPass, highShelfFilter };\n');
const m = await import(pathToFileURL(tmp).href + '?v=' + Date.now());

const A = createAsserter();

/** 官方系数的解析频响 */
function officialDb(f, sr = SR) {
  const one = (co) => {
    const w = 2 * Math.PI * f / sr;
    const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nRe = co.b[0] + co.b[1] * cw + co.b[2] * c2, nIm = -(co.b[1] * sw + co.b[2] * s2);
    const dRe = co.a[0] + co.a[1] * cw + co.a[2] * c2, dIm = -(co.a[1] * sw + co.a[2] * s2);
    return Math.hypot(nRe, nIm) / Math.hypot(dRe, dIm);
  };
  return 20 * Math.log10(one(OFF_RLB) * one(OFF_SHELF));
}

/** 实现的时域扫频实测 */
function implDb(f) {
  const N = SR * 6;
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / SR);
  const y = m.highShelfFilter(m.rlbHighPass(x, SR), SR);
  const half = N >> 1;
  let sx = 0, sy = 0;
  for (let i = half; i < N; i++) { sx += x[i] * x[i]; sy += y[i] * y[i]; }
  return 20 * Math.log10(Math.sqrt(sy / half) / Math.sqrt(sx / half));
}

// ── 1. 频响与官方一致 ──
console.log('=== 1) K-weighting 频响：实现 vs 官方 BS.1770-4 系数 ===');
console.log('频率      官方       实现       偏差     判定');
console.log('-'.repeat(52));
const probes = [20, 30, 40, 50, 60, 80, 100, 200, 500, 1000, 2000, 5000, 10000];
let maxAbove200 = 0, maxAbove40 = 0;
for (const f of probes) {
  const off = officialDb(f), imp = implDb(f), dev = imp - off;
  if (f >= 200) maxAbove200 = Math.max(maxAbove200, Math.abs(dev));
  if (f >= 40) maxAbove40 = Math.max(maxAbove40, Math.abs(dev));
  const good = f >= 200 ? Math.abs(dev) < 0.1 : Math.abs(dev) < 0.35;
  A.ok(good, `${f}Hz 偏差 ${dev.toFixed(3)}dB 超出容差（官方 ${off.toFixed(3)}，实现 ${imp.toFixed(3)}）`);
  console.log(`${String(f).padStart(6)}Hz ${off.toFixed(3).padStart(9)} ${imp.toFixed(3).padStart(10)} ${((dev>0?'+':'')+dev.toFixed(3)).padStart(9)}   ${good ? '✅' : '❌'}`);
}
console.log(`\n200Hz 以上最大偏差 = ${maxAbove200.toFixed(3)} dB   (要求 < 0.1)`);
console.log(`40Hz 以上最大偏差  = ${maxAbove40.toFixed(3)} dB   (要求 < 0.35)`);

// ── 2. 关键频点语义 ──
console.log('\n=== 2) 关键频点的语义正确性 ===');
{
  const g10k = implDb(10000), g1k = implDb(1000), g50 = implDb(50);
  A.near(g10k, 4.0, 0.1, '10kHz 应约 +4dB（高架抬升）');
  A.near(g1k, 0.7, 0.15, '1kHz 应约 +0.7dB');
  A.ok(g50 < -3.5, `50Hz 应低于 -3.5dB（RLB 高通生效），实际 ${g50.toFixed(3)}`);
  console.log(`  10kHz = ${g10k.toFixed(3)}dB (期望 ~+4.0)  ${Math.abs(g10k-4)<0.1?'✅':'❌'}`);
  console.log(`   1kHz = ${g1k.toFixed(3)}dB (期望 ~+0.70) ${Math.abs(g1k-0.7)<0.15?'✅':'❌'}`);
  console.log(`    50Hz = ${g50.toFixed(3)}dB (期望 <-3.5) ${g50<-3.5?'✅':'❌'}`);
}

// ── 3. 逆向检查：高架必须是「高频抬升」而非「低频抬升」──
console.log('\n=== 3) 高架滤波器方向（防低架回归）===');
{
  const s10k = (() => {
    const N = SR * 6, x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 10000 * i / SR);
    const y = m.highShelfFilter(x, SR);
    const h = N >> 1; let sx = 0, sy = 0;
    for (let i = h; i < N; i++) { sx += x[i]*x[i]; sy += y[i]*y[i]; }
    return 20 * Math.log10(Math.sqrt(sy/h)/Math.sqrt(sx/h));
  })();
  const s20 = (() => {
    const N = SR * 6, x = new Float32Array(N);
    for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 20 * i / SR);
    const y = m.highShelfFilter(x, SR);
    const h = N >> 1; let sx = 0, sy = 0;
    for (let i = h; i < N; i++) { sx += x[i]*x[i]; sy += y[i]*y[i]; }
    return 20 * Math.log10(Math.sqrt(sy/h)/Math.sqrt(sx/h));
  })();
  A.ok(Math.abs(s20) < 0.1, `高架在 20Hz 应 0dB（不抬低频），实际 ${s20.toFixed(3)}`);
  A.near(s10k, 4.0, 0.1, '高架在 10kHz 应 +4dB');
  console.log(`  高架 @20Hz  = ${s20.toFixed(3)}dB (期望 ~0)    ${Math.abs(s20)<0.1?'✅':'❌'}`);
  console.log(`  高架 @10kHz = ${s10k.toFixed(3)}dB (期望 ~+4)   ${Math.abs(s10k-4)<0.1?'✅':'❌'}`);
  console.log('  （若两者颠倒，说明又退回成「低架」，LUFS 会整体偏差 3.3dB）');
}

// ── 4. LUFS 端到端误差 ──
console.log('\n=== 4) LUFS 端到端：实现 vs 官方系数链 ===');
{
  const runBiquad = (data, b, A1, A2) => {
    const out = new Float32Array(data.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i];
      const y0 = b[0]*x0 + b[1]*x1 + b[2]*x2 - A1*y1 - A2*y2;
      out[i] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    }
    return out;
  };
  // 官方系数为标准写法 y = b0x+...+a1y1+a2y2，内部约定为减去 a → 直接传入 a[1],a[2]
  const refKW = (d) => runBiquad(runBiquad(d, OFF_RLB.b, OFF_RLB.a[1], OFF_RLB.a[2]), OFF_SHELF.b, OFF_SHELF.a[1], OFF_SHELF.a[2]);
  const impKW = (d) => m.highShelfFilter(m.rlbHighPass(d, SR), SR);

  const lufsOf = (kw) => {
    const block = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
    const sq = new Float32Array(kw.length);
    for (let i = 0; i < kw.length; i++) sq[i] = kw[i] * kw[i];
    if (!sq.every(Number.isFinite)) return null;      // 链发散保护
    const ms = [];
    for (let s = 0; s + block <= kw.length; s += hop) {
      let sum = 0; for (let i = s; i < s + block; i++) sum += sq[i];
      ms.push(sum / block);
    }
    const g1 = ms.filter(v => v >= 1e-7);
    if (!g1.length) return null;
    const mean1 = g1.reduce((a, b) => a + b, 0) / g1.length;
    const g2 = g1.filter(v => v >= mean1 * 0.1);
    const p = (g2.length ? g2 : g1).reduce((a, b) => a + b, 0) / (g2.length || g1.length);
    return -0.691 + 10 * Math.log10(Math.max(p, 1e-12));
  };

  const signals = {
    '1kHz正弦': (n) => { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=0.5*Math.sin(2*Math.PI*1000*i/SR); return a; },
    '60Hz低音': (n) => { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=0.5*Math.sin(2*Math.PI*60*i/SR); return a; },
    '40Hz极低音': (n) => { const a = new Float32Array(n); for (let i=0;i<n;i++) a[i]=0.5*Math.sin(2*Math.PI*40*i/SR); return a; },
    '多音音乐': (n) => { const a = new Float32Array(n);
      for (let i=0;i<n;i++){const t=i/SR;
        a[i]=0.35*Math.sin(2*Math.PI*60*t)+0.2*Math.sin(2*Math.PI*180*t)+0.15*Math.sin(2*Math.PI*700*t)+0.1*Math.sin(2*Math.PI*3000*t)+0.05*Math.sin(2*Math.PI*9000*t);} return a; },
  };

  console.log('信号          官方LUFS   实现LUFS    偏差');
  console.log('-'.repeat(46));
  let maxDev = 0;
  for (const [name, gen] of Object.entries(signals)) {
    const d = gen(SR * 6);
    const ref = lufsOf(refKW(d)), imp = lufsOf(impKW(d));
    A.ok(ref !== null && imp !== null, `${name}: LUFS 计算返回 null（链发散？）`);
    if (ref === null || imp === null) continue;
    const dev = imp - ref;
    maxDev = Math.max(maxDev, Math.abs(dev));
    console.log(`${name.padEnd(12)} ${ref.toFixed(3).padStart(8)} ${imp.toFixed(3).padStart(10)} ${((dev>0?'+':'')+dev.toFixed(3)).padStart(8)}`);
  }
  A.ok(maxDev < 0.5, `LUFS 最大偏差 ${maxDev.toFixed(3)}dB 应 < 0.5dB`);
  console.log(`\n最大偏差 = ${maxDev.toFixed(3)} dB  ${maxDev < 0.5 ? '✅' : '❌'}`);
  console.log('（修复前：1kHz 偏低 13.6dB；加预加重后 100Hz 偏低 27.6dB）');
}

try { fs.unlinkSync(tmp); } catch (_) {}
process.exit(A.report('K-weighting 滤波器精度回归') ? 0 : 1);
