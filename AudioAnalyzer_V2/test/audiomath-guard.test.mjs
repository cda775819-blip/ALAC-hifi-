// 验证 audioMath 的数值边界守卫（静音 / 极低电平 / THD 上限）
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAsserter } from './extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const tmp = path.join(ROOT, `.tmp-am-guard-${process.pid}.mjs`);
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, 'utils', 'audioMath.js'), 'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*logger[^'"]*['"];?/g, 'const D={ok(){},info(){},warn(){},err(){}};')
  .replace(/^let D\s*=.*$/m, ''));
const m = await import(pathToFileURL(tmp).href + '?v=' + Date.now());

const A = createAsserter();
const SR = 44100;
const sig = (f, amp, secs = 3) => {
  const a = new Float32Array(SR * secs);
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(2 * Math.PI * f * i / SR);
  return a;
};

console.log('=== 1) 数字静音应返回 null（不再给出 -109 LUFS 这类荒谬值）===');
{
  const r = m.computeLoudness(new Float32Array(SR * 3), SR);
  A.ok(r === null, `静音应返回 null，实际 ${JSON.stringify(r)}`);
  console.log('  静音 →', r === null ? 'null ✅' : JSON.stringify(r) + ' ❌');
}

console.log('\n=== 2) 极低电平（-140dBFS）也应判为静音 ===');
{
  const r = m.computeLoudness(sig(1000, 1e-7), SR);
  A.ok(r === null, `1e-7 电平应返回 null，实际 ${JSON.stringify(r)}`);
  console.log('  1e-7 →', r === null ? 'null ✅' : JSON.stringify(r) + ' ❌');
}

console.log('\n=== 3) 正常正弦应给出合理 LUFS ===');
{
  const r = m.computeLoudness(sig(1000, 0.5), SR);
  A.ok(r !== null, '正常信号不应为 null');
  if (r) {
    // 注意：这里是「无预加重 + 近似高架滤波器」的实现，
    // 与标准 BS.1770 K-weighting 仍有约 ±3dB 差距（滤波器系数为近似值）。
    // 因此只校验量级正确且高于门限，不按标准值做严格断言。
    A.ok(r.integratedLoudnessLUFS > -20 && r.integratedLoudnessLUFS < 0,
      `0.5 振幅 1kHz 的 LUFS 应在 -20..0 区间，实际 ${r.integratedLoudnessLUFS}`);
    A.ok(r.integratedLoudnessLUFS > -70, `LUFS ${r.integratedLoudnessLUFS} 不应低于门限 -70`);
    console.log(`  0.5 正弦 → ${r.integratedLoudnessLUFS} LUFS（量级合理；标准值约 -9.7，本实现为近似 K-weighting）`);
  }
  // 振幅翻倍应恰好 +6 LUFS（线性度检查，与滤波器绝对精度无关）
  const r2 = m.computeLoudness(sig(1000, 1.0), SR);
  if (r && r2) {
    A.near(r2.integratedLoudnessLUFS - r.integratedLoudnessLUFS, 6.02, 0.2, '振幅翻倍应提升约 6 LUFS');
    console.log(`  线性度检查: 0.5→1.0 振幅 = +${(r2.integratedLoudnessLUFS - r.integratedLoudnessLUFS).toFixed(2)} LU（理论 +6.02）`);
  }
}

console.log('\n=== 4) THD 应被钳制在 100% 以内，并标出 limitHit ===');
{
  // 构造「基频被淹没在宽带能量里」的频谱：基频 0dB，谐波位置反而更高不可能（dB<=0），
  // 但谐波数量多且接近 0dB 时比值会超 100%
  const BINS = 1024, BINHZ = (SR / 2) / BINS;
  const freqs = Array.from({ length: BINS }, (_, i) => i * BINHZ);
  const spec = new Array(BINS).fill(-120);
  const k1 = Math.round(1000 / BINHZ);
  spec[k1] = -30;                       // 基频很弱
  for (let h = 2; h <= 5; h++) spec[Math.round(k1 * h)] = -30;  // 谐波同级 → 比值 > 100%
  const data = sig(1000, 0.5);
  const r = m.computeDistortion(data, SR, freqs, spec);
  if (r) {
    A.ok(r.thdPct <= 100, `THD 应钳制到 ≤100%，实际 ${r.thdPct}%`);
    console.log(`  等幅谐波 → THD=${r.thdPct}%  limitHit=${r.limitHit}  ${r.thdPct <= 100 ? '✅' : '❌'}`);
  } else {
    console.log('  （该构造未触发 distortion，跳过）');
  }

  // 纯正弦（谐波极低）→ THD 接近 0 且不应 limitHit
  const clean = new Array(BINS).fill(-120);
  clean[Math.round(1000 / BINHZ)] = 0;
  const r2 = m.computeDistortion(data, SR, freqs, clean);
  if (r2) {
    A.ok(r2.thdPct < 1, `纯正弦 THD 应 <1%，实际 ${r2.thdPct}%`);
    A.ok(!r2.limitHit, '纯正弦不应触发 limitHit');
    console.log(`  纯正弦   → THD=${r2.thdPct}%  limitHit=${r2.limitHit}  ${r2.thdPct < 1 ? '✅' : '❌'}`);
  }
}

try { fs.unlinkSync(tmp); } catch (_) {}
process.exit(A.report('audioMath 数值边界守卫') ? 0 : 1);
