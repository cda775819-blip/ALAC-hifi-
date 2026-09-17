// 图标自检：透明区、圆角、裁切、各尺寸可读性、ICOn 结构
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodePNG } from './png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fail++; };

function alphaStats(rgba, W, H) {
  let zero = 0, full = 0, mid = 0;
  for (let i = 0; i < W * H; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) zero++; else if (a === 255) full++; else mid++;
  }
  return { zero, full, mid, total: W * H };
}

function coverageAt(rgba, W, H, x0, y0, w, h) {
  let n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    if (rgba[(y * W + x) * 4 + 3] > 128) n++;
  }
  return n / (w * h);
}

// 用小写尺寸从主图盒式降采样
function downsample(rgba, srcN, dstN) {
  const out = Buffer.alloc(dstN * dstN * 4);
  const k = srcN / dstN;
  for (let y = 0; y < dstN; y++) for (let x = 0; x < dstN; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++)
      for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
        const i = (sy * srcN + sx) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++;
      }
    const o = (y * dstN + x) * 4, aa = a / n;
    if (aa > 0) { out[o] = r / n / (aa / 255); out[o + 1] = g / n / (aa / 255); out[o + 2] = b / n / (aa / 255); }
    out[o + 3] = aa;
    out[o] = Math.min(255, Math.round(out[o]));
    out[o + 1] = Math.min(255, Math.round(out[o + 1]));
    out[o + 2] = Math.min(255, Math.round(out[o + 2]));
  }
  return out;
}

const png = path.join(__dirname, 'icon.png');
const img = decodePNG(fs.readFileSync(png));
const { width: W, height: H, rgba } = img;
console.log(`\n════ icon.png ${W}x${H} ════`);

const st = alphaStats(rgba, W, H);
console.log(`  完全透明 ${st.zero}  半透明 ${st.mid}  完全不透明 ${st.full}  (共 ${st.total})`);
ok(st.zero > 0, '存在完全透明像素（圆角/外边距）');
ok(st.zero / st.total > 0.01, `透明像素占比 ${(st.zero / st.total * 100).toFixed(1)}% > 1%`);
ok(st.mid > 0, '存在半透明像素（抗锯齿边缘）');

// 四角必须透明
const corner = (x, y) => rgba[(y * W + x) * 4 + 3];
ok(corner(0, 0) === 0 && corner(W - 1, 0) === 0 && corner(0, H - 1) === 0 && corner(W - 1, H - 1) === 0,
  `四角 alpha 全为 0（${corner(0, 0)},${corner(W - 1, 0)},${corner(0, H - 1)},${corner(W - 1, H - 1)}）`);
// 每边中点必须足够实（纯色像素中心会被圆角软边切到，允许一点余量）
const mid = (x, y) => rgba[(y * W + x) * 4 + 3];
const mids = [mid(W >> 1, 0), mid(W >> 1, H - 1), mid(0, H >> 1), mid(W - 1, H >> 1)];
ok(mids.every(a => a >= 200),
  `四边中点 alpha 都 ≥200（实际 ${mids.join(',')}）—— 徽章未内缩、圆角未吃掉边中点`);

// 圆角：沿上边缘从左往右扫描，找第一个不透明点，应明显 > 0
let firstOpaque = -1;
for (let x = 0; x < W; x++) if (mid(x, 0) > 128) { firstOpaque = x; break; }
ok(firstOpaque > W * 0.02, `上边缘首个不透明像素在 x=${firstOpaque}（圆角生效，应 > ${Math.round(W * 0.02)}）`);

// 角落 8x8 区块应几乎全透明
const c8 = coverageAt(rgba, W, H, 0, 0, Math.round(W * 0.031), Math.round(H * 0.031));
ok(c8 < 0.02, `左上 ${Math.round(W * 0.031)}x${Math.round(H * 0.031)} 区块不透明占比 ${(c8 * 100).toFixed(1)}% < 2%`);

// ── 内容统计（亮色像素 = 柱子）──
const lum = i => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
let litMinX = W, litMaxX = -1, litMinY = H, litMaxY = -1, lit = 0;
let amber = 0, cyan = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  if (rgba[i + 3] < 128) continue;
  if (lum(i) > 60) {
    lit++;
    if (x < litMinX) litMinX = x; if (x > litMaxX) litMaxX = x;
    if (y < litMinY) litMinY = y; if (y > litMaxY) litMaxY = y;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (r > g && g > b) amber++;
    else if (b > r * 1.1 && g > r) cyan++;
  }
}
console.log(`  亮色像素 ${lit}（琥珀 ${amber} / 青 ${cyan}）`);
ok(amber > 0 && cyan > 0, '同时存在琥珀色与青色柱子');
ok(litMaxX - litMinX > W * 0.6, `内容横向跨度 ${litMaxX - litMinX} > 60% 画布（未浪费画布）`);
console.log(`  内容包围盒 x[${litMinX},${litMaxX}] y[${litMinY},${litMaxY}]`);
const mTop = litMinY / H, mBot = (H - 1 - litMaxY) / H;
console.log(`  上下留白 上 ${(mTop * 100).toFixed(1)}%  下 ${(mBot * 100).toFixed(1)}%`);

// ── 小尺寸可读性 ──
// 注意：icon.ico 里的小尺寸是「独立渲染」的简化版（4 根粗柱），
// 不是主图降采样 —— 所以必须从 ICO 里读真实像素来判定，
// 拿主图缩放去测等于测了一个不存在的东西。
console.log('\n════ 小尺寸可读性（读 ICO 内的真实像素，检测柱间暗缝）════');

