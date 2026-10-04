// ═══════════════════════════════════════════════════════════════
//  library-sources.js — 音乐库「来源」管理
//
//  解决的问题：
//   老实现只有一个写死的库路径（F:\本地音乐文件），且选的目录只存在内存里。
//   移动硬盘一拔，路径不存在 → 整个库空白，报 ENOENT。
//
//  现在的模型：
//   · 可配置**多个来源**，一次全部扫出来并合并显示
//   · 来源可以是「整块盘」（如 D:\）或某个文件夹
//   · 每个来源记录所在卷的序列号（st.dev，与 Windows 卷序列号一致）
//     → 移动硬盘换了盘符（F: → G:）也能按卷认回同一个库
//   · 卷不在时标记「离线」，保留已有列表，其余来源照常扫描
//
//  全部只读：只做 readdir + stat，不写入/移动/删除用户的任何文件。
//  配置文件写在 userData（library-sources.json），不碰音乐目录。
// ═══════════════════════════════════════════════════════════════

const api = () => window.electronAPI;

// ── 状态 ──
const SRC = {
  list: [],        // [{ kind, path, volDev, volSerial, relPath, label, addedAt }]
  resolved: [],    // [{ src, path, online, remapped, volSerial, error }]
  panelOpen: false,
};

const fmtGB = (b) => (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1);

/** 卷标 + 盘符 + 容量，便于用户认出是哪块盘 */
function volumeLabel(v) {
  const name = v.label ? `${v.label} ` : '';
  const cap = v.totalBytes ? ` ${fmtGB(v.freeBytes)}/${fmtGB(v.totalBytes)} GB` : '';
  return `${name}(${v.letter})${cap}`;
}

/** 读配置（主进程会自动补全老配置里缺失的卷信息） */
async function loadSources() {
  const a = api();
  if (!a || !a.getLibrarySources) return [];
  try {
    const cfg = await a.getLibrarySources();
    SRC.list = (cfg && cfg.sources) || [];
  } catch (e) {
    console.warn('[LIB] 读取来源配置失败:', e.message);
    SRC.list = [];
  }
  return SRC.list;
}

async function saveSources(list) {
  const a = api();
  if (!a || !a.setLibrarySources) return false;
  try {
    const r = await a.setLibrarySources(list || SRC.list);
    if (r && r.ok && Array.isArray(r.sources)) SRC.list = r.sources;
    return !!(r && r.ok);
  } catch (e) {
    console.warn('[LIB] 保存来源配置失败:', e.message);
    return false;
  }
}

/**
 * 把配置里的每个来源解析成「当前可用的实际路径」。
 * 盘符变了会按卷序列号自动重定位（remapped=true）。
 */
async function resolveSources() {
  const a = api();
  if (!a || !a.resolveLibrarySource) return [];
  const out = [];
  for (const s of SRC.list) {
    try {
      const r = await a.resolveLibrarySource(s);
      out.push({ src: s, path: (r && r.path) || s.path, online: !!(r && r.ok),
                 remapped: !!(r && r.remapped), from: r && r.from,
                 volSerial: (r && r.volSerial) || s.volSerial || null,
                 error: (r && r.error) || null });
    } catch (e) {
      out.push({ src: s, path: s.path, online: false, remapped: false, error: e.message });
    }
  }
  SRC.resolved = out;
  return out;
}

/** 盘符变了的话，把新路径写回配置，下次启动就直接可用 */
async function persistRemapped() {
  const changed = SRC.resolved.filter(r => r.online && r.remapped && r.path !== r.src.path);
  if (!changed.length) return false;
  for (const r of changed) {
    r.src.path = r.path;
    r.src.relPath = r.src.kind === 'volume' ? '' : (r.src.relPath || '');
  }
  const ok = await saveSources(SRC.list);
  if (ok) console.log(`[LIB] 已按卷序列号重定位 ${changed.length} 个来源并写回配置`);
  return ok;
}

// ── 界面：来源管理面板 ──
function ensurePanel() {
  let el = document.getElementById('libSourcesPanel');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'libSourcesPanel';
  el.className = 'lib-src-panel';
  el.innerHTML = `
    <div class="lib-src-head">
      <b>音乐库来源</b>
      <span class="lib-src-sub">可添加多块盘或多个文件夹，一次全部扫描</span>
      <button class="lib-src-close" id="libSrcClose" title="关闭">✕</button>
    </div>
    <div class="lib-src-list" id="libSrcList"></div>
    <div class="lib-src-add">
      <button class="btn-mini" id="libSrcAddVol">＋ 整块盘</button>
      <button class="btn-mini" id="libSrcAddDir">＋ 文件夹</button>
      <button class="btn-mini" id="libSrcRescan">重新扫描</button>
    </div>
    <div class="lib-src-vols" id="libSrcVols"></div>
  `;
  document.body.appendChild(el);
  el.querySelector('#libSrcClose').onclick = () => togglePanel(false);
  el.querySelector('#libSrcAddDir').onclick = addFolder;
  el.querySelector('#libSrcAddVol').onclick = showVolumes;
  el.querySelector('#libSrcRescan').onclick = () => {
    togglePanel(false);
    if (window.__LIB_SCAN_ALL__) window.__LIB_SCAN_ALL__();
  };
  return el;
}

