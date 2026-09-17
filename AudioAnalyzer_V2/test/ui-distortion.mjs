// UI 渲染验证：确认失真卡片在「估算不可用」时不显示误导性数值，且不崩溃
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { app, BrowserWindow } = require('electron');
require('../main.js');

// 一个复音音乐文件（limitHit 应为 true）＋ 一个纯音测试文件（应给出正常 THD）
const MUSIC = 'F:\\本地音乐文件\\1989\\02 Blank Space.m4a';

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  const fails = [];
  try {
    const musicSize = fs.statSync(MUSIC).size;
    const r = await w.webContents.executeJavaScript(`
      (async () => {
        const api = window.__AA__;
        await api.analyzePath(${JSON.stringify(MUSIC)}, ${musicSize});
        const A = api.STATE.analysis;
        // 找到失真 section 的 HTML
        const sec = document.getElementById('section-distortion');
        return {
          limitHit: A.distortion && A.distortion.limitHit,
          thdPct: A.distortion && A.distortion.thdPct,
          hasCanvas: !!(sec && sec.querySelector('#distortionCanvas')),
          sectionText: sec ? sec.innerText.slice(0, 260) : null,
          renderErr: (sec && sec.innerText.includes('渲染错误')) || false,
        };
      })()
    `, true);

    console.log('=== 失真卡片渲染验证（复音音乐文件）===');
    console.log(`  limitHit      = ${r.limitHit}`);
    console.log(`  原始 thdPct   = ${r.thdPct}`);
    console.log(`  绘制了柱状图  = ${r.hasCanvas}   (limitHit 时应为 false)`);
    console.log(`  渲染报错      = ${r.renderErr}`);
    console.log(`\n  卡片文字:\n${(r.sectionText || '').split('\n').map(s => '    ' + s).join('\n')}`);

    if (r.renderErr) fails.push('失真卡片渲染报错');
    if (r.limitHit && r.hasCanvas) fails.push('limitHit 时仍绘制了误导性柱状图');
    if (r.limitHit && r.sectionText && r.sectionText.includes('100.000%')) {
      fails.push('UI 仍显示 100.000% 这种误导数值');
    }
    if (r.limitHit && r.sectionText && !/无法给出可靠/.test(r.sectionText)) {
      fails.push('未提示「无法给出可靠 THD」');
    }

    console.log('\n' + (fails.length ? '❌ 失败:\n - ' + fails.join('\n - ') : '✅ 失真卡片行为正确'));
    app.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('异常:', e.message, (e.stack || '').split('\n').slice(0, 5).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('超时'); app.exit(1); }, 300000);
