// ═══════════════════════════════════════════════════════════════
//  analyzeEngine.js — 分析引擎核心（产品级入口）
//  唯一分析入口：切片 → Worker Pool → 汇总
// ═══════════════════════════════════════════════════════════════

import { splitPCM } from "./chunkManager.js";
import { WorkerPool } from "./workerPool.js";
import { reduceResults } from "./reduceResults.js";

export class AnalyzeEngine {
  constructor() {
    this.pool = new WorkerPool("../worker/analyze.worker.js", 4);
  }

  /**
   * 运行完整分析
   * @param {Float32Array[]} channels — PCM 声道数据
   * @param {number} sampleRate
   * @param {Function} [onProgress] — (ratio: 0-1) => void
   * @returns {object} 汇总后的分析结果
   */
  async run(channels, sampleRate, onProgress) {
    const totalSamples = channels[0].length;
    const channelsCount = channels.length;

    // 1. 分片
    const chunks = splitPCM(channels, sampleRate);
    const total = chunks.length;

    // 2. 并行分派
    const results = [];

    for (let i = 0; i < total; i++) {
      try {
        const raw = await this.pool.run({
          chunk: chunks[i].data,
          index: i,
          sampleRate,
        });

        // Worker 返回 { ok: true, res } 或 { ok: false, error }
        if (raw && raw.ok === false) {
          console.error(`[Engine] Chunk ${i} failed: ${raw.error}`);
          results.push({ rms: 0, peak: 0, spectrum: [], sampleCount: 0 });
        } else if (raw && raw.ok === true && raw.res) {
          results.push(raw.res);
        } else {
          // 兼容旧的直接返回格式
          results.push(raw);
        }

        if (onProgress) {
          onProgress(i / total);
        }
      } catch (err) {
        console.error(`[Engine] Chunk ${i} exception:`, err);
        // 失败降级
        results.push({ rms: 0, peak: 0, spectrum: [], sampleCount: 0 });
      }
    }

    // 3. 汇总
    return reduceResults(results, sampleRate, totalSamples, channelsCount);
  }
}
