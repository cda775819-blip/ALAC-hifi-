// ═══════════════════════════════════════════════════════════════
//  library.js — 音乐库浏览器
//
//  设计约束（严格遵守）：
//   · 全部只读 —— 只做 readdir + stat + 读文件头，绝不写入/移动/删除
//   · 文件保持原位，分析时也只在内存中处理
//   · 全库可达数千条，列表必须虚拟化，DOM 节点数与库规模无关
//
//  来源（扫哪些地方）由 library-sources.js 管理：支持多块盘/多个文件夹，
//  并记录卷序列号 —— 移动硬盘换盘符后仍能认回同一个库；盘不在时标为离线，
//  其余来源照常扫描，不再因为一个盘拔了就整个库空白。
// ═══════════════════════════════════════════════════════════════

const SRCM = () => window.__LIBSRC__;

const ROW_H = 34;
const RENDER_PAD = 6;        // 上下各多渲染几行，减少快速滚动白屏
const MAX_VISIBLE = 500;     // 默认最多展示多少条，保证长列表依然流畅

const $ = (s, p = document) => p.querySelector(s);

// ── 状态 ──
const LIB = {
  root: null,       // 主来源路径（兼容旧字段，用于页脚显示）
  roots: [],        // 本次实际扫描的来源路径
  offline: [],      // 离线来源（路径不存在/卷未挂载）
  all: [],          // 全部音频文件（元数据）
  view: [],         // 当前筛选后的列表
  status: new Map(),// path -> 'pending' | 'running' | 'done' | 'err'
  selected: -1,     // view 内的索引
  current: null,    // 正在分析/已分析的条目 path
  filter: 'all',
  query: '',
  scanning: false,
  running: false,
  truncShown: MAX_VISIBLE,
};

// ── 元素 ──
const elList = $('#libList');
const elBody = $('#libBody');
const elEmpty = $('#libEmpty');
const elStat = $('#libStat');
const elFoot = $('#libFootStat');
const elSearch = $('#libSearch');
const elFilters = $('#libFilters');
const elScan = $('#btnScanLib');
const elAnalyzeAll = $('#btnAnalyzeAll');

const AA = () => window.__AA__;

// ── 工具 ──
const fmtSize = (b) => b < 1024 ? b + ' B'
  : b < 1048576 ? (b / 1024).toFixed(0) + ' KB'
  : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB'
  : (b / 1073741824).toFixed(2) + ' GB';

const fmtCount = (n) => n.toLocaleString('en-US');

function tagClass(ext) {
  return ['m4a', 'flac', 'dsf', 'wav', 'mp3'].includes(ext) ? ext : 'other';
}

// ── 筛选 ──
function applyFilter() {
  const q = LIB.query.trim().toLowerCase();
  const f = LIB.filter;
  LIB.view = LIB.all.filter(it => {
    if (f !== 'all' && it.ext !== f) return false;
    if (q && !(it.name.toLowerCase().includes(q) || it.dir.toLowerCase().includes(q))) return false;
    return true;
  });
  LIB.truncShown = MAX_VISIBLE;
  if (LIB.selected >= LIB.view.length) LIB.selected = LIB.view.length - 1;
  renderFilters();
  renderList();
  renderFoot();
}

function renderFilters() {
  const counts = new Map();
  for (const it of LIB.all) counts.set(it.ext, (counts.get(it.ext) || 0) + 1);
  const order = ['m4a', 'flac', 'dsf', 'wav', 'mp3'];
  const exts = [...counts.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return counts.get(b) - counts.get(a);
  });
  const parts = [`<span class="chip ${LIB.filter === 'all' ? 'on' : ''}" data-f="all">全部<span class="n">${fmtCount(LIB.all.length)}</span></span>`];
  for (const e of exts) {
    parts.push(`<span class="chip ${LIB.filter === e ? 'on' : ''}" data-f="${e}">${e.toUpperCase()}<span class="n">${fmtCount(counts.get(e))}</span></span>`);
  }
  elFilters.innerHTML = parts.join('');
}

// ── 虚拟列表 ──
function renderList() {
  if (LIB.view.length === 0) {
    elList.style.display = 'none';
    elEmpty.style.display = '';
    elEmpty.innerHTML = LIB.all.length === 0
      ? '尚未扫描音乐库<br><span style="font-size:10.5px">点击下方「扫描」按钮，或按 <kbd>Ctrl</kbd>+<kbd>O</kbd></span>'
      : `没有匹配「${LIB.query}」的条目`;
    return;
  }
  elEmpty.style.display = 'none';
  elList.style.display = '';
  LIB.truncShown = Math.min(LIB.truncShown, LIB.view.length);
  elList.style.height = (LIB.truncShown * ROW_H) + 'px';
  renderRows();
}

