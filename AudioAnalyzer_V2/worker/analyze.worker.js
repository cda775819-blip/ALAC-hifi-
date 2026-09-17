// ═══════════════════════════════════════════════════════════════
//  analyze.worker.js — 分片音频分析 Worker
//  每个 Chunk 独立计算，返回标量与频谱供 reduceResults 汇总
// ═══════════════════════════════════════════════════════════════

const FFT_SIZE = 2048;
const SPECTRUM_BINS = FFT_SIZE / 2;

// 不变式：spectrum 的格数必须等于 FFT_SIZE/2，这样 spectrum[b] 对应
// FFT bin b、频率 = b * sampleRate / FFT_SIZE，覆盖 0..奈奎斯特。
// 渲染层用 `i / n * sampleRate / 2` 还原频率轴，一旦两者不等，
// 频率轴就会整体缩放错位（曾经因此差了 2 倍）。
if (SPECTRUM_BINS !== FFT_SIZE / 2) {
  throw new Error(`SPECTRUM_BINS(${SPECTRUM_BINS}) 必须等于 FFT_SIZE/2(${FFT_SIZE / 2})`);
}

// 削波判据：与主线程/历史口径保持一致
const CLIP_THRESHOLD = 0.999;

self.onmessage = (e) => {
  try {
    const { chunk, sampleRate } = e.data;

    if (!chunk || !chunk[0]) {
      throw new Error('Invalid chunk: empty channel data');
    }

    const res = analyzeChunk(chunk, sampleRate);
    self.postMessage({ ok: true, res });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};

function analyzeChunk(channels, sampleRate) {
  const numChannels = channels.length;
  const len = channels[0].length;

  // ── 1. 逐采样统计 ──
  // 注意：必须独立成一遍遍历，绝不能放进下面 50% 重叠的 FFT 帧循环，
  // 否则每个采样点会被统计两次（削波计数会翻倍、RMS 权重也会失真）。
  const ch0 = channels[0];
  let peak = 0;
  let clippedCount = 0;
  let dcSum = 0;

  for (let i = 0; i < len; i++) {
    const a = Math.abs(ch0[i]);
    if (a > peak) peak = a;
    dcSum += ch0[i];
    if (a >= CLIP_THRESHOLD) clippedCount++;
  }

  // 多声道：峰值取所有声道的绝对值最大，削波数累加所有声道
  // （单声道下与上面的结果完全一致）
  for (let c = 1; c < numChannels; c++) {
    const chc = channels[c];
    for (let i = 0; i < len; i++) {
      const a = Math.abs(chc[i]);
      if (a > peak) peak = a;
      if (a >= CLIP_THRESHOLD) clippedCount++;
    }
  }

  // RMS 直接对 ch0 逐样本计算
  let rmsSumSq = 0;
  for (let i = 0; i < len; i++) rmsSumSq += ch0[i] * ch0[i];

  const rms = len > 0 ? Math.sqrt(rmsSumSq / len) : 0;
  const dcOffset = len > 0 ? dcSum / len : 0;

  // ── 2. 频谱（50% 重叠 Hann + 平均幅度谱） ──
  const window = hannWindow(FFT_SIZE);
  const fftReal = new Float32Array(FFT_SIZE);
  const fftImag = new Float32Array(FFT_SIZE);
  const spectrumAccum = new Float32Array(SPECTRUM_BINS);
  const HOP = FFT_SIZE / 2;
  const numFrames = Math.max(0, Math.floor((len - FFT_SIZE) / HOP) + 1);

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * HOP;
    if (offset + FFT_SIZE > len) break;

    for (let i = 0; i < FFT_SIZE; i++) {
      let val;
      if (numChannels === 1) {
        val = ch0[offset + i];
      } else {
        val = (ch0[offset + i] + channels[1][offset + i]) / 2;
      }
      fftReal[i] = val * window[i];
      fftImag[i] = 0;
    }

    fftInPlace(fftReal, fftImag, FFT_SIZE, false);

    // 逐 FFT bin 累加幅度谱（不做降采样归并）。
    // 口径：spectrum[b] 对应 FFT bin b，频率 = b * sampleRate / FFT_SIZE。
    // 输出格数必须等于 FFT_SIZE/2，渲染层才能用 i/n * sr/2 正确还原频率轴。
    // 旧的 Math.round((b / SPECTRUM_BINS) * (FFT_SIZE / 2)) 会跳过约一半的 FFT bin，
    // 窄带信号（如工频哼声）会被系统性低估。
    for (let k = 0; k < SPECTRUM_BINS; k++) {
      spectrumAccum[k] += Math.sqrt(fftReal[k] * fftReal[k] + fftImag[k] * fftImag[k]);
    }
  }

  const spectrum = new Array(SPECTRUM_BINS);
  for (let b = 0; b < SPECTRUM_BINS; b++) {
    spectrum[b] = numFrames > 0 ? spectrumAccum[b] / numFrames : 0;
  }

  // ── 3. 立体声 ──
  let stereoCorrelation = null;
  let midRMS = null;
  let sideRMS = null;

  if (numChannels >= 2) {
    const ch1 = channels[1];
    let midSumSq = 0;
    let sideSumSq = 0;
    let sumLR = 0;
    let sumLL = 0;
    let sumRR = 0;

    for (let i = 0; i < len; i++) {
      const L = ch0[i];
      const R = ch1[i];
      const mid = (L + R) / 2;
      const side = (L - R) / 2;
      midSumSq += mid * mid;
      sideSumSq += side * side;
      sumLR += L * R;
      sumLL += L * L;
      sumRR += R * R;
    }

    midRMS = len > 0 ? Math.sqrt(midSumSq / len) : 0;
    sideRMS = len > 0 ? Math.sqrt(sideSumSq / len) : 0;

    // 归一化互相关系数（Pearson）：+1 同相 / 0 无关 / -1 反相
    // 旧实现用 1 - sideRMS/midRMS 只是宽度启发式，恒为非负，
    // 会把反相音频误判为正常，且与主线程口径不一致。
    const denom = Math.sqrt(sumLL * sumRR);
    if (denom > 1e-12) {
      stereoCorrelation = sumLR / denom;
      if (stereoCorrelation < -1) stereoCorrelation = -1;
      else if (stereoCorrelation > 1) stereoCorrelation = 1;
    } else {
      stereoCorrelation = 0;
    }
  }

  return {
    peak,
    rms,
    dcOffset,
    clippedSamples: clippedCount,
    spectrum,
    // 与逐采样统计口径一致，供 reduceResults 作为加权权重
    sampleCount: len,
    stereoCorrelation,
    midRMS,
    sideRMS,
    numFrames,
  };
}

// ── FFT (Cooley-Tukey, in-place) ──
function fftInPlace(real, imag, n, inverse) {
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let m = n >> 1;
    while (m > 0 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    for (let i = 0; i < n; i += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const re = real[i + j + half] * wr - imag[i + j + half] * wi;
        const im = real[i + j + half] * wi + imag[i + j + half] * wr;
        real[i + j + half] = real[i + j] - re;
        imag[i + j + half] = imag[i + j] - im;
        real[i + j] += re;
        imag[i + j] += im;

        const tmp = wr * cosA - wi * sinA;
        wi = wr * sinA + wi * cosA;
        wr = tmp;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

// ── Hann 窗 ──
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}
