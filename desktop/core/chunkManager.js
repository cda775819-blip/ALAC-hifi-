// ═══════════════════════════════════════════════════════════════
//  chunkManager.js — PCM 音频分片管理器（ES Module）
//  根据音频时长自动选择最优 chunk 大小
// ═══════════════════════════════════════════════════════════════

/**
 * 将多声道 PCM 数据切分为等长片段（自适应 chunk）
 * @param {Float32Array[]} channels — 每个声道的 PCM 数据
 * @param {number} sampleRate
 * @returns {Array<{data: Float32Array[], index: number}>}
 */
export function splitPCM(channels, sampleRate) {
  const length = channels[0].length;
  const duration = length / sampleRate;

  let chunkSec;
  if (duration < 60) chunkSec = 5;
  else if (duration < 600) chunkSec = 10;
  else chunkSec = 20;

  const chunkSamples = sampleRate * chunkSec;
  const chunks = [];

  for (let i = 0; i < length; i += chunkSamples) {
    const end = Math.min(i + chunkSamples, length);
    chunks.push({
      data: channels.map(ch => ch.slice(i, end)),
      index: chunks.length,
    });
  }

  return chunks;
}
