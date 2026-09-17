// ═══════════════════════════════════════════════════════════════
//  audioMath.js — 高级音频分析算法（主线程执行）
//  输出精确的响度 / 位深度 / SNR / 失真 / 截止频率
// ═══════════════════════════════════════════════════════════════

// ── D 引用（由 app.js 在调用前注入或作为全局） ──
const D = {
  warn(tag, msg) { console.warn(`[audioMath:${tag}] ${msg}`); }
};

export function setLogger(logger) {
  Object.assign(D, logger);
}

// ═══════════════════════════════════════════════════════════════
//  1. computeLoudness — ITU-R BS.1770-4 K-weighting 响度分析
//  输入: Float32Array (单声道或已混缩), sampleRate
//  输出: { integratedLoudnessLUFS, shortTermMaxLUFS, lra, stLUFSvalues, stTimeStep }
// ═══════════════════════════════════════════════════════════════

export function computeLoudness(data, sampleRate) {
  try {
    if (!data || !sampleRate || sampleRate < 1000) {
      D.warn('Loudness', `采样率无效 (${sampleRate})`);
      return null;
    }
    if (data.length < sampleRate * 0.4) {
      D.warn('Loudness', '音频太短（<0.4s），无法计算响度');
      return null;
    }

    // 数字静音早退：无音轨的视频/空轨会走到这里。
    // 若不做这个判断，滤波器自身舍入噪声会被绝对值门限放过，
    // 最终算出 -109 LUFS 这类小于门限本身的荒谬值。
    let _sumSq = 0;
    for (let i = 0; i < data.length; i++) _sumSq += data[i] * data[i];
    const rawRms = Math.sqrt(_sumSq / data.length);
    if (!(rawRms > 1e-6)) {   // 低于约 -120 dBFS 视为数字静音
      D.warn('Loudness', `输入近似数字静音 (RMS=${rawRms.toExponential(2)})，无有效响度`);
      return null;
    }

    // ── K-weighting 滤波：预加重 + RLB 高通 + 高架 ──
    // K-weighting 严格按 ITU-R BS.1770-4 只有两级：
    //   ① RLB 高通（fc≈38Hz，去 DC 与极低频）
    //   ② 高架滤波（~+4dB @ 高段）
    // 历史上这里额外插了一级 preEmphasis（out = x - 0.995*x[-1]），
    // 那是个一阶高通，BS.1770 中并不存在；它会把低频整体压掉
    // （实测 1kHz 偏低 13.6dB、100Hz 偏低 27.6dB），使 LUFS 完全失真。
    // 去 DC 已由 RLB 高通负责，不需要也不应再加这一级。
    const rlbFiltered = rlbHighPass(data, sampleRate);
    const kWeighted = highShelfFilter(rlbFiltered, sampleRate);

    // ── 预计算平方值（避免重复乘法） ──
    const sq = new Float32Array(kWeighted.length);
    for (let i = 0; i < kWeighted.length; i++) sq[i] = kWeighted[i] * kWeighted[i];

    // ── 400ms block, 75% overlap ──
    const blockSamples = Math.round(0.4 * sampleRate);
    const hopSamples = Math.round(0.1 * sampleRate);

    const meanSquares = [];
    for (let start = 0; start + blockSamples <= kWeighted.length; start += hopSamples) {
      let sumSq = 0;
      for (let i = start; i < start + blockSamples; i++) sumSq += sq[i];
      meanSquares.push(sumSq / blockSamples);
    }

    if (meanSquares.length === 0) {
      D.warn('Loudness', '无有效数据块');
      return null;
    }

    // ── 门控 1: 绝对门控 -70 LUFS ──
    const threshold1 = Math.pow(10, -7); // -70 LUFS → 10^(-7)
    const gated1 = meanSquares.filter(v => v >= threshold1);
    if (gated1.length === 0) {
      D.warn('Loudness', '所有块低于-70 LUFS 门限');
      return null;
    }
    const meanLoud1 = gated1.reduce((a, b) => a + b, 0) / gated1.length;

    // ── 门控 2: 相对门控 — 排除低于绝对响度 10 LU 的块 ──
    const threshold2 = meanLoud1 * 0.1; // -10 LU
    const gated2 = gated1.filter(v => v >= threshold2);
    const integratedPower = gated2.length > 0
      ? gated2.reduce((a, b) => a + b, 0) / gated2.length
      : meanLoud1;

    const integratedLoudnessLUFS = -0.691 + 10 * Math.log10(Math.max(integratedPower, 1e-12));

    // ── 短时响度（滑动窗口，O(n)） ──
    const stBlockSamples = Math.round(3.0 * sampleRate);
    const stHopSamples = Math.round(0.1 * sampleRate);
    const stLUFSvalues = [];
    if (kWeighted.length >= stBlockSamples) {
      let windowSum = 0;
      for (let i = 0; i < stBlockSamples; i++) windowSum += sq[i];
      stLUFSvalues.push(windowSum > 1e-12 ? -0.691 + 10 * Math.log10(windowSum / stBlockSamples) : -70);
      for (let i = stBlockSamples; i < kWeighted.length; i++) {
        windowSum += sq[i] - sq[i - stBlockSamples];
        if ((i - stBlockSamples + 1) % stHopSamples === 0) {
          stLUFSvalues.push(windowSum > 1e-12 ? -0.691 + 10 * Math.log10(windowSum / stBlockSamples) : -70);
        }
      }
    }

    const shortTermMaxLUFS = stLUFSvalues.length > 0
      ? Math.max(...stLUFSvalues)
      : integratedLoudnessLUFS;

    // ── LRA（基于门控2后的块） ──
    const gatedLUFS = gated1.map(v => v > 1e-12 ? -0.691 + 10 * Math.log10(v) : -70);
    gatedLUFS.sort((a, b) => a - b);
    const n = gatedLUFS.length;
    const p10 = gatedLUFS[Math.floor(n * 0.1)];
    const p95 = gatedLUFS[Math.floor(n * 0.95)];
    const lra = p95 - p10;

    return {
      integratedLoudnessLUFS: Math.round(integratedLoudnessLUFS * 10) / 10,
      shortTermMaxLUFS: Math.round(shortTermMaxLUFS * 10) / 10,
      lra: Math.round(lra * 10) / 10,
      stLUFSvalues,
      stTimeStep: 0.1,
    };
  } catch (e) {
    D.warn('Loudness', `计算失败: ${e.message}`);
    return null;
  }
}

