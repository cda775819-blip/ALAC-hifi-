// ═══════════════════════════════════════════════════════════════
//  build/make-icon.mjs — 应用图标生成器（纯 JS，无第三方依赖）
//
//  跑法：node build/make-icon.mjs      生成 icon.png / icon.ico
//        node build/check-icon.mjs     自检（透明区/圆角/小尺寸可读性/ICO 结构）
//
//  ── 为什么重做 ──
//  旧图标是深青底(#081818)+蓝色柱(#58a8f8)，与应用界面的
//  炭黑 + 琥珀(#ffb020) + 青(#2dd4bf) 仪器风格完全无关；
//  且四角不透明、柱子有阶梯锯齿、分辨率只有 256。
//
//  ── 设计 ──
//  保留「频谱柱」这个语义（它就是频谱分析仪），换成应用真实配色：
//  炭黑圆角徽章 + 琥珀柱 + 一根青色峰值柱 + 柱底基线。
//
//  ── 两个关键做法（都是量出来的，不是拍脑袋）──
//
//  1) 圆角矩形外框就是画布本身（inset=0）。
//     第一版留了 5px 内缩，导致四条边的中点也变透明 ——
//     图标看着像浮在小方块里，且失去圆角轮廓。
//
//  2) 小尺寸单独渲染，不做整体降采样。
//     主图 9 根柱、柱宽 12px/间距 8px（1024 画布）；
//     降到 16px 后每根柱宽 0.75px、缝隙 0.5px —— 全部糊成一条，
//     完全看不出是频谱。所以 ≤42px 改用「4 根粗柱」简化版：
//     16px 下柱宽 2px、缝隙 2px，能真正分辨。
//     这是图标设计的常规做法（小尺寸要重画，不是缩小）。
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodePNG } from './png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配色（取自 renderer/styles.css）──
const BG_IN   = [0x16, 0x18, 0x1c];
const BG_OUT  = [0x08, 0x09, 0x0b];
const AMBER   = [0xff, 0xb0, 0x20];   // --am
const AMBER_D = [0xc8, 0x88, 0x14];   // 柱底稍深，避免发灰
const AMBER_L = [0xff, 0xcc, 0x5e];   // 柱顶提亮（不用接近白色，否则失去琥珀感）
const CYAN    = [0x2d, 0xd4, 0xbf];   // --cy
const BORDER  = [0x33, 0x38, 0x42];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

// 圆角矩形覆盖率（像素中心到圆角矩形的距离软边）
function coverage(px, py, x0, y0, x1, y1, r) {
  const cx = px + 0.5, cy = py + 0.5;
  if (cx < x0 || cx > x1 || cy < y0 || cy > y1) return 0;
  const rx = Math.min(Math.max(cx, x0 + r), x1 - r);
  const ry = Math.min(Math.max(cy, y0 + r), y1 - r);
  const d = Math.hypot(cx - rx, cy - ry);
  if (d <= r - 0.5) return 1;
  if (d >= r + 0.5) return 0;
  return r + 0.5 - d;
}

/**
 * 渲染一个尺寸的图标。
 * @param {number} size      输出边长
 * @param {number} ss        超采样倍率
 * @param {object} cfg       柱形配置
 */