function renderRows() {
  const scrollTop = elBody.scrollTop;
  const vh = elBody.clientHeight || 600;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - RENDER_PAD);
  const last = Math.min(LIB.truncShown - 1, Math.ceil((scrollTop + vh) / ROW_H) + RENDER_PAD);

  const out = [];
  for (let i = first; i <= last; i++) {
    const it = LIB.view[i];
    if (!it) continue;
    const st = LIB.status.get(it.path) || '';
    const cls = [
      'vrow',
      LIB.current === it.path ? 'cur' : (i === LIB.selected ? 'sel' : ''),
    ].filter(Boolean).join(' ');
    const stIcon = st === 'running' ? '◐' : st === 'done' ? '●' : st === 'err' ? '✕' : '○';
    out.push(
      `<div class="${cls}" data-i="${i}" style="top:${i * ROW_H}px" title="${escapeAttr(it.path)}">` +
        `<span class="idx">${i + 1}</span>` +
        `<span class="nm">${it.dir ? `<span class="dir">${escapeHtml(it.dir)}\\</span>` : ''}${escapeHtml(it.name)}</span>` +
        `<span class="tag ${tagClass(it.ext)}">${it.ext.toUpperCase()}</span>` +
        `<span class="sz">${fmtSize(it.size)}</span>` +
        `<span class="st ${st || 'pending'}">${stIcon}</span>` +
      `</div>`
    );
  }
  elList.innerHTML = out.join('');
}

function renderFoot() {
  const shown = Math.min(LIB.truncShown, LIB.view.length);
  const more = LIB.view.length - shown;
  const done = [...LIB.status.values()].filter(v => v === 'done').length;
  const err = [...LIB.status.values()].filter(v => v === 'err').length;
  let t = `${fmtCount(shown)} / ${fmtCount(LIB.view.length)}`;
  if (more > 0) t += ` (+${fmtCount(more)})`;
  if (done || err) t += ` · 已分析 ${done}${err ? ` / 失败 ${err}` : ''}`;
  elFoot.textContent = t;
}

// ── 转义（路径可能含引号/特殊字符）──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

// ── 扫描 ──
/**
 * 扫描所有已配置来源并合并结果。
 * 单个来源失败（盘不在/无权限）不影响其余来源 —— 这是这个函数的核心改进：
 * 老实现只扫一个写死的路径，那个盘一拔整个库就空了。
 */
