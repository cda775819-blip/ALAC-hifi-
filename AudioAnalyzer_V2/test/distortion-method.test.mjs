// ═══════════════════════════════════════════════════════════════
//  test/distortion-method.test.mjs — THD 方法适用性门槛回归测试
//
//  背景：computeDistortion 用「自相关估基频 → 平均频谱取 H2~H5」估算谐波失真。
//  该方法的成立前提是音频只有**单一基频**，物理依据是单音的谐波必然随阶数
//  单调递减（能量向高阶传递必然衰减）。
//
//  守护的 bug（真实修复过的）：
//   对复音素材，各阶"谐波格"落在不同乐器的能量上，排序任意。
//   实测某流行乐文件 H1=-12.3dB 而 H2=-9.9dB，比值算出 >100%，
//   被钳制到 100% 后显示为「失真极高」—— 实际是方法不适用。
//
//  修法：谐波不呈单调递减时返回 unmeasurable=true（而非给个数字），
//  宁可明说「测不了」，也不给会被误读的值。
//
//  跑法：node test/distortion-method.test.mjs
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAsserter } from './extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SR = 44100;
const BINS = 1024;
const BINHZ = (SR / 2) / BINS;
const freqs = Array.from({ length: BINS }, (_, i) => i * BINHZ);

const tmp = path.join(ROOT, `.tmp-distortion-${process.pid}.mjs`);
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, 'utils', 'audioMath.js'), 'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*logger[^'"]*['"];?/g, 'const D={ok(){},info(){},warn(){},err(){}};')
  .replace(/^let D\s*=.*$/m, ''));
const AM = await import(pathToFileURL(tmp).href + '?v=' + Date.now());

const A = createAsserter();

function tone(f, amp = 0.5, secs = 3) {
  const a = new Float32Array(SR * secs);
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(2 * Math.PI * f * i / SR);
  return a;
}

/**
 * 构造与给定音频匹配的频谱。
 *
 * 两个坑（都踩过）：
 *  1. 自相关估出的基频与名义频率常有偏差（实测 1000Hz→1002.3Hz、500Hz→501.1Hz），
 *     按名义频率摆放谐波会偏一格而读到噪声底。
 *  2. 实现是按「目标频率 → 找最近 bin」定位的，而 round(k0*h) 与它并不等价
 *     （k0=46.55 时前者给 47、后者给 46）。必须用同样的换算方式。
 *
 * 这里统一按 "从频率找最近 bin"，并在相邻格也放等量能量，
 * 使亚格偏差不会让谐波落到噪声底上。
 */
function specAtFundamental(f0Hz, harmonicDb) {
  const s = new Array(BINS).fill(-120);
  const nearest = (hz) => Math.max(0, Math.min(BINS - 1, Math.round(hz / BINHZ)));
  for (let h = 1; h <= harmonicDb.length; h++) {
    const db = harmonicDb[h - 1];
    const idx = nearest(f0Hz * h);
    for (const d of [-1, 0, 1]) {
      const j = idx + d;
      if (j >= 0 && j < BINS) s[j] = Math.max(s[j], db);
    }
  }
  return s;
}

/** 探测某个信号的真实基频估计值（复刻实现里的自相关法） */
function detectFundamental(data, minHz = 60, maxHz = 4000) {
  const autoLen = Math.min(data.length, 2 * SR);
  const corrLen = Math.min(autoLen, 4096);
  const corr = new Float32Array(corrLen);
  for (let lag = 0; lag < corrLen; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < autoLen; i++) sum += data[i] * data[i + lag];
    corr[lag] = sum;
  }
  let bestLag = 0, bestVal = -Infinity;
  const minLag = Math.floor(SR / maxHz), maxLag = Math.floor(SR / minHz);
  for (let lag = minLag; lag < Math.min(maxLag, corrLen); lag++) {
    if (corr[lag] > corr[lag - 1] && corr[lag] > corr[lag + 1] && corr[lag] > bestVal) {
      bestVal = corr[lag]; bestLag = lag;
    }
  }
  return bestLag > 0 ? SR / bestLag : 0;
}

