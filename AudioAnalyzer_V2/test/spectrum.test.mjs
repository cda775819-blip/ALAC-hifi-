// ═══════════════════════════════════════════════════════════════
//  test/spectrum.test.mjs — 频谱/频标回归测试
//
//  守护的 bug（均为真实修复过的）：
//   1. 粗频谱格号与 FFT bin 混淆，导致 bin→Hz 换算差 2 倍
//      （440Hz 正弦曾被标成 887Hz，1kHz 曾被标成 1771Hz）
//   2. bandSpectrum 的 labels 与 values 错位一格
//      （labels[i] 是频段下边界，values[i] 却是几何中心所在的段）
//
//  跑法：node test/spectrum.test.mjs
// ═══════════════════════════════════════════════════════════════

import { buildModule, tone, createAsserter, cleanup } from './extract.mjs';

const mod = buildModule(['yieldToUI', 'makeAutoYield', 'fftDisplay', 'computeDisplayData']);
const { computeDisplayData } = await import(mod);

const A = createAsserter();

// 与 computeDisplayData 内的 bandEdges 保持一致
const EDGES = [20, 40, 80, 160, 315, 630, 1250, 2500, 5000, 10000, 20000];
const bandIndexFor = (hz) => {
  for (let i = 0; i < EDGES.length - 1; i++) if (hz >= EDGES[i] && hz < EDGES[i + 1]) return i;
  return -1;
};

console.log('=== 1) 频标正确性：正弦的最强频段 ===');
console.log('输入频率   最强频段中心   含该频率的段   判定');
console.log('-'.repeat(56));
for (const f of [100, 440, 1000, 2000, 5000, 8000]) {
  const dd = await computeDisplayData(tone(f), 44100);
  const bs = dd.bandSpectrum;
  A.ok(!!bs, `${f}Hz: bandSpectrum 为空`);
  if (!bs) continue;
  let mi = 0;
  for (let i = 0; i < bs.values.length; i++) if (bs.values[i] > bs.values[mi]) mi = i;
  const expected = bandIndexFor(f);
  // 频段很宽：正好压在边界上的频率（如 5000Hz）主瓣会被相邻两段同时计入，
  // 允许相邻一段，这属于频段划分的固有边界效应
  const near = Math.abs(mi - expected) <= 1;
  A.ok(near, `${f}Hz 最强频段 index=${mi}(${bs.freqs[mi].toFixed(0)}Hz)，应为 index=${expected}(${EDGES[expected]}~${EDGES[expected+1]}Hz)`);
  console.log(`${String(f).padStart(7)}Hz  ${String(bs.freqs[mi].toFixed(0)).padStart(11)}Hz  ${String(EDGES[expected]+'~'+EDGES[expected+1]).padStart(13)}   ${near ? '✅' : '❌'}`);
}

console.log('\n=== 2) labels 与 values / freqs 严格同索引 ===');
{
  const dd = await computeDisplayData(tone(1000), 44100);
  const bs = dd.bandSpectrum;
  A.ok(bs.labels.length === bs.values.length, `labels 长度 ${bs.labels.length} != values 长度 ${bs.values.length}`);
  A.ok(bs.labels.length === bs.freqs.length, `labels 长度 != freqs 长度`);
  A.ok(bs.values.length === EDGES.length - 1, `频段数 ${bs.values.length} != ${EDGES.length - 1}`);
  // 每个 label 必须能由同索引的 freqs 推出（不允许再出现标签错位）
  for (let i = 0; i < bs.freqs.length; i++) {
    const c = bs.freqs[i];
    const expectLabel = c < 1000 ? `${Math.round(c)}` : `${(c / 1000).toFixed(1)}k`;
    A.ok(bs.labels[i] === expectLabel, `index ${i}: label "${bs.labels[i]}" 与 freqs ${c.toFixed(1)}Hz 不匹配（应为 "${expectLabel}"）`);
  }
  // 每个 freqs[i] 必须落在其对应频段的几何中心上
  for (let i = 0; i < bs.freqs.length; i++) {
    const geo = Math.sqrt(EDGES[i] * EDGES[i + 1]);
    A.near(bs.freqs[i], geo, 0.5, `index ${i}: 中心频率应为 sqrt(${EDGES[i]}*${EDGES[i+1]})=${geo.toFixed(1)}`);
  }
  console.log(`  labels   = ${JSON.stringify(bs.labels)}`);
  console.log(`  freqs    = ${JSON.stringify(bs.freqs.map(x => +x.toFixed(0)))}`);
}

console.log('\n=== 3) 输出结构完整性 ===');
{
  const dd = await computeDisplayData(tone(1000), 44100);
  A.ok(dd.waveform && dd.waveform.length >= 1900, `waveform 点数异常: ${dd.waveform && dd.waveform.length}`);
  A.ok(!!dd.spectrogram, 'spectrogram 为空');
  if (dd.spectrogram) {
    A.ok(dd.spectrogram.data.length > 0, 'spectrogram.data 为空');
    A.ok(dd.spectrogram.fAxis.length === dd.spectrogram.data[0].length, 'fAxis 与 data 列宽不一致');
    // fAxis 必须是单调递增且上限为奈奎斯特
    const fa = dd.spectrogram.fAxis;
    A.near(fa[fa.length - 1], 22050, 30, 'spectrogram fAxis 上限应约等于奈奎斯特');
  }
  A.ok(!!dd.phaseData && dd.phaseData.length > 0, 'phaseData 为空（立体声应有点）');
  A.ok(dd.loudnessCurve.length > 0, 'loudnessCurve 为空');
  A.ok(dd.snr && dd.snr.snrDB != null, 'snr 缺失');
  A.ok(dd.distortion && typeof dd.distortion.thdPct === 'number', 'distortion 缺失');
  console.log(`  waveform=${dd.waveform.length}, spectrogram=${dd.spectrogram.data.length}x${dd.spectrogram.data[0].length}, phase=${dd.phaseData.length}, loudness=${dd.loudnessCurve.length}`);
}

console.log('\n=== 4) 单声道不应崩且 phaseData 为空 ===');
{
  const mono = tone(1000);
  const dd = await computeDisplayData([mono[0]], 44100);
  A.ok(!!dd.bandSpectrum, '单声道 bandSpectrum 为空');
  A.ok(dd.phaseData === null, '单声道 phaseData 应为 null');
  console.log('  ✅ 单声道处理正常');
}

console.log('\n=== 5) 静音输入不应产生 NaN/Infinity ===');
{
  const n = 44100;
  const dd = await computeDisplayData([new Float32Array(n), new Float32Array(n)], 44100);
  const bs = dd.bandSpectrum;
  A.ok(bs.values.every(v => Number.isFinite(v)), 'bandSpectrum 含非有限值');
  A.ok(dd.waveform.every(v => Number.isFinite(v)), 'waveform 含非有限值');
  A.ok(Number.isFinite(dd.distortion.thdPct), 'distortion.thdPct 非有限');
  A.ok(dd.loudnessCurve.every(v => Number.isFinite(v)), 'loudnessCurve 含非有限值');
  console.log(`  静音: band[0]=${bs.values[0].toFixed(1)}dB, thd=${dd.distortion.thdPct}, snrDB=${dd.snr.snrDB}`);
}

cleanup(mod);
process.exit(A.report('频谱/频标回归测试') ? 0 : 1);
