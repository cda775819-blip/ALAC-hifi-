// ═══════════════════════════════════════════════════════════════
//  test/e2e.js — Electron 端到端冒烟测试
//
//  跑法：npm run smoke
//
//  覆盖纯 Node 测试测不到的部分：真实 Electron 环境下的
//  解码 → Worker(ESM, file://) → reduceResults → computeDisplayData → 渲染
//
//  检查项：Worker 分片路径生效、徽标状态、采样率保留、
//          频标正确、THD 接近 0、各图表数据非空
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// 复用真实主进程（窗口 + 全部 IPC 处理器）
require('../main.js');

const ROOT = path.resolve(__dirname, '..');
const F44 = path.join(ROOT, '.e2e-44k.wav');
const F96 = path.join(ROOT, '.e2e-96k.wav');
const TIMEOUT_MS = 90000;

function makeWav(file, sr, ch, secs, freq, amp) {
  const len = sr * secs, bps = 16, dataSize = len * ch * bps / 8;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * bps / 8, 28); buf.writeUInt16LE(ch * bps / 8, 32);
  buf.writeUInt16LE(bps, 34); buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < len; i++) {
    const v = Math.round(amp * Math.sin(2 * Math.PI * freq * i / sr) * 32767);
    for (let c = 0; c < ch; c++) { buf.writeInt16LE(v, o); o += 2; }
  }
  fs.writeFileSync(file, buf);
}

makeWav(F44, 44100, 2, 3, 1000, 0.8);
makeWav(F96, 96000, 2, 3, 1000, 0.5);

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); return !!cond; };

const cleanup = () => {
  for (const f of [F44, F96]) { try { fs.unlinkSync(f); } catch (_) {} }
};

const timer = setTimeout(() => {
  console.error('❌ 超时：未在 ' + (TIMEOUT_MS / 1000) + 's 内完成');
  cleanup();
  app.exit(1);
}, TIMEOUT_MS);

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) {
    console.error('❌ 未找到窗口');
    cleanup();
    return app.exit(1);
  }
  try {
    const r = await w.webContents.executeJavaScript(`
      (async () => {
        const H = window.__AA__;
        if (!H) return { fatal: 'window.__AA__ 未暴露（renderer 初始化失败）' };
        const { processFiles, STATE } = H;
        const load = async (p, name) => {
          const resp = await fetch('file:///' + p.split('\\\\').join('/'));
          const file = new File([await resp.blob()], name, { type: 'audio/wav' });
          await processFiles([file]);
          const A = STATE.analysis || {};
          return {
            sampleRate: STATE.sampleRate, channels: STATE.channels,
            peak: A.peak, rms: A.rms,
            chunked: A._chunked, chunkCount: A._chunkCount,
            spectrumLen: A.spectrum && A.spectrum.length,
            normLen: A.normSpectrum && A.normSpectrum.length,
            freqsFirst: A.freqs && A.freqs[0],
            freqsLast: A.freqs && A.freqs[A.freqs.length - 1],
            thdPct: A.distortion && A.distortion.thdPct,
            cutoffHz: A.cutoff && A.cutoff.freq,
            bandLabels: A.bandSpectrum && A.bandSpectrum.labels,
            bandFreqs: A.bandSpectrum && A.bandSpectrum.freqs.map(x => +x.toFixed(0)),
            waveform: (A.waveform || []).length,
            specCols: A.spectrogram ? A.spectrogram.data.length : 0,
            loudness: A.loudness && A.loudness.integratedLoudnessLUFS,
            badge: (document.getElementById('workerStatus') || {}).textContent,
            badgeClass: (document.getElementById('workerStatus') || {}).className,
          };
        };
        return {
          a: await load(${JSON.stringify(F44)}, 'e2e-44k.wav'),
          b: await load(${JSON.stringify(F96)}, 'e2e-96k.wav'),
        };
      })()
    `, true);

    if (r.fatal) {
      console.error('❌ ' + r.fatal);
      cleanup();
      return app.exit(1);
    }

    const EDGES = [20, 40, 80, 160, 315, 630, 1250, 2500, 5000, 10000, 20000];
    let i1k = -1;
    for (let i = 0; i < EDGES.length - 1; i++) if (1000 >= EDGES[i] && 1000 < EDGES[i + 1]) i1k = i;

    for (const [label, x, expectRate, expectRms] of [
      ['44.1kHz', r.a, 44100, 0.565685],
      ['96kHz', r.b, 96000, 0.353553],
    ]) {
      console.log(`\n--- ${label} ---`);
      console.log(JSON.stringify(x, null, 2));
      ok(x.chunked === true, `${label}: 未走 Worker 分片路径（_chunked=${x.chunked}）`);
      ok(x.sampleRate === expectRate, `${label}: 采样率 ${x.sampleRate}，期望 ${expectRate}`);
      ok(Math.abs(x.rms - expectRms) < 0.02, `${label}: RMS ${x.rms} 偏离 ${expectRms}`);
      ok(x.spectrumLen > 0 && x.spectrumLen === x.normLen, `${label}: spectrum/normSpectrum 长度异常`);
      ok(x.freqsFirst === 0, `${label}: freqs 应从 0 开始，实际 ${x.freqsFirst}`);
      ok(Math.abs(x.freqsLast - expectRate / 2) < expectRate / 512,
        `${label}: 频率轴上界 ${x.freqsLast} 与奈奎斯特 ${expectRate / 2} 不符`);
      ok(x.thdPct != null && x.thdPct < 1, `${label}: 纯正弦 THD=${x.thdPct}% 应 < 1%（原 bug 会报 ~178%）`);
      ok(x.bandFreqs && x.bandFreqs[i1k] === 887,
        `${label}: 1kHz 所在频段中心 ${x.bandFreqs && x.bandFreqs[i1k]}，期望 887`);
      ok(x.bandLabels && x.bandLabels[i1k] === '887',
        `${label}: 1kHz 所在频段标签 "${x.bandLabels && x.bandLabels[i1k]}"，期望 "887"`);
      ok(x.waveform >= 1900, `${label}: waveform 点数 ${x.waveform} 异常`);
      ok(x.specCols > 0, `${label}: spectrogram 为空`);
      ok(typeof x.badgeClass === 'string' && x.badgeClass.indexOf('idle') >= 0,
        `${label}: Worker 徽标类名异常 ${x.badgeClass}`);
    }

    console.log('\n' + (fails.length
      ? '❌ 端到端冒烟测试失败:\n - ' + fails.join('\n - ')
      : '✅ 端到端冒烟测试全部通过'));
    clearTimeout(timer);
    cleanup();
    app.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('❌ 执行异常:', e.message);
    console.error((e.stack || '').split('\n').slice(0, 6).join('\n'));
    clearTimeout(timer);
    cleanup();
    app.exit(1);
  }
}, 4500);