// ── 1. 纯正弦（谐波单调递减）→ 应给出测量值 ──
console.log('=== 1) 纯正弦：谐波单调递减，应给出 THD ===');
{
  const data = tone(1000);
  const f0 = detectFundamental(data);
  const spec = specAtFundamental(f0, [0, -60, -70, -80, -90]);
  const r = AM.computeDistortion(data, SR, freqs, spec);
  A.ok(r !== null, `纯正弦不应返回 null（估计基频 ${f0.toFixed(1)}Hz）`);
  if (r) {
    A.ok(!r.unmeasurable, `纯正弦不应判为不可测量（原因: ${r.reason}）`);
    A.ok(!r.limitHit, '纯正弦不应触发 limitHit');
    A.ok(r.thdPct >= 0 && r.thdPct < 5, `纯正弦 THD 应在 0..5%，实际 ${r.thdPct}%`);
    // 纯音必须通过能量集中度门槛，否则新判据会把真纯音也拦掉
    A.ok(r.topBinEnergyPct !== null && r.topBinEnergyPct >= 30,
      `纯音能量集中度应 ≥30%，实际 ${r.topBinEnergyPct}%`);
    console.log(`  估计基频=${f0.toFixed(1)}Hz  thdPct=${r.thdPct}%  集中度=${r.topBinEnergyPct}%  unmeasurable=${r.unmeasurable}  ✅`);
  }
}

// ── 2. 复音素材（H2 强于 H1）→ 应判不可测量 ──
console.log('\n=== 2) 复音素材：H2 强于 H1，应判为不可测量 ===');
{
  const f0n = 174.3;
  const data = tone(f0n);
  const f0 = detectFundamental(data);
  // 复刻实测形态：H1 弱、H2 更强
  const spec = specAtFundamental(f0, [-12.3, -9.9, -18.5, -10.3, -16.4]);
  const r = AM.computeDistortion(data, SR, freqs, spec);
  A.ok(r !== null, '复音素材仍应返回对象（带 unmeasurable 标记）');
  if (r) {
    A.ok(r.unmeasurable === true, `应判为 unmeasurable，实际 ${r.unmeasurable}`);
    A.ok(typeof r.reason === 'string' && r.reason.length > 0, '应给出不可测量的原因');
    A.ok(r.thdPct === 0, `不可测量时 thdPct 应为 0（而非 100），实际 ${r.thdPct}`);
    A.ok(r.limitHit === true, 'limitHit 应同步为 true 以兼容既有 UI 判定');
    console.log(`  估计基频=${f0.toFixed(1)}Hz  unmeasurable=${r.unmeasurable}  thdPct=${r.thdPct}  reason="${r.reason}"  ✅`);
  }
}

// ── 3. 单调递减但频谱能量分散 → 仍应判不可测量（真实音乐文件的形态）──
console.log('\n=== 3) 谐波单调递减但无占主导单音 → 应判为不可测量 ===');
{
  // 复刻 E:\260917_2108.wav 的实测值：
  //   H1=-0.04dB、H2=-10.8、H3=-12.7、H4=-25.4、H5=-31.2 —— 完美单调递减，
  //   因此旧判据全部放行，算出 THD=37.7%，UI 显示「很高，有明显失真」。
  //   但该文件没有任何失真：它是以某个音为主的音乐，那把乐器的固有泛音
  //   （天然是基频的整数倍、天然单调递减）被当成了失真。
  // 区分「单音」与「音乐」的可靠物理量是能量集中度：
  //   纯音把全部能量放在 1 个格子里，音乐铺满整条频带
  //   （实测 96kHz/1024 格：1kHz 纯音 57.7% vs 该音乐 19.4%）。
  const data = tone(1000);
  const f0 = detectFundamental(data);
  const spec = specAtFundamental(f0, [-0.04, -10.81, -12.67, -25.40, -31.24]);
  const r = AM.computeDistortion(data, SR, freqs, spec);
  A.ok(r !== null, '应返回对象（带 unmeasurable 标记）');
  if (r) {
    // 先确认这个构造真的通过了旧判据 —— 否则新门槛根本没被测到
    const h = r.harmonics;
    const oldPass = h[0] >= Math.max(...h) - 0.5 && (h[0] - Math.max(...h.slice(1)) > 6);
    A.ok(oldPass, `构造应满足旧的单调递减判据（harmonics=${JSON.stringify(h)}）`);
    A.ok(r.unmeasurable === true,
      `谐波单调递减但能量分散时，应判为不可测量，实际 unmeasurable=${r.unmeasurable}（thdPct=${r.thdPct}）`);
    A.ok(r.thdPct === 0, `不可测量时 thdPct 应为 0，实际 ${r.thdPct}`);
    A.ok(r.topBinEnergyPct !== null && r.topBinEnergyPct < 30,
      `应报告能量集中度且 <30%，实际 ${r.topBinEnergyPct}%`);
    A.ok(typeof r.reason === 'string' && /能量分散/.test(r.reason),
      `原因应说明能量分散，实际 "${r.reason}"`);
    console.log(`  harmonics=${JSON.stringify(h)}`);
    console.log(`  集中度=${r.topBinEnergyPct}%  unmeasurable=${r.unmeasurable}  ${r.unmeasurable ? '✅' : '❌'}  reason="${r.reason}"`);
  }
}