async function scanAll() {
  if (LIB.scanning) return;
  const api = window.electronAPI;
  const M = SRCM();
  if (!api || !api.scanLibrary) {
    elStat.textContent = '扫描不可用';
    renderEmptyHint('扫描接口不可用（需在 Electron 中运行）');
    return;
  }

  LIB.scanning = true;
  elScan.disabled = true;
  elScan.textContent = '扫描中…';
  elStat.textContent = '扫描中…';
  renderEmptyHint('正在读取来源列表…');

  try {
    // 1) 载入来源配置（主进程会自动补全老配置缺失的卷信息）
    await M.loadSources();
    if (!M.SRC.list.length) {
      elStat.textContent = '未配置来源';
      renderEmptyHint(
        '还没有配置音乐库来源。<br>' +
        '<span style="font-size:10.5px">点上面「来源」按钮添加整块盘或文件夹；' +
        '也可以直接把音频文件拖进来分析。</span>');
      elAnalyzeAll.disabled = true;
      return;
    }

    // 2) 解析每个来源（盘符变了会按卷序列号自动重定位）
    renderEmptyHint('正在检查各来源是否可用…');
    const resolved = await M.resolveSources();
    await M.persistRemapped();          // 重定位结果写回配置，下次启动直接可用

    const online = resolved.filter(r => r.online);
    LIB.offline = resolved.filter(r => !r.online);
    LIB.roots = online.map(r => r.path);
    LIB.root = LIB.roots[0] || null;

    if (!online.length) {
      elStat.textContent = '来源全部离线';
      elAnalyzeAll.disabled = true;
      renderEmptyHint(
        `<b>已配置的 ${resolved.length} 个来源当前都不可用</b><br>` +
        '<span style="font-size:10.5px">' +
        resolved.map(r => `· ${escapeHtml(r.path)} — ${escapeHtml(r.error || '不可用')}`).join('<br>') +
        '<br><br>若在移动硬盘上，插回硬盘后点「扫描」即可；' +
        '也可以点上面「来源」按钮添加新的位置。</span>');
      M.renderPanel();
      return;
    }

    // 3) 逐个来源扫描并合并（串行：避免同时遍历多块盘拖慢机械硬盘）
    const merged = [];
    let bytes = 0, dirs = 0, elapsed = 0, truncated = false;
    for (let i = 0; i < online.length; i++) {
      const r = online[i];
      elStat.textContent = `扫描中 ${i + 1}/${online.length}：${r.path}`;
      renderEmptyHint(`正在扫描（只读元数据）…<br><span style="font-size:10.5px">${escapeHtml(r.path)}</span>`);
      await yieldTick();
      try {
        const res = await api.scanLibrary(r.path, { maxDepth: 12, limit: 200000 });
        if (!res || !res.ok) {
          const err = (res && res.error) || '扫描失败';
          LIB.offline.push({ src: r.src, path: r.path, online: false, error: err });
          console.warn(`[LIB] 来源扫描失败 ${r.path}: ${err}`);
          continue;
        }
        // 标记每条记录来自哪个来源，便于显示与排查
        for (const f of res.files) { f.srcRoot = res.root; f.srcSerial = res.volSerial || null; }
        merged.push(...res.files);
        bytes += res.bytes; dirs += res.dirCount; elapsed += res.elapsedMs;
        if (res.truncated) truncated = true;
      } catch (e) {
        LIB.offline.push({ src: r.src, path: r.path, online: false, error: e.message });
        console.warn(`[LIB] 来源扫描异常 ${r.path}: ${e.message}`);
      }
    }

    // 4) 应用结果
    LIB.all = merged;
    LIB.status.clear();
    LIB.current = null;
    LIB.selected = merged.length ? 0 : -1;
    LIB.filter = 'all';
    LIB.query = '';
    if (elSearch) elSearch.value = '';

    const offNote = LIB.offline.length ? ` · ${LIB.offline.length} 个来源离线` : '';
    elStat.textContent = `${fmtCount(merged.length)} 个文件${offNote}`;
    console.log(`[LIB] 扫描完成 ${merged.length} 个音频文件, ${(bytes / 1073741824).toFixed(2)}GB, ` +
      `${dirs} 目录, ${elapsed}ms${truncated ? ' (已达上限)' : ''}` +
      (LIB.offline.length ? `；离线来源: ${LIB.offline.map(o => o.path).join(', ')}` : ''));
    applyFilter();
    elAnalyzeAll.disabled = merged.length === 0;
    M.renderPanel();

    // 全部来源都没扫出文件时给出明确提示，而不是留一个空白列表
    if (!merged.length) {
      renderEmptyHint('这些来源里没有找到音频文件。<br>' +
        '<span style="font-size:10.5px">支持 ' + 'mp3 / flac / wav / m4a / ape / dsf 等 20+ 格式；' +
        '来源配置见上面「来源」按钮。</span>');
    }
  } catch (e) {
    console.error('[LIB] 扫描失败', e);
    elStat.textContent = '扫描失败';
    renderEmptyHint(`扫描失败：${escapeHtml(e.message)}<br>` +
      '<span style="font-size:10.5px">可点上面「来源」按钮检查或更换位置</span>');
  } finally {
    LIB.scanning = false;
    elScan.disabled = false;
    elScan.textContent = '扫描';
  }
}

