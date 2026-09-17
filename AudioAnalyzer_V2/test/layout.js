// 布局几何断言：不依赖肉眼，直接量化每个区域的位置/尺寸/溢出/重叠
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('../main.js');

const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); return !!c; };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}（实际 ${typeof a === 'number' ? a.toFixed(1) : a}，期望 ${b}±${tol}）`);

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) { console.error('❌ 无窗口'); return app.exit(1); }
  try {
    await new Promise(r => setTimeout(r, 7000));

    const r = await w.webContents.executeJavaScript(`
      (() => {
        const R = (s) => { const e = document.querySelector(s); if (!e) return null;
          const b = e.getBoundingClientRect();
          return { x:Math.round(b.x), y:Math.round(b.y), w:Math.round(b.width), h:Math.round(b.height) }; };
        const vw = window.innerWidth, vh = window.innerHeight;
        // 检查页面是否出现意外滚动条（= 溢出）
        const overflowX = document.documentElement.scrollWidth > vw + 1;
        const overflowY = document.documentElement.scrollHeight > vh + 1;
        // 主区内容是否可滚动且未溢出
        const content = document.querySelector('.content');
        const libBody = document.querySelector('#libBody');
        // 侧栏文字是否被裁切
        const nav = document.querySelector('.nav-item');
        const navText = nav ? nav.innerText.trim() : '';
        return {
          vw, vh, overflowX, overflowY,
          app: R('.app'), sidebar: R('.sidebar'), topbar: R('.topbar'),
          library: R('.library'), main: R('.main'), statusbar: R('.statusbar'),
          content: R('.content'), libHead: R('.lib-head'), libFoot: R('.lib-foot'),
          search: R('#libSearch'), firstRow: R('.vrow'),
          navText,
          navVisible: nav ? getComputedStyle(nav).display !== 'none' : false,
          contentScrollable: content ? content.scrollHeight > content.clientHeight : false,
          libScrollable: libBody ? libBody.scrollHeight > libBody.clientHeight : false,
          libRows: document.querySelectorAll('.vrow').length,
          docScrollW: document.documentElement.scrollWidth,
          docScrollH: document.documentElement.scrollHeight,
        };
      })()
    `, true);

    console.log('=== 视口 ===');
    console.log(`  ${r.vw} × ${r.vh}   文档尺寸 ${r.docScrollW} × ${r.docScrollH}`);
    console.log(`  横向溢出: ${r.overflowX}   纵向溢出: ${r.overflowY}`);
    console.log('\n=== 区域几何 (x, y, w, h) ===');
    for (const k of ['app', 'sidebar', 'topbar', 'library', 'main', 'statusbar', 'content', 'libHead', 'libFoot', 'search', 'firstRow']) {
      const g = r[k];
      console.log(`  ${k.padEnd(11)} ${g ? `x=${String(g.x).padStart(4)} y=${String(g.y).padStart(3)} w=${String(g.w).padStart(4)} h=${String(g.h).padStart(4)}` : 'null'}`);
    }
    console.log(`\n  侧栏首个导航项文字: "${r.navText}"`);
    console.log(`  .content 可滚动: ${r.contentScrollable}   #libBody 可滚动: ${r.libScrollable}   已渲染行: ${r.libRows}`);

    // ── 断言 ──
    ok(!r.overflowX, '页面出现横向溢出（布局超出视口）');
    ok(!r.overflowY, '页面出现纵向溢出（布局超出视口）');

    ok(r.sidebar && r.sidebar.w > 40, '侧栏宽度异常');
    ok(r.library && r.library.w > 200, `库面板宽度 ${r.library && r.library.w}，期望 >200`);

    // 顶栏应横跨「库面板 + 主区」，不压住侧栏
    if (r.topbar && r.sidebar) near(r.topbar.x, r.sidebar.w, 2, '顶栏左边界应紧贴侧栏右边界');
    if (r.topbar) near(r.topbar.h, 48, 3, '顶栏高度');

    // 三列横向拼接无缝隙、无重叠
    if (r.sidebar && r.library && r.main) {
      near(r.library.x, r.sidebar.w, 2, '库面板应紧接侧栏');
      near(r.main.x, r.library.x + r.library.w, 2, '主区应紧接库面板');
      near(r.main.x + r.main.w, r.vw, 2, '主区右边界应贴合视口右边');
    }

    // 纵向：顶栏 → 库/主区 → 状态栏
    if (r.library && r.topbar && r.statusbar) {
      near(r.library.y, r.topbar.h, 2, '库面板顶部应紧接顶栏底部');
      near(r.library.h + r.topbar.h + r.statusbar.h, r.vh, 2, '侧栏外三行高度之和应填满视口');
    }
    if (r.statusbar) near(r.statusbar.y + r.statusbar.h, r.vh, 2, '状态栏底部应贴合视口底');

    // 库内部：头 / 列表 / 脚 三段
    if (r.libHead && r.library) {
      ok(r.libHead.h > 50 && r.libHead.h < 200, `库头部高度 ${r.libHead.h} 异常`);
    }
    if (r.libFoot && r.library) {
      near(r.libFoot.y + r.libFoot.h, r.library.y + r.library.h, 2, '库底部工具条应贴合面板底');
    }
    // 虚拟行宽应与列表容器一致
    if (r.firstRow && r.library) {
      ok(r.firstRow.w > r.library.w * 0.8, `虚拟行宽度 ${r.firstRow.w} 明显小于面板宽 ${r.library.w}`);
    }
    // 侧栏文字未被裁切
    ok(r.navVisible && r.navText.length > 0, `侧栏导航文字不可见或为空: "${r.navText}"`);

    console.log('\n' + (fails.length ? '❌ 布局断言失败:\n - ' + fails.join('\n - ') : '✅ 布局几何全部通过'));
    app.exit(fails.length ? 1 : 0);
  } catch (e) {
    console.error('❌ 异常:', e.message, (e.stack || '').split('\n').slice(0, 5).join('\n'));
    app.exit(1);
  }
}, 4500);

setTimeout(() => { console.error('❌ 超时'); app.exit(1); }, 60000);
