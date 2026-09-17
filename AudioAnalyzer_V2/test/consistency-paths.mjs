// 一致性验证：同一条音频，原生解码路径 vs FFmpeg 分段解码路径，
// 你的分析算法输出指标是否一致？
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { app, BrowserWindow } = require('electron');
require('../main.js');

const TARGET = 'F:\\本地音乐文件\\1989\\02 Blank Space.m4a';   // 27MB ALAC 44.1kHz
const SIZE = fs.statSync(TARGET).size;

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('无窗口'); return app.exit(1); }

  const mathSrc = fs.readFileSync(path.join(ROOT, 'utils', 'audioMath.js'), 'utf8')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*logger[^'"]*['"];?/g, 'const D={ok(){},info(){},warn(){},err(){}};')
    .replace(/^let D\s*=.*$/m, '');

  try {
    const r = await w.webContents.executeJavaScript(`
      (async () => {
        const api = window.__AA__;
        const d = api._diag;
        const out = {};

        // ① 原生路径
        await api.analyzePath(${JSON.stringify(TARGET)}, ${SIZE});
        const A0 = api.STATE.analysis;
        const F0 = api.STATE.formatInfo;
        out.native = {
          method: F0.decodeMethod,
          sampleRate: api.STATE.sampleRate,
          duration: F0.duration,
          peak: A0.peak, rms: A0.rms,
          crest: A0.dynamics && A0.dynamics.crest,
          lufs: A0.loudness && A0.loudness.integratedLoudnessLUFS,
          lra: A0.loudness && A0.loudness.lra,
          thd: A0.distortion && A0.distortion.thdPct,
          fundHz: A0.distortion && A0.distortion.fundamentalHz,
          cutoff: A0.cutoff && A0.cutoff.freq,
          snr: A0.snr && A0.snr.snrDB,
          bitDepth: A0.actualBitDepth && A0.actualBitDepth.estimated,
          dcOffset: A0.dcOffset && A0.dcOffset.offset,
          correlation: A0.stereo && A0.stereo.correlation,
          stereoWidth: A0.stereo && A0.stereo.stereoWidth,
          clipped: A0.clip && A0.clip.clippedSamples,
          bandLabels: A0.bandSpectrum && A0.bandSpectrum.labels,
          bandValues: A0.bandSpectrum && A0.bandSpectrum.values.map(v => +v.toFixed(2)),
          specCols: A0.spectrogram ? A0.spectrogram.data.length : 0,
          waveform: (A0.waveform || []).length,
        };

        // ② FFmpeg 分段解码
        const fake = new File([], 'x.m4a');
        Object.defineProperty(fake, 'path', { value: ${JSON.stringify(TARGET)}, configurable: true });
        Object.defineProperty(fake, 'size', { value: ${SIZE}, configurable: true });
        const dec = await d.decodeLargeViaFFmpeg(fake, 44100);
        out.ffmpeg = {
          sampleRate: dec.sampleRate, channels: dec.channels,
          frames: dec.buffer.length,
          seconds: +(dec.buffer.length / dec.sampleRate).toFixed(1),
        };

        // ③ 同一套分析链
        const pcm = [];
        for (let c = 0; c < dec.buffer.numberOfChannels; c++) {
          pcm.push(new Float32Array(dec.buffer.getChannelData(c)));
        }
        const raw = await api.engine.run(pcm, dec.sampleRate);
        const ch0 = pcm[0];
        const nn = raw.normSpectrumDB;
        const ff = raw.spectrum.map((_, i) => i * (raw.binHz || (raw.sampleRate / 2) / raw.spectrum.length));

        const src = ${JSON.stringify(mathSrc)};
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const AM = await import(url);
        const adv = {
          loudness: AM.computeLoudness(ch0, dec.sampleRate),
          bitDepth: AM.estimateBitDepth(ch0, F0),
          snr: AM.computeSNR(ch0, dec.sampleRate),
        };
        if (ff && nn) {
          adv.distortion = AM.computeDistortion(ch0, dec.sampleRate, ff, nn);
          adv.cutoff = AM.detectCutoff(ff, nn, dec.sampleRate);
        }
        const dd = await api.computeDisplayData(pcm, dec.sampleRate);

        out.ffmpegMetrics = {
          peak: raw.peak, rms: raw.rms,
          crest: raw.crestFactor,
          lufs: adv.loudness && adv.loudness.integratedLoudnessLUFS,
          lra: adv.loudness && adv.loudness.lra,
          thd: adv.distortion && adv.distortion.thdPct,
          fundHz: adv.distortion && adv.distortion.fundamentalHz,
          cutoff: adv.cutoff && adv.cutoff.freq,
          snr: adv.snr && adv.snr.snrDB,
          bitDepth: adv.bitDepth && adv.bitDepth.estimated,
          dcOffset: raw.dcOffset,
          correlation: raw.stereoCorrelation,
          stereoWidth: raw.stereoWidth,
          clipped: raw.clippedSamples,
          bandLabels: dd.bandSpectrum && dd.bandSpectrum.labels,
          bandValues: dd.bandSpectrum && dd.bandSpectrum.values.map(v => +v.toFixed(2)),
          specCols: dd.spectrogram ? dd.spectrogram.data.length : 0,
          waveform: (dd.waveform || []).length,
        };
        return out;
      })()
    `, true);

    console.log('=== ① 原生路径（库内 27MB ALAC 当前走的就是这条）===');
    console.log(JSON.stringify(r.native, null, 2));
    console.log('\n=== ② FFmpeg 分段解码 ===');
    console.log(JSON.stringify(r.ffmpeg, null, 2));

    console.log('\n=== ③ 同一套算法指标对比 ===');
    console.log('指标                     原生路径       FFmpeg路径       相对差');
    console.log('-'.repeat(68));
    const keys = ['peak', 'rms', 'crest', 'lufs', 'lra', 'thd', 'fundHz', 'cutoff', 'snr',
      'bitDepth', 'dcOffset', 'correlation', 'stereoWidth', 'clipped', 'specCols', 'waveform'];
    const bigDiff = [];
    for (const k of keys) {
      const a = r.native[k], b = r.ffmpegMetrics[k];
      let rel = '';
      if (typeof a === 'number' && typeof b === 'number' && a !== 0) {
        const d2 = (b - a) / Math.abs(a);
        rel = (d2 * 100).toFixed(2) + '%';
        if (Math.abs(d2) > 0.05) bigDiff.push(`${k}: ${a} → ${b}`);
      } else if (a === b) rel = '相同';
      console.log(`${k.padEnd(22)} ${String(a).padStart(12)} ${String(b).padStart(14)} ${rel.padStart(11)}`);
    }

    console.log('\n=== 频段值对比 ===');
    console.log('段      原生      FFmpeg      差');
    const bl = r.native.bandLabels || [];
    for (let i = 0; i < (r.native.bandValues || []).length; i++) {
      const a = r.native.bandValues[i], b = r.ffmpegMetrics.bandValues[i];
      console.log(`${String(bl[i]).padStart(6)} ${String(a).padStart(8)} ${String(b).padStart(10)} ${(b - a).toFixed(2).padStart(8)}`);
    }

    console.log('\n=== 结论 ===');
    if (bigDiff.length === 0) {
      console.log('✅ 两条解码路径下全部指标相对差 < 5% —— 算法结果一致');
    } else {
      console.log(`⚠ ${bigDiff.length} 项差异 > 5%:`);
      bigDiff.forEach(x => console.log('   · ' + x));
    }

    app.exit(0);
  } catch (e) {
    console.error('异常:', e.message, (e.stack || '').split('\n').slice(0, 6).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('超时'); app.exit(1); }, 600000);