/** 让出一帧，使扫描进度能刷新出来（MessageChannel，不受 setTimeout 4ms 钳制） */
function yieldTick() {
  if (typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
  let ch = yieldTick._ch;
  if (!ch) {
    ch = yieldTick._ch = new MessageChannel();
    ch._q = [];
    ch.port1.onmessage = () => { const q = ch._q; ch._q = []; for (const r of q) r(); };
  }
  return new Promise(r => { ch._q.push(r); ch.port2.postMessage(null); });
}

function renderEmptyHint(html) {
  elList.style.display = 'none';
  elEmpty.style.display = '';
  elEmpty.innerHTML = html;
}

// ── 分析 ──
async function analyzeOne(index) {
  const it = LIB.view[index];
  if (!it) return;
  const api = AA();
  if (!api || !api.analyzePath) { console.error('[LIB] analyzePath 未就绪'); return; }

  LIB.current = it.path;
  LIB.selected = index;
  LIB.status.set(it.path, 'running');
  renderRows(); renderFoot();

  const t0 = performance.now();
  try {
    await api.analyzePath(it.path, it.size);
    LIB.status.set(it.path, 'done');
    console.log(`[LIB] 分析完成 ${it.name} 用时 ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (e) {
    LIB.status.set(it.path, 'err');
    console.error(`[LIB] 分析失败 ${it.name}: ${e.message}`);
  }
  renderRows(); renderFoot();
}

async function analyzeAll() {
  if (LIB.running) return;
  LIB.running = true;
  elAnalyzeAll.disabled = true;
  const t0 = performance.now();
  const targets = LIB.view.slice(0, LIB.truncShown);
  let ok = 0, bad = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      elAnalyzeAll.textContent = `${i + 1}/${targets.length}`;
      try {
        await analyzeOne(i);
        if (LIB.status.get(LIB.view[i].path) === 'done') ok++; else bad++;
      } catch (_) { bad++; }
      // 每 10 个让出一次主线程，保持界面可用
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    LIB.running = false;
    elAnalyzeAll.disabled = false;
    elAnalyzeAll.textContent = '分析全部';
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[LIB] 批量分析结束：成功 ${ok}，失败 ${bad}，共 ${targets.length}，用时 ${s}s`);
    elFoot.textContent = `批量完成 · 成功 ${ok} · 失败 ${bad} · ${s}s`;
  }
}

// ── 事件 ──
elBody?.addEventListener('scroll', () => {
  if (LIB.running) return;
  renderRows();
  // 滚到底部时继续放出更多条目
  if (elBody.scrollTop + elBody.clientHeight > LIB.truncShown * ROW_H - ROW_H * 4) {
    if (LIB.truncShown < LIB.view.length) {
      LIB.truncShown = Math.min(LIB.view.length, LIB.truncShown + MAX_VISIBLE);
      renderList(); renderFoot();
    }
  }
}, { passive: true });

elList?.addEventListener('click', (e) => {
  const row = e.target.closest('.vrow');
  if (!row) return;
  const i = Number(row.dataset.i);
  LIB.selected = i;
  renderRows();
});

elList?.addEventListener('dblclick', (e) => {
  const row = e.target.closest('.vrow');
  if (!row) return;
  analyzeOne(Number(row.dataset.i));
});

elFilters?.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  LIB.filter = chip.dataset.f;
  applyFilter();
});

let searchTimer = null;
elSearch?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { LIB.query = elSearch.value; applyFilter(); }, 120);
});

// 「扫描」= 把所有已配置来源重新扫一遍（含按卷序列号重定位盘符）
elScan?.addEventListener('click', () => scanAll());

// 「来源」按钮：打开来源管理面板（加/减盘与文件夹、看在线状态）
document.getElementById('btnLibSources')?.addEventListener('click', () => {
  const M = SRCM();
  if (M) M.togglePanel();
});

elAnalyzeAll?.addEventListener('click', analyzeAll);

// 键盘：上下选择 + Enter 分析
window.addEventListener('keydown', (e) => {
  if (e.target === elSearch) {
    if (e.key === 'ArrowDown' && LIB.view.length) { elSearch.blur(); LIB.selected = Math.max(0, LIB.selected); scrollToSel(); renderRows(); e.preventDefault(); }
    return;
  }
  if (!LIB.view.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    LIB.selected = Math.min(LIB.view.length - 1, LIB.selected + 1);
    scrollToSel(); renderRows();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    LIB.selected = Math.max(0, LIB.selected - 1);
    scrollToSel(); renderRows();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (LIB.selected >= 0) analyzeOne(LIB.selected);
  }
});

function scrollToSel() {
  if (LIB.selected < 0) return;
  // 选中项超出已展示范围时，自动扩展
  if (LIB.selected >= LIB.truncShown) {
    LIB.truncShown = Math.min(LIB.view.length, LIB.selected + MAX_VISIBLE);
    renderList();
  }
  const top = LIB.selected * ROW_H;
  const vh = elBody.clientHeight;
  if (top < elBody.scrollTop) elBody.scrollTop = top;
  else if (top + ROW_H > elBody.scrollTop + vh) elBody.scrollTop = top + ROW_H - vh;
}

// ── 顶栏按钮 / 欢迎屏 ──
$('#btnWelcomeLib')?.addEventListener('click', () => {
  $('#welcome')?.classList.add('hide');
  scanAll();                                  // 不再写死某个盘，扫全部已配置来源
});
$('#btnWelcomeOpen')?.addEventListener('click', () => $('#fileInput')?.click());

document.getElementById('btnLibrary')?.addEventListener('click', (e) => {
  document.getElementById('appRoot')?.classList.toggle('lib-hidden');
  e.currentTarget.classList.toggle('on');
});

// ── 启动：等 __AA__ 就绪后自动扫描全部来源 ──
// 盘不在时不会让库空白：可用来源照常扫，离线的单独列出。
(function boot() {
  let tries = 0;
  const t = setInterval(() => {
    if (AA() || ++tries > 60) {
      clearInterval(t);
      if (AA()) scanAll();
      else console.warn('[LIB] __AA__ 未就绪，库功能受限');
    }
  }, 100);
})();

// 供调试与自动化测试使用
window.__LIB__ = LIB;
window.__LIB_SCAN__ = scanAll;
window.__LIB_SCAN_ALL__ = scanAll;
