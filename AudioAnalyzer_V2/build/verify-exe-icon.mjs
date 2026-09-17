// ═══════════════════════════════════════════════════════════════
//  build/verify-exe-icon.mjs — 校验打包后的 exe 内嵌图标
//
//  为什么不能只靠 PowerShell 的 ExtractAssociatedIcon：
//  它只能拿到一个尺寸，且 .NET 的 Icon 构造器对多尺寸图标会抛异常。
//  这里直接解析 PE 的 RT_GROUP_ICON / RT_ICON 资源，
//  把 exe 里的图标重新拼成一个 .ico，与 build/icon.ico 逐条比对。
//
//  跑法：node build/verify-exe-icon.mjs "dist/win-unpacked/Audio Analyzer Pro.exe"
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exePath = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'Audio Analyzer Pro.exe');
const srcIcoPath = path.join(__dirname, 'icon.ico');

const buf = fs.readFileSync(exePath);
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✅' : '❌'} ${m}`); if (!c) fail++; };

console.log(`\n════ ${path.basename(exePath)} ════`);
console.log(`  文件大小 ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

// ── DOS 头 → PE 头 ──
ok(buf.readUInt16LE(0) === 0x5a4d, 'DOS 头 MZ 正确');
const peOff = buf.readUInt32LE(0x3c);
ok(buf.readUInt32LE(peOff) === 0x00004550, 'PE 签名正确');

const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const optOff = peOff + 24;
const magic = buf.readUInt16LE(optOff);
const is64 = magic === 0x20b;
ok(is64 || magic === 0x10b, `可选头 magic 0x${magic.toString(16)}（${is64 ? 'PE32+' : 'PE32'}）`);

// 数据目录：资源表是第 3 个（索引 2）
const ddOff = optOff + (is64 ? 112 : 96);
const resRva = buf.readUInt32LE(ddOff + 2 * 8);
const resSize = buf.readUInt32LE(ddOff + 2 * 8 + 4);
ok(resRva !== 0 && resSize !== 0, `存在资源目录 RVA=0x${resRva.toString(16)} size=${resSize}`);

// ── RVA → 文件偏移 ──
const sections = [];
for (let i = 0; i < numSections; i++) {
  const s = peOff + 24 + optSize + i * 40;
  sections.push({
    name: buf.toString('ascii', s, s + 8).replace(/\0+$/, ''),
    vSize: buf.readUInt32LE(s + 8),
    vAddr: buf.readUInt32LE(s + 12),
    rSize: buf.readUInt32LE(s + 16),
    rPtr: buf.readUInt32LE(s + 20),
  });
}
function rvaToOff(rva) {
  for (const s of sections) {
    if (rva >= s.vAddr && rva < s.vAddr + Math.max(s.vSize, s.rSize)) return rva - s.vAddr + s.rPtr;
  }
  return -1;
}
const resOff = rvaToOff(resRva);
ok(resOff > 0, `资源段定位成功（文件偏移 0x${resOff.toString(16)}）`);

// ── 遍历资源目录树，收集 RT_ICON(3) 与 RT_GROUP_ICON(14) ──
// 目录树三层：type(0) → name/id(1) → language(2)；只有第三层指向
// IMAGE_RESOURCE_DATA_ENTRY（含真正的 DataRVA/Size）。
// ⚠ 第三层的 ID 是「语言」(通常 1033)，不是图标 ID —— 图标 ID 在第二层，
//   必须一路带下来；GRPICONDIR 里引用的正是第二层那个 ID。
function walkDir(absOff, level, wantType, acc, carryId) {
  const named = buf.readUInt16LE(absOff + 12);
  const ids = buf.readUInt16LE(absOff + 14);
  const total = named + ids;
  for (let i = 0; i < total; i++) {
    const e = absOff + 16 + i * 8;
    const nameOrId = buf.readUInt32LE(e);
    const offField = buf.readUInt32LE(e + 4);
    const isDir = (offField & 0x80000000) !== 0;
    const childOff = resOff + (offField & 0x7fffffff);
    const entryId = (nameOrId & 0x80000000) ? -1 : (nameOrId & 0xffff);

    if (level === 0) {
      if (entryId === wantType && isDir) walkDir(childOff, 1, wantType, acc, -1);
    } else if (level === 1) {
      if (isDir) walkDir(childOff, 2, wantType, acc, entryId);
    } else {
      // level 2：叶子是 IMAGE_RESOURCE_DATA_ENTRY；id 用第二层带下来的
      const dataRva = buf.readUInt32LE(childOff);
      const dataSize = buf.readUInt32LE(childOff + 4);
      acc.push({ id: carryId, lang: entryId, offset: rvaToOff(dataRva), size: dataSize, dataRva });
    }
  }
  return acc;
}

const iconEntries = walkDir(resOff, 0, 3, [], -1);      // RT_ICON
const groupEntries = walkDir(resOff, 0, 14, [], -1);    // RT_GROUP_ICON
ok(iconEntries.length > 0, `找到 ${iconEntries.length} 个 RT_ICON 资源（id: ${iconEntries.map(e => e.id).join(',')}）`);
ok(groupEntries.length > 0, `找到 ${groupEntries.length} 个 RT_GROUP_ICON 资源`);
ok(iconEntries.every(e => e.offset > 0 && e.size > 0), 'RT_ICON 资源偏移/长度都有效');
ok(iconEntries.every(e => e.id > 0), 'RT_ICON 的 id 来自第二层（非语言 id）');

// ── 解析 GRPICONDIR，重建 .ico ──
const g = groupEntries[0];
const gd = buf.subarray(g.offset, g.offset + g.size);
const gCount = gd.readUInt16LE(4);
console.log(`  图标组包含 ${gCount} 个尺寸`);

const srcIco = fs.readFileSync(srcIcoPath);
const srcCount = srcIco.readUInt16LE(4);
const srcSizes = [];
for (let i = 0; i < srcCount; i++) {
  const o = 6 + i * 16;
  srcSizes.push(srcIco[o] || 256);
}
const exeSizes = [];
for (let i = 0; i < gCount; i++) {
  const o = 6 + i * 14;
  exeSizes.push(gd[o] || 256);
}
console.log(`  源 icon.ico 尺寸: ${srcSizes.join('/')}`);
console.log(`  exe 内嵌尺寸:     ${exeSizes.join('/')}`);

// 源里的每个尺寸都必须出现在 exe 中（exe 可能少 20/40 这类，Windows 不要求全带）
const missing = srcSizes.filter(s => !exeSizes.includes(s));
ok(missing.length === 0, missing.length ? `exe 缺少尺寸: ${missing.join('/')}` : '源图标的所有尺寸都已内嵌');

// ── 逐尺寸比对像素内容 ──
console.log('\n  尺寸逐一比对（exe 内字节 vs build/icon.ico 内字节）:');
let matched = 0;
for (let i = 0; i < gCount; i++) {
  const o = 6 + i * 14;
  const w = gd[o] || 256;
  const bytes = gd.readUInt32LE(o + 8);
  const resId = gd.readUInt16LE(o + 12);
  const res = iconEntries.find(e => e.id === resId);
  if (!res) { console.log(`    ${String(w).padStart(3)}px  ❌ 找不到 RT_ICON id=${resId}`); fail++; continue; }

  // 在源 ico 中找到同尺寸条目
  let si = -1;
  for (let k = 0; k < srcCount; k++) if ((srcIco[6 + k * 16] || 256) === w) { si = k; break; }
  if (si < 0) { console.log(`    ${String(w).padStart(3)}px  ⚠️  源中无此尺寸，跳过比对`); continue; }
  const sLen = srcIco.readUInt32LE(6 + si * 16 + 8);
  const sOff = srcIco.readUInt32LE(6 + si * 16 + 12);
  const a = buf.subarray(res.offset, res.offset + res.size);
  const b = srcIco.subarray(sOff, sOff + sLen);
  const same = a.length === b.length && a.equals(b);
  if (same) matched++;
  console.log(`    ${String(w).padStart(3)}px  ${String(res.size).padStart(7)} B  ${same ? '✅ 完全一致' : '❌ 不一致'}${bytes ? '' : ''}`);
  if (!same) fail++;
}
ok(matched > 0, `共 ${matched} 个尺寸逐字节一致`);

// ── PNG 大图做「非空白」抽查 ──
console.log('\n  内容抽查（防止嵌入的是空白/全黑图标）:');
for (const w of [256, 128]) {
  const gi = exeSizes.indexOf(w);
  if (gi < 0) continue;
  const o = 6 + gi * 14;
  const resId = gd.readUInt16LE(o + 12);
  const res = iconEntries.find(e => e.id === resId);
  const d = buf.subarray(res.offset, res.offset + res.size);
  if (d.subarray(0, 4).toString('hex') !== '89504e47') { console.log(`    ${w}px 非 PNG 压缩，跳过`); continue; }
  // 解出 IDAT 看是否有非透明像素（不做完整解码，只查 zlib 是否可解）
  const zlib = await import('zlib');
  let off = 8, idat = [];
  while (off + 8 <= d.length) {
    const len = d.readUInt32BE(off);
    const type = d.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(d.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  try {
    const raw = zlib.inflateSync(Buffer.concat(idat));
    let nonZero = 0;
    for (const v of raw) if (v > 16) nonZero++;
    const ratio = nonZero / raw.length;
    console.log(`    ${w}px 解压 ${(raw.length / 1024).toFixed(0)} KB，非零字节占比 ${(ratio * 100).toFixed(1)}%`);
    ok(ratio > 0.05, `${w}px 图标有实际内容（非空白）`);
  } catch (e) {
    console.log(`    ${w}px 解压失败: ${e.message}`);
    fail++;
  }
}

console.log(`\n${fail ? '❌ exe 图标校验失败 ' + fail + ' 项' : '✅ exe 内嵌图标与 build/icon.ico 完全一致'}`);
process.exit(fail ? 1 : 0);
