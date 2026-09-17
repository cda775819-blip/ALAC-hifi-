// 极限测试 B：跨格式/跨大小分层抽样 + 完整分析链路
// 在真实 Electron 中跑，覆盖：解码 → Worker → reduceResults → computeDisplayData → 渲染
// 严格只读：文件由主进程读取，从不写入/移动
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../main.js');

const ROOT = 'F:\\本地音乐文件';
const AUDIO_EXT = new Set(['.wav','.flac','.aiff','.aif','.mp3','.m4a','.aac','.ogg','.opus','.wma','.ape','.wv','.tta','.dsf','.dff','.caf','.ac3','.eac3','.mka','.webm','.mp4','.alac']);

// ── 收集 + 分层抽样 ──
const all = [];
(function walk(dir, depth) {
  if (depth > 8) return;
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of es) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      all.push({ path: full, name: e.name, ext: ext.slice(1), size: st.size });
    }
  }
})(ROOT, 1);

// 策略：每个格式按大小排序后取 小/中/大 三点；再加已知异常文件与极值
const byExt = new Map();
for (const f of all) { if (!byExt.has(f.ext)) byExt.set(f.ext, []); byExt.get(f.ext).push(f); }

const picked = [];
for (const [ext, list] of byExt) {
  list.sort((a, b) => a.size - b.size);
  const want = Math.min(list.length, 3);
  for (let i = 0; i < want; i++) {
    const idx = want === 1 ? 0 : Math.round(i * (list.length - 1) / (want - 1));
    picked.push(list[idx]);
  }
}
// 已知异常：扩展名说谎的 .flac(实为 M4A)
const liars = all.filter(f => f.name.endsWith('.flac') && f.path.includes('QQ\\'));
if (liars[0]) picked.push(liars[0]);
// 体积极值
picked.push(all.slice().sort((a, b) => b.size - a.size)[0]);
picked.push(all.slice().sort((a, b) => a.size - b.size)[0]);

// 去重
const seen = new Set();
const sample = picked.filter(f => !seen.has(f.path) && seen.add(f.path));

