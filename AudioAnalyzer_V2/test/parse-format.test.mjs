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

function probe(relPath) {
  const p = path.join(MUSIC, relPath);
  if (!fs.existsSync(p)) return { missing: true, p };
  const st = fs.statSync(p);
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(Math.min(HEAD, st.size));
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
  const r = probe(c.rel);
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

try { fs.unlinkSync(tmp); } catch (_) {}

console.log(`\n（检查 ${checked} 个真实文件，跳过 ${skipped} 个）`);
process.exit(A.report('文件头格式解析回归测试') ? 0 : 1);
