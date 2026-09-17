// ═══════════════════════════════════════════════════════════════
//  ALAC 解码端到端对拍：旧实现 vs 新位读取器
//
//  与「逐位对拍」不同，这里比对的是**最终 PCM 样本**，也就是真正要保证的东西：
//  位读取器再怎么写，只要解码出的样本逐样本一致，替换就是安全的。
//
//  做法：把渲染层的 ALAC 解码链抽出来，用可控的 MP4 容器喂进去，
//  分别注入旧/新位读取器，比较输出。
//
//  跑法：node test/alac-decode.test.mjs
// ═══════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'renderer', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

// 抽取所需的纯函数（不依赖 DOM）
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

const NEW_READER = sliceFn('createALACBitReader');

// 旧实现（内联，与 git 历史中的版本一致）
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

// 被测函数：新读取器用原名，再复制一份用旧读取器
const decodeFn = sliceFn('decodeOneALACFrame');
const pcmFn = sliceFn('decodeALACFramesToPCM');
const writeFn = sliceFn('writeInterleavedPCM');

// 渲染层这些函数会调用 D 日志器，测试环境需要桩
const STUBS = 'const D = { ok(){}, info(){}, warn(){}, err(){} };\n';

// 需要 decodeOneALACFrame 内部使用指定的读取器 → 用源码替换生成两份
function makeDecoder(readerName, tag) {
  const body = decodeFn.replace(/createALACBitReader\(/g, readerName + '(');
  const s = `
${STUBS}
${OLD_READER}
${NEW_READER}
let ALAC_FRAME_DIAG = {};
let ALAC_FRAME_DIAG_HOLDER = { v: {} };
${body}
${writeFn}
${pcmFn.replace(/decodeOneALACFrame\(/g, '_ONE_(')}
${body.replace('function decodeOneALACFrame', 'function _ONE_')}
export { decodeALACFramesToPCM as run };
`;
  const p = path.join(ROOT, `.tmp-alac-${tag}.mjs`);
  fs.writeFileSync(p, s);
  return p;
}

const oldModPath = makeDecoder('createALACBitReader_old', 'old');
const newModPath = makeDecoder('createALACBitReader', 'new');
const oldMod = await import(pathToFileURL(oldModPath).href);
const newMod = await import(pathToFileURL(newModPath).href);

// ── 用应用自身的 MP4 解析器抽帧（与 decoder 走同一条路径，避免手写 mdat 猜测）──
const mp4Src = `
const D = { ok(){}, info(){}, warn(){}, err(){} };
${sliceFn('findChild')}
${sliceFn('findAllChildren')}
${sliceFn('parseMP4BoxTree')}
${sliceFn('extractMP4Info')}
${sliceFn('parseSampleTable')}
${sliceFn('readStrHelper')}
${sliceFn('extractASCFromESDS')}
${sliceFn('parseALACConfig')}
export { parseMP4BoxTree, extractMP4Info, parseSampleTable, parseALACConfig };
`;
const mp4Path = path.join(ROOT, '.tmp-mp4-parse.mjs');
fs.writeFileSync(mp4Path, mp4Src);
let mp4 = null;
try {
  mp4 = await import(pathToFileURL(mp4Path).href);
} catch (e) {
  console.log('⚠ MP4 解析器抽取失败:', e.message);
}

function extractRealFrames(filePath, count) {
  if (!mp4) return { frames: [], cfg: null, info: null, alacCfg: null };
  const bytes = new Uint8Array(fs.readFileSync(filePath));
  const tree = mp4.parseMP4BoxTree(bytes);
  const info = mp4.extractMP4Info(bytes, tree);
  const list = mp4.parseSampleTable(bytes, tree, info);
  // 与产品代码一致：config 必须由 parseALACConfig 解析 ALAC magic cookie 得到，
  // 手拼 frameLength/bitDepth 会导致帧头解析走错分支（bitDepth 未定义时全部帧解码失败）
  const alacCfg = mp4.parseALACConfig(info.config);
  const frames = [];
  for (const f of list) {
    if (frames.length >= count) break;
    if (f.offset + f.size > bytes.length) continue;
    frames.push({ data: bytes.subarray(f.offset, f.offset + f.size) });
  }
  return { frames, cfg: info, alacCfg, tree };
}

const candidates = [
  'F:\\本地音乐文件\\1989\\02 Blank Space.m4a',
  'F:\\本地音乐文件\\1989\\01 Welcome To New York.m4a',
].filter(f => { try { return fs.statSync(f).size > 0; } catch (_) { return false; } });

if (!candidates.length) {
  console.log('⚠ 库中无可用的 ALAC 样本');
}

let totalFrames = 0, mismatchFrames = 0, totalSamples = 0, mismatchSamples = 0;

console.log('=== ALAC 解码端到端对拍（旧位读取器 vs 新位读取器）===\n');

for (const f of candidates) {
  const { frames, cfg, alacCfg } = extractRealFrames(f, 40);
  console.log(`样本文件: ${path.basename(f)}`);
  if (!alacCfg) { console.log('  ❌ 无法解析 ALAC 配置，跳过\n'); mismatchFrames++; continue; }
  console.log(`  ALAC 配置: frameLength=${alacCfg.frameLength} bitDepth=${alacCfg.bitDepth} maxRun=${alacCfg.maxRun} ch=${alacCfg.channels} sr=${alacCfg.sampleRate}`);
  console.log(`  抽出真实帧: ${frames.length}`);
  if (!frames.length) { console.log('  （未抽到帧，跳过）\n'); continue; }

  const config = alacCfg;
  const sr = alacCfg.sampleRate || 44100;
  const ch = alacCfg.channels || 2;

  let bad = 0, firstBad = null, nonZeroFrames = 0, maxAbs = 0, lengthsSeen = new Set();
  for (let k = 0; k < frames.length; k++) {
    let A, B;
    try { A = oldMod.run([frames[k]], config, sr, ch); }
    catch (e) { firstBad = firstBad || `帧${k} 旧实现抛错: ${e.message}`; bad++; mismatchFrames++; continue; }
    try { B = newMod.run([frames[k]], config, sr, ch); }
    catch (e) { firstBad = firstBad || `帧${k} 新实现抛错: ${e.message}`; bad++; mismatchFrames++; continue; }

    totalFrames++;
    const na = (A && A.length) || 0, nb = (B && B.length) || 0;
    lengthsSeen.add(na);
    totalSamples += Math.max(na, nb);
    // 输出必须真实存在，否则「一致」毫无意义
    if (na === 0) { bad++; mismatchFrames++; firstBad = firstBad || `帧${k} 旧实现输出为空`; continue; }
    for (let i = 0; i < na; i++) { const v = Math.abs(A[i]); if (v > maxAbs) maxAbs = v; }
    if (na !== nb) {
      bad++; mismatchFrames++; mismatchSamples += Math.max(na, nb);
      if (!firstBad) firstBad = `帧${k}: 长度不同 旧=${na} 新=${nb}`;
      continue;
    }
    let diff = 0, firstIdx = -1;
    for (let i = 0; i < na; i++) if (A[i] !== B[i]) { diff++; if (firstIdx < 0) firstIdx = i; if (diff > 8) break; }
    if (diff) {
      bad++; mismatchFrames++; mismatchSamples += diff;
      if (!firstBad) firstBad = `帧${k}: ${diff} 个样本不同，首个 idx=${firstIdx} 旧=${A[firstIdx]} 新=${B[firstIdx]}`;
    } else nonZeroFrames++;
  }
  console.log(`  逐帧比对: ${frames.length - bad}/${frames.length} 帧一致  ${bad ? '❌ ' + firstBad : '✅'}`);
  console.log(`  输出校验: 每帧长度=${[...lengthsSeen].join('/')}  最大幅度=${maxAbs.toFixed(4)}  ${maxAbs > 0 ? '（输出为真实 PCM ✅）' : '（输出全零 ❌ 比对无意义）'}\n`);
  if (maxAbs === 0) { mismatchFrames += frames.length; }
}

console.log('=== 汇总 ===');
console.log(`  比对帧数    : ${totalFrames}`);
console.log(`  不一致帧数  : ${mismatchFrames}`);
console.log(`  比对样本数  : ${totalSamples}`);
console.log(`  不一致样本  : ${mismatchSamples}`);
console.log('\n' + (mismatchFrames === 0 && totalFrames > 0
  ? '✅ 新位读取器与旧实现解码结果逐样本一致 —— 替换安全'
  : (totalFrames === 0 ? '⚠ 未取得可比对的真实帧' : '❌ 存在差异，替换不安全')));

for (const p of [oldModPath, newModPath, mp4Path]) { try { fs.unlinkSync(p); } catch (_) {} }
process.exit(mismatchFrames === 0 && totalFrames > 0 ? 0 : 1);