// ── 4. 谐波中途回升 → 也应判不可测量 ──
console.log('\n=== 4) 谐波中途回升（非单调）→ 应判为不可测量 ===');
{
  const data = tone(500);
  const f0 = detectFundamental(data);
  const spec = specAtFundamental(f0, [0, -30, -20, -40, -50]);   // H3 比 H2 高 10dB
  const r = AM.computeDistortion(data, SR, freqs, spec);
  A.ok(r !== null, '应返回对象');
  if (r) {
    A.ok(r.unmeasurable === true, `H1 最强但谐波回升，应判为不可测量，实际 ${r.unmeasurable}（harmonics=${JSON.stringify(r.harmonics)}）`);
    console.log(`  估计基频=${f0.toFixed(1)}Hz  unmeasurable=${r.unmeasurable}  reason="${r.reason}"  ${r.unmeasurable ? '✅' : '❌'}`);
  }
}

// ── 5. 基频落在噪声底（比谱峰低 40dB 以上）→ 返回 null ──
console.log('\n=== 5) 基频格无能量 → 应返回 null ===');
{
  const data = tone(1000);
  const spec = new Array(BINS).fill(-120);
  spec[Math.round(3000 / BINHZ)] = 0;    // 谱峰在 3kHz，基频 1kHz 处是噪底
  const r = AM.computeDistortion(data, SR, freqs, spec);
  A.ok(r === null, `基频未检出时应返回 null，实际 ${JSON.stringify(r)}`);
  console.log(`  返回 ${r === null ? 'null ✅' : JSON.stringify(r) + ' ❌'}`);
}

// ── 6. 数据不足 / 异常输入 ──
console.log('\n=== 6) 边界与健壮性 ===');
{
  A.ok(AM.computeDistortion(new Float32Array(1000), SR, freqs.slice(0, 5), new Array(5).fill(0)) === null,
    '频谱数据不足应返回 null');
  A.ok(AM.computeDistortion(null, SR, freqs, new Array(BINS).fill(-60)) === null, 'null 输入应返回 null');
  A.ok(AM.computeDistortion(tone(440), SR, null, null) === null, 'freqs/spectrum 为 null 应返回 null');
  console.log('  频谱不足 / null 输入 → 均返回 null ✅');
}

// ── 7. 关键不变量：任何情况下都不再报出误导性的 100% ──
console.log('\n=== 7) 关键不变量：非单音素材绝不报出数值 ===');
{
  const cases = [
    ['H2>H1',   200, [-12, -9, -18, -10, -16]],
    ['全等幅',   300, [-30, -30, -30, -30, -30]],
    ['递增',     400, [-50, -40, -30, -20, -10]],
    ['平坦尾',   250, [0, -20, -40, -39, -41]],
  ];
  for (const [label, f0n, db] of cases) {
    const data = tone(f0n);
    const f0 = detectFundamental(data);
    const spec = specAtFundamental(f0, db);
    const r = AM.computeDistortion(data, SR, freqs, spec);
    // 核心断言：要么判为不可测量，要么给出的值必须合理（<100%）
    const misleading = r && !r.unmeasurable && r.thdPct >= 100;
    A.ok(!misleading, `${label}: 报出了 ${r && r.thdPct}% 这种误导值`);
    // 非单调的素材必须被拦下
    const nonMonotonic = label === 'H2>H1' || label === '递增';
    if (nonMonotonic) {
      A.ok(r === null || r.unmeasurable === true,
        `${label}: 非单调谐波应判为不可测量，实际 unmeasurable=${r && r.unmeasurable}`);
    }
    console.log(`  ${label.padEnd(8)} → ${r === null ? 'null' : `unmeasurable=${r.unmeasurable} thdPct=${r.thdPct}`}  ${misleading ? '❌' : '✅'}`);
  }
}

try { fs.unlinkSync(tmp); } catch (_) {}
process.exit(A.report('THD 方法适用性门槛回归测试') ? 0 : 1);
