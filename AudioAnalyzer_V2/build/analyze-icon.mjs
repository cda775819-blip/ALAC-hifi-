// 分析现有图标：主色、形状、构图（用 ASCII 缩略图代替肉眼）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodePNG } from './png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const img = decodePNG(fs.readFileSync(path.join(__dirname, 'icon.png')));
const { width: W, height: H, rgba, colorType } = img;

console.log(`尺寸 ${W}x${H}  colorType=${colorType}`);

// 颜色统计（按 16 级量化）
const hist = new Map();
let opaque = 0, transparent = 0;
for (let i = 0; i < W * H; i++) {
  const a = rgba[i * 4 + 3];
  if (a < 8) { transparent++; continue; }
  opaque++;
  const k = `${rgba[i * 4] >> 4},${rgba[i * 4 + 1] >> 4},${rgba[i * 4 + 2] >> 4}`;
  hist.set(k, (hist.get(k) || 0) + 1);
}
console.log(`不透明像素 ${opaque}  透明/半透明 ${transparent}`);
console.log('\n主要颜色（量化到 16 级，取前 12）:');
[...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => {
  const [r, g, b] = k.split(',').map(v => v * 16 + 8);
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  console.log(`  ${hex}  rgb(${String(r).padStart(3)},${String(g).padStart(3)},${String(b).padStart(3)})  ${String(n).padStart(6)} px  ${(n / opaque * 100).toFixed(1)}%`);
});

// 角落 alpha：判断是否有圆角/透明边
const at = (x, y) => rgba[(y * W + x) * 4 + 3];
console.log(`\n角落 alpha: 左上=${at(0, 0)} 右上=${at(W - 1, 0)} 左下=${at(0, H - 1)} 右下=${at(W - 1, H - 1)}`);
console.log(`中心 alpha=${at(W >> 1, H >> 1)}  边缘中点 alpha: 上=${at(W >> 1, 0)} 左=${at(0, H >> 1)}`);

// ASCII 缩略图（亮度 + 色相提示）
const CW = 64, CH = 32;
const ramp = ' .:-=+*#%@';
console.log('\n亮度缩略图（每格平均，' + CW + 'x' + CH + '）:');
for (let cy = 0; cy < CH; cy++) {
  let line = '';
  for (let cx = 0; cx < CW; cx++) {
    const x0 = Math.floor(cx * W / CW), x1 = Math.floor((cx + 1) * W / CW);
    const y0 = Math.floor(cy * H / CH), y1 = Math.floor((cy + 1) * H / CH);
    let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const a = rgba[i + 3] / 255;
      sr += rgba[i] * a; sg += rgba[i + 1] * a; sb += rgba[i + 2] * a; sa += a; n++;
    }
    if (sa < 0.05) { line += ' '; continue; }
    const lum = (0.299 * sr + 0.587 * sg + 0.114 * sb) / n / 255;
    line += ramp[Math.min(ramp.length - 1, Math.round(lum * (ramp.length - 1)))];
  }
  console.log('  |' + line + '|');
}

// 色相缩略图：A=琥珀 B=青 C=白/灰 D=其他
console.log('\n色相缩略图（A=琥珀系 B=青系 W=灰白 .=透明）:');
for (let cy = 0; cy < CH; cy++) {
  let line = '';
  for (let cx = 0; cx < CW; cx++) {
    const x0 = Math.floor(cx * W / CW), x1 = Math.floor((cx + 1) * W / CW);
    const y0 = Math.floor(cy * H / CH), y1 = Math.floor((cy + 1) * H / CH);
    let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const a = rgba[i + 3] / 255;
      sr += rgba[i] * a; sg += rgba[i + 1] * a; sb += rgba[i + 2] * a; sa += a; n++;
    }
    if (sa < 0.05) { line += '.'; continue; }
    const r = sr / n, g = sg / n, b = sb / n;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    if (sat < 0.15) line += (mx > 90 ? 'W' : '#');
    else if (r >= g && g >= b && r > b * 1.4) line += 'A';
    else if (b >= r && g >= r) line += 'B';
    else line += '?';
  }
  console.log('  |' + line + '|');
}