function renderIcon(size, ss, cfg) {
  const N = size * ss;
  const buf = new Float64Array(N * N * 4);   // 预乘 RGBA

  const blend = (x, y, rgb, alpha) => {
    if (alpha <= 0 || x < 0 || y < 0 || x >= N || y >= N) return;
    const i = (y * N + x) * 4;
    const inv = 1 - alpha;
    buf[i]     = rgb[0] / 255 * alpha + buf[i]     * inv;
    buf[i + 1] = rgb[1] / 255 * alpha + buf[i + 1] * inv;
    buf[i + 2] = rgb[2] / 255 * alpha + buf[i + 2] * inv;
    buf[i + 3] = alpha + buf[i + 3] * inv;
  };

  const R = N * cfg.radiusFrac;              // 圆角半径
  // ⚠ coverage 的 x1/y1 是「排他边界」：像素中心必须落在 [x0,x1) 内。
  // 传 N-1 会让最右/最下一列的像素中心落在框外，右边缘与下边缘变成半透明
  // （实测 alpha=128，肉眼看着像图标被削掉一条）。
  // ── 1) 徽章底（外框 = 整个画布，inset=0）──
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cov = coverage(x, y, 0, 0, N, N, R);
      if (cov <= 0) continue;
      let c = mix(BG_IN, BG_OUT, Math.min(1, (y / N) * 1.15));
      const dx = (x - N * 0.5) / (N * 0.5), dy = (y - N * 0.42) / (N * 0.62);
      const glow = Math.max(0, 1 - Math.hypot(dx, dy));
      c = mix(c, [0x23, 0x28, 0x31], glow * glow * 0.5);
      blend(x, y, c, cov);
    }
  }

  // ── 2) 内描边：深色背景下给出轮廓 ──
  {
    const sw = N * 0.008;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const outer = coverage(x, y, 0, 0, N, N, R);
        const inner = coverage(x, y, sw, sw, N - sw, N - sw, Math.max(0, R - sw));
        const ring = Math.max(0, outer - inner);
        if (ring > 0) blend(x, y, BORDER, ring * 0.9);
      }
    }
  }

  // ── 3) 频谱柱 ──
  // 柱子的横向位置在「目标像素」上算好并对齐到整像素边界，再乘 ss 放大。
  // 若直接在渲染分辨率上按比例算，小尺寸下柱宽/缝隙会落在半像素上，
  // 抗锯齿把缝隙糊掉 —— 16px 会变成一块连着的色块。
  const bars = cfg.heights;
  const BARS = bars.length;
  const areaW = N * cfg.widthFrac;
  const areaX = (N - areaW) / 2;
  const baseY = N * cfg.baseYFrac;
  const maxH = N * cfg.maxHFrac;
  const gapRatio = cfg.gapRatio;

  const rects = [];
  for (let b = 0; b < BARS; b++) {
    // target 像素坐标 → 乘 ss 回到渲染分辨率
    const tSlot = (size * cfg.widthFrac) / BARS;
    const tX0 = size * (1 - cfg.widthFrac) / 2 + tSlot * b;
    const tBarW = tSlot * (1 - gapRatio);
    const x0 = Math.round(tX0) * ss;
    const x1 = Math.round(tX0 + tBarW) * ss;
    const h = maxH * bars[b];
    const y0 = baseY - h, y1 = baseY;
    rects.push({ x0, x1: Math.max(x1, x0 + ss), y0, y1, h });
  }

  const barR = Math.min((rects[0].x1 - rects[0].x0) * 0.30, N * 0.018);
  for (let b = 0; b < BARS; b++) {
    const { x0, x1, y0, y1, h } = rects[b];
    const isPeak = b === cfg.peak;

    for (let y = Math.floor(y0 - 2); y <= Math.ceil(y1 + 2); y++) {
      for (let x = Math.floor(x0 - 2); x <= Math.ceil(x1 + 2); x++) {
        const cov = coverage(x, y, x0, y0, x1, y1, Math.min(barR, h / 2, (x1 - x0) / 2));
        if (cov <= 0) continue;
        const t = h > 0 ? (y1 - y) / h : 0;          // 0=柱底 1=柱顶
        const col = isPeak
          ? mix(mix(CYAN, [0x18, 0x8c, 0x80], 0.30), [0x8f, 0xf0, 0xe4], Math.pow(t, 1.5) * 0.55)
          : mix(AMBER_D, AMBER_L, Math.pow(t, 1.3));
        blend(x, y, col, cov);
      }
    }

    // 峰值柱加柔光，强化"读数峰值"的观感
    if (isPeak && cfg.glow > 0) {
      const gx = (x0 + x1) / 2, gy = y0, gr = (x1 - x0) * (1.0 + cfg.glow);
      for (let y = Math.floor(gy - gr); y <= Math.ceil(gy + gr); y++) {
        for (let x = Math.floor(gx - gr); x <= Math.ceil(gx + gr); x++) {
          const d = Math.hypot(x - gx, y - gy) / gr;
          if (d > 1) continue;
          blend(x, y, CYAN, (1 - d) * (1 - d) * 0.32 * cfg.glow);
        }
      }
    }
  }

  // ── 4) 基线：紧贴柱底，与柱子连成一体 ──
  if (cfg.baseline) {
    // 竖向上限 1 个目标像素：太粗会在小尺寸下吃掉柱子的区分度
    const th = Math.max(ss, Math.round(size * cfg.baseline) * ss);
    const ly0 = baseY, ly1 = baseY + th;
    const lx0 = rects[0].x0 - ss * 1.5, lx1 = rects[BARS - 1].x1 + ss * 1.5;
    for (let y = Math.floor(ly0); y <= Math.ceil(ly1); y++) {
      for (let x = Math.floor(lx0); x <= Math.ceil(lx1); x++) {
        const cov = coverage(x, y, lx0, ly0, lx1, ly1, th / 2);
        if (cov > 0) blend(x, y, mix(AMBER_D, AMBER, 0.5), cov);
      }
    }
  }

  // ── 5) 超采样降采样 ──
  const out = Buffer.alloc(size * size * 4);
  const k = ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = y * k; sy < (y + 1) * k; sy++) {
        for (let sx = x * k; sx < (x + 1) * k; sx++) {
          const i = (sy * N + sx) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = k * k, o = (y * size + x) * 4, aa = a / n;
      if (aa > 0) {
        out[o]     = Math.min(255, Math.round(r / n / aa * 255));
        out[o + 1] = Math.min(255, Math.round(g / n / aa * 255));
        out[o + 2] = Math.min(255, Math.round(b / n / aa * 255));
      }
      out[o + 3] = Math.min(255, Math.round(aa * 255));
    }
  }
  return out;
}