// ── K-weighting 子滤波器 ──

function preEmphasisFilter(data) {
  // 预加重：从音频中移除 DC 并做简单高通
  const out = new Float32Array(data.length);
  let prev = 0;
  const alpha = 0.995;
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] - alpha * prev;
    prev = data[i];
  }
  return out;
}

function rlbHighPass(data, sr) {
  // RLB (Revised Low-frequency B) 高通 —— ITU-R BS.1770-4 的 K-weighting 第一级
  //
  // 采用二阶高通做预畸变双线性变换，但 Q 不是 Butterworth 的 1/√2：
  // 从官方 48kHz 分母系数 a=[1, -1.99004745483398, 0.99007225036621] 反推极点
  //   r = 0.995027, θ = 0.0999376
  //   → 模拟极点：ω0 = 2·sr·tan(θ/2) = 244.4 rad/s
  //               σ  = -sr·ln(r)·(1+k²)/(2k) → Q = ω0/(2σ) ≈ 0.5
  // 即 f0 = 38.9 Hz、Q = 0.5。若用 Butterworth 的 Q=0.7071，
  // 低频段会系统性抬升约 2.5dB（30Hz +2.5 / 50Hz +2.6 / 100Hz +1.0），
  // 重低音素材的 LUFS 会被高估 2-3dB。
  //
  // 注意：官方 RLB 的分子 b=[1,-2,1] 无法由标准模拟原型精确复现
  // （其数字极点是直接在数字域规定的），本实现取 Q=0.5 的拟合，
  // 200Hz 以上与官方一致（偏差 <0.05dB），200Hz 以下残差约 0.3dB 以内。
  const RLB_F0 = 38.9;
  const RLB_Q = 0.5;
  const out = new Float32Array(data.length);
  const k = Math.tan(Math.PI * RLB_F0 / sr);   // 预畸变
  const k2 = k * k;
  const alpha = k / RLB_Q;
  const norm = 1 / (1 + alpha + k2);           // = 1/a0

  const b0 = norm;
  const b1 = -2 * norm;
  const b2 = norm;
  // 本函数约定：y = b0x0+b1x1+b2x2 + (-a1)y1 + (-a2)y2
  const a1 = 2 * (k2 - 1) * norm;
  const a2 = (1 - alpha + k2) * norm;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function highShelfFilter(data, sr) {
  // 高架滤波器：高频 +4dB，低频 0dB（ITU-R BS.1770-4 的 K-weighting 第二级）
  //
  // 采用 ITU-R BS.1770-4 的等效设计参数：
  //   G  = 4.00 dB
  //   fc = 1500 Hz
  //   S  = 1（RBJ shelf slope）
  // 这组参数可复现官方 48kHz 数字系数到 1.1e-4（已用 .dbg 脚本逐位核对）。
  //
  // 原实现的 fc 就是 1500，参数本来没错；真正的 bug 在系数组的配对方向：
  //   b1 写成了  2A·((A−1) − (A+1)cos)  ← 这是**低架**的形式
  //   正确应为 −2A·((A−1) + (A+1)cos)  ← 高架
  // 后果是滤波器变成「低频 +4dB、高频 0dB」（与预期完全相反），
  // 使 K-weighting 整体抬高 3.3dB —— 这是 LUFS 长期偏差的直接原因。
  const fc = 1500;
  const gainDB = 4.0;

  const out = new Float32Array(data.length);
  const A = Math.pow(10, gainDB / 40);
  const w0 = 2 * Math.PI * fc / sr;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const sqrtA = Math.sqrt(A);

  const alpha = sinW0 / 2 * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2); // S = 1

  const b0 = A * ((A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
  const b2 = A * ((A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha);
  const a0 = (A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cosW0);
  const a2 = (A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
//  2. estimateBitDepth — GCD 量化步长直方图法
//  输入: Float32Array PCM, formatInfo { bitDepth }
//  输出: { estimated, note, detail }
// ═══════════════════════════════════════════════════════════════

export function estimateBitDepth(data, formatInfo) {
  try {
    if (!data || data.length < 1000) {
      D.warn('BitDepth', '数据不足');
      return null;
    }

    // 取前 30 秒样本
    const sampleLen = Math.min(data.length, 30 * 48000);
    const step = Math.max(1, Math.floor(sampleLen / 50000));

    // 收集非零相邻差值
    const diffs = [];
    for (let i = 1; i < sampleLen; i += step) {
      const d = Math.abs(data[i] - data[i - 1]);
      if (d > 1e-10 && d < 0.5) diffs.push(d);
    }

    if (diffs.length < 100) {
      const formatBD = formatInfo?.bitDepth || 16;
      return { estimated: formatBD, note: '样本不足，回退到文件声明', detail: `基于格式声明 ${formatBD}-bit` };
    }

    // 量化直方图：将差值按精度分桶
    const NUM_BINS = 2000;
    const minDiff = diffs.reduce((a, b) => Math.min(a, b), Infinity);
    const binWidth = minDiff * 0.5;
    const histogram = new Array(NUM_BINS).fill(0);

    for (const d of diffs) {
      const bin = Math.min(NUM_BINS - 1, Math.floor(d / binWidth));
      if (bin >= 0) histogram[bin]++;
    }

    // 找峰值间距（量化步长的倍数关系）
    const peaks = [];
    for (let i = 2; i < NUM_BINS - 1; i++) {
      if (histogram[i] > histogram[i - 1] && histogram[i] > histogram[i + 1] && histogram[i] > diffs.length * 0.002) {
        peaks.push(i);
      }
    }

    if (peaks.length < 2) {
      const formatBD = formatInfo?.bitDepth || 16;
      return { estimated: formatBD, note: '无清晰量化特征', detail: `回退到格式声明 ${formatBD}-bit` };
    }

    // GCD of peak spacings
    function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

    const spacings = [];
    for (let i = 1; i < peaks.length; i++) {
      spacings.push(peaks[i] - peaks[i - 1]);
    }

    let commonGcd = spacings[0];
    for (let i = 1; i < spacings.length; i++) {
      commonGcd = gcd(commonGcd, spacings[i]);
      if (commonGcd <= 1) break;
    }

    const rawStep = commonGcd * binWidth;
    if (rawStep <= 0 || rawStep > 0.5) {
      return { estimated: 16, note: '量化步长异常', detail: '无法可靠检测' };
    }

    // 位深度 = -log2(step)
    const estimated = Math.round(-Math.log2(rawStep));
    const clamped = Math.max(8, Math.min(32, estimated));
    const formatBD = formatInfo?.bitDepth || 16;

    if (clamped <= 17 && formatBD >= 24) {
      return {
        estimated: clamped,
        note: `${clamped}-bit 实测（文件声称 ${formatBD}-bit）`,
        detail: `量化步长 ${rawStep.toExponential(2)} → ~${estimated}-bit。文件声称 ${formatBD}-bit，差异 ${formatBD - clamped} bit 可能为零填充`,
      };
    }

    return {
      estimated: clamped,
      note: `${clamped}-bit 实测`,
      detail: `量化步长 ${rawStep.toExponential(2)} → ${estimated}-bit`,
    };
  } catch (e) {
    D.warn('BitDepth', `计算失败: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  3. computeSNR — 分块噪底估计信噪比
//  输入: Float32Array PCM, sampleRate
//  输出: { snrDB, noiseFloorDB, snrLow, snrMid, snrHigh, isEstimate }
// ═══════════════════════════════════════════════════════════════

export function computeSNR(data, sampleRate) {
  try {
    if (!data || data.length < sampleRate * 1) {
      D.warn('SNR', '音频太短（<1s）');
      return null;
    }

    const BLOCK = 4096;
    const totalBlocks = Math.floor(data.length / BLOCK);
    if (totalBlocks < 10) {
      D.warn('SNR', '分块不足');
      return null;
    }

    // 全频段 RMS per block
    const blockRMS = new Float32Array(totalBlocks);
    let globalSumSq = 0;

    for (let b = 0; b < totalBlocks; b++) {
      const off = b * BLOCK;
      let sumSq = 0;
      for (let i = off; i < off + BLOCK; i++) {
        sumSq += data[i] * data[i];
      }
      blockRMS[b] = Math.sqrt(sumSq / BLOCK);
      globalSumSq += sumSq;
    }

    const globalRMS = Math.sqrt(globalSumSq / (totalBlocks * BLOCK));

    // 取最安静 10% 的块作为噪底
    const sortedBlocks = Array.from(blockRMS).sort((a, b) => a - b);
    const noiseCount = Math.max(1, Math.floor(totalBlocks * 0.1));
    let noiseSumSq = 0;
    for (let i = 0; i < noiseCount; i++) {
      noiseSumSq += sortedBlocks[i] * sortedBlocks[i];
    }
    const noiseFloorRMS = Math.sqrt(noiseSumSq / noiseCount);
    const noiseFloorDB = noiseFloorRMS > 1e-12
      ? 20 * Math.log10(noiseFloorRMS)
      : -96;
    const snrDB = noiseFloorRMS > 1e-12
      ? 20 * Math.log10(globalRMS / noiseFloorRMS)
      : globalRMS > 1e-12 ? 96 : 0;

    // 分段 SNR：低频 20-250Hz, 中频 250-4kHz, 高频 4kHz+
    const bandSNR = (lowCut, highCut) => {
      // 简易 FIR 带通（移动平均差分法）
      const filtered = simpleBandFilter(data, sampleRate, lowCut, highCut);
      let bandTotal = 0;
      for (let i = 0; i < filtered.length; i++) bandTotal += filtered[i] * filtered[i];
      const bandRMS = Math.sqrt(bandTotal / filtered.length);

      // 噪底估算：同样的滤波 + 安静段
      const quietBlocks = [];
      for (let b = 0; b < totalBlocks; b++) {
        const off = b * BLOCK;
        let sq = 0;
        for (let i = off; i < Math.min(off + BLOCK, filtered.length); i++) {
          sq += filtered[i] * filtered[i];
        }
        quietBlocks.push(Math.sqrt(sq / Math.min(BLOCK, filtered.length - off)));
      }
      quietBlocks.sort((a, b) => a - b);
      const nc = Math.max(1, Math.floor(quietBlocks.length * 0.1));
      let ns = 0;
      for (let i = 0; i < nc; i++) ns += quietBlocks[i] * quietBlocks[i];
      const nRMS = Math.sqrt(ns / nc);

      return nRMS > 1e-12 ? 20 * Math.log10(bandRMS / nRMS) : 60;
    };

    const snrLow = bandSNR(20, 250);
    const snrMid = bandSNR(250, 4000);
    const snrHigh = bandSNR(4000, Math.min(sampleRate / 2 * 0.9, 20000));

    return {
      snrDB: Math.round(snrDB * 10) / 10,
      noiseFloorDB: Math.round(noiseFloorDB * 10) / 10,
      snrLow: Math.round(snrLow * 10) / 10,
      snrMid: Math.round(snrMid * 10) / 10,
      snrHigh: Math.round(snrHigh * 10) / 10,
      isEstimate: false,
    };
  } catch (e) {
    D.warn('SNR', `计算失败: ${e.message}`);
    return null;
  }
}

// 简易带通滤波器（二阶 Butterworth 级联）
function simpleBandFilter(data, sr, lowCut, highCut) {
  // 降采样以加速（高频段不需要全采样率）
  const targetSR = highCut * 3;
  const decimate = targetSR < sr ? Math.floor(sr / targetSR) : 1;
  const filtered = new Float32Array(Math.floor(data.length / decimate));

  // 低通滤波器（截止 = highCut）
  const alpha = Math.exp(-2 * Math.PI * highCut / sr * decimate);

  let y = data[0] || 0;
  for (let i = 0; i < filtered.length; i++) {
    const idx = i * decimate;
    const x = idx < data.length ? data[idx] : 0;
    y = y + alpha * (x - y);
    filtered[i] = y;
  }

  // 高通滤波（截止 = lowCut）
  if (lowCut > 20) {
    const beta = Math.exp(-2 * Math.PI * lowCut / sr * decimate);
    let prev = filtered[0] || 0;
    let prevOut = 0;
    for (let i = 1; i < filtered.length; i++) {
      const current = filtered[i];
      filtered[i] = beta * (prevOut + current - prev);
      prevOut = filtered[i];
      prev = current;
    }
  }

  return filtered;
}

// ═══════════════════════════════════════════════════════════════
//  4. computeDistortion — 基频检测 + 谐波分析
//  输入: Float32Array PCM, sampleRate, freqs[], spectrum[]
//  输出: { thdPct, fundamentalHz, harmonics[], asymmetryPct, isEstimate }
// ═══════════════════════════════════════════════════════════════

export function computeDistortion(data, sampleRate, freqs, spectrum) {
  try {
    if (!data || !freqs || !spectrum || freqs.length < 10) {
      D.warn('Distortion', '数据不足');
      return null;
    }

    // 自相关法检测基频（取前 2 秒）
    const autoLen = Math.min(data.length, 2 * sampleRate);
    const corrLen = Math.min(autoLen, 4096);
    const correlation = new Float32Array(corrLen);

    for (let lag = 0; lag < corrLen; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < autoLen; i++) {
        sum += data[i] * data[i + lag];
      }
      correlation[lag] = sum;
    }

    // 找自相关峰值（跳过 lag=0）
    let bestLag = 0, bestVal = -Infinity;
    const minLag = Math.floor(sampleRate / 4000);  // ~4kHz max
    const maxLag = Math.floor(sampleRate / 60);    // 60Hz min
    for (let lag = minLag; lag < Math.min(maxLag, corrLen); lag++) {
      if (correlation[lag] > correlation[lag - 1] && correlation[lag] > correlation[lag + 1]) {
        if (correlation[lag] > bestVal) {
          bestVal = correlation[lag];
          bestLag = lag;
        }
      }
    }

    if (bestLag === 0) {
      D.warn('Distortion', '无法检测基频');
      return null;
    }

    const fundamentalHz = sampleRate / bestLag;
    if (fundamentalHz < 30 || fundamentalHz > 2000) {
      D.warn('Distortion', `基频 ${fundamentalHz.toFixed(0)}Hz 超出合理范围`);
      return null;
    }

    // 从频谱中提取谐波幅度
    const harmonics = [];
    for (let h = 1; h <= 5; h++) {
      const targetFreq = fundamentalHz * h;
      // 找最接近的频率 bin
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < freqs.length; i++) {
        const dist = Math.abs(freqs[i] - targetFreq);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestDist < targetFreq * 0.1) {
        harmonics.push(spectrum[bestIdx] !== undefined ? spectrum[bestIdx] : -120);
      } else if (h === 1) {
        return null; // 基频不在频谱中
      } else {
        harmonics.push(-120); // 谐波超出范围用静音填充
      }
    }

    if (harmonics.length < 2) {
      D.warn('Distortion', '谐波不足');
      return null;
    }

    // ── 基频有效性校验 ──
    // 「最近的 bin 足够近」并不代表「那个 bin 里真有基频能量」：
    // 自相关估出的基频（如 1002.3Hz）与频谱 bin 中心（1002.0Hz 附近的 21.5Hz 栅格）
    // 常有半格偏差，取到的可能是噪声底。
    // 若不校验，H1 与各阶谐波会一起读到噪底，比值恒为 1 → THD 假报 100%。
    const specMax = Math.max(...spectrum.filter(v => Number.isFinite(v)));
    const h1Db = harmonics[0];
    if (h1Db < specMax - 40) {
      D.warn('Distortion', `基频格电平 ${h1Db.toFixed(1)}dB 比谱峰低 40dB 以上，判定基频未检出`);
      return null;
    }

    // ══════════════════════════════════════════════════════════
    //  方法论门槛：此估算**只对单一基频素材成立**
    //
    //  物理依据：单音（纯音、单件乐器独奏）的谐波随阶数单调递减 ——
    //  这是任何真实振动系统的性质（能量向高阶谐波传递必然衰减）。
    //  而多件乐器叠加的复音素材，各阶"谐波格"落在不同乐器的能量上，
    //  排序是任意的，不存在"基频 + 谐波"结构。
    //
    //  实测：某流行乐文件 H1=-12.3dB 而 H2=-9.9dB（谐波比基频高 2.4dB），
    //  比值算出 >100% —— 不是失真极大，而是方法不适用。
    //
    //  因此：只要谐波不呈单调递减趋势，就判定无法测量，
    //  宁可明说"测不了"，也不给一个会被误读为"失真极高"的数字。
    // ══════════════════════════════════════════════════════════
    const h1 = harmonics[0];
    let growth = 0;             // 相邻谐波中"上升"的最大幅度
    let growthAt = -1;
    for (let i = 1; i < harmonics.length; i++) {
      const d = harmonics[i] - harmonics[i - 1];
      if (d > growth) { growth = d; growthAt = i; }
    }
    const strongest = Math.max(...harmonics);
    const h1IsStrongest = h1 >= strongest - 0.5;   // 允许 0.5dB 的测量噪声
    // 仅"不上升"还不够：全等幅（H1..H5 电平相同）也不上升，
    // 但那显然不是"谐波递减"的物理形态（会算出恰好 100%）。
    // 因此还要求带内谐波确实低于基频。
    const decayed = h1 - Math.max(...harmonics.slice(1)) > 6;
    // 尾部可放宽：高阶谐波靠近噪底时排序无意义
    const tailFloor = h1 - 60;
    const growthIsMeaningful = growth > 0.5 && (growthAt < 2 || harmonics[growthAt] > tailFloor);

    if (!h1IsStrongest || growthIsMeaningful || !decayed) {
      const why = !h1IsStrongest
        ? `谐波 H${(harmonics.indexOf(strongest) + 1)} 比基频高 ${(strongest - h1).toFixed(1)}dB`
        : (growthIsMeaningful
            ? `谐波在 H${growthAt + 1} 处回升 ${growth.toFixed(1)}dB`
            : `谐波未低于基频（H1=${h1.toFixed(1)}dB，最强谐波=${Math.max(...harmonics.slice(1)).toFixed(1)}dB）`);
      D.warn('Distortion', `谐波不呈单调递减（${why}），判定非单一基频素材，THD 不可测量`);
      return {
        thdPct: 0,
        fundamentalHz: Math.round(fundamentalHz * 10) / 10,
        harmonics: harmonics.map(v => Math.round(v * 10) / 10),
        asymmetryPct: 0,
        // unmeasurable：「方法不适用」而非「失真为 0」，UI 必须据此显示提示
        unmeasurable: true,
        reason: why,
        limitHit: true,        // 兼容既有的 UI 判定
        isEstimate: false,
      };
    }

    // THD = sqrt(sum(H2²...H5²)) / H1 × 100%
    //
    // 局限：这是「从平均频谱推谐波」的估算，不是真正的 THD 测量。
    // 对真实音乐（宽带、复音），谐波格可能恰好落在别的乐器的强能量上，
    // 算出的比值会超过 100%，物理上无意义。因此：
    //   · 超过 100% 时钳制到 100%
    //   · 并用 isEstimate/limitHit 标出「此结果不可用于定量判断」
    const H1_linear = Math.pow(10, harmonics[0] / 20);
    let harmonicSumSq = 0;
    for (let h = 1; h < harmonics.length; h++) {
      const linear = Math.pow(10, harmonics[h] / 20);
      harmonicSumSq += linear * linear;
    }
    const rawThd = H1_linear > 1e-12
      ? (Math.sqrt(harmonicSumSq) / H1_linear) * 100
      : 0;
    const limitHit = !Number.isFinite(rawThd) || rawThd > 100;
    const thdPct = limitHit ? 100 : Math.max(0, rawThd);

    // 波形不对称性
    let posSum = 0, negSum = 0, posCount = 0, negCount = 0;
    const asymLen = Math.min(data.length, 5 * sampleRate);
    for (let i = 0; i < asymLen; i++) {
      if (data[i] > 0) { posSum += data[i]; posCount++; }
      else if (data[i] < 0) { negSum += -data[i]; negCount++; }
    }
    const posAvg = posCount > 0 ? posSum / posCount : 0;
    const negAvg = negCount > 0 ? negSum / negCount : 0;
    const asymmetryPct = (posAvg + negAvg) > 1e-10
      ? Math.abs(posAvg - negAvg) / ((posAvg + negAvg) / 2) * 100
      : 0;

    return {
      thdPct: Math.round(thdPct * 1000) / 1000,
      fundamentalHz: Math.round(fundamentalHz * 10) / 10,
      harmonics,
      asymmetryPct: Math.round(asymmetryPct * 10) / 10,
      // 走到这里说明通过了单调递减门槛，谐波结构可信
      unmeasurable: false,
      // 保留 limitHit 以兼容既有 UI 判定（此处恒为 false）
      limitHit: !!limitHit,
      isEstimate: false,
    };
  } catch (e) {
    D.warn('Distortion', `计算失败: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  5. detectCutoff — 截止频率检测
//  输入: freqs[], spectrum[] (dB), sampleRate
//  输出: { freq, bw, confidence }
// ═══════════════════════════════════════════════════════════════

export function detectCutoff(freqs, spectrum, sampleRate) {
  try {
    if (!freqs || !spectrum || freqs.length < 20) {
      D.warn('Cutoff', '频谱数据不足');
      return null;
    }

    const nyquist = sampleRate / 2;
    const numBins = freqs.length;

    // 找高频段（8kHz 以上）的平均噪底
    let noiseStartIdx = 0;
    for (let i = 0; i < numBins; i++) {
      if (freqs[i] >= 12000) { noiseStartIdx = i; break; }
    }
    if (noiseStartIdx === 0) noiseStartIdx = Math.floor(numBins * 0.7);

    let ultraSum = 0, ultraCount = 0;
    for (let i = noiseStartIdx; i < numBins; i++) {
      ultraSum += spectrum[i];
      ultraCount++;
    }
    const ultraNoiseFloor = ultraCount > 0 ? ultraSum / ultraCount : -80;

    // 从高频向低频扫描，找第一个比噪底高 threshold dB 的位置
    const threshold = 15; // dB above noise floor
    let cutoffIdx = numBins - 1;
    for (let i = numBins - 1; i >= 0; i--) {
      if (spectrum[i] > ultraNoiseFloor + threshold) {
        cutoffIdx = i;
        break;
      }
    }

    const cutoffFreq = freqs[cutoffIdx] || nyquist;
    const availableBw = cutoffFreq / nyquist * 100;

    // 置信度
    let confidence = 'low';
    if (cutoffFreq < nyquist * 0.6) {
      confidence = 'high'; // 明显截断
    } else if (cutoffFreq < nyquist * 0.85) {
      confidence = 'medium';
    }

    return {
      freq: Math.round(cutoffFreq),
      bw: Math.round(availableBw * 10) / 10,
      confidence,
    };
  } catch (e) {
    D.warn('Cutoff', `计算失败: ${e.message}`);
    return null;
  }
}
