// ═══════════════════════════════════════════════════════════════
//  library.js — 音乐库浏览器
//
//  设计约束（严格遵守）：
//   · 全部只读 —— 只做 readdir + stat + 读文件头，绝不写入/移动/删除
//   · 文件保持原位，分析时也只在内存中处理
//   · 全库可达数千条，列表必须虚拟化，DOM 节点数与库规模无关
//
//  默认库路径可直接改 DEFAULT_ROOT，或点「扫描」选择其他目录。
// ═══════════════════════════════════════════════════════════════

const DEFAULT_ROOT = 'F:\\本地音乐文件';

const ROW_H = 34;
const RENDER_PAD = 6;        // 上下各多渲染几行，减少快速滚动白屏
const MAX_VISIBLE = 500;     // 默认最多展示多少条，保证长列表依然流畅

const $ = (s, p = document) => p.querySelector(s);

// ── 状态 ──
const LIB = {
  root: null,
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
async function scan(root) {
  if (LIB.scanning) return;
  const target = root || LIB.root || DEFAULT_ROOT;
  LIB.scanning = true;
  elScan.disabled = true;
  elScan.textContent = '扫描中…';
  elStat.textContent = '扫描中…';
  renderEmptyHint('正在扫描目录（只读元数据）…');
  try {
    const api = window.electronAPI;
    if (!api || !api.scanLibrary) throw new Error('扫描接口不可用（需在 Electron 中运行）');
    const r = await api.scanLibrary(target, { maxDepth: 8, limit: 200000 });
    if (!r || !r.ok) throw new Error((r && r.error) || '扫描失败');

    LIB.root = r.root;
    LIB.all = r.files;
    LIB.status.clear();
    LIB.current = null;
    LIB.selected = r.files.length ? 0 : -1;
    LIB.filter = 'all';
    LIB.query = '';
    if (elSearch) elSearch.value = '';

    elStat.textContent = `${fmtCount(r.files.length)} 个文件`;
    console.log(`[LIB] 扫描完成 ${r.files.length} 个音频文件, ${(r.bytes / 1073741824).toFixed(2)}GB, ${r.dirCount} 目录, ${r.elapsedMs}ms${r.truncated ? ' (已达上限)' : ''}`);
    applyFilter();
    elAnalyzeAll.disabled = r.files.length === 0;
  } catch (e) {
    console.error('[LIB] 扫描失败', e);
    elStat.textContent = '扫描失败';
    renderEmptyHint(`扫描失败：${escapeHtml(e.message)}<br><span style="font-size:10.5px">可用「扫描」按钮选择其他目录</span>`);
  } finally {
    LIB.scanning = false;
    elScan.disabled = false;
    elScan.textContent = '扫描';
  }
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

elScan?.addEventListener('click', async () => {
  const api = window.electronAPI;
  // 首次点击：若默认路径可用就扫它；否则让用户挑目录
  let root = DEFAULT_ROOT;
  if (api && api.chooseLibraryRoot && LIB.root && LIB.root !== DEFAULT_ROOT) {
    const picked = await api.chooseLibraryRoot();
    if (picked) root = picked;
  }
  scan(root);
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
  scan(DEFAULT_ROOT);
});
$('#btnWelcomeOpen')?.addEventListener('click', () => $('#fileInput')?.click());

document.getElementById('btnLibrary')?.addEventListener('click', (e) => {
  document.getElementById('appRoot')?.classList.toggle('lib-hidden');
  e.currentTarget.classList.toggle('on');
});

// ── 启动：等 __AA__ 就绪后自动扫描默认库（欢迎屏保持显示，用户可拖文件） ──
(function boot() {
  let tries = 0;
  const t = setInterval(() => {
    if (AA() || ++tries > 60) {
      clearInterval(t);
      if (AA()) scan(DEFAULT_ROOT);
      else console.warn('[LIB] __AA__ 未就绪，库功能受限');
    }
  }, 100);
})();

// 供调试与自动化测试使用
window.__LIB__ = LIB;
window.__LIB_SCAN__ = scan;
