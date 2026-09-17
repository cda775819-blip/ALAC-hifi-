// 分段耗时插桩：定位高采样率长文件「30-55 秒」的真实瓶颈
// 直接对 app.js 的 computeDisplayData 注入计时，不改产品代码
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../main.js');

// 200MB 限制：超过则只降混不重采样（不引入 352.8k 也不失败）
const big = 'F:\\本地音乐文件\\新建文件夹 (2)\\09.杀死那个石家庄人.dsf';        // 464MB DSF 352.8kHz
const mid = 'F:\\本地音乐文件\\New folder'.replace('New folder', '黄凯芹');     // 占位，后面动态挑
const small = 'F:\\本地音乐文件\\1989\\02 Blank Space.m4a';                    // 27MB M4A 44.1kHz

const AUDIO_EXT = new Set(['.wav','.flac','.m4a','.dsf','.mp3','.mp4']);
function pick(dir, depth, out) {
  if (depth > 8 || out.length) return;
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of es) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) pick(full, depth + 1, out);
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      const st = fs.statSync(full);
      if (st.size > 40e6 && st.size < 90e6) { out.push({ path: full, size: st.size }); return; }
    }
    if (out.length) return;
  }
}
const midPick = [];
pick('F:\\本地音乐文件', 1, midPick);

const targets = [
  { label: '小 27MB / 44.1kHz', path: small },
  { label: '中 ' + (midPick[0] ? (midPick[0].size / 1048576).toFixed(0) + 'MB' : 'n/a'), path: midPick[0] && midPick[0].path },
  { label: '大 464MB / 352.8kHz DSD', path: big },
].filter(t => t.path && fs.existsSync(t.path));

console.log('插桩目标:');
targets.forEach(t => console.log(`  ${t.label}\n    ${t.path}`));
console.log(`  文件大小: ${targets.map(t => (fs.statSync(t.path).size / 1048576).toFixed(0) + 'MB').join(', ')}\n`);

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('❌ 无窗口'); return app.exit(1); }
  try {
    for (const t of targets) {
      console.log('='.repeat(78));
      console.log(`▶ ${t.label}`);
      console.log('='.repeat(78));

      const r = await w.webContents.executeJavaScript(`
        (async () => {
          const api = window.__AA__;
          const st = api.STATE;
          window.__AA_DD_TIMING__ = null;
          window.__AA_PHASE_TIMING__ = null;
          window.__TRACE_PHASE__ = false;

          const tStart = performance.now();
          await api.analyzePath(${JSON.stringify(t.path)});
          // 让渲染任务跑完，再用独立微任务读取分段标记（同微任务内读会拿到旧值）
          await new Promise(r => setTimeout(r, 60));
          const stages = (window.__AA_DD_TIMING__ || []).slice();
          const phases = (window.__AA_PHASE_TIMING__ || []).slice();

          const A = st.analysis || {};
          return {
            ok: true,
            sampleRate: st.sampleRate, channels: st.channels,
            decodeMethod: st.formatInfo && st.formatInfo.decodeMethod,
            duration: st.formatInfo && st.formatInfo.duration,
            fileSize: st.formatInfo && st.formatInfo.fileSize,
            specCols: A.spectrogram ? A.spectrogram.data.length : 0,
            specRows: A.spectrogram && A.spectrogram.data[0] ? A.spectrogram.data[0].length : 0,
            specCells: A.spectrogram ? A.spectrogram.data.length * (A.spectrogram.data[0]||[]).length : 0,
            waveform: (A.waveform||[]).length,
            totalMs: performance.now() - tStart,
            stages, phases,
          };
        })()
      `, true);

      if (!r.ok) { console.log('  ❌ 失败', r); continue; }
      console.log(`  解码方式    : ${r.decodeMethod}`);
      console.log(`  采样率/声道 : ${r.sampleRate} Hz / ${r.channels}ch`);
      console.log(`  时长        : ${r.duration ? r.duration.toFixed(1) + 's (' + (r.duration/60).toFixed(1) + '分)' : '-'}`);
      console.log(`  文件大小    : ${r.fileSize ? (r.fileSize/1048576).toFixed(1) + ' MB' : '-'}`);
      console.log(`  频谱图      : ${r.specCols} 列 × ${r.specRows} bins = ${(r.specCells/1e6).toFixed(2)}M 格`);
      console.log(`  波形点数    : ${r.waveform}`);
      console.log(`  总耗时      : ${(r.totalMs/1000).toFixed(1)}s`);
      if (r.phases && r.phases.length) {
        const sum = r.phases.reduce((s, x) => s + x.ms, 0);
        console.log(`\n  ▶ 全流程分段（合计 ${sum}ms）:`);
        r.phases.forEach(x => {
          const pct = sum ? (x.ms / sum * 100) : 0;
          const bar = '█'.repeat(Math.max(1, Math.round(pct / 3)));
          console.log(`     ${String(x.ms).padStart(6)}ms ${String(pct.toFixed(0)).padStart(3)}% ${bar} ${x.name}`);
        });
      }
      if (r.stages && r.stages.length) {
        const sum = r.stages.reduce((s, x) => s + x.ms, 0);
        console.log(`\n  ▶ computeDisplayData 细分（合计 ${sum}ms）:`);
        r.stages.forEach(x => {
          const pct = sum ? (x.ms / sum * 100) : 0;
          const bar = '█'.repeat(Math.max(1, Math.round(pct / 4)));
          console.log(`     ${String(x.ms).padStart(6)}ms ${String(pct.toFixed(0)).padStart(3)}% ${bar} ${x.name}`);
        });
      }
      console.log('');
    }
    app.exit(0);
  } catch (e) {
    console.error('❌ 异常:', e.message, (e.stack || '').split('\n').slice(0, 6).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('❌ 超时'); app.exit(1); }, 420000);
