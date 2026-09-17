// ═══════════════════════════════════════════════════════════════
//  reduceResults.js — 分片分析结果汇总器（ES Module，唯一真源）
// ═══════════════════════════════════════════════════════════════

function reduceResults(results, sampleRate, totalSamples, channelsCount) {
  if (!results || results.length === 0) return {};
  let globalPeak = 0, rmsSumSq = 0, globalClippedSamples = 0, dcOffsetSum = 0, totalWeight = 0;
  let spectrumBins = null, spectrumWeightSum = 0;
  let stereoCorrSum = 0, midSumSq = 0, sideSumSq = 0, stereoWeightSum = 0;

  for (const r of results) {
    if (!r) continue;
    const w = r.sampleCount || 1;
    if (r.peak > globalPeak) globalPeak = r.peak;
    if (typeof r.rms === 'number') { rmsSumSq += (r.rms * r.rms) * w; totalWeight += w; }
    if (typeof r.clippedSamples === 'number') globalClippedSamples += r.clippedSamples;
    if (typeof r.dcOffset === 'number') dcOffsetSum += r.dcOffset * w;
    if (r.spectrum && r.spectrum.length > 0) {
      if (!spectrumBins) spectrumBins = new Float32Array(r.spectrum.length);
      for (let i = 0; i < spectrumBins.length && i < r.spectrum.length; i++) spectrumBins[i] += (r.spectrum[i] || 0) * w;
      spectrumWeightSum += w;
    }
    if (typeof r.stereoCorrelation === 'number') { stereoCorrSum += r.stereoCorrelation * w; stereoWeightSum += w; }
    if (typeof r.midRMS === 'number') midSumSq += (r.midRMS * r.midRMS) * w;
    if (typeof r.sideRMS === 'number') sideSumSq += (r.sideRMS * r.sideRMS) * w;
  }

  const globalRMS = totalWeight > 0 ? Math.sqrt(rmsSumSq / totalWeight) : 0;
  const avgSpectrum = spectrumBins && spectrumWeightSum > 0 ? Array.from(spectrumBins).map(v => v / spectrumWeightSum) : [];
  const maxSpecVal = avgSpectrum.length > 0 ? Math.max(...avgSpectrum) : 1;
  const normSpectrum = avgSpectrum.map(v => v / (maxSpecVal || 1));

  // 归一化频谱转 dB（峰值 0dB，其余为负）。
  // computeDistortion / detectCutoff 内部按 dB 处理（用 10^(x/20) 还原线性幅度、
  // 用「噪底 + 15dB」判阈值），若传线性幅度谱会得到恒定错误结果。
  const normSpectrumDB = normSpectrum.map(v =>
    v > 0 ? Math.max(-120, 20 * Math.log10(v)) : -120);

  // 频谱每格带宽，供渲染层还原真实频率轴。
  // 每格等宽：奈奎斯特 / 格数。不要用 i/(n-1)*nyquist 推算，
  // 那样会在仅 1 格宽的尾部区间算出偏高的频率。
  const binHz = avgSpectrum.length > 0 ? (sampleRate / 2) / avgSpectrum.length : 0;

  return {
    peak: globalPeak, rms: globalRMS,
    crestFactor: globalRMS > 0 ? 20 * Math.log10(globalPeak / globalRMS) : 0,
    dcOffset: totalWeight > 0 ? dcOffsetSum / totalWeight : 0,
    clippedSamples: globalClippedSamples,
    clipRatio: totalSamples > 0 ? globalClippedSamples / totalSamples : 0,
    spectrum: avgSpectrum, normSpectrum, normSpectrumDB, binHz,
    dynamicRangeDB: globalRMS > 0 ? 20 * Math.log10(1.0 / globalRMS) : 0,
    stereoCorrelation: stereoWeightSum > 0 ? stereoCorrSum / stereoWeightSum : null,
    midRMS: totalWeight > 0 ? Math.sqrt(midSumSq / totalWeight) : 0,
    sideRMS: totalWeight > 0 ? Math.sqrt(sideSumSq / totalWeight) : 0,
    stereoWidth: totalWeight > 0 && Math.sqrt(midSumSq / totalWeight) > 0 ? Math.sqrt(sideSumSq / totalWeight) / Math.sqrt(midSumSq / totalWeight) : 0,
    sampleRate, totalSamples, channelsCount,
    _chunked: true, _chunkCount: results.length,
  };
}

export { reduceResults };
