// 生成可视化核对图：把 256 尺寸裁出来 + 放大几个关键尺寸，便于人工/多模态核对
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { encodePNG, decodePNG } from './png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const img = decodePNG(fs.readFileSync(path.join(__dirname, 'icon.png')));
const { width: W, rgba } = img;

function crop(x0, y0, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    rgba.copy(out, y * w * 4, ((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4);
  }
  return out;
}

function scale(src, sw, sh, dstW, dstH, bg = [26, 26, 30]) {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / dstW));
      const sy = Math.min(sh - 1, Math.floor(y * sh / dstH));
      const s = (sy * sw + sx) * 4;
      const a = src[s + 3] / 255;
      const o = (y * dstW + x) * 4;
      out[o]     = Math.round(src[s] * a + bg[0] * (1 - a));
      out[o + 1] = Math.round(src[s + 1] * a + bg[1] * (1 - a));
      out[o + 2] = Math.round(src[s + 2] * a + bg[2] * (1 - a));
      out[o + 3] = 255;
    }
  }
  return out;
}

// 拼一张核对图：256 原尺寸 + 64 + 32 + 16（都放大到 256 便于观察）
const CELL = 256, GAP = 16;
const total = CELL * 4 + GAP * 5;
const sheet = Buffer.alloc(total * (CELL + GAP * 2) * 4);
// 铺一层中性背景，方便看透明区域
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 40; sheet[i + 1] = 42; sheet[i + 2] = 48; sheet[i + 3] = 255;
}
const put = (px, size, dstX, dstY) => {
  const scaled = size === CELL ? px : scale(px, size, size, CELL, CELL);
  for (let y = 0; y < CELL; y++) {
    scaled.copy(sheet, ((dstY + y) * total + dstX) * 4, y * CELL * 4, (y + 1) * CELL * 4);
  }
};
let cx = GAP;
for (const s of [256, 64, 32, 16]) {
  const px = s === 256 ? rgba : scale(rgba, W, W, s, s);
  put(px, s, cx, GAP);
  cx += CELL + GAP;
}
fs.writeFileSync(path.join(__dirname, '.icon-preview.png'),
  encodePNG(total, CELL + GAP * 2, sheet));
console.log(`核对图: build/.icon-preview.png  ${total}x${CELL + GAP * 2}  （256 / 64 / 32 / 16 各放大到 256）`);

// 同时导出一张纯 256 的图，模拟任务栏实际尺寸
const p256 = scale(rgba, W, W, 256, 256);
fs.writeFileSync(path.join(__dirname, '.icon-256.png'), encodePNG(256, 256, p256));
console.log('单图: build/.icon-256.png');