// ── 两套柱形：大尺寸用 9 根细柱（频谱感），小尺寸用 4 根粗柱（能分辨）──
// 基线与最高柱高度是按「视觉重心居中」定的：需要「上方留白 ≈ 下方留白」，
// 即 1-baseY ≈ baseY-maxH。早先 0.815/0.53 时上方 35%、下方 18%，图标明显往下坠。
const CFG_BIG = {
  radiusFrac: 0.18,
  heights:    [0.20, 0.34, 0.52, 0.42, 0.66, 0.86, 0.58, 0.74, 0.30],
  peak: 5, widthFrac: 0.74, baseYFrac: 0.78, maxHFrac: 0.62, gapRatio: 0.40,
  baseline: 0, glow: 1,
};
// 4 根：16px 下柱宽 2px、缝 2px（整像素对齐），仍能看出是几根柱子
const CFG_SMALL = {
  radiusFrac: 0.18,
  heights:    [0.38, 0.80, 0.56, 0.95],
  peak: 3, widthFrac: 0.70, baseYFrac: 0.78, maxHFrac: 0.60, gapRatio: 0.40,
  baseline: 0.05, glow: 0,
};

const SMALL_MAX = 42;                  // ≤42px 用简化版

function barsFor(size) {
  return size <= SMALL_MAX ? CFG_SMALL : CFG_BIG;
}
function ssFor(size) {
  return size <= 32 ? 6 : size <= 64 ? 5 : size <= 128 ? 4 : 3;
}

// ── icon.png：1024 主图 ──
const MASTER = 1024;
const master = renderIcon(MASTER, 2, CFG_BIG);
const pngPath = path.join(__dirname, 'icon.png');
fs.writeFileSync(pngPath, encodePNG(MASTER, MASTER, master));

// ── icon.ico：每个尺寸独立渲染（不是从主图缩放）──
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function icoBmp(rgba, size) {
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;                     // ICO 自下而上
    for (let x = 0; x < size; x++) {
      const s = (srcY * size + x) * 4, d = (y * size + x) * 4;
      const a = rgba[s + 3];
      // 某些老 API 忽略 alpha，这里把颜色预乘到黑底，避免出现白色描边
      xor[d]     = Math.round(rgba[s + 2] * a / 255);
      xor[d + 1] = Math.round(rgba[s + 1] * a / 255);
      xor[d + 2] = Math.round(rgba[s]     * a / 255);
      xor[d + 3] = a;
    }
  }
  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size);       // 全 0：不透明性由 alpha 通道决定
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(0, 16);
  return Buffer.concat([hdr, xor, and]);
}

{
  const entries = SIZES.map(s => {
    const px = s === MASTER ? master : renderIcon(s, ssFor(s), barsFor(s));
    return { size: s, data: s >= 128 ? encodePNG(s, s, px) : icoBmp(px, s) };
  });

  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    dir[o]     = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  const icoPath = path.join(__dirname, 'icon.ico');
  fs.writeFileSync(icoPath, Buffer.concat([dir, ...entries.map(e => e.data)]));
  console.log(`icon.ico  ${SIZES.join('/')}  ${(fs.statSync(icoPath).size / 1024).toFixed(1)} KB`);
}

console.log(`icon.png  ${MASTER}x${MASTER}  ${(fs.statSync(pngPath).size / 1024).toFixed(1)} KB`);
