// ═══════════════════════════════════════════════════════════════
//  safeRunner.js — 产品级保护层
//  安全执行异步函数，失败返回 fallback
// ═══════════════════════════════════════════════════════════════

export async function safeRun(fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    console.error("[SAFE ERROR]", e);
    return fallback;
  }
}