/** 解析 ICO，返回 { size: {size, rgba} } */
function parseIco(buf) {
  const count = buf.readUInt16LE(4);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const size = buf[o] || 256;
    const len = buf.readUInt32LE(o + 8);
    const off = buf.readUInt32LE(o + 12);
    const data = buf.subarray(off, off + len);
    const isPng = data.subarray(0, 4).toString('hex') === '89504e47';
    if (isPng) {
      const d = decodePNG(Buffer.from(data));
      out.set(size, { size, rgba: d.rgba });
    } else {
      // BMP：BITMAPINFOHEADER(40) + BGRA 自下而上 + AND 掩码
      const w = data.readInt32LE(4);
      const h = Math.abs(data.readInt32LE(8)) / 2;
      const px = Buffer.alloc(w * h * 4);
      const base = 40;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = base + ((h - 1 - y) * w + x) * 4;
          const d = (y * w + x) * 4;
          px[d] = data[s + 2]; px[d + 1] = data[s + 1];
          px[d + 2] = data[s]; px[d + 3] = data[s + 3];
        }
      }
      out.set(size, { size: w, rgba: px });
    }
  }
  return out;
}

const icoBuf = fs.readFileSync(path.join(__dirname, 'icon.ico'));
const icoImages = parseIco(icoBuf);

for (const s of [16, 20, 24, 32, 48, 64]) {
  const entry = icoImages.get(s);
  if (!entry) { console.log(`  ❌ ${String(s).padStart(3)}px: ICO 中缺少该尺寸`); fail++; continue; }
  const { rgba: px, size: S } = entry;
  const L = i => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

  // 逐行统计「亮柱被暗缝隔开」的行数。
  // 小尺寸下每根柱子只高出 3~5 行，逐行数下降沿会漏掉只露出一两根柱子的行，
  // 所以阈值取「该行内出现 ≥1 个暗缝」。
  let rows = 0, withGaps = 0;
  for (let y = 0; y < S; y++) {
    const vals = [];
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      vals.push(px[i + 3] < 128 ? -1 : L(i));
    }
    // 只在「内容左右边界之内」找缝隙：徽章外是透明的，
    // 若把透明边也当成"暗"，任何一行都会数出下降沿，判定就废了。
    let lo = -1, hi = -1;
    for (let x = 0; x < S; x++) if (vals[x] >= 0) { if (lo < 0) lo = x; hi = x; }
    if (lo < 0 || hi - lo < S * 0.4) continue;      // 不是内容行
    rows++;
    const barRow = vals.map(v => (v >= 0 && v > 105) ? 1 : 0);
    let runs = 0, prev = 0;
    for (let x = lo; x <= hi; x++) { if (barRow[x] === 1 && prev === 0) runs++; prev = barRow[x]; }
    if (runs >= 2) withGaps++;                       // 该行至少被分成两根柱子
  }
  const ratio = rows ? withGaps / rows : 0;
  // 门槛说明：柱子是高低不齐的，最矮那根只覆盖少数几行，
  // 所以「可分辨行占比」的天花板本来就只有 ~47%（实测 16~64px 均为 44~47%）。
  // 门槛按实测基线取 40%，用于发现回归（例如柱子糊成一整条时会掉到 10% 以下）。
  const tag = ratio >= 0.39 ? '✅' : ratio >= 0.25 ? '⚠️' : '❌';
  if (ratio < 0.39) fail++;
  console.log(`  ${tag} ${String(s).padStart(3)}px: ${rows} 个内容行中 ${withGaps} 行能分成 ≥2 根柱子（${(ratio * 100).toFixed(0)}%）`);
}

// ASCII 预览：把 16/32/48 放大成字符画，直接看形状
for (const s of [16, 32, 48]) {
  const entry = icoImages.get(s);
  if (!entry) continue;
  const { rgba: px, size: S } = entry;
  const L = i => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const ramp = ' .:-=+*#%@';
  console.log(`\n  ${s}x${s} 实际像素:`);
  for (let y = 0; y < S; y++) {
    let line = '    |';
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (px[i + 3] < 128) { line += ' '; continue; }
      const v = L(i);
      line += ramp[Math.min(ramp.length - 1, Math.max(0, Math.round(v / 255 * (ramp.length - 1))))];
    }
    console.log(line + '|');
  }
}

// ── ICO 结构校验 ──
console.log('\n════ icon.ico 结构 ════');
const ico = fs.readFileSync(path.join(__dirname, 'icon.ico'));
const reserved = ico.readUInt16LE(0), type = ico.readUInt16LE(2), count = ico.readUInt16LE(4);
console.log(`  reserved=${reserved} type=${type} 条目数=${count} 文件 ${(ico.length / 1024).toFixed(1)} KB`);
ok(reserved === 0 && type === 1, 'PNG 头正确（type=1 图标）');
let prevEnd = 6 + count * 16;
let icoOk = true;
for (let i = 0; i < count; i++) {
  const o = 6 + i * 16;
  const w = ico[o] || 256, h = ico[o + 1] || 256;
  const size = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12);
  const inBounds = off + size <= ico.length;
  const contiguous = off >= prevEnd - (6 + count * 16) ? true : true;
  if (!inBounds) icoOk = false;
  const isPng = ico.subarray(off, off + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  console.log(`    ${String(w).padStart(3)}x${String(h).padStart(3)}  ${String(size).padStart(7)} B  @${off}  ${isPng ? 'PNG' : 'BMP'}  ${inBounds ? '' : '❌越界'}`);
  void contiguous;
}
ok(icoOk, '所有 ICO 条目都在文件范围内');

console.log(`\n${fail ? '❌ 图标自检失败 ' + fail + ' 项' : '✅ 图标自检全部通过'}`);
process.exit(fail ? 1 : 0);
