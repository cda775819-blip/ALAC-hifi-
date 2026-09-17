// ═══════════════════════════════════════════════════════════════
//  test/parse-format.test.mjs — 文件头格式解析回归测试
//
//  守护的 bug（真实修复过的）：
//   1. MP4/ALAC：AudioSampleEntry 的字段偏移整体差 2 字节，
//      且去读了容器里恒为 0 的 channelcount/samplesize。
//      真值只在 ALAC magic cookie 里 —— 旧实现把 sampleRate 报成 1。
//      实测：stsd+38 的 channelcount = 0，cookie 里 numChannels = 2。
//   2. DSF：把文件 +20 的 64 位 ID3 metadataPtr 当成了声道数，
//      高 32 位当成采样率 —— 结果 channels 报成 486850652。
//      正确位置是 fmt chunk（文件+28）的 +24 channelNum / +28 samplingFrequency。
//
//  跑法：node test/parse-format.test.mjs
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createAsserter } from './extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MUSIC = 'F:\\本地音乐文件';
const HEAD = 64 * 1024;

// 抽出真实实现（不二次实现，避免"测了个假的"）
const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
function sliceFn(name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`).test(l));
  if (start < 0) throw new Error('找不到函数 ' + name);
  let d = 0, s = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') { d++; s = true; } else if (ch === '}') d--; }
    if (s && d === 0) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error('未闭合 ' + name);
}

const tmp = path.join(ROOT, `.tmp-parseformat-${process.pid}.mjs`);
fs.writeFileSync(tmp,
  'const D={ok(){},info(){},warn(){},err(){}};\n'
  + 'const $$=()=>[]; const $=()=>null;\n'
  + sliceFn('readALACMagicCookie') + '\n'
  + sliceFn('parseFormatFromBytes') + '\n'
  + 'export { parseFormatFromBytes, readALACMagicCookie };\n');
const { parseFormatFromBytes } = await import(pathToFileURL(tmp).href);

const A = createAsserter();

// headBytes: 只把文件的前 N 字节喂给解析器，用来复现"解析窗口不足"的场景
// find: 多个候选路径，取第一个存在的（外部样本不保证在本机）
function probe(relPath, { abs = false, headBytes = HEAD, find = null } = {}) {
  let p = abs ? relPath : path.join(MUSIC, relPath);
  if (find) {
    const hit = find.find(f => fs.existsSync(f));
    if (!hit) return { missing: true, p: find[0] };
    p = hit;
  }
  if (!fs.existsSync(p)) return { missing: true, p };
  const st = fs.statSync(p);
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(Math.min(headBytes, st.size));
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  let info = null, err = null;
  try { info = parseFormatFromBytes(new Uint8Array(buf.subarray(0, n))); }
  catch (e) { err = e.message; }
  return { missing: false, info, err, size: st.size };
}

const CASES = [
  {
    label: 'M4A ALAC 44.1k/24bit',
    rel: '1989\\02 Blank Space.m4a',
    expect: { container: 'ALAC', codec: 'ALAC', lossless: true, channels: 2, sampleRate: 44100, bitDepth: 24 },
  },
  {
    label: 'M4A ALAC 192k 大文件',
    rel: "Coldplay\\Parachutes\\10 Everything's Not Lost.m4a",
    expect: { container: 'ALAC', codec: 'ALAC', channels: 2, sampleRate: 192000, bitDepth: 24 },
  },
  {
    label: 'FLAC 96k/24bit',
    rel: '新建文件夹\\V. Pie Jesu2420.flac',
    expect: { container: 'FLAC', codec: 'FLAC', lossless: true, channels: 2, sampleRate: 96000, bitDepth: 24 },
  },
  {
    label: 'WAV 44.1k',
    rel: 'am\\04. 苦瓜.wav',
    expect: { container: 'WAV', codec: 'PCM', lossless: true, channels: 2, sampleRate: 44100 },
  },
  {
    // ── 回归：data chunk 远在 fmt 之后 ──
    // 该文件的 chunk 顺序是 fmt(12) → LIST(36,+270) → JUNK(314,+3766) → data(4088)。
    // 旧实现的 DataView 只覆盖前 256 字节，且命中 fmt 后不 break，
    // 继续推进 off 去读后面的 chunk 头 → RangeError → 整条分析链崩掉
    // （用户看到的是"所有解码方式均失败"）。
    // 这是外部样本，可能被移动/删除；缺失时下面的合成用例仍会覆盖同一 bug。
    label: 'WAV data块在4088',
    abs: true,
    find: ['E:\\260917_2108.wav', path.join(MUSIC, '260917_2108.wav')],
    headBytes: 4096,
    expect: { container: 'WAV', codec: 'PCM', lossless: true, channels: 2, sampleRate: 96000, bitDepth: 24 },
  },
  {
    label: 'DSF (DSD128)',
    rel: '新建文件夹 (2)\\09.杀死那个石家庄人.dsf',
    expect: { container: 'DSF', codec: 'DSD', lossless: true, channels: 2, bitDepth: 1 },
    extra: (info, a) => {
      // DSF 的 sampleRate 是 DSD 原始 1-bit 码率，必须落在合理区间
      a.ok(info.sampleRate >= 2800000 && info.sampleRate <= 50000000,
        `DSF 采样率 ${info.sampleRate} 不在 DSD 原始码率范围（应 ≥2822400）`);
      a.ok(info.dsdRate === info.sampleRate, 'DSF 应同时给出 dsdRate 字段');
      a.ok(info.channelType >= 1 && info.channelType <= 64, `DSF channelType 异常: ${info.channelType}`);
      // 关键回归点：绝不能是那串荒谬数字
      a.ok(info.channels < 100, `DSF 声道数 ${info.channels} 仍异常（旧 bug 会报 486850652）`);
    },
  },
  {
    label: '扩展名说谎 .flac(实为M4A)',
    rel: 'QQ\\悪女.flac',
    expect: { container: 'ALAC', codec: 'ALAC', channels: 2 },
  },
];

console.log('=== 文件头解析：解析结果 vs 期望值 ===\n');
console.log('文件                        容器   编码   声道  采样率      位深   判定');
console.log('-'.repeat(80));

let checked = 0, skipped = 0;
for (const c of CASES) {
  const r = probe(c.rel, { abs: !!c.abs, headBytes: c.headBytes || HEAD, find: c.find || null });
  if (r.missing) {
    console.log(`${c.label.padEnd(26)} — 样本文件不存在，跳过（${r.p}）`);
    skipped++;
    continue;
  }
  checked++;
  if (r.err) { A.ok(false, `${c.label}: 解析抛异常 — ${r.err}`); continue; }
  const info = r.info || {};
  const bad = [];
  for (const [k, v] of Object.entries(c.expect)) {
    if (info[k] !== v) bad.push(`${k}=${info[k]}≠${v}`);
    A.ok(info[k] === v, `${c.label}: ${k} = ${info[k]}，期望 ${v}`);
  }
  if (c.extra) c.extra(info, A);
  console.log(
    `${c.label.padEnd(26)} ${String(info.container).padEnd(6)} ${String(info.codec).padEnd(6)} ` +
    `${String(info.channels).padStart(4)}  ${String(info.sampleRate).padStart(8)}  ${String(info.bitDepth).padStart(4)}   ` +
    `${bad.length ? '❌ ' + bad.join(' ') : '✅'}`
  );
}

// ── 反向断言：旧 bug 的特征值绝不能再次出现 ──
console.log('\n=== 旧 bug 特征值检查 ===');
{
  const r = probe('1989\\02 Blank Space.m4a');
  if (!r.missing && r.info) {
    A.ok(r.info.sampleRate !== 1, 'M4A 采样率又变回 1（旧 bug：读了 SampleEntry 的错误偏移）');
    A.ok(r.info.channels !== undefined, 'M4A 声道数为 undefined（cookie 与 SampleEntry 都没解析到）');
    console.log(`  M4A sampleRate=${r.info.sampleRate}  ${r.info.sampleRate !== 1 ? '✅ 不是 1' : '❌ 仍是 1'}`);
  }
  const d = probe('新建文件夹 (2)\\09.杀死那个石家庄人.dsf');
  if (!d.missing && d.info) {
    A.ok(d.info.channels !== 486850652, 'DSF 又报出 486850652（旧 bug：把 metadataPtr 当声道数）');
    console.log(`  DSF  channels=${d.info.channels}  ${d.info.channels !== 486850652 ? '✅ 不是 486850652' : '❌ 仍是 486850652'}`);
  }
}

// ── 合成边界用例（不依赖真实文件）──
console.log('\n=== 边界与健壮性 ===');
{
  A.ok(parseFormatFromBytes(new Uint8Array(0)) === null, '空输入应返回 null');
  A.ok(parseFormatFromBytes(new Uint8Array([1, 2, 3])) === null, '过短输入应返回 null');
  A.ok(parseFormatFromBytes(new Uint8Array(1000)) === null, '全零输入应返回 null');
  // 伪造 DSF 头但 fmt 缺失
  const fake = new Uint8Array(200);
  fake.set([0x44, 0x53, 0x44, 0x20], 0);   // "DSD "
  const r = parseFormatFromBytes(fake);
  A.ok(r && r.container === 'DSF', '伪造 DSF 头应识别为 DSF');
  A.ok(r.channels === undefined, 'fmt 缺失时不应给出 channels');
  console.log('  空/过短/全零输入 → null ✅   伪造 DSF 头 → 识别但不猜字段 ✅');
}

// ── 合成 WAV：data chunk 在第一窗口之外（不依赖真实文件，必跑）──
// 这是那个 RangeError 的最小复现：fmt 在前 44 字节内，data 在 4096。
// 旧实现在这里抛 "Offset is outside the bounds of the DataView"。
console.log('\n=== WAV chunk 遍历：data 在第一窗口之外 ===');
{
  function buildWav({ pad, dataOff, sr = 96000, ch = 2, bits = 24 }) {
    const buf = new Uint8Array(dataOff + 64);
    const dv = new DataView(buf.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, buf.length - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true);                 // fmt 头在 12，size=16
    dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * bits / 8, true);
    dv.setUint16(32, ch * bits / 8, true); dv.setUint16(34, bits, true);
    let off = 36;
    for (const [id, size] of pad) {                              // 干扰 chunk
      str(off, id); dv.setUint32(off + 4, size, true);
      off += 8 + size + (size % 2);
    }
    if (off !== dataOff) throw new Error(`构造错误：data 落在 ${off}，期望 ${dataOff}`);
    str(off, 'data'); dv.setUint32(off + 4, 8, true);            // data 头
    return buf;
  }

  const near = parseFormatFromBytes(buildWav({ pad: [], dataOff: 36 }));
  A.ok(near && near.container === 'WAV' && near.sampleRate === 96000,
    `data 紧邻 fmt 时应解析成功（得到 ${near && near.sampleRate}）`);

  // 复刻真实文件的块布局：fmt(12) → LIST(36,+270) → JUNK(314,+3766) → data(4088)
  const far = parseFormatFromBytes(buildWav({ pad: [['LIST', 270], ['JUNK', 3766]], dataOff: 4088 }));
  A.ok(far !== null, 'data 在 4096 时应解析出对象（旧实现抛 RangeError）');
  A.ok(far && far.container === 'WAV', `data 在 4096 时 container = ${far && far.container}，期望 WAV`);
  A.ok(far && far.sampleRate === 96000, `data 在 4096 时 sampleRate = ${far && far.sampleRate}，期望 96000`);
  A.ok(far && far.channels === 2 && far.bitDepth === 24,
    `data 在 4096 时 channels/bitDepth = ${far && far.channels}/${far && far.bitDepth}，期望 2/24`);

  // 奇数长度 chunk 要做字对齐（JUNK size=5 → 占 8+5+1=14 字节）
  const odd = parseFormatFromBytes(buildWav({ pad: [['JUNK', 5], ['LIST', 1000]], dataOff: 1058 }));
  A.ok(odd && odd.sampleRate === 96000, `奇数长 chunk 对齐后 sampleRate = ${odd && odd.sampleRate}，期望 96000`);

  // 越界声明的 chunk 不能让解析器跑飞（也不能谎报成功）
  const bad = new Uint8Array(buildWav({ pad: [], dataOff: 36 }));
  new DataView(bad.buffer).setUint32(16, 0x7ffffff0, true);      // fmt size 声明成天文数字
  let badErr = null;
  try { parseFormatFromBytes(bad); } catch (e) { badErr = e.message; }
  A.ok(!badErr, `chunk size 越界时不应抛异常（实际：${badErr}）`);

  console.log(`  data@36    → ${near && near.sampleRate}Hz ${near && near.bitDepth}bit ✅`);
  console.log(`  data@4088  → ${far && far.sampleRate}Hz ${far && far.bitDepth}bit ✅（旧实现此处 RangeError）`);
  console.log(`  奇数 chunk → ${odd && odd.sampleRate}Hz ✅   越界 size → 无异常 ✅`);
}

try { fs.unlinkSync(tmp); } catch (_) {}

console.log(`\n（检查 ${checked} 个真实文件，跳过 ${skipped} 个）`);
process.exit(A.report('文件头格式解析回归测试') ? 0 : 1);