console.log(`库内 ${all.length} 个文件，抽样 ${sample.length} 个：`);
sample.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. [${(f.size / 1048576).toFixed(1).padStart(6)}MB] ${f.ext.padEnd(5)} ${f.name}`));

const fails = [];
const warn = [];
const results = [];
let peakRss = 0, peakHeap = 0;
const memTimer = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}, 200);

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('❌ 无窗口'); return app.exit(1); }
  try {
    const t0 = Date.now();
    console.log('\n开始逐个分析（真实完整链路）…\n');
    console.log('  #  格式    大小     耗时    采样率    声道  峰值      RMS      频谱  片段  判定');
    console.log('  ' + '-'.repeat(94));

    const EXTS = ['flac', 'm4a'];
    for (let i = 0; i < sample.length; i++) {
      const f = sample[i];
      const t = Date.now();
      const r = await w.webContents.executeJavaScript(`
        (async () => {
          const api = window.__AA__;
          try {
            await api.analyzePath(${JSON.stringify(f.path)}, ${f.size});
            const A = api.STATE.analysis || {};
            const F = api.STATE.formatInfo || {};
            return {
              ok: true,
              codec: F.codec, container: F.container, lossless: F.lossless,
              fileExt: F.fileExt, decodeMethod: F.decodeMethod,
              sampleRate: api.STATE.sampleRate, channels: api.STATE.channels,
              peak: A.peak, rms: A.rms,
              spectrumLen: A.spectrum && A.spectrum.length,
              chunked: A._chunked, chunkCount: A._chunkCount,
              thd: A.distortion && A.distortion.thdPct,
              cutoff: A.cutoff && A.cutoff.freq,
              band0: A.bandSpectrum && A.bandSpectrum.values[0],
              waveform: (A.waveform||[]).length,
              specCols: A.spectrogram ? A.spectrogram.data.length : 0,
              clip: A.clip && A.clip.clippedSamples,
              lufs: A.loudness && A.loudness.integratedLoudnessLUFS,
              sections: document.querySelectorAll('#results .section').length,
              nanFree: [A.peak, A.rms, A.dynamics && A.dynamics.crest, A.loudness && A.loudness.integratedLoudnessLUFS]
                        .every(v => v == null || Number.isFinite(v)),
            };
          } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        })()
      `, true);

      const ms = Date.now() - t;
      results.push({ file: f, ms, r });

      if (!r.ok) {
        fails.push(`${f.name}: 分析失败 — ${r.error}`);
        console.log(`  ${String(i + 1).padStart(2)}  ${f.ext.padEnd(5)} ${(f.size/1048576).toFixed(1).padStart(6)}MB ${String(ms).padStart(5)}ms  ❌ ${r.error}`);
        continue;
      }

      // ── 断言 ──
      const problems = [];
      if (r.chunked !== true) problems.push('未走Worker');
      if (r.spectrumLen !== 1024) problems.push(`频谱长度${r.spectrumLen}≠1024`);
      if (!r.waveform) problems.push('波形为空');
      if (!r.specCols) problems.push('频谱图为空');
      if (r.sections < 12) problems.push(`section仅${r.sections}`);
      if (!r.nanFree) problems.push('含NaN');
      if (!r.sampleRate || r.sampleRate < 8000) problems.push(`采样率${r.sampleRate}`);
      if (!(r.channels >= 1 && r.channels <= 8)) problems.push(`声道${r.channels}`);

      // 数值范围检查（这是"极限测试"该做的：不只验证跑通，还要验证结果合理）
      if (r.peak != null && (r.peak < 0 || r.peak > 1.0001)) problems.push(`峰值越界 ${r.peak}`);
      if (r.rms != null && (r.rms < 0 || r.rms > 1.0001)) problems.push(`RMS越界 ${r.rms}`);
      if (r.peak != null && r.rms != null && r.rms > r.peak + 1e-6) problems.push(`RMS(${r.rms.toFixed(4)}) > 峰值(${r.peak.toFixed(4)})`);
      if (r.thd != null && (r.thd < 0 || r.thd > 100)) problems.push(`THD 越界 ${r.thd}%`);
      if (r.lufs != null && (r.lufs < -70 || r.lufs > 5)) problems.push(`LUFS 越界 ${r.lufs}`);
      if (r.cutoff != null && (r.cutoff <= 0 || r.cutoff > r.sampleRate / 2 + 1)) problems.push(`截止频率越界 ${r.cutoff}`);
      if (r.band0 != null && !Number.isFinite(r.band0)) problems.push('低频段值非有限');
      if (r.clip != null && r.clip < 0) problems.push(`削波数为负 ${r.clip}`);

      // 扩展名与容器一致性
      const liar = (f.ext === 'flac' && r.container === 'M4A') || (f.ext === 'm4a' && r.container === 'FLAC');
      if (liar) warn.push(`${f.name}\n      → 扩展名 .${f.ext}，实际容器 ${r.container}；应用报 codec=${r.codec} / container=${r.container}`);

      if (problems.length) fails.push(`${f.name}: ${problems.join(', ')}`);

      const verdict = problems.length ? '❌ ' + problems.join(',') : '✅';
      console.log(`  ${String(i + 1).padStart(2)}  ${f.ext.padEnd(5)} ${(f.size/1048576).toFixed(1).padStart(6)}MB ${String(ms).padStart(5)}ms  ${String(r.sampleRate).padStart(7)}  ${String(r.channels).padStart(2)}ch  ${(r.peak==null?'-':r.peak.toFixed(3)).padStart(7)} ${(r.rms==null?'-':r.rms.toFixed(4)).padStart(8)} ${String(r.spectrumLen).padStart(5)} ${String(r.specCols).padStart(5)}  ${verdict}`);
    }

    const total = Date.now() - t0;
    clearInterval(memTimer);
    const totalMB = sample.reduce((s, f) => s + f.size, 0);

    console.log(`\n=== B 段汇总 ===`);
    console.log(`  抽样           : ${sample.length} 个文件，${(totalMB / 1073741824).toFixed(2)} GB`);
    console.log(`  总耗时         : ${(total / 1000).toFixed(1)}s`);
    console.log(`  平均           : ${(total / sample.length).toFixed(0)}ms/文件`);
    console.log(`  吞吐           : ${(totalMB / 1048576 / (total / 1000)).toFixed(1)} MB/s`);
    console.log(`  进程峰值 RSS   : ${(peakRss / 1048576).toFixed(0)} MB`);
    console.log(`  进程峰值 Heap  : ${(peakHeap / 1048576).toFixed(0)} MB`);

    const slowest = results.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`\n  最慢 5 个:`);
    slowest.forEach(s => console.log(`    ${String(s.ms).padStart(6)}ms  ${(s.file.size/1048576).toFixed(1).padStart(7)}MB  ${s.file.name}`));

    if (warn.length) {
      console.log(`\n⚠ 扩展名与容器不符（${warn.length}）:`);
      warn.forEach(x => console.log('  ' + x));
    }
    if (fails.length) {
      console.log(`\n❌ 失败 ${fails.length}:`);
      fails.forEach(x => console.log('  - ' + x));
    }
    console.log('\n' + (fails.length ? '❌ B 段存在失败项' : '✅ B 段全部通过'));
    app.exit(fails.length ? 1 : 0);
  } catch (e) {
    clearInterval(memTimer);
    console.error('❌ 异常:', e.message, (e.stack || '').split('\n').slice(0, 6).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('❌ 超时（10 分钟）'); app.exit(1); }, 600000);
