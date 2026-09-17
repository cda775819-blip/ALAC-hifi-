// 关键验证：小文件（原生解码路径）的采样率是否被静默降级到系统默认
// 背景：parseFormatFromBytes 对 M4A/ALAC 报 sampleRate=1，
//       tryAudioElementDecode 收到 1 后不在 [8000,192000] 区间，
//       会退回 audioCtx.sampleRate（Windows 上通常是 48000）。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../main.js');

const ROOT = 'F:\\本地音乐文件';
const AUDIO_EXT = new Set(['.m4a', '.flac', '.wav', '.mp3', '.dsf']);

// 挑若干小于 32MB 的文件，尽量覆盖不同采样率
function collect(dir, depth, out, limit) {
  if (depth > 8 || out.length >= limit) return;
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of es) {
    if (out.length >= limit) return;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collect(full, depth + 1, out, limit);
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.size < 32 * 1024 * 1024 && st.size > 1024 * 1024) out.push({ p: full, size: st.size, ext });
    }
  }
}
const files = [];
collect(ROOT, 1, files, 40);
console.log(`候选（1-32MB）: ${files.length} 个\n`);

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('无窗口'); return app.exit(1); }
  try {
    // 系统默认上下文采样率
    const sysRate = await w.webContents.executeJavaScript(
      'new (window.AudioContext || window.webkitAudioContext)().sampleRate', true);
    console.log(`系统 AudioContext 默认采样率 = ${sysRate} Hz`);
    console.log(`（若某文件分析结果的采样率 == 这个值，就要怀疑被静默降级）\n`);
    console.log('文件                                    大小    ffprobe真值  分析结果   判定');
    console.log('-'.repeat(96));

    let suspicious = 0, checked = 0;
    for (const f of files.slice(0, 14)) {
      const r = await w.webContents.executeJavaScript(`
        (async () => {
          const api = window.__AA__;
          const d = api._diag;
          let probe = null;
          try { probe = await window.electronAPI.probeAudio(${JSON.stringify(f.p)}); } catch (_) {}
          let info = null, err = null;
          try {
            await api.analyzePath(${JSON.stringify(f.p)}, ${f.size});
            const F = api.STATE.formatInfo || {};
            info = { rate: api.STATE.sampleRate, method: F.decodeMethod, codec: F.codec };
          } catch (e) { err = String(e && e.message || e); }
          return { probe, info, err };
        })()
      `, true);

      const probeRate = r.probe && r.probe.ok ? r.probe.sampleRate : null;
      const gotRate = r.info ? r.info.rate : null;
      const mismatch = probeRate && gotRate && probeRate !== gotRate;
      if (mismatch) suspicious++;
      checked++;
      const label = `${path.basename(f.p).slice(0, 34)} [${f.ext}]`;
      console.log(
        `${label.padEnd(40)} ${(f.size / 1048576).toFixed(0).padStart(4)}MB ` +
        `${String(probeRate).padStart(11)} ${String(gotRate).padStart(10)}   ` +
        `${r.err ? '❌ ' + r.err.slice(0, 30) : (mismatch ? '⚠ 不一致 (差 ' + (gotRate / probeRate).toFixed(2) + 'x)' : '✅')}`
      );
      if (r.info) console.log(`      → 解码方式: ${r.info.method}  codec=${r.info.codec}`);
    }

    console.log(`\n=== 汇总 ===`);
    console.log(`  检查 ${checked} 个，采样率与 ffprobe 不一致: ${suspicious}`);
    if (suspicious > 0) {
      console.log(`\n  ⚠ 说明小文件路径确实存在采样率降级：`);
      console.log(`     parseFormatFromBytes 对 M4A/ALAC 返回 sampleRate=1，`);
      console.log(`     导致 tryAudioElementDecode 退回系统默认 ${sysRate}Hz。`);
      console.log(`     这会直接损害「升采样假无损检测」—— 正是本工具的核心卖点。`);
    } else {
      console.log('  ✅ 全部一致');
    }

    app.exit(0);
  } catch (e) {
    console.error('异常:', e.message, (e.stack || '').split('\n').slice(0, 5).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('超时'); app.exit(1); }, 600000);
