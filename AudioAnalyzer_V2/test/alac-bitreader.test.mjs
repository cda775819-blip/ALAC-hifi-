// 位级对拍：新 ALAC 位读取器 vs git HEAD 中的旧实现
// 用真实 ALAC 文件字节做随机读取序列，逐次比较返回值
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'renderer', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

// 从 git HEAD 取旧文件（若取不到则用内联旧实现）
let oldSrc;
try {
  oldSrc = execSync('git show HEAD:AudioAnalyzer_V2/renderer/app.js', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  console.log('旧实现来源: git HEAD');
} catch (e) {
  console.log('git HEAD 取不到（V2 尚未提交），回退到内联旧实现');
  oldSrc = null;
}

// 旧实现（若取不到就内联一份等价物）
const OLD_IMPL = oldSrc
  ? oldSrc.slice(oldSrc.indexOf('function createALACBitReader'), oldSrc.indexOf('let ALAC_FRAME_DIAG'))
  : `function createALACBitReader(data, offset, length) {
  let pos = offset, bitCount = 0, bitBuf = 0;
  return {
    readBits(n) { let val = 0; for (let i = 0; i < n; i++) { if (bitCount === 0) { bitBuf = pos < offset + length ? data[pos++] : 0; bitCount = 8; } val = (val << 1) | (bitBuf >> 7); bitBuf = (bitBuf << 1) & 0xFF; bitCount--; } return val; },
    readBit() { if (bitCount === 0) { bitBuf = pos < offset + length ? data[pos++] : 0; bitCount = 8; } bitCount--; return (bitBuf >> bitCount) & 1; },
    alignToByte() { bitCount = 0; bitBuf = 0; },
    rawPos() { return pos; },
    remaining() { return offset + length - pos - (bitCount > 0 ? 1 : 0); },
  };
}`;

const NEW_IMPL = src.slice(src.indexOf('function createALACBitReader'), src.indexOf('let ALAC_FRAME_DIAG'));

if (!OLD_IMPL.includes('readBit')) { console.error('❌ 未取到旧实现'); process.exit(1); }
if (!NEW_IMPL.includes('readUnary')) { console.error('❌ 未取到新实现'); process.exit(1); }

// 组装对拍模块
const tmpMod = path.join(ROOT, '.tmp-bitref.mjs');
fs.writeFileSync(tmpMod, `
${OLD_IMPL.replace('function createALACBitReader', 'function makeOld')}
${NEW_IMPL.replace('function createALACBitReader', 'function makeNew')}
export { makeOld, makeNew };
`);
const { makeOld, makeNew } = await import(pathToFileURL(tmpMod).href);

// 可复现的伪随机数（关键：两个 reader 必须跑完全相同的操作序列，
// 否则差异只反映 rand() 不同，而不是实现不同）
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── 测试数据：真实 ALAC 文件的一帧 + 合成边界数据 ──
function realFrame() {
  const p = 'F:\\本地音乐文件\\1989\\02 Blank Space.m4a';
  const buf = fs.readFileSync(p);
  // 找 mdat 起点后在附近取一段真实压缩字节
  const i = buf.indexOf(Buffer.from('mdat'));
  const start = i + 4 + 4096;
  return new Uint8Array(buf.subarray(start, start + 200000));
}

const cases = [];
cases.push(['真实 ALAC 帧字节', realFrame()]);
// 边界构造
cases.push(['全 0x00', new Uint8Array(5000)]);
cases.push(['全 0xFF', new Uint8Array(5000).fill(0xFF)]);
cases.push(['全 0xAA', new Uint8Array(5000).fill(0xAA)]);
cases.push(['交替 0x0F/0xF0', (() => { const a = new Uint8Array(5000); for (let i = 0; i < a.length; i++) a[i] = i % 2 ? 0xF0 : 0x0F; return a; })()]);
const rnd = (() => { const a = new Uint8Array(5000); for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; })();
cases.push(['随机字节', rnd]);

let mismatches = 0, checks = 0;
console.log('\n对拍项目: readBits(n) 各宽度 + readBit() + 一元码 + alignToByte\n');

for (const [name, data] of cases) {
  const o = makeOld(data, 0, data.length);
  const n = makeNew(data, 0, data.length);
  const rnd = mulberry32(0x9E3779B9);   // 固定种子 → 两侧序列完全一致
  let bad = 0, firstBad = null;

  // 1) 随机宽度 readBits（同一序列）
  for (let t = 0; t < 4000; t++) {
    const w = 1 + ((rnd() * 31) | 0);
    const a = o.readBits(w), b = n.readBits(w);
    checks++;
    if (a !== b) { bad++; firstBad = `readBits(${w}) 第${t}次: 旧=${a} 新=${b}`; break; }
  }
  // 2) readBit
  if (!bad) {
    for (let t = 0; t < 2000; t++) {
      const a = o.readBit(), b = n.readBit();
      checks++;
      if (a !== b) { bad++; firstBad = `readBit() 第${t}次: 旧=${a} 新=${b}`; break; }
    }
  }
  // 3) alignToByte 后的对齐一致性
  if (!bad) {
    o.alignToByte(); n.alignToByte();
    for (let t = 0; t < 500; t++) {
      const a = o.readBits(8), b = n.readBits(8);
      checks++;
      if (a !== b) { bad++; firstBad = `alignToByte 后 readBits(8) 第${t}次: 旧=${a} 新=${b}`; break; }
    }
  }

  console.log(`  ${bad ? '❌' : '✅'} ${name.padEnd(18)} ${bad ? firstBad : '一致'}`);
  if (bad) mismatches++;
}

// 4) 一元码专项：readUnary 必须等价于「逐比特读到 1 为止」
console.log('\n一元码等价性（readUnary 应等于"逐比特计数到第一个 1"）:');
{
  const data = cases[0][1];
  const o = makeOld(data, 0, data.length);
  const n = makeNew(data, 0, data.length);
  let bad = 0, firstBad = null, total = 0, maxZeros = 0;
  for (let t = 0; t < 3000; t++) {
    // 旧：逐比特数零
    let lz = 0;
    const CAP = 4096;
    while (lz < CAP && o.readBit() === 0) lz++;
    // 新：批量
    const nz = n.readUnary(CAP, 8);
    total++;
    maxZeros = Math.max(maxZeros, lz);
    if (lz !== nz) { bad++; if (!firstBad) firstBad = `第${t}次: 旧=${lz} 新=${nz}`; break; }
  }
  console.log(`  ${bad ? '❌ ' + firstBad : '✅ 3000 次一元码读取全部一致'}（最大零串 ${maxZeros}）`);
  if (bad) mismatches++;
}

// 5) 数据耗尽边界
console.log('\n数据耗尽边界:');
{
  const tiny = new Uint8Array([0b10100000]);
  const o = makeOld(tiny, 0, 1);
  const n = makeNew(tiny, 0, 1);
  const seq = [[3], [2], [5], [8], [4]];
  let bad = 0;
  for (const [w] of seq) {
    const a = o.readBits(w), b = n.readBits(w);
    if (a !== b) { bad++; console.log(`  ❌ readBits(${w}) 越界后: 旧=${a} 新=${b}`); }
  }
  if (!bad) console.log('  ✅ 越界读取行为一致（均补零）');
  if (bad) mismatches++;
}

fs.unlinkSync(tmpMod);
console.log(`\n共 ${checks} 次比较`);
console.log(mismatches === 0 ? '✅ 位级完全一致 —— 优化是安全的' : `❌ 存在 ${mismatches} 组不一致，不可用`);
process.exit(mismatches === 0 ? 0 : 1);
