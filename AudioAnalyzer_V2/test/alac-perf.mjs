// 隔离测量：纯 ALAC 解码耗时（旧位读取器 vs 新位读取器），不涉及 Electron/解码链路
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

function sliceFn(name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`).test(l));
  if (start < 0) throw new Error('找不到 ' + name);
  let d = 0, s = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') { d++; s = true; } else if (ch === '}') d--; }
    if (s && d === 0) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error('未闭合 ' + name);
}

const NEW_READER = sliceFn('createALACBitReader');
const OLD_READER = `function createALACBitReader_old(data, offset, length) {
  let pos = offset, bitCount = 0, bitBuf = 0;
  return {
    readBits(n) { let val = 0; for (let i = 0; i < n; i++) { if (bitCount === 0) { bitBuf = pos < offset + length ? data[pos++] : 0; bitCount = 8; } val = (val << 1) | (bitBuf >> 7); bitBuf = (bitBuf << 1) & 0xFF; bitCount--; } return val; },
    readBit() { if (bitCount === 0) { bitBuf = pos < offset + length ? data[pos++] : 0; bitCount = 8; } bitCount--; return (bitBuf >> bitCount) & 1; },
    alignToByte() { bitCount = 0; bitBuf = 0; },
    rawPos() { return pos; },
    remaining() { return offset + length - pos - (bitCount > 0 ? 1 : 0); },
  };
}`;

const decodeFn = sliceFn('decodeOneALACFrame');
const pcmFn = sliceFn('decodeALACFramesToPCM');
const writeFn = sliceFn('writeInterleavedPCM');
const STUBS = 'const D = { ok(){}, info(){}, warn(){}, err(){} };\n';

function build(readerName, tag) {
  const body = decodeFn.replace(/createALACBitReader\(/g, readerName + '(');
  const s = `
${STUBS}
${OLD_READER}
${NEW_READER}
let ALAC_FRAME_DIAG = {};
${body}
${writeFn}
${pcmFn.replace(/decodeOneALACFrame\(/g, '_ONE_(')}
${body.replace('function decodeOneALACFrame', 'function _ONE_')}
export { decodeALACFramesToPCM as run };
`;
  const p = path.join(ROOT, `.tmp-perf-${tag}.mjs`);
  fs.writeFileSync(p, s);
  return p;
}
const oldPath = build('createALACBitReader_old', 'old');
const newPath = build('createALACBitReader', 'new');
const oldMod = await import(pathToFileURL(oldPath).href);
const newMod = await import(pathToFileURL(newPath).href);

// MP4 解析（抽帧）
const mp4Path = path.join(ROOT, '.tmp-perf-mp4.mjs');
fs.writeFileSync(mp4Path, `
${STUBS}
${sliceFn('findChild')}
${sliceFn('findAllChildren')}
${sliceFn('parseMP4BoxTree')}
${sliceFn('extractMP4Info')}
${sliceFn('parseSampleTable')}
${sliceFn('readStrHelper')}
${sliceFn('extractASCFromESDS')}
${sliceFn('parseALACConfig')}
export { parseMP4BoxTree, extractMP4Info, parseSampleTable, parseALACConfig };
`);
const mp4 = await import(pathToFileURL(mp4Path).href);

const FILE = 'F:\\本地音乐文件\\1989\\02 Blank Space.m4a';
const bytes = new Uint8Array(fs.readFileSync(FILE));
const tree = mp4.parseMP4BoxTree(bytes);
const info = mp4.extractMP4Info(bytes, tree);
const cfg = mp4.parseALACConfig(info.config);
const list = mp4.parseSampleTable(bytes, tree, info);
const frames = list.filter(f => f.offset + f.size <= bytes.length)
  .map(f => ({ data: bytes.subarray(f.offset, f.offset + f.size) }));

console.log(`文件: ${path.basename(FILE)}  ${(bytes.length / 1048576).toFixed(1)}MB`);
console.log(`配置: bitDepth=${cfg.bitDepth} frameLength=${cfg.frameLength} sr=${cfg.sampleRate} ch=${cfg.channels}`);
console.log(`帧数: ${frames.length}  总压缩字节: ${(frames.reduce((s, f) => s + f.data.length, 0) / 1048576).toFixed(1)}MB\n`);

// 预热
oldMod.run(frames.slice(0, 5), cfg, cfg.sampleRate, cfg.channels);
newMod.run(frames.slice(0, 5), cfg, cfg.sampleRate, cfg.channels);

function timeIt(label, mod) {
  const t0 = performance.now();
  const out = mod.run(frames, cfg, cfg.sampleRate, cfg.channels);
  const ms = performance.now() - t0;
  let mx = 0, sq = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > mx) mx = a; sq += out[i] * out[i]; }
  return { label, ms, len: out.length, max: mx, rms: Math.sqrt(sq / out.length), out };
}

const rOld = timeIt('旧（逐比特）', oldMod);
const rNew = timeIt('新（批量跳零）', newMod);

console.log('实现           耗时      输出样本数   峰值     RMS');
console.log('-'.repeat(62));
for (const r of [rOld, rNew]) {
  console.log(`${r.label.padEnd(14)} ${String(Math.round(r.ms)).padStart(6)}ms  ${String(r.len).padStart(10)}  ${r.max.toFixed(4)}  ${r.rms.toFixed(6)}`);
}
console.log(`\n加速比: ${(rOld.ms / rNew.ms).toFixed(2)}x  （${Math.round(rOld.ms)}ms → ${Math.round(rNew.ms)}ms）`);

// 逐样本一致性
let diff = 0;
for (let i = 0; i < rOld.out.length; i++) if (rOld.out[i] !== rNew.out[i]) diff++;
console.log(`逐样本比对: ${rOld.out.length - diff}/${rOld.out.length} 一致  ${diff === 0 ? '✅' : '❌ ' + diff + ' 个不同'}`);

for (const p of [oldPath, newPath, mp4Path]) { try { fs.unlinkSync(p); } catch (_) {} }
process.exit(diff === 0 && rNew.ms < rOld.ms ? 0 : 1);
