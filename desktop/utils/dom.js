// ═══════════════════════════════════════════════════════════════
//  utils/dom.js — DOM 快捷工具
//  来源: app.js L6-8
// ═══════════════════════════════════════════════════════════════

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
