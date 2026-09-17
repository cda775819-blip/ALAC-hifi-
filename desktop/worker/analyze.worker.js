// ═══════════════════════════════════════════════════════════════
//  analyze.worker.js — 轻量分片音频分析 Worker (V3.1 增强保护)
//  每个 Chunk 独立计算，增强错误隔离
// ═══════════════════════════════════════════════════════════════

const FFT_SIZE = 2048;
const SPECTRUM_BINS = 512;

self.onmessage = async (e) => {
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

  let peak = 0;
  let rmsSumSq = 0;
  let clippedCount = 0;
  let dcSum = 0;

  // Hann 窗
  const window = hannWindow(FFT_SIZE);
  const fftReal = new Float32Array(FFT_SIZE);
  const fftImag = new Float32Array(FFT_SIZE);
  const spectrumAccum = new Float32Array(SPECTRUM_BINS);

  const numFrames = Math.max(1, Math.floor((len - FFT_SIZE) / (FFT_SIZE / 2)) + 1);

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * (FFT_SIZE / 2);
    if (offset + FFT_SIZE > len) break;

    for (let i = 0; i < FFT_SIZE; i++) {
      let val = 0;
      if (numChannels === 1) {
        val = channels[0][offset + i];
      } else if (numChannels >= 2) {
        val = (channels[0][offset + i] + channels[1][offset + i]) / 2;
      }
      fftReal[i] = val * window[i];
      fftImag[i] = 0;

      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      rmsSumSq += val * val;
      dcSum += val;
      if (abs >= 0.999) clippedCount++;
    }

    fftInPlace(fftReal, fftImag, FFT_SIZE, false);

    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const freqIdx = Math.round((b / SPECTRUM_BINS) * (FFT_SIZE / 2));
      const mag = Math.sqrt(fftReal[freqIdx] * fftReal[freqIdx] + fftImag[freqIdx] * fftImag[freqIdx]);
      spectrumAccum[b] += mag;
    }
  }

  const totalSamples = numFrames * FFT_SIZE;
  const rms = totalSamples > 0 ? Math.sqrt(rmsSumSq / totalSamples) : 0;
  const dcOffset = totalSamples > 0 ? dcSum / totalSamples : 0;
  const spectrum = Array.from(spectrumAccum).map(v => v / Math.max(1, numFrames));

  let stereoCorrelation = null;
  let midRMS = null, sideRMS = null;

  if (numChannels >= 2) {
    let midSumSq = 0, sideSumSq = 0;
    for (let i = 0; i < len; i++) {
      const L = channels[0][i];
      const R = channels[1][i];
      const mid = (L + R) / 2;
      const side = (L - R) / 2;
      midSumSq += mid * mid;
      sideSumSq += side * side;
    }
    midRMS = len > 0 ? Math.sqrt(midSumSq / len) : 0;
    sideRMS = len > 0 ? Math.sqrt(sideSumSq / len) : 0;

    if (midRMS > 0 && sideRMS > 0) {
      const ratio = sideRMS / midRMS;
      stereoCorrelation = 1 - Math.min(ratio, 1);
    }
  }

  return {
    peak,
    rms,
    dcOffset,
    clippedSamples: clippedCount,
    spectrum,
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