function togglePanel(open) {
  const el = ensurePanel();
  SRC.panelOpen = open === undefined ? !SRC.panelOpen : !!open;
  el.classList.toggle('open', SRC.panelOpen);
  if (SRC.panelOpen) { renderPanel(); showVolumes(); }
}

function renderPanel() {
  const el = document.getElementById('libSrcList');
  if (!el) return;
  if (!SRC.resolved.length && !SRC.list.length) {
    el.innerHTML = `<div class="lib-src-empty">还没有配置来源。<br>点下面的「整块盘」或「文件夹」添加。</div>`;
    return;
  }
  const rows = (SRC.resolved.length ? SRC.resolved : SRC.list.map(s => ({ src: s, path: s.path, online: null })));
  el.innerHTML = rows.map((r, i) => {
    const s = r.src;
    const kindTag = s.kind === 'volume' ? '整块盘' : '文件夹';
    const state = r.online === null ? '<span class="ls-wait">未检查</span>'
      : r.online ? (r.remapped ? '<span class="ls-ok">已重定位</span>' : '<span class="ls-ok">在线</span>')
      : '<span class="ls-off">离线</span>';
    const note = r.remapped && r.from ? `<div class="ls-note">盘符已变：${r.from} → ${r.path}</div>`
      : (!r.online && r.error ? `<div class="ls-note">${r.error}</div>` : '');
    const vs = s.volSerial ? `<span class="ls-serial">卷 ${s.volSerial}</span>` : '';
    return `<div class="lib-src-row" data-i="${i}">
      <span class="ls-kind">${kindTag}</span>
      <span class="ls-path" title="${r.path}">${r.path}</span>
      ${vs}${state}
      <button class="ls-del" data-del="${i}" title="移除这个来源">✕</button>
      ${note}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const i = Number(b.dataset.del);
      const row = rows[i];
      if (!row) return;
      SRC.list = SRC.list.filter(s => !(s.path === row.src.path && s.volDev === row.src.volDev));
      await saveSources(SRC.list);
      await resolveSources();
      renderPanel();
      if (window.__LIB_SCAN_ALL__) window.__LIB_SCAN_ALL__();
    };
  });
}

/** 列出当前挂载的卷，供点选 */
async function showVolumes() {
  const el = document.getElementById('libSrcVols');
  if (!el) return;
  const a = api();
  if (!a || !a.listVolumes) { el.innerHTML = '<div class="ls-note">当前环境不支持枚举磁盘</div>'; return; }
  el.innerHTML = '<div class="ls-note">正在读取磁盘…</div>';
  let vols = [];
  try { const r = await a.listVolumes(); vols = (r && r.volumes) || []; } catch (_) {}
  if (!vols.length) { el.innerHTML = '<div class="ls-note">没有读到可用的磁盘</div>'; return; }
  el.innerHTML = vols.map((v, i) => {
    const already = SRC.list.some(s => s.volDev === v.dev && s.kind === 'volume');
    return `<button class="ls-vol${already ? ' on' : ''}" data-vol="${i}" ${already ? 'disabled' : ''}>${
      volumeLabel(v)}${already ? ' · 已添加' : ''}</button>`;
  }).join('');
  el.querySelectorAll('[data-vol]').forEach(b => {
    b.onclick = async () => {
      const v = vols[Number(b.dataset.vol)];
      if (!v) return;
      SRC.list.push({
        kind: 'volume', path: v.root, volDev: v.dev, volSerial: v.serial,
        relPath: '', label: v.label || null, addedAt: Date.now(),
      });
      await saveSources(SRC.list);
      await resolveSources();
      renderPanel(); showVolumes();
      if (window.__LIB_SCAN_ALL__) window.__LIB_SCAN_ALL__();
    };
  });
}

/** 添加单个文件夹 */
async function addFolder() {
  const a = api();
  if (!a || !a.chooseLibraryRoot) return;
  const picked = await a.chooseLibraryRoot();
  if (!picked) return;
  if (SRC.list.some(s => s.path.toLowerCase() === picked.toLowerCase())) return;
  SRC.list.push({ kind: 'dir', path: picked, addedAt: Date.now() });
  await saveSources(SRC.list);          // 主进程会补卷信息
  await resolveSources();
  renderPanel();
  if (window.__LIB_SCAN_ALL__) window.__LIB_SCAN_ALL__();
}

// 供 library.js 使用（两个文件都是 ES module 且无 export，
// 沿用该目录既有的 window.__LIB__ 约定共享）
window.__LIBSRC__ = {
  SRC,
  loadSources, saveSources, resolveSources, persistRemapped,
  togglePanel, renderPanel, ensurePanel, volumeLabel,
};
