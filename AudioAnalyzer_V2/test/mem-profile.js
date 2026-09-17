// 内存分段测量：定位峰值出现在解码/提取/分析/渲染的哪一段
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../main.js');

const ROOT = 'F:\\本地音乐文件';
const targets = [
  { label: '303MB M4A 192kHz', p: path.join(ROOT, 'Coldplay', 'Parachutes', "10 Everything's Not Lost.m4a") },
  { label: '464MB DSF 352.8kHz', p: path.join(ROOT, '新建文件夹 (2)', '09.杀死那个石家庄人.dsf') },
  { label: '1486MB FLAC 352.8kHz', p: path.join(ROOT, '新建文件夹', 'La Primavera, Op. 9737028.flac') },
].filter(t => { try { return fs.statSync(t.p).size > 0; } catch (_) { return false; } });

console.log('内存分段测量目标:');
targets.forEach(t => console.log(`  [${(fs.statSync(t.p).size / 1048576).toFixed(0)}MB] ${t.label}`));

// 主进程侧内存采样
let mpPeak = 0;
const mpTimer = setInterval(() => {
  const m = process.memoryUsage();
  mpPeak = Math.max(mpPeak, m.rss);
}, 100);

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('❌ 无窗口'); return app.exit(1); }
  try {
    for (const t of targets) {
      mpPeak = 0;
      console.log('\n' + '='.repeat(72));
      console.log(`▶ ${t.label}  文件 ${(fs.statSync(t.p).size / 1048576).toFixed(0)}MB`);
      console.log('='.repeat(72));

      // 渲染进程内存采样（在页面内轮询）
      const r = await w.webContents.executeJavaScript(`
        (async () => {
          const api = window.__AA__;
          const mem = window.performance && performance.memory;
          const samples = [];
          let peakUsed = 0, peakTotal = 0;
          const timer = setInterval(() => {
            if (!mem) return;
            peakUsed = Math.max(peakUsed, mem.usedJSHeapSize);
            peakTotal = Math.max(peakTotal, mem.totalJSHeapSize);
          }, 60);

          window.__AA_PHASE_TIMING__ = null;
          const t0 = performance.now();
          let err = null;
          try {
            await api.analyzePath(${JSON.stringify(t.p)});
          } catch (e) { err = String(e && e.message || e); }
          const ms = performance.now() - t0;
          clearInterval(timer);
          await new Promise(r => setTimeout(r, 80));   // 让末次采样落地

          const st = api.STATE;
          const A = st.analysis || {};
          return {
            ok: !err, err, ms,
            phases: (window.__AA_PHASE_TIMING__ || []).slice(),
            peakUsedMB: mem ? peakUsed / 1048576 : null,
            peakTotalMB: mem ? peakTotal / 1048576 : null,
            limitMB: mem ? mem.jsHeapSizeLimit / 1048576 : null,
            sampleRate: st.sampleRate, channels: st.channels,
            duration: st.formatInfo && st.formatInfo.duration,
            decodeMethod: st.formatInfo && st.formatInfo.decodeMethod,
            specCols: A.spectrogram ? A.spectrogram.data.length : 0,
          };
        })()
      `, true);

      if (!r.ok) { console.log(`  ❌ 失败: ${r.err}`); continue; }

      const sr = r.sampleRate || 0;
      const dur = r.duration || 0;
      // 解码后 PCM 的理论大小（float32 × 声道）
      const pcmMB = dur * sr * (r.channels || 2) * 4 / 1048576;

      console.log(`  解码方式    : ${r.decodeMethod}`);
      console.log(`  采样率/时长 : ${sr} Hz / ${dur.toFixed(1)}s`);
      console.log(`  PCM 理论大小: ${pcmMB.toFixed(0)} MB  (${dur.toFixed(0)}s × ${sr} × ${r.channels}ch × 4B)`);
      console.log(`  频谱图      : ${r.specCols} 列`);
      console.log(`  总耗时      : ${(r.ms / 1000).toFixed(1)}s`);
      console.log(`\n  渲染进程 JS 堆峰值: ${r.peakUsedMB ? r.peakUsedMB.toFixed(0) : 'n/a'} MB  (上限 ${r.limitMB ? r.limitMB.toFixed(0) : '?'} MB)`);
      console.log(`  主进程 RSS 峰值  : ${(mpPeak / 1048576).toFixed(0)} MB`);
      if (r.peakUsedMB && r.limitMB) {
        const pct = r.peakUsedMB / r.limitMB * 100;
        console.log(`  堆占用比         : ${pct.toFixed(1)}%  ${pct > 70 ? '⚠ 接近上限，大文件可能 OOM' : '✅'}`);
      }
      console.log(`\n  阶段分解:`);
      r.phases.forEach(x => console.log(`     ${String(x.ms).padStart(6)}ms  ${x.name}`));
    }
    clearInterval(mpTimer);
    app.exit(0);
  } catch (e) {
    clearInterval(mpTimer);
    console.error('❌ 异常:', e.message, (e.stack || '').split('\n').slice(0, 5).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('❌ 超时'); app.exit(1); }, 600000);
