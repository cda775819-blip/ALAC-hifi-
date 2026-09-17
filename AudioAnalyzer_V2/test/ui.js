// UI 冒烟 + 截图：验证新界面结构，并把窗口与库面板截图存盘以便肉眼审查
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../main.js');

const OUT = path.resolve(__dirname, '..', '.shot');
try { fs.mkdirSync(OUT, { recursive: true }); } catch (_) {}

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); return !!c; };

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('❌ 无窗口'); return app.exit(1); }
  try {
    // 等库扫描完成（默认 5s 内应扫完 3321 个文件）
    console.log('等待渲染与库扫描…');
    await new Promise(r => setTimeout(r, 7000));

    const r = await w.webContents.executeJavaScript(`
      (() => {
        const g = (id) => document.getElementById(id);
        const L = window.__LIB__;
        return {
          aa: !!window.__AA__,
          hasApp: !!document.querySelector('.app'),
          hasLib: !!document.querySelector('.library'),
          hasWelcome: !!g('welcome'),
          welcomeHidden: g('welcome') && g('welcome').classList.contains('hide'),
          navCount: document.querySelectorAll('.nav-item').length,
          cssOk: getComputedStyle(document.body).overflow === 'hidden',
          accent: getComputedStyle(document.documentElement).getPropertyValue('--am').trim(),
          bg0: getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim(),
          errors: window.__UI_ERRORS__ || [],
          lib: L ? {
            root: L.root, total: L.all.length, view: L.view.length,
            rows: document.querySelectorAll('.vrow').length,
            stat: (g('libStat')||{}).textContent,
            foot: (g('libFootStat')||{}).textContent,
            chips: document.querySelectorAll('.chip').length,
            err: L.err || null,
          } : null,
        };
      })()
    `, true);

    console.log('=== UI 结构 ===');
    console.log(JSON.stringify(r, null, 2));

    ok(r.aa, 'window.__AA__ 未就绪');
    ok(r.hasApp && r.hasLib, '骨架元素缺失');
    ok(r.navCount >= 14, `侧栏导航项 ${r.navCount} 个，期望 ≥14`);
    ok(r.cssOk, '新样式未生效（body overflow 不是 hidden）');
    ok(r.accent === '#ffb020', `琥珀色变量异常: ${r.accent}`);
    ok(r.bg0 === '#0a0b0d', `底色变量异常: ${r.bg0}`);

    // 库
    if (r.lib) {
      ok(r.lib.root, '库未扫描（root 为空）');
      ok(r.lib.total > 3000, `库条目 ${r.lib.total}，期望 >3000`);
      ok(r.lib.rows > 0 && r.lib.rows <= 540, `虚拟列表渲染行数 ${r.lib.rows}（应在 1..540 之间，证明虚拟化生效）`);
      ok(r.lib.chips >= 3, `筛选 chip 数 ${r.lib.chips}，期望 ≥3`);
      console.log(`\n✅ 虚拟化：库中 ${r.lib.total} 条，DOM 只渲染 ${r.lib.rows} 行`);
    } else {
      fails.push('window.__LIB__ 未暴露');
    }

    // 截图
    const img = await w.webContents.capturePage();
    const p1 = path.join(OUT, 'ui-welcome.png');
    fs.writeFileSync(p1, img.toPNG());
    console.log('截图: ' + p1);

    // 关掉欢迎屏再截一张（看主区 + 库）
    await w.webContents.executeJavaScript(`document.getElementById('welcome')?.classList.add('hide'); true`, true);
    await new Promise(r => setTimeout(r, 400));
    const img2 = await w.webContents.capturePage();
    const p2 = path.join(OUT, 'ui-main.png');
    fs.writeFileSync(p2, img2.toPNG());
    console.log('截图: ' + p2);

    console.log('\n' + (fails.length ? '❌ UI 冒烟失败:\n - ' + fails.join('\n - ') : '✅ UI 冒烟通过'));
    app.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('❌ 异常:', e.message);
    console.error((e.stack || '').split('\n').slice(0, 6).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('❌ 超时'); app.exit(1); }, 60000);
