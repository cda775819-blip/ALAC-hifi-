// ═══════════════════════════════════════════════════════════════
//  utils/format.js — 格式化工具
//  来源: app.js L2443-2445
// ═══════════════════════════════════════════════════════════════

function fmtSize(b) {
  return b < 1024
    ? b + ' B'
    : (b < 1048576
      ? (b / 1024).toFixed(1) + ' KB'
      : (b / 1048576).toFixed(1) + ' MB');
}

function fmtDur(s) {
  const m = Math.floor(s / 60);
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
