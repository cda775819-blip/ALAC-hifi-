// ═══════════════════════════════════════════════════════════════
//  极限测试 A：全库格式探测
//  对 3294 个文件各读前 64KB，验证格式解析覆盖率与异常文件
//  严格只读：fs.openSync(path,'r') + 读一次 + close
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = 'F:\\本地音乐文件';
const HEAD = 65536;
const AUDIO_EXT = new Set(['.wav','.flac','.aiff','.aif','.mp3','.m4a','.aac','.ogg','.opus','.wma','.ape','.wv','.tta','.dsf','.dff','.caf','.ac3','.eac3','.mka','.webm','.mp4','.alac']);

// ── 与渲染层 parseFormatFromBytes 等价的探测逻辑（只看文件头）──
function probe(buf) {
  if (buf.length < 16) return { container: null, reason: 'file too small' };
  const a4 = buf.toString('ascii', 0, 4);
  const a8 = buf.toString('ascii', 4, 8);
  const be = (o) => buf.readUInt32BE(o);
  const le = (o) => buf.readUInt32LE(o);

  // RIFF / WAVE
  if (a4 === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12, fmt = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = le(off + 4);
      if (id === 'fmt ') {
        fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: le(off + 12), bits: buf.readUInt16LE(off + 22) };
        break;
      }
      off += 8 + size + (size % 2);
    }
    return { container: 'WAV', codec: 'PCM', lossless: true, ...(fmt || {}) };
  }
  // FLAC
  if (a4 === 'fLaC') {
    // STREAMINFO 紧跟其后
    let sr = null, ch = null, bits = null;
    if (buf.length >= 4 + 4 + 34) {
      const b = buf.subarray(8, 8 + 34);
      sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      ch = ((b[12] >> 1) & 0x07) + 1;
      bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
    }
    return { container: 'FLAC', codec: 'FLAC', lossless: true, sampleRate: sr, channels: ch, bits };
  }
  // OggS
  if (a4 === 'OggS') return { container: 'OGG', codec: 'Vorbis/Opus', lossless: false };
  // DSD
  if (a4 === 'DSD ') return { container: 'DSF', codec: 'DSD', lossless: true };
  if (a4 === 'FRM8') return { container: 'DFF', codec: 'DSD', lossless: true };
  // WavPack
  if (a4 === 'wvpk') return { container: 'WV', codec: 'WavPack', lossless: true };
  // APE
  if (a4 === 'MAC ') return { container: 'APE', codec: 'Monkey\'s Audio', lossless: true };
  // AIFF
  if (a4 === 'FORM' && (a8 === 'AIFF' || a8 === 'AIFC')) return { container: 'AIFF', codec: 'PCM', lossless: true };
  // MP3
  if ((buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return { container: 'MP3', codec: 'MPEG', lossless: false };
  if (a4 === 'ID3\u0000' || buf.toString('ascii', 0, 3) === 'ID3') return { container: 'MP3', codec: 'MPEG+ID3', lossless: false };
  if (a4 === 'TTA1') return { container: 'TTA', codec: 'TTA', lossless: true };
  if (a4 === 'caff') return { container: 'CAF', codec: 'PCM', lossless: true };

  // ISO BMFF（M4A / MP4 / ALAC）—— 单次遍历 box 树找 moov
  if (a8 === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    let off = 0, moov = null;
    while (off + 8 <= buf.length) {
      const size = be(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (size < 8) break;
      if (type === 'moov') { moov = { off, size }; break; }
      off += size;
    }
    return { container: brand.includes('M4A') ? 'M4A' : 'MP4', codec: moov ? 'moov@' + moov.off : 'moov-not-in-head', lossless: null };
  }

  return { container: null, reason: 'unrecognized magic: ' + JSON.stringify(a4) };
}

// ── 收集文件 ──
const files = [];
(function walk(dir, depth) {
  if (depth > 8) return;
  let es;
  try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of es) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (AUDIO_EXT.has(ext)) files.push({ full, ext, name: e.name });
    }
  }
})(ROOT, 1);

console.log(`待探测: ${files.length} 个文件\n`);

const byContainer = new Map();
const failures = [];
const mismatches = [];
let bytesRead = 0;
const t0 = Date.now();

for (let i = 0; i < files.length; i++) {
  const f = files[i];
  let fd = null;
  try {
    fd = fs.openSync(f.full, 'r');
    const st = fs.fstatSync(fd);
    const n = Math.min(HEAD, st.size);
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    bytesRead += got;
    const r = probe(buf.subarray(0, got));
    const key = r.container || '(未识别)';
    byContainer.set(key, (byContainer.get(key) || 0) + 1);
    if (!r.container) failures.push({ file: path.relative(ROOT, f.full), reason: r.reason, size: st.size });
    // 扩展名与容器不符
    const extUp = f.ext.slice(1).toUpperCase();
    if (r.container && !['MP3','MPEG+ID3'].includes(r.container)) {
      const map = { m4a: ['M4A','MP4'], mp4: ['MP4','M4A'], flac: ['FLAC'], wav: ['WAV'], dsf: ['DSF'], mp3: ['MP3'] };
      const allowed = map[f.ext.slice(1)] || [extUp];
      if (!allowed.includes(r.container)) mismatches.push({ file: path.relative(ROOT, f.full), ext: f.ext, container: r.container });
    }
  } catch (e) {
    failures.push({ file: path.relative(ROOT, f.full), reason: 'IO: ' + e.message, size: -1 });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  if (i % 500 === 499) process.stdout.write(`  …${i + 1}/${files.length}\r`);
}

const ms = Date.now() - t0;
console.log(`\n=== 结果（${(ms / 1000).toFixed(1)}s，共读 ${(bytesRead / 1048576).toFixed(1)} MB = 平均 ${(bytesRead / files.length / 1024).toFixed(0)} KB/文件）===`);
console.log(`探测成功: ${files.length - failures.length} / ${files.length}  (${(((files.length - failures.length) / files.length) * 100).toFixed(2)}%)`);

console.log('\n容器分布:');
[...byContainer.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
  console.log(`  ${k.padEnd(16)} ${String(n).padStart(5)}  ${(n / files.length * 100).toFixed(1)}%`);
});

if (mismatches.length) {
  console.log(`\n⚠ 扩展名与容器不符: ${mismatches.length}`);
  mismatches.slice(0, 20).forEach(m => console.log(`  ${m.ext} → ${m.container}  ${m.file}`));
}

if (failures.length) {
  console.log(`\n❌ 探测失败: ${failures.length}`);
  failures.slice(0, 30).forEach(f => console.log(`  [${f.size}] ${f.reason}  ${f.file}`));
}

console.log(`\n${failures.length === 0 ? '✅ A 段通过：全库格式探测 100% 成功' : `⚠ A 段：${failures.length} 个文件未能识别`}`);
