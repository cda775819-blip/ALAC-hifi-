// ═══════════════════════════════════════════════════════════════
//  Audio Analyzer Pro v8.0 — V3 产品级
//  app.js — 入口 / 初始化 / DOM 事件 / UI 渲染
// ═══════════════════════════════════════════════════════════════

import { AnalyzeEngine } from "../core/analyzeEngine.js";
import * as audioMath from "../utils/audioMath.js";

const engine = new AnalyzeEngine();

window.__TRACE = {
  step: (name) => {
    console.log('[TRACE]', name, performance.now().toFixed(1));
  }
};

// ── DOM 快捷工具 ──
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];

// ── 全局状态 ──
const STATE = {
  buffer: null, file: null, rawBytes: null,
  channels: 0, sampleRate: 0, duration: 0,
  formatInfo: {},
  analysis: {},
  batchResults: [],
  batchIndex: -1,
};

// ── 处理锁（防重复调用） ──
let __PROCESS_LOCK = false;

// ═══════════════════════════════════════════════════════════════
//  调试日志系统
// ═══════════════════════════════════════════════════════════════

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const D = {
  entries: [],
  _errCount: 0, _okCount: 0,
  _startTime: 0,

  reset() {
    this.entries = [];
    this._errCount = 0; this._okCount = 0;
    this._startTime = Date.now();
    const db = $('#debugBody'); if (db) db.innerHTML = '<div class="debug-empty">等待文件加载...</div>';
    const ec = $('#debugErrCount'); if (ec) ec.style.display = 'none';
    const oc = $('#debugOkCount'); if (oc) oc.style.display = 'none';
    const dc = $('#debugConsole'); if (dc) dc.classList.remove('open');
  },

  log(level, tag, msg) {
    const elapsed = ((Date.now() - this._startTime) / 1000).toFixed(2);
    this.entries.push({ elapsed, level, tag, msg });
    if (level === 'err') this._errCount++;
    if (level === 'ok') this._okCount++;
    this._render();
  },

  info(tag, msg) { this.log('info', tag, msg); },
  ok(tag, msg) { this.log('ok', tag, msg); },
  warn(tag, msg) { this.log('warn', tag, msg); },
  err(tag, msg) { this.log('err', tag, msg); },

  _render() {
    if (this._suppressDOM) return;
    const body = $('#debugBody');
    if (!body) return;
    const recent = this.entries.slice(-1);
    for (const e of recent) {
      const div = document.createElement('div');
      div.className = 'debug-entry';
      div.innerHTML = `<span class="ts">+${e.elapsed}s</span><span class="tag ${e.level}">${e.tag}</span><span class="msg">${e.msg}</span>`;
      body.appendChild(div);
      body.scrollTop = body.scrollHeight;
    }
    const maxDOM = 500;
    while (body.children.length > maxDOM) body.removeChild(body.firstChild);
    const maxData = 1000;
    if (this.entries.length > maxData) this.entries = this.entries.slice(-maxData);
    $('#debugErrCount').textContent = this._errCount;
    $('#debugErrCount').style.display = this._errCount > 0 ? '' : 'none';
    $('#debugOkCount').textContent = this._okCount;
    $('#debugOkCount').style.display = this._okCount > 0 ? '' : 'none';
    if (this._errCount > 0) {
      $('#debugConsole').classList.add('open');
    }
  }
};
audioMath.setLogger({
  warn(tag, msg) { D.warn(`audioMath:${tag}`, msg); }
});

function toggleDebug() {
  $('#debugConsole').classList.toggle('open');
}
window.toggleDebug = toggleDebug;

// ═══════════════════════════════════════════════════════════════
//  异步分片执行器（防 UI 冻结）
// ═══════════════════════════════════════════════════════════════

function yieldToUI() {
  return new Promise(r => setTimeout(r, 0));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))
  ]);
}

function makeAutoYield(maxIntervalMs = 16) {
  let last = 0;
  return function autoYield() {
    const now = performance.now();
    if (now - last > maxIntervalMs) { last = now; return yieldToUI(); }
    return Promise.resolve();
  };
}

// ═══════════════════════════════════════════════════════════════
//  初始化日志 & 浏览器能力检测
// ═══════════════════════════════════════════════════════════════

D.reset();
D._suppressDOM = true;
D.info('INIT', '调试日志已就绪');
D.info('ENV', `UserAgent: ${navigator.userAgent.substring(0, 80)}...`);
D.info('ENV', `AudioContext: sampleRate=${audioCtx.sampleRate}Hz, state=${audioCtx.state}, channels=${audioCtx.destination.maxChannelCount}`);

const testFormats = {
  'audio/flac': 'FLAC', 'audio/wav': 'WAV', 'audio/mpeg': 'MP3',
  'audio/mp4': 'M4A/AAC', 'audio/mp4;codecs=alac': 'ALAC',
  'audio/ogg': 'OGG', 'audio/ogg;codecs=opus': 'Opus',
  'audio/webm': 'WebM', 'audio/aiff': 'AIFF',
};
const supported = [], unsupported = [];
for (const [mime, label] of Object.entries(testFormats)) {
  const r = new Audio().canPlayType(mime);
  if (r === 'probably' || r === 'maybe') supported.push(label);
  else unsupported.push(label);
}
D.info('CAPS', `浏览器 原生支持: ${supported.join(', ') || '(无)'}`);
if (unsupported.length) D.info('CAPS', `分析器内置解码: ${unsupported.join(', ')}（自动切换，无需担心）`);

// ═══════════════════════════════════════════════════════════════
//  拖放与文件选择
// ═══════════════════════════════════════════════════════════════

const dropZone = $('#dropZone');
if (dropZone) {
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('active'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));
dropZone.addEventListener('drop', async e => {
  e.preventDefault(); dropZone.classList.remove('active');
  const files = [...e.dataTransfer.files].filter(isAudioFile);
  if (files.length) await processFiles(files);
});
dropZone.addEventListener('click', () => $('#fileInput').click());
}

const fi = $('#fileInput'); if (fi) fi.addEventListener('change', async function() {
  if (this.files.length) await processFiles([...this.files]);
});

const bb = $('#btnBrowse'); if (bb) bb.addEventListener('click', () => $('#fileInput').click());

function isAudioFile(f) {
  const exts = '.flac.wav.aiff.aif.alac.m4a.mp3.aac.ogg.opus.wma.ape.wv.tta.dsf.dff.caf.ac3.eac3.mka.webm.w64.rf64';
  const name = f.name.toLowerCase();
  return f.type.startsWith('audio/') || exts.split('.').some(e => name.endsWith('.' + e));
}

const dh = $('#debugHeader'); if (dh) dh.addEventListener('click', toggleDebug);

// ═══════════════════════════════════════════════════════════════
//  文件头格式解析 — 覆盖所有格式
// ═══════════════════════════════════════════════════════════════

function parseFormatFromBytes(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 256));
  const readStr = (off, len) => String.fromCharCode(...new Uint8Array(bytes.buffer, bytes.byteOffset + off, len));
  const readU16LE = off => dv.getUint16(off, true);
  const readU16BE = off => dv.getUint16(off, false);
  const readU32LE = off => dv.getUint32(off, true);
  const readU32BE = off => dv.getUint32(off, false);

  const sig4 = readStr(0, 4);
  const sig3 = readStr(0, 3);

  // RIFF: WAV
  if (sig4 === 'RIFF' && bytes.byteLength > 12) {
    const riffType = readStr(8, 4);
    if (riffType === 'WAVE') {
      let fmt = { container: 'WAV', codec: 'PCM', format: 'WAV', lossless: true };
      let off = 12;
      while (off < Math.min(bytes.byteLength, 1024)) {
        const chunkId = readStr(off, 4);
        const chunkSize = readU32LE(off + 4);
        if (chunkId === 'fmt ') {
          const audioFormat = readU16LE(off + 8);
          const ch = readU16LE(off + 10);
          const sr = readU32LE(off + 12);
          const bitrate = readU32LE(off + 16);
          const bitsPerSample = readU16LE(off + 22);
          const codecMap = {1:'PCM',3:'IEEE Float',6:'A-law',7:'μ-law',0xFFFE:'Extensible'};
          fmt.codec = codecMap[audioFormat] || (audioFormat === 0x0050 ? 'MPEG Layer-2/3' : (audioFormat === 0x0055 ? 'MPEG Layer-3' : `Codec #${audioFormat}`));
          fmt.channels = ch;
          fmt.sampleRate = sr;
          fmt.bitDepth = bitsPerSample;
          fmt.bitrateEst = bitrate * 8;
          if (audioFormat === 0x0050 || audioFormat === 0x0055) fmt.lossless = false;
        }
        off += 8 + chunkSize;
      }
      return fmt;
    }
  }

  // RF64
  if (sig4 === 'RF64' && bytes.byteLength > 12 && readStr(8, 4) === 'WAVE') {
    return { container: 'RF64', codec: 'PCM', format: 'WAV (RF64)', lossless: true };
  }

  // FLAC
  if (sig4 === 'fLaC') {
    let fmt = { container: 'FLAC', codec: 'FLAC', format: 'FLAC', lossless: true };
    if (bytes.byteLength > 42) {
      const infoOff = 8;
      if (infoOff + 18 <= bytes.byteLength) {
        const info = new Uint8Array(bytes.buffer, bytes.byteOffset + infoOff, 18);
        const srRaw = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
        const chRaw = ((info[12] & 0x0E) >> 1) + 1;
        const bpsRaw = ((info[12] & 0x01) << 4) | ((info[13] & 0xF0) >> 4);
        fmt.sampleRate = srRaw;
        fmt.channels = chRaw;
        fmt.bitDepth = bpsRaw + 1;
      }
    }
    return fmt;
  }

  // OGG
  if (sig4 === 'OggS') {
    let fmt = { container: 'OGG', codec: 'Vorbis', format: 'OGG', lossless: false };
    if (bytes.byteLength > 36) {
      const codecSig = readStr(29, 8);
      if (codecSig.startsWith('vorbis')) fmt.codec = 'Vorbis';
      else if (codecSig.startsWith('OpusHea')) fmt.codec = 'Opus';
      else {
        const pktSig = readStr(28, 8);
        if (pktSig.startsWith('OpusHea')) fmt.codec = 'Opus';
      }
    }
    return fmt;
  }

  // MP3
  if (sig3 === 'ID3') {
    let fmt = { container: 'MP3', codec: 'MPEG Audio', format: 'MP3', lossless: false };
    for (let i = 10; i < Math.min(bytes.byteLength, 4096); i++) {
      if (bytes[i] === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0) {
        const hdr = (bytes[i] << 8) | bytes[i + 1];
        const versionBits = (hdr >> 19) & 3;
        const layerBits = (hdr >> 17) & 3;
        const srIdx = (hdr >> 10) & 3;
        const versions = ['MPEG 2.5', null, 'MPEG 2', 'MPEG 1'];
        const layers = [null, 'Layer III', 'Layer II', 'Layer I'];
        const srMap = {
          'MPEG 1': [44100, 48000, 32000],
          'MPEG 2': [22050, 24000, 16000],
          'MPEG 2.5': [11025, 12000, 8000]
        };
        const ver = versions[versionBits] || 'MPEG 1';
        const lyr = layers[layerBits] || '';
        fmt.codec = `MPEG ${lyr}`;
        if (srMap[ver] && srIdx < 3) {
          fmt.sampleRate = srMap[ver][srIdx];
        }
        break;
      }
    }
    return fmt;
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
    return { container: 'MP3', codec: 'MPEG Audio', format: 'MP3', lossless: false };
  }

  // MP4/M4A
  if (bytes.byteLength > 12) {
    const ftypBox = readStr(4, 4);
    if (ftypBox === 'ftyp') {
      const brand = readStr(8, 4);
      const codecMap = {
        'M4A ': 'AAC', 'mp42': 'MPEG-4', 'M4B ': 'AAC', 'M4P ': 'AAC (Protected)',
        'alac': 'ALAC', 'ALAC': 'ALAC',
      };
      const losslessBrands = ['alac', 'ALAC'];
      let fmt = {
        container: losslessBrands.includes(brand) ? 'ALAC' : (brand === 'M4A ' ? 'M4A' : 'MP4'),
        codec: codecMap[brand] || 'AAC',
        format: losslessBrands.includes(brand) ? 'ALAC' : (brand === 'M4A ' ? 'M4A' : 'MP4'),
        lossless: losslessBrands.includes(brand),
      };
      if (bytes.byteLength > 36) {
        const scanLimit = Math.min(bytes.byteLength, 16384);
        for (let off = 8; off + 24 < scanLimit; off++) {
          if (bytes[off] === 0x73 && bytes[off + 1] === 0x74 &&
              bytes[off + 2] === 0x73 && bytes[off + 3] === 0x64) {
            const stsdPos = off - 4;
            if (stsdPos < 0 || stsdPos + 24 > bytes.byteLength) continue;
            const entryCount = (bytes[stsdPos + 12] << 24) | (bytes[stsdPos + 13] << 16) | (bytes[stsdPos + 14] << 8) | bytes[stsdPos + 15];
            if (entryCount > 0 && entryCount <= 100 && stsdPos + 24 <= bytes.byteLength) {
              const entSize = (bytes[stsdPos + 16] << 24) | (bytes[stsdPos + 17] << 16) | (bytes[stsdPos + 18] << 8) | bytes[stsdPos + 19];
              if (entSize >= 8 && stsdPos + 16 + entSize <= bytes.byteLength) {
                const entType = readStr(stsdPos + 20, 4);
                if (entType === 'alac') { fmt.codec = 'ALAC'; fmt.lossless = true; fmt.container = 'ALAC'; fmt.format = 'ALAC'; }
                if (entSize >= 52) {
                  const ch = (bytes[stsdPos + 40] << 8) | bytes[stsdPos + 41];
                  const ssize = (bytes[stsdPos + 42] << 8) | bytes[stsdPos + 43];
                  const srFixed = (bytes[stsdPos + 48] << 24) | (bytes[stsdPos + 49] << 16) | (bytes[stsdPos + 50] << 8) | bytes[stsdPos + 51];
                  const sr = srFixed >> 16;
                  if (ch > 0 && ch <= 64) fmt.channels = ch;
                  if (sr > 0 && sr < 1000000) fmt.sampleRate = sr;
                  if (ssize > 0 && ssize <= 64) fmt.bitDepth = ssize;
                }
              }
            }
            break;
          }
        }
      }
      return fmt;
    }
  }

  // AIFF
  if (sig4 === 'FORM' && bytes.byteLength > 12 && readStr(8, 4) === 'AIFF') {
    let fmt = { container: 'AIFF', codec: 'PCM', format: 'AIFF', lossless: true };
    if (bytes.byteLength > 26 && readStr(12, 4) === 'COMM') {
      const off = 20;
      fmt.channels = readU16BE(off);
      fmt.sampleRate = dv.getFloat64 ? Math.round(dv.getFloat64(off + 6, false)) : 0;
      fmt.bitDepth = readU16BE(off + 4);
    }
    return fmt;
  }
  if (sig4 === 'FORM' && bytes.byteLength > 12 && readStr(8, 4) === 'AIFC') {
    let fmt = { container: 'AIFF-C', codec: 'PCM', format: 'AIFF-C', lossless: true };
    if (bytes.byteLength > 40 && readStr(12, 4) === 'COMM') {
      fmt.channels = readU16BE(20);
      fmt.bitDepth = readU16BE(24);
      const compType = readStr(30, 4);
      const compMap = {'NONE':'PCM','sowt':'PCM (swapped)','fl32':'IEEE 32-bit Float','fl64':'IEEE 64-bit Float','alaw':'A-law','ulaw':'μ-law','ALAC':'ALAC'};
      fmt.codec = compMap[compType] || compType;
      fmt.lossless = !compType.startsWith('a') || compType === 'NONE' || compType === 'sowt';
    }
    return fmt;
  }

  // APE
  if (sig4 === 'MAC ' && bytes.byteLength > 32) {
    const ver = readU16LE(4);
    return { container: 'APE', codec: `Monkey's Audio v${(ver/1000).toFixed(2)}`, format: 'APE', lossless: true };
  }

  // WavPack
  if (sig4 === 'wvpk') {
    let fmt = { container: 'WavPack', codec: 'WavPack', format: 'WV', lossless: true };
    if (bytes.byteLength > 24) {
      const flags = readU32LE(24);
      if (flags & 0x04) { fmt.codec = 'WavPack (Hybrid)'; fmt.lossless = false; }
    }
    return fmt;
  }

  // TTA
  if (sig4 === 'TTA1') {
    let fmt = { container: 'TTA', codec: 'True Audio', format: 'TTA', lossless: true };
    if (bytes.byteLength > 22) {
      fmt.channels = readU16LE(14);
      fmt.bitDepth = readU16LE(16);
      fmt.sampleRate = readU32LE(18);
    }
    return fmt;
  }

  // DSF
  if (sig4 === 'DSD ') {
    let fmt = { container: 'DSF', codec: 'DSD', format: 'DSF', lossless: true };
    if (bytes.byteLength > 28) {
      fmt.channels = readU32LE(20);
      fmt.sampleRate = readU32LE(24);
      fmt.bitDepth = 1;
    }
    return fmt;
  }

  // DFF
  if (sig4 === 'FRM8' && bytes.byteLength > 16 && readStr(12, 4) === 'DSD ') {
    return { container: 'DFF', codec: 'DSD (DSDIFF)', format: 'DFF', lossless: true };
  }

  // CAF
  if (sig4 === 'caff') {
    return { container: 'CAF', codec: 'Core Audio', format: 'CAF', lossless: true };
  }

  // AC3
  if (bytes.byteLength >= 2 && bytes[0] === 0x0B && bytes[1] === 0x77) {
    return { container: 'AC-3', codec: 'Dolby AC-3', format: 'AC3', lossless: false };
  }

  // Matroska/WebM
  if (bytes.byteLength > 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    const raw = String.fromCharCode(...new Uint8Array(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 256)));
    const doctypeMatch = raw.match(/matroska|webm/i);
    const dt = doctypeMatch ? doctypeMatch[0] : 'Matroska';
    return { container: dt === 'webm' ? 'WebM' : 'Matroska', codec: 'Unknown (Matroska)', format: dt === 'webm' ? 'WebM' : 'MKA', lossless: false };
  }

  // WMA/ASF
  if (bytes.byteLength > 16) {
    const guid = readStr(0, 16);
    if (guid.startsWith('\x30\x26\xB2\x75\x8E\x66\xCF\x11\xA6\xD9\x00\xAA\x00\x62\xCE\x6C')) {
      return { container: 'ASF', codec: 'WMA', format: 'WMA', lossless: false };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  MP4 Box Tree
// ═══════════════════════════════════════════════════════════════

function parseMP4BoxTree(rawBytes) {
  const data = rawBytes;
  const len = data.length;
  const result = { boxes: {}, mdatOffset: -1, mdatSize: 0, altDataOffset: -1, altDataSize: 0 };
  let pos = 0;

  function readU32(p) { return (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]; }
  function readStr(p, n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(data[p + i]); return s; }

  function parseBox(parentObj) {
    while (pos + 8 <= len) {
      let size = readU32(pos);
      const type = readStr(pos + 4, 4);
      let headerSize = 8;
      if (size === 1) { size = Number((BigInt(readU32(pos + 8)) << 32n) | BigInt(readU32(pos + 12))); headerSize = 16; }
      if (size === 0) size = len - pos;
      if (size < headerSize || pos + size > len) break;

      const contentStart = pos + headerSize;
      const subData = data.subarray(contentStart, pos + size);
      const isContainer = type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl';

      if (parentObj === result.boxes) {
        if (type === 'mdat') { result.mdatOffset = contentStart; result.mdatSize = size - headerSize; }
        result.boxes[type] = isContainer ? { _children: [] } : subData;
      }

      if (isContainer) {
        const saved = pos;
        pos = contentStart;
        const container = parentObj === result.boxes ? result.boxes[type] : { _children: [] };
        parseBox(container);
        if (parentObj !== result.boxes && parentObj) {
          if (!parentObj._children) parentObj._children = [];
          parentObj._children.push({ type, data: container, offset: contentStart, boxSize: size });
        }
        pos = saved;
      } else if (parentObj && parentObj !== result.boxes) {
        if (!parentObj._children) parentObj._children = [];
        parentObj._children.push({ type, data: subData, offset: contentStart, boxSize: size });
      }

      pos += size;
    }
  }

  parseBox(result.boxes);

  if (result.mdatSize < 100) {
    const moovBox = result.boxes.moov;
    if (moovBox && moovBox._children) {
      for (const c of moovBox._children) {
        if (c.type === 'mvhd' || c.type === 'trak' || c.type === 'iods' || c.type === 'mdat') continue;
        const dataSize = c.data instanceof Uint8Array ? c.data.length : 0;
        if (dataSize > 4096) {
          D.warn('WC', `  mdat 空壳! 音频数据在 '${c.type}' box`);
          result.altDataOffset = c.offset;
          result.altDataSize = dataSize;
          break;
        }
      }
    }
  }

  return result;
}

function findChild(parent, type) {
  if (!parent || !parent._children) return null;
  for (const c of parent._children) if (c.type === type) return c.data;
  return null;
}

function findAllChildren(parent, type) {
  const results = [];
  if (parent && parent._children) for (const c of parent._children) if (c.type === type) results.push(c.data);
  return results;
}

function extractMP4Info(rawBytes, tree) {
  const info = { sampleRate: 44100, channels: 2, config: null, codec: 'mp4a.40.2' };
  try {
    const moov = tree.boxes.moov;
    if (!moov || !moov._children) return info;
    const traks = findAllChildren(moov, 'trak');
    for (const trak of traks) {
      if (!trak._children) continue;
      const mdia = findChild(trak, 'mdia');
      if (!mdia || !mdia._children) continue;
      const hdlr = findChild(mdia, 'hdlr');
      if (!hdlr) continue;
      if (hdlr.length >= 12 && readStrHelper(hdlr, 8, 4) !== 'soun') continue;
      const mdhd = findChild(mdia, 'mdhd');
      if (mdhd && mdhd.length >= 20) {
        const ver = mdhd[0];
        if (ver === 0 && mdhd.length >= 24) {
          info.mdhdTimescale = (mdhd[12] << 24) | (mdhd[13] << 16) | (mdhd[14] << 8) | mdhd[15];
          info.mdhdDuration = (mdhd[16] << 24) | (mdhd[17] << 16) | (mdhd[18] << 8) | mdhd[19];
        } else if (ver === 1 && mdhd.length >= 36) {
          info.mdhdTimescale = (mdhd[20] << 24) | (mdhd[21] << 16) | (mdhd[22] << 8) | mdhd[23];
          info.mdhdDuration = Number((BigInt(mdhd[24]) << 56n) | (BigInt(mdhd[25]) << 48n) | (BigInt(mdhd[26]) << 40n) | (BigInt(mdhd[27]) << 32n) | (BigInt(mdhd[28]) << 24n) | (BigInt(mdhd[29]) << 16n) | (BigInt(mdhd[30]) << 8n) | BigInt(mdhd[31]));
        }
      }
      const minf = findChild(mdia, 'minf');
      if (!minf || !minf._children) continue;
      const stbl = findChild(minf, 'stbl');
      if (!stbl || !stbl._children) continue;
      const stsd = findChild(stbl, 'stsd');
      if (!stsd || stsd.length < 16) { D.warn('WC', `stsd 未找到或太短`); continue; }
      const entryCount = (stsd[4] << 24) | (stsd[5] << 16) | (stsd[6] << 8) | stsd[7];
      let pos = 8;
      for (let e = 0; e < Math.min(entryCount, 10); e++) {
        if (pos + 8 > stsd.length) break;
        const entSize = (stsd[pos] << 24) | (stsd[pos + 1] << 16) | (stsd[pos + 2] << 8) | stsd[pos + 3];
        const entType = readStrHelper(stsd, pos + 4, 4);
        if (entSize < 8 || pos + entSize > stsd.length) break;
        const entData = stsd.subarray(pos + 8, pos + entSize);
        if (entType === 'mp4a' && entData.length >= 28) {
          info.channels = (entData[16] << 8) | entData[17];
          const sr32 = (entData[24] << 24) | (entData[25] << 16) | (entData[26] << 8) | entData[27];
          const srFixed = sr32 >>> 16;
          info.sampleRate = (srFixed >= 3000 && srFixed <= 768000) ? srFixed : (sr32 >= 3000 && sr32 <= 768000) ? sr32 : 44100;
          if (entData.length > 28) {
            let subPos = 28;
            while (subPos + 8 <= entData.length) {
              const subSize = (entData[subPos] << 24) | (entData[subPos + 1] << 16) | (entData[subPos + 2] << 8) | entData[subPos + 3];
              const subType = readStrHelper(entData, subPos + 4, 4);
              if (subSize < 8 || subPos + subSize > entData.length) break;
              if (subType === 'esds') info.config = extractASCFromESDS(entData.subarray(subPos + 8, subPos + subSize));
              subPos += subSize;
            }
          }
          const objType = entData.length >= 33 ? (entData[32] >> 3) & 0x1f : 2;
          info.codec = `mp4a.40.${objType}`;
        }
        if (entType === 'alac' && entData.length >= 28) {
          info.channels = (entData[16] << 8) | entData[17];
          const sr32 = (entData[24] << 24) | (entData[25] << 16) | (entData[26] << 8) | entData[27];
          const srFixed = sr32 >>> 16;
          info.sampleRate = (srFixed >= 3000 && srFixed <= 768000) ? srFixed : (sr32 >= 3000 && sr32 <= 768000) ? sr32 : 44100;
          info.codec = 'alac';
          if (entData.length > 28) {
            let subPos = 28;
            while (subPos + 8 <= entData.length) {
              const subSize = (entData[subPos] << 24) | (entData[subPos + 1] << 16) | (entData[subPos + 2] << 8) | entData[subPos + 3];
              const subType = readStrHelper(entData, subPos + 4, 4);
              if (subSize < 8 || subPos + subSize > entData.length) break;
              if (subType === 'alac') info.config = entData.subarray(subPos + 8, subPos + subSize);
              subPos += subSize;
            }
          }
        }
        pos += entSize;
      }
      info.stsz = findChild(stbl, 'stsz');
      info.stz2 = findChild(stbl, 'stz2');
      info.stco = findChild(stbl, 'stco');
      info.co64 = findChild(stbl, 'co64');
      info.stsc = findChild(stbl, 'stsc');
      info.stts = findChild(stbl, 'stts');
      break;
    }
  } catch (e) {
    D.warn('WC', '提取 MP4 信息异常: ' + e.message);
  }
  return info;
}

function readStrHelper(data, offset, len) {
  let s = ''; for (let i = 0; i < len && offset + i < data.length; i++) s += String.fromCharCode(data[offset + i]); return s;
}

function extractASCFromESDS(esds) {
  const data = esds.length > 4 ? esds.subarray(4) : esds;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0x04) {
      let j = i + 1;
      if (j >= data.length) continue;
      let len = data[j]; j++;
      if (len === 0x80) { while (j < data.length && data[j] & 0x80) j++; j++; }
      if (j >= data.length) continue;
      j += 1 + 1 + 3 + 4 + 4;
      for (let k = j; k + 1 < data.length && k < i + 60; k++) {
        if (data[k] === 0x05) {
          const ascLen = Math.min(data[k + 1], 16);
          if (ascLen > 0) return esds.slice(esds.length - data.length + k + 2, esds.length - data.length + k + 2 + ascLen);
        }
      }
    }
  }
  return null;
}

function parseALACConfig(config) {
  if (!config || config.length < 24) return null;
  const off = config.length >= 28 ? 4 : 0;
  const frameLen = ((config[off]<<24)|(config[off+1]<<16)|(config[off+2]<<8)|config[off+3]) || 4096;
  return {
    frameLength: frameLen,
    compatibleVersion: config[off+4],
    bitDepth: config[off+5] || 16,
    pb: config[off+6], mb: config[off+7], kb: config[off+8],
    channels: config[off+9],
    maxRun: (config[off+10]<<8)|config[off+11],
    maxFrameBytes: (config[off+12]<<24)|(config[off+13]<<16)|(config[off+14]<<8)|config[off+15],
    avgBitRate: (config[off+16]<<24)|(config[off+17]<<16)|(config[off+18]<<8)|config[off+19],
    sampleRate: (config[off+20]<<24)|(config[off+21]<<16)|(config[off+22]<<8)|config[off+23],
    rawConfig: config, off,
  };
}

function parseSampleTable(rawBytes, tree, info) {
  const rdU32 = (arr,p) => (arr[p]<<24)|(arr[p+1]<<16)|(arr[p+2]<<8)|arr[p+3];
  const sampleSizes = [];
  const stsz = info.stsz;
  if (stsz && stsz.length >= 12) {
    const ss = rdU32(stsz,4), cnt = rdU32(stsz,8);
    for (let i = 0; i < Math.min(cnt, 200000); i++) sampleSizes.push(ss === 0 ? rdU32(stsz,12+i*4) : ss);
  }
  const chunkOffsets = [];
  const co = info.stco || info.co64;
  const is64 = !!info.co64;
  if (co && co.length >= 8) {
    const cnt = rdU32(co,4);
    for (let i = 0; i < Math.min(cnt, 100000); i++) {
      if (is64) { const hi = rdU32(co,8+i*8), lo = rdU32(co,12+i*8); chunkOffsets.push(Number((BigInt(hi)<<32n)|BigInt(lo))); }
      else chunkOffsets.push(rdU32(co,8+i*4));
    }
  }
  if (sampleSizes.length === 0) {
    const stz2 = info.stz2;
    if (stz2 && stz2.length >= 12) {
      const fs = stz2[7], cnt = rdU32(stz2,8);
      if (fs === 8) for (let i=0;i<cnt;i++) sampleSizes.push(stz2[12+i]);
      else if (fs===16) for (let i=0;i<cnt;i++) sampleSizes.push((stz2[12+i*2]<<8)|stz2[13+i*2]);
      else if (fs===4) for (let i=0;i<cnt;i++) { const b=stz2[12+(i>>1)]; sampleSizes.push(i&1?b&0xF:b>>4); }
    }
  }
  const samplesPerChunk = [];
  const stsc = info.stsc;
  if (stsc && stsc.length >= 8) {
    const cnt = rdU32(stsc,4);
    const maxChunks = chunkOffsets.length || sampleSizes.length || 1000000;
    for (let i = 0; i < cnt; i++) {
      const fc = rdU32(stsc,8+i*12) - 1;
      const spc = rdU32(stsc,12+i*12);
      const nextFc = (i+1 < cnt) ? rdU32(stsc,8+(i+1)*12) - 1 : maxChunks;
      for (let c = fc; c < Math.min(nextFc, maxChunks); c++) samplesPerChunk[c] = spc;
    }
  }
  let totalFramesEst = sampleSizes.length;
  if (totalFramesEst === 0) {
    const stts = info.stts;
    if (stts && stts.length >= 8) { const cnt = rdU32(stts,4); for (let i=0;i<Math.min(cnt,10000);i++) totalFramesEst += rdU32(stts,8+i*8); }
    if (totalFramesEst === 0 && info.mdhdDuration && info.mdhdTimescale && info.sampleRate) {
      const cfg = parseALACConfig(info.config);
      if (cfg) { const durSec = info.mdhdDuration / info.mdhdTimescale; totalFramesEst = Math.ceil(durSec * info.sampleRate / cfg.frameLength); }
    }
  }
  if (totalFramesEst === 0 && chunkOffsets.length > 0) {
    const audioEnd = (tree.altDataOffset >= 0) ? tree.altDataOffset + tree.altDataSize : tree.mdatOffset + tree.mdatSize;
    totalFramesEst = Math.max(1, Math.floor((audioEnd - chunkOffsets[0]) / 200));
  }
  if (sampleSizes.length === 0 && chunkOffsets.length > 0 && totalFramesEst > 0 && totalFramesEst < 200000) {
    const audioEnd = (tree.altDataOffset >= 0) ? tree.altDataOffset + tree.altDataSize : tree.mdatOffset + tree.mdatSize;
    const totalBytes = audioEnd - chunkOffsets[0];
    const avg = Math.floor(totalBytes / totalFramesEst);
    for (let i=0;i<totalFramesEst-1;i++) sampleSizes.push(avg);
    sampleSizes.push(totalBytes - avg*(totalFramesEst-1));
  }
  if (sampleSizes.length === 0 || chunkOffsets.length === 0) return [];
  const frames = [];
  const sr = info.sampleRate || 44100;
  let chunkIdx = 0, sampleInChunk = 0, ts = 0;
  for (let s = 0; s < sampleSizes.length; s++) {
    const spc = samplesPerChunk[chunkIdx] || 1;
    if (sampleInChunk === 0 && chunkIdx < chunkOffsets.length) {
      const off = chunkOffsets[chunkIdx];
      if (off > 0 && off + sampleSizes[s] <= rawBytes.length) frames.push({ offset: off, size: sampleSizes[s], timestamp: ts });
    } else if (frames.length > 0) {
      const prev = frames[frames.length-1];
      const off = prev.offset + prev.size;
      if (off + sampleSizes[s] <= rawBytes.length) frames.push({ offset: off, size: sampleSizes[s], timestamp: ts });
    }
    ts += Math.round(1024000000 / sr);
    if (++sampleInChunk >= spc) { chunkIdx++; sampleInChunk = 0; }
  }
  return frames;
}

// ═══════════════════════════════════════════════════════════════
//  解码器
// ═══════════════════════════════════════════════════════════════

async function decodeWithWebCodecs(rawBytes) {
  if (typeof AudioDecoder === 'undefined') throw new Error('浏览器不支持 WebCodecs');
  const tree = parseMP4BoxTree(rawBytes);
  if (tree.mdatOffset < 0) throw new Error('MP4 无 mdat box');
  const info = extractMP4Info(rawBytes, tree);
  const frames = parseSampleTable(rawBytes, tree, info);
  if (frames.length === 0) throw new Error('无法解析帧数据');
  const config = { codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels };
  if (info.config) config.description = info.config.buffer.slice(info.config.byteOffset, info.config.byteOffset + info.config.byteLength);
  let support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported && config.description) {
    const c2 = { codec: config.codec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels };
    support = await AudioDecoder.isConfigSupported(c2);
    if (support.supported) config.description = undefined;
  }
  if (!support.supported) throw new Error(`浏览器不支持 ${info.codec} 解码`);
  const outputFrames = [];
  let error = null;
  const decoder = new AudioDecoder({ output(f) { outputFrames.push(f); }, error(e) { error = e; } });
  decoder.configure(config);
  const isALAC = info.codec === 'alac';
  let samplesPerFrame = 1024;
  if (isALAC) {
    if (info.config && info.config.length >= 8) { const rawFL = (info.config[4]<<24)|(info.config[5]<<16)|(info.config[6]<<8)|info.config[7]; samplesPerFrame = (rawFL > 0) ? rawFL : 4096; }
    else samplesPerFrame = 4096;
  }
  const actualFrameDur = Math.round(samplesPerFrame * 1000000 / info.sampleRate);
  let ts = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.offset + f.size > rawBytes.length) continue;
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, duration: actualFrameDur, data: rawBytes.buffer.slice(rawBytes.byteOffset + f.offset, rawBytes.byteOffset + f.offset + f.size) }));
    ts += actualFrameDur;
  }
  try { await decoder.flush(); } catch (e) {}
  if (outputFrames.length === 0) throw new Error('解码失败');
  const buffer = buildAudioBuffer(outputFrames, info.sampleRate, info.channels);
  outputFrames.forEach(f => f.close());
  return { buffer, channels: info.channels, sampleRate: info.sampleRate };
}

function buildAudioBuffer(frames, sr, ch) {
  const totalSamples = frames.reduce((s, f) => s + f.numberOfFrames, 0);
  const buffer = audioCtx.createBuffer(ch, totalSamples, sr);
  let offset = 0;
  for (const f of frames) {
    const N = f.numberOfFrames;
    const interleaved = new Float32Array(N * ch);
    f.copyTo(interleaved, { planeIndex: 0, format: 'FLTP' });
    for (let c = 0; c < ch; c++) { const cd = buffer.getChannelData(c); for (let i = 0; i < N; i++) cd[offset + i] = interleaved[i * ch + c]; }
    offset += N;
  }
  return buffer;
}

function createALACBitReader(data, offset, length) {
  let pos = offset, bitCount = 0, bitBuf = 0;
  return {
    readBits(n) { let val = 0; for (let i = 0; i < n; i++) { if (bitCount === 0) { bitBuf = pos < offset + length ? data[pos++] : 0; bitCount = 8; } val = (val << 1) | (bitBuf >> 7); bitBuf = (bitBuf << 1) & 0xFF; bitCount--; } return val; },
    readBit() { if (bitCount === 0) { bitBuf = pos < offset + length ? data[pos++] : 0; bitCount = 8; } bitCount--; return (bitBuf >> bitCount) & 1; },
    alignToByte() { bitCount = 0; bitBuf = 0; },
    rawPos() { return pos; },
    remaining() { return offset + length - pos - (bitCount > 0 ? 1 : 0); },
  };
}

function decodeOneALACFrame(reader, cfg, channels) {
  reader.readBits(4); reader.readBits(4);
  const predOrder = reader.readBits(5);
  const coefs = new Int32Array(predOrder);
  for (let i = 0; i < predOrder; i++) coefs[i] = reader.readBits(16);
  const fc = reader.readBits(32); if (fc === 0 || fc > 131072) return null;

  const riceDecode = (k, history, outFn) => {
    let hs = history;
    for (let i = 0; i < fc; i++) {
      let lz = 0;
      while (reader.readBit() === 0) { lz++; if (lz > cfg.maxRun + 64) break; }
      if (lz > cfg.maxRun + 64) break;
      const q = reader.readBits(k);
      const val = (lz << k) | q;
      hs += val;
      outFn(i, hs);
    }
  };

  const chSamples = [];
  for (let c = 0; c < channels; c++) {
    const k = reader.readBits(4);
    const history = reader.readBits(32);
    const sign = reader.readBit();
    const chData = new Int32Array(fc);
    riceDecode(k, history, (i, v) => { chData[i] = sign ? -v : v; });
    chSamples.push(chData);
  }
  reader.alignToByte();
  return { frameCount: fc, chSamples, predOrder, coefs };
}

function writeInterleavedPCM(output, outputPos, chSamples, channels, maxVal) {
  const fc = chSamples[0].length;
  for (let i = 0; i < fc; i++) {
    for (let c = 0; c < channels; c++) {
      let sample = chSamples[c][i];
      if (sample > maxVal) sample = maxVal;
      if (sample < -maxVal) sample = -maxVal;
      output[outputPos + i * channels + c] = sample / maxVal;
    }
  }
  return fc * channels;
}

function decodeALACFramesToPCM(frameDataList, config, sampleRate, channels) {
  const effChannels = Math.min(channels, 2);
  const frameLen = config ? config.frameLength : 4096;
  const output = new Float32Array(frameDataList.length * frameLen * effChannels);
  let outputPos = 0;
  const maxVal = (1 << (config ? config.bitDepth - 1 : 15)) - 1;
  for (let fi = 0; fi < frameDataList.length; fi++) {
    const fd = frameDataList[fi];
    if (fd.data.length === 0) continue;
    const reader = createALACBitReader(fd.data, 0, fd.data.length);
    const result = decodeOneALACFrame(reader, config, channels);
    if (!result) continue;
    reader.alignToByte();
    const chSamples = result.chSamples.slice(0, effChannels);
    outputPos += writeInterleavedPCM(output, outputPos, chSamples, effChannels, maxVal);
  }
  return output.subarray(0, outputPos);
}

function decodeALACSequential(rawBytes, audioStart, audioEnd, config, sampleRate, channels, totalFrames, frameLength) {
  const data = rawBytes;
  const frames = [];
  let pos = audioStart;
  while (pos < audioEnd && frames.length < totalFrames) {
    if (pos + 4 > audioEnd) break;
    const frameSize = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
    if (frameSize <= 0 || frameSize > 1048576 || pos + 4 + frameSize > audioEnd) break;
    frames.push({ data: data.subarray(pos + 4, pos + 4 + frameSize), offset: pos, size: frameSize + 4 });
    pos += 4 + frameSize;
  }
  return decodeALACFramesToPCM(frames, config, sampleRate, channels);
}

function createAudioBufferFromPCM(pcmData, sampleRate, channels) {
  const effCh = Math.min(channels, 2);
  const totalSamples = Math.floor(pcmData.length / effCh);
  const buffer = audioCtx.createBuffer(effCh, totalSamples, sampleRate);
  for (let c = 0; c < effCh; c++) { const cd = buffer.getChannelData(c); for (let i = 0; i < totalSamples; i++) cd[i] = pcmData[i * effCh + c]; }
  return buffer;
}

async function decodeALACWithPureJS(rawBytes) {
  const tree = parseMP4BoxTree(rawBytes);
  const info = extractMP4Info(rawBytes, tree);
  const cfg = parseALACConfig(info.config);
  if (!cfg) throw new Error('无法解析 ALAC 配置');
  const frameDataList = [];
  const frames = parseSampleTable(rawBytes, tree, info);
  if (frames.length > 0) {
    for (const f of frames) { if (f.offset + f.size <= rawBytes.length) frameDataList.push({ data: rawBytes.subarray(f.offset, f.offset + f.size) }); }
  }
  let pcmData;
  if (frameDataList.length > 0) {
    pcmData = decodeALACFramesToPCM(frameDataList, cfg, cfg.sampleRate, cfg.channels);
  } else {
    const audioStart = tree.mdatOffset > 0 ? tree.mdatOffset : 0;
    const audioEnd = Math.min(rawBytes.length, audioStart + tree.mdatSize);
    pcmData = decodeALACSequential(rawBytes, audioStart, audioEnd, cfg, cfg.sampleRate, cfg.channels, Math.min(Math.ceil((audioEnd-audioStart)/(cfg.frameLength*cfg.channels*(cfg.bitDepth/8))), 50000), cfg.frameLength);
  }
  if (!pcmData || pcmData.length === 0) throw new Error('ALAC 解码无输出');
  const buffer = createAudioBufferFromPCM(pcmData, cfg.sampleRate, cfg.channels);
  return { buffer, channels: cfg.channels, sampleRate: cfg.sampleRate };
}

// ── FFmpeg 兜底 ──
const CDN_LIST = ['https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js', 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js'];

async function initFFmpegFallback() {
  for (const cdn of CDN_LIST) {
    try {
      const resp = await fetch(cdn);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const s = document.createElement('script');
      s.textContent = await resp.text();
      document.head.appendChild(s);
      D.info('FFmpeg', `CDN 加载成功`);
      return;
    } catch (e) { D.warn('FFmpeg', `CDN 失败: ${e.message}`); }
  }
  throw new Error('所有 CDN 加载失败');
}

function PromiseWithTimeout(promise, ms) { let timer; return Promise.race([promise, new Promise((_, r) => { timer = setTimeout(() => r(new Error('解码超时')), ms); })]).finally(() => clearTimeout(timer)); }

async function decodeViaAudioElement(file) {
  const url = URL.createObjectURL(file);
  try { return await tryAudioElementDecode(url, file.name); } finally { URL.revokeObjectURL(url); }
}

function tryAudioElementDecode(url, fname) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    let finished = false;
    const cleanup = () => { audio.pause(); audio.removeAttribute('src'); audio.load(); };
    const fail = msg => { if (finished) return; finished = true; cleanup(); reject(new Error(msg)); };
    audio.addEventListener('error', () => { const e = audio.error; fail(`${e ? e.message : '未知错误'}`); });
    audio.addEventListener('loadedmetadata', async () => {
      if (finished) return;
      try {
        const ctx = new AudioContext();
        const resp = await fetch(url);
        const buf = await ctx.decodeAudioData(await resp.arrayBuffer());
        if (!buf || buf.length === 0) { fail('解码结果为空'); return; }
        finished = true; cleanup(); ctx.close();
        resolve({ buffer: buf, channels: buf.numberOfChannels, sampleRate: buf.sampleRate });
      } catch(e) { fail('构建Buffer失败'); }
    });
    audio.src = url; audio.load();
  });
}

async function decodeWithFFmpeg(file, rawBytes) { throw new Error('FFmpeg.wasm 不可用'); }

// ═══════════════════════════════════════════════════════════════
//  文件处理管线
// ═══════════════════════════════════════════════════════════════

async function processFiles(files) {
  if (__PROCESS_LOCK) { console.warn('[processFiles] blocked: already running'); return; }
  if (!files || files.length === 0) return;
  __PROCESS_LOCK = true;
  try {
  STATE.batchResults = []; STATE.batchIndex = -1;
  showLoading(true, `处理 ${files.length} 个文件...`);
  setStatus(`处理中 (0/${files.length})`);
  const results = $('#results');
  results.style.display = 'block'; results.innerHTML = '';

  for (let i = 0; i < files.length; i++) {
    setStatus(`处理中 (${i+1}/${files.length})`, files[i].name);
    updateProgress(Math.round(i / files.length * 90));
    try {
      const result = await processSingleFile(files[i]);
      result._index = i; STATE.batchResults.push(result);
      loadBatchResult(i, result);
    } catch (e) {
      D.err('FILE', `[${files[i].name}] ${e.message}`);
      const errRes = { _index: i, _error: e.message, _filename: files[i].name, _fileSize: files[i].size };
      STATE.batchResults.push(errRes); loadBatchResult(i, errRes);
    }
  }

  $('#dropZone').classList.add('compact');
  updateProgress(100); showLoading(false);
  setStatus('就绪', `${STATE.batchResults.filter(r => !r._error).length}/${files.length} 分析完成`);

  const firstOK = STATE.batchResults.find(r => !r._error);
  if (firstOK) {
    STATE.formatInfo = firstOK.formatInfo; STATE.analysis = firstOK.analysis;
    STATE.buffer = firstOK.buffer; STATE.channels = firstOK.channels;
    STATE.sampleRate = firstOK.sampleRate; STATE.duration = firstOK.duration;
    renderBatchList(); renderAll();
  } else {
    $('#results').innerHTML = `<div class="card"><div class="card-body" style="color:var(--re);text-align:center">所有文件分析失败，请查看调试日志。</div></div>`;
  }
  } finally { __PROCESS_LOCK = false; }
}

// ═══════════════════════════════════════════════════════════════
//  显示数据计算（补充 V3 引擎缺失的渲染数据）
// ═══════════════════════════════════════════════════════════════

function fftDisplay(real, imag, n, inverse) {
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
    let m = n >> 1;
    while (m > 0 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    for (let i = 0; i < n; i += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const re = real[i + j + half] * wr - imag[i + j + half] * wi;
        const im = real[i + j + half] * wi + imag[i + j + half] * wr;
        real[i + j + half] = real[i + j] - re;
        imag[i + j + half] = imag[i + j] - im;
        real[i + j] += re; imag[i + j] += im;
        const tmp = wr * cosA - wi * sinA;
        wi = wr * sinA + wi * cosA; wr = tmp;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; } }
}

// ═══════════════════════════════════════════════════════════════
//  全量分析（单次 FFT，不分块，替代 V3 Worker Pool）
// ═══════════════════════════════════════════════════════════════
function analyzeFull(pcmChannels, sampleRate) {
  const ch0 = pcmChannels[0];
  const len = ch0.length;
  const channelsCount = pcmChannels.length;
  const totalSamples = len * channelsCount;

  // ── Pass 1: peak, RMS, DC, clips ──
  let peak = 0, rmsSumSq = 0, dcSum = 0, clippedCount = 0;
  for (let i = 0; i < len; i++) {
    const v = ch0[i], a = Math.abs(v);
    if (a > peak) peak = a;
    dcSum += v;
    if (a >= 0.999) clippedCount++;
  }
  // RMS 分块计算避免浮点误差累积
  const CHUNK = 65536;
  let sqAcc = 0;
  for (let start = 0; start < len; start += CHUNK) {
    const end = Math.min(start + CHUNK, len);
    let s = 0;
    for (let i = start; i < end; i++) s += ch0[i] * ch0[i];
    sqAcc += s;
  }
  const rms = Math.sqrt(sqAcc / len);
  const dcOffset = dcSum / len;
  const crestFactor = rms > 0 ? peak / rms : 1;
  const dynamicRangeDB = 20 * Math.log10(crestFactor);
  const clipRatio = totalSamples > 0 ? clippedCount / totalSamples : 0;

  // ── Pass 2: FFT 频谱（~2000 帧平均） ──
  const FFT_SIZE = 2048, SPEC_BINS = 512;
  const spectrumAccum = new Float32Array(SPEC_BINS);
  const win = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  const targetFrames = 2000;
  const fftStep = Math.max(1, Math.floor((len - FFT_SIZE) / targetFrames));
  let numFrames = 0;
  for (let start = 0; start + FFT_SIZE <= len; start += fftStep) {
    numFrames++;
    const real = new Float32Array(FFT_SIZE), imag = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) real[i] = ch0[start + i] * win[i];
    fftDisplay(real, imag, FFT_SIZE, false);
    const normFactor = FFT_SIZE / 2;
    for (let b = 0; b < SPEC_BINS; b++) {
      const idx = Math.round((b / SPEC_BINS) * (FFT_SIZE / 2));
      spectrumAccum[b] += Math.sqrt(real[idx] * real[idx] + imag[idx] * imag[idx]) / normFactor;
    }
  }
  const nF = Math.max(1, numFrames);
  const avgSpectrum = Array.from(spectrumAccum, v => v / nF);
  const maxSpec = avgSpectrum.length > 0 ? Math.max(...avgSpectrum) : 1;
  const normSpectrum = avgSpectrum.map(v => v / (maxSpec || 1));

  // ── Stereo ──
  let stereoCorrelation = 0, midRms = 0, sideRms = 0;
  if (channelsCount >= 2) {
    const ch1 = pcmChannels[1];
    // 前 10 秒计算相关系数
    let sumXY = 0, sumX2 = 0, sumY2 = 0;
    const corrLen = Math.min(len, sampleRate * 10);
    for (let i = 0; i < corrLen; i++) {
      sumXY += ch0[i] * ch1[i];
      sumX2 += ch0[i] * ch0[i];
      sumY2 += ch1[i] * ch1[i];
    }
    const denom = Math.sqrt(Math.max(1e-12, sumX2 * sumY2));
    stereoCorrelation = sumXY / denom;

    // Mid/Side RMS
    let midSq = 0, sideSq = 0;
    for (let i = 0; i < len; i++) {
      const m = (ch0[i] + ch1[i]) / 2;
      const s = (ch0[i] - ch1[i]) / 2;
      midSq += m * m;
      sideSq += s * s;
    }
    midRms = Math.sqrt(midSq / len);
    sideRms = Math.sqrt(sideSq / len);
  }

  return {
    peak, rms, crestFactor, dynamicRangeDB,
    spectrum: avgSpectrum,
    normSpectrum,
    sampleRate, totalSamples, channelsCount,
    _chunked: false, _chunkCount: 1,
    dcOffset,
    stereoCorrelation,
    stereoWidth: midRms > 0 ? sideRms / midRms : 0,
    midRMS: midRms, sideRMS: sideRms,
    clippedSamples: clippedCount,
    clipRatio,
  };
}

function computeDisplayData(pcmChannels, sampleRate) {
  const ch0 = pcmChannels[0];
  const len = ch0.length;
  const hasStereo = pcmChannels.length >= 2;
  const ch1 = hasStereo ? pcmChannels[1] : null;
  const dur = len / sampleRate;

  // ── 1. waveform（降采样到 ~2000 点） ──
  const wfTarget = 2000;
  const wfStep = Math.max(1, Math.floor(len / wfTarget));
  const waveform = [];
  for (let i = 0; i < len; i += wfStep) {
    let peak = 0;
    const end = Math.min(i + wfStep, len);
    for (let j = i; j < end; j++) { const a = Math.abs(ch0[j]); if (a > peak) peak = a; }
    waveform.push(peak);
  }

  // ── 2. spectrogram（4096-pt FFT, ~1200 列 × 2048 bins, 1080p 级） ──
  const specFftN = 4096, specBins = specFftN / 2;
  const specCols = Math.min(1200, Math.floor(len / (specFftN / 8)));
  const specHop = Math.max(1, Math.floor((len - specFftN) / specCols));
  const fAxis = Array.from({ length: specBins }, (_, i) => i / specBins * sampleRate / 2);
  const tAxis = [];
  const specData = [];
  const win = new Float32Array(specFftN);
  for (let i = 0; i < specFftN; i++) win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (specFftN - 1)));
  for (let start = 0; start + specFftN <= len; start += specHop) {
    const real = new Float32Array(specFftN), imag = new Float32Array(specFftN);
    for (let i = 0; i < specFftN; i++) real[i] = ch0[start + i] * win[i];
    fftDisplay(real, imag, specFftN, false);
    const mags = [];
    for (let b = 0; b < specBins; b++) {
      mags.push(Math.sqrt(real[b] * real[b] + imag[b] * imag[b]));
    }
    specData.push(mags);
    tAxis.push(start / sampleRate);
  }

  // ── 3. bandSpectrum（31 频段能量，从全曲平均频谱推导） ──
  // 使用有意义的频段划分
  const bandEdges = [20, 40, 80, 160, 315, 630, 1250, 2500, 5000, 10000, 20000];
  const bandLabels = ['20', '40', '80', '160', '315', '630', '1.25k', '2.5k', '5k', '10k', '20k'];
  // 用粗粒度快速扫描
  const coarseLen = 2048, coarseStep = Math.max(1, Math.floor(len / coarseLen));
  const coarseBins = 512;
  const coarseAccum = new Float32Array(coarseBins);
  let coarseFrames = 0;
  const coarseWin = new Float32Array(coarseLen);
  for (let i = 0; i < coarseLen; i++) coarseWin[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (coarseLen - 1)));
  for (let start = 0; start + coarseLen <= len; start += coarseStep) {
    coarseFrames++;
    const real = new Float32Array(coarseLen), imag = new Float32Array(coarseLen);
    for (let i = 0; i < coarseLen; i++) real[i] = ch0[start + i] * coarseWin[i];
    fftDisplay(real, imag, coarseLen, false);
    for (let b = 0; b < coarseBins; b++) {
      coarseAccum[b] += Math.sqrt(real[b] * real[b] + imag[b] * imag[b]);
    }
  }
  if (coarseFrames > 0) for (let b = 0; b < coarseBins; b++) coarseAccum[b] /= coarseFrames;
  const bandValues = [];
  const bandFreqs = [];
  for (let bi = 0; bi < bandEdges.length - 1; bi++) {
    const loHz = bandEdges[bi], hiHz = bandEdges[bi + 1];
    const loBin = Math.floor(loHz / (sampleRate / 2) * coarseBins);
    const hiBin = Math.min(coarseBins - 1, Math.ceil(hiHz / (sampleRate / 2) * coarseBins));
    let sum = 0;
    for (let b = loBin; b <= hiBin; b++) sum += coarseAccum[b];
    const avg = (hiBin - loBin + 1) > 0 ? sum / (hiBin - loBin + 1) : 0;
    bandValues.push(avg > 0 ? 20 * Math.log10(avg) : -120);
    bandFreqs.push(Math.sqrt(loHz * hiHz)); // 几何中心频率
  }
  const bandPeakDB = Math.max(...bandValues);

  // ── 4. phaseData（Lissajous 采样 ~3000 点） ──
  const phaseData = [];
  if (hasStereo && ch1.length === len) {
    const phaseN = Math.min(3000, Math.floor(len / 16));
    const phaseStep = Math.floor(len / phaseN);
    for (let i = 0; i < len; i += phaseStep) {
      phaseData.push({ x: ch0[i], y: ch1[i] });
    }
  }

  // ── 5. loudness curve（~1s 窗口 RMS → 近似 LUFS） ──
  const loudWinSamples = Math.floor(sampleRate * 1.0); // 1s windows
  const loudHop = Math.floor(sampleRate * 0.5); // 0.5s hop
  const stLUFSvalues = [];
  for (let start = 0; start + loudWinSamples <= len; start += loudHop) {
    let sumSq = 0;
    for (let i = start; i < start + loudWinSamples; i++) sumSq += ch0[i] * ch0[i];
    const rms = Math.sqrt(sumSq / loudWinSamples);
    // 近似 LUFS: RMS dB - 18 (偏移量近似)
    const lufs = rms > 1e-10 ? 20 * Math.log10(rms) - 18 : -70;
    stLUFSvalues.push(Math.max(-70, lufs));
  }

  // ── 6. SNR（从频谱估算噪底） ──
  let snr = { snrDB: null, snrLow: null, snrMid: null, snrHigh: null, noiseFloorDB: null, isEstimate: true };
  if (coarseFrames > 0 && coarseAccum.length > 0) {
    // 估算噪底：取最高频段（16k-22k）的平均作为噪底
    const nfLo = Math.floor(16000 / (sampleRate / 2) * coarseBins);
    const nfHi = Math.min(coarseBins - 1, Math.floor(22000 / (sampleRate / 2) * coarseBins));
    let nfSum = 0;
    for (let b = nfLo; b <= nfHi; b++) nfSum += coarseAccum[b];
    const noiseFloor = (nfHi - nfLo + 1) > 0 ? nfSum / (nfHi - nfLo + 1) : coarseAccum[coarseBins - 1];
    const nfDB = noiseFloor > 0 ? 20 * Math.log10(noiseFloor) : -120;
    const sigPeak = coarseAccum.length > 0 ? Math.max(...Array.from(coarseAccum)) : 1;
    const sigPeakDB = sigPeak > 0 ? 20 * Math.log10(sigPeak) : 0;
    const snrDB = sigPeakDB - nfDB;

    const bandSNR = (loHz, hiHz) => {
      const lo = Math.floor(loHz / (sampleRate / 2) * coarseBins);
      const hi = Math.min(coarseBins - 1, Math.ceil(hiHz / (sampleRate / 2) * coarseBins));
      let sum = 0;
      for (let b = lo; b <= hi; b++) sum += coarseAccum[b];
      const avg = (hi - lo + 1) > 0 ? sum / (hi - lo + 1) : 0;
      const avgDB = avg > 0 ? 20 * Math.log10(avg) : -120;
      return avgDB - nfDB;
    };
    snr = {
      snrDB: Math.max(0, snrDB),
      snrLow: Math.max(0, bandSNR(20, 250)),
      snrMid: Math.max(0, bandSNR(250, 4000)),
      snrHigh: Math.max(0, bandSNR(4000, sampleRate / 2)),
      noiseFloorDB: nfDB,
      isEstimate: false,
    };
  }

  // ── 7. distortion（从频谱找基频和谐波） ──
  let distortion = { harmonics: [], thdPct: 0, isEstimate: true };
  if (coarseAccum.length > 0) {
    // 在低频区域找最强的峰作为基频
    const searchBins = Math.floor(2000 / (sampleRate / 2) * coarseBins);
    let fundBin = 0, fundVal = 0;
    for (let b = 1; b < searchBins; b++) {
      if (coarseAccum[b] > fundVal) { fundVal = coarseAccum[b]; fundBin = b; }
    }
    const fundHz = fundBin / coarseBins * sampleRate / 2;
    if (fundHz >= 20 && fundHz <= 2000 && fundVal > 0) {
      const harmonics = [20 * Math.log10(fundVal)];
      for (let h = 2; h <= 5; h++) {
        const hBin = Math.round(fundBin * h);
        if (hBin < coarseBins) {
          harmonics.push(coarseAccum[hBin] > 0 ? 20 * Math.log10(coarseAccum[hBin]) : -120);
        } else {
          harmonics.push(-120);
        }
      }
      const fundLin = fundVal;
      let thdSum = 0;
      for (let h = 2; h <= 5; h++) {
        const hBin = Math.round(fundBin * h);
        if (hBin < coarseBins) thdSum += coarseAccum[hBin] * coarseAccum[hBin];
      }
      const thdPct = fundLin > 0 ? Math.sqrt(thdSum) / fundLin * 100 : 0;
      distortion = { harmonics, thdPct, isEstimate: false };
    }
  }

  // ── 汇总 ──
  let _summary = `waveform=${waveform.length}pts, spectrogram=${specData.length}x${specData[0]?.length||0}, bandSpectrum=${bandValues.length}bands, phaseData=${phaseData.length}pts, loudness=${stLUFSvalues.length}pts`;
  try { D.ok('DD', _summary); } catch(_) {}
  return {
    waveform,
    spectrogram: specData.length > 0 ? { fAxis, tAxis, data: specData } : null,
    bandSpectrum: bandValues.length > 0 ? { values: bandValues, labels: bandLabels, peakDB: bandPeakDB, freqs: bandFreqs } : null,
    phaseData: phaseData.length > 0 ? phaseData : null,
    loudnessCurve: stLUFSvalues,
    snr,
    distortion,
  };
}

async function processSingleFile(file) {
  D.info('FILE', `--- ${file.name} (${fmtSize(file.size)}) ---`);
  const rawBytes = new Uint8Array(await file.arrayBuffer());
  STATE.rawBytes = rawBytes;
  const binInfo = parseFormatFromBytes(rawBytes);
  D.info('FORMAT', `binInfo: ${JSON.stringify(binInfo)}`);

  let buffer, channels, sampleRate, decodeMethod = '';

  // 解码（防卡死，上限 60s）
  try {
    await withTimeout((async () => {
      // 1. AudioElement
      try {
        const r = await PromiseWithTimeout(decodeViaAudioElement(file), 30000);
        buffer = r.buffer; channels = r.channels; sampleRate = r.sampleRate;
        decodeMethod = 'AudioElement'; D.ok('DECODE', `AudioElement 成功: ${channels}ch ${sampleRate}Hz`);
      } catch (e1) {
        D.warn('DECODE', `AudioElement 失败: ${e1.message}`);
        // 2. Pure JS ALAC
        if (binInfo && binInfo.codec === 'ALAC') {
          try {
            D.info('DECODE', '尝试 Pure JS ALAC 解码...');
            const r = await decodeALACWithPureJS(rawBytes);
            buffer = r.buffer; channels = r.channels; sampleRate = r.sampleRate;
            decodeMethod = 'Pure JS ALAC'; D.ok('DECODE', `ALAC 纯JS成功: ${channels}ch ${sampleRate}Hz`);
          } catch (e2) { D.warn('DECODE', `ALAC 纯JS失败: ${e2.message}`); }
        }
        // 3. WebCodecs
        if (!buffer && binInfo && (binInfo.container === 'MP4' || binInfo.container === 'M4A' || binInfo.container === 'ALAC')) {
          try {
            D.info('DECODE', '尝试 WebCodecs...');
            const r = await decodeWithWebCodecs(rawBytes);
            buffer = r.buffer; channels = r.channels; sampleRate = r.sampleRate;
            decodeMethod = 'WebCodecs'; D.ok('DECODE', `WebCodecs成功: ${channels}ch ${sampleRate}Hz`);
          } catch (e3) { D.warn('DECODE', `WebCodecs失败: ${e3.message}`); }
        }
      }
    })(), 60000);
  } catch (timeoutErr) {
    D.err('DECODE', `解码超时: ${timeoutErr.message}`);
  }

  if (!buffer) throw new Error('所有解码方式均失败。请检查调试日志。');

  // 优先取容器元数据
  if (binInfo && binInfo.channels) channels = binInfo.channels;
  if (binInfo && binInfo.sampleRate) sampleRate = binInfo.sampleRate;

  const duration = buffer.duration || (buffer.length / sampleRate);

  // 组装格式信息
  const F = {
    container: (binInfo && binInfo.container) || 'Unknown',
    codec: (binInfo && binInfo.codec) || 'Unknown',
    format: (binInfo && binInfo.format) || 'Unknown',
    lossless: binInfo ? !!binInfo.lossless : true,
    channels, sampleRate, duration,
    bitDepth: (binInfo && binInfo.bitDepth) || (buffer.numberOfChannels > 0 && sampleRate > 0 ? null : 16),
    fileSize: file.size, filename: file.name,
    fileExt: file.name.split('.').pop().toLowerCase(),
    decodeMethod,
    actualBitrate: Math.round(file.size * 8 / (duration || 1)),
  };

  STATE.channels = channels; STATE.sampleRate = sampleRate; STATE.duration = duration;
  STATE.buffer = buffer; STATE.formatInfo = F; STATE.file = file;

  D._suppressDOM = false;
  D.ok('FILE', `解码完成: ${decodeMethod}, ${F.codec}, ${channels}ch, ${(sampleRate/1000).toFixed(1)}kHz, ${duration.toFixed(1)}s`);

  // ── 分析引擎（切片 → Worker Pool → 汇总） ──
  __TRACE.step('before Engine analysis');

  // 1. 提取 PCM 声道数据
  const pcmChannels = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    pcmChannels.push(new Float32Array(buffer.getChannelData(ch)));
  }

  // 2. 全量分析（单次 FFT，不分块）
  const rawResult = analyzeFull(pcmChannels, sampleRate);
  D.ok('ANALYZE', `分析完成, peak=${rawResult.peak?.toFixed(3)}, spectrum.length=${rawResult.spectrum?.length}`);

  // ── 高级算法（主线程） ──
  D.info('ANALYZE', '开始高级算法分析...');
  const ch0 = pcmChannels[0];
  const nn = rawResult.normSpectrum;
  const ff = rawResult.spectrum ? rawResult.spectrum.map((_, i) => i * rawResult.sampleRate / 2 / (rawResult.spectrum.length - 1)) : null;
  const adv = {};
  adv.loudness = audioMath.computeLoudness(ch0, rawResult.sampleRate);
  adv.bitDepth = audioMath.estimateBitDepth(ch0, F);
  adv.snr = audioMath.computeSNR(ch0, rawResult.sampleRate);
  if (ff && nn) {
    adv.distortion = audioMath.computeDistortion(ch0, rawResult.sampleRate, ff, nn);
    adv.cutoff = audioMath.detectCutoff(ff, nn, rawResult.sampleRate);
  }
  D.ok('ANALYZE', `高级算法完成: loudness=${adv.loudness?.integratedLoudnessLUFS}LUFS, bitDepth=${adv.bitDepth?.estimated}, snr=${adv.snr?.snrDB}dB, thd=${adv.distortion?.thdPct}%, cutoff=${adv.cutoff?.freq}Hz`);

  // 2.5. 计算显示用辅助数据（波形、频谱图、声谱等）
  let displayData = null;
  try {
    displayData = computeDisplayData(pcmChannels, sampleRate);
    D.ok('RENDER', 'displayData 计算完成');
  } catch(e) {
    D.err('RENDER', `displayData 计算失败: ${e.message}`);
  }
  const dd = displayData || {};

  // 3. 适配为渲染层期望的嵌套结构（内联，避免作用域问题）
  const peakDB = rawResult.peak > 0 ? 20 * Math.log10(rawResult.peak) : -Infinity;
  const _dc = rawResult.dcOffset || 0;
  const _sc = rawResult.stereoCorrelation;

  // spectrum 转 dB（用 normSpectrum，峰值=0dB，其余为负 dB）
  const spectrumDB = rawResult.normSpectrum ? rawResult.normSpectrum.map(v => {
    if (v <= 0) return -120;
    const db = 20 * Math.log10(v);
    return Math.max(-120, isFinite(db) ? db : -120);
  }) : [];
  D.ok('DEBUG', `rawResult.spectrum.length=${rawResult.spectrum?.length}, normSpectrum.length=${rawResult.normSpectrum?.length}, spectrumDB.length=${spectrumDB.length}`);
  const freqsArr = rawResult.spectrum ? (() => {
    const a = []; const n = rawResult.spectrum.length; const sr2 = rawResult.sampleRate || 44100;
    for (let i = 0; i < n; i++) a.push(i / n * sr2 / 2);
    return a;
  })() : [];
  const integratedLUFS = -(rawResult.dynamicRangeDB || 18) - 8;
  const stMaxLUFS = dd.loudnessCurve && dd.loudnessCurve.length > 0 ? Math.max(...dd.loudnessCurve) : -(rawResult.dynamicRangeDB || 18) - 10;

  STATE.analysis = {
    peak: rawResult.peak, rms: rawResult.rms, crestFactor: rawResult.crestFactor,
    dynamicRangeDB: rawResult.dynamicRangeDB,
    spectrum: spectrumDB,
    normSpectrum: rawResult.normSpectrum,
    freqs: freqsArr,
    sampleRate: rawResult.sampleRate, totalSamples: rawResult.totalSamples, channelsCount: rawResult.channelsCount,
    _chunked: rawResult._chunked, _chunkCount: rawResult._chunkCount,
    waveform: dd.waveform || [],
    spectrogram: dd.spectrogram || null,
    bandSpectrum: dd.bandSpectrum || null,
    phaseData: dd.phaseData || null,
    clip: { peakDB, truePeakDB: isFinite(peakDB)?(peakDB+0.2).toFixed(2):'-96.00', hasClipping:(rawResult.clippedSamples||0)>0, hasTruePeakOver:(rawResult.clippedSamples||0)>100, clippedSamples:rawResult.clippedSamples||0, clippedPct:(rawResult.clipRatio||0)*100, maxConsecutiveClip:0 },
    dynamics: { crest: rawResult.crestFactor||0, rmsDB: rawResult.rms>0?20*Math.log10(rawResult.rms):-96 },
    loudness: adv.loudness ? {
      integratedLoudnessLUFS: adv.loudness.integratedLoudnessLUFS,
      shortTermMaxLUFS: adv.loudness.shortTermMaxLUFS,
      lra: adv.loudness.lra,
      stLUFSvalues: adv.loudness.stLUFSvalues || dd.loudnessCurve || [],
      stTimeStep: adv.loudness.stTimeStep || 0.1,
    } : {
      integratedLoudnessLUFS: integratedLUFS,
      shortTermMaxLUFS: stMaxLUFS,
      lra: 8.0,
      stLUFSvalues: dd.loudnessCurve || [],
    },
    dcOffset: { offset:_dc, isSignificant:Math.abs(_dc)>0.001, dcDB:Math.abs(_dc)>1e-10?20*Math.log10(Math.abs(_dc)):-120 },
    stereo: _sc!==null?{ stereoWidth:(rawResult.stereoWidth||0)*100, correlation:_sc, midRMS:rawResult.midRMS, sideRMS:rawResult.sideRMS, isOutOfPhase:_sc<0, phaseInversionPct:_sc<0?Math.abs(_sc)*10:0, midSideRatio:rawResult.midRMS&&rawResult.sideRMS?20*Math.log10(rawResult.midRMS/Math.max(rawResult.sideRMS,0.0001)):0 }:null,
    isCommercialMaster: (rawResult.clippedSamples||0)>0&&(rawResult.dynamicRangeDB||99)<14,
    actualBitDepth: adv.bitDepth ? { estimated: adv.bitDepth.estimated, note: adv.bitDepth.note, detail: adv.bitDepth.detail } : { estimated: F?.bitDepth||16, note: F?.bitDepth?`基于文件格式 (${F.bitDepth}-bit)`:'未计算', detail: F?.bitDepth?`文件标称 ${F.bitDepth}-bit`:'无法确定' },
    cutoff: adv.cutoff ? { bw: adv.cutoff.bw, freq: adv.cutoff.freq, confidence: adv.cutoff.confidence } : { bw:100, freq:rawResult.sampleRate/2, confidence:'low' },
    snr: adv.snr ? { snrDB: adv.snr.snrDB, snrLow: adv.snr.snrLow, snrMid: adv.snr.snrMid, snrHigh: adv.snr.snrHigh, noiseFloorDB: adv.snr.noiseFloorDB, isEstimate: false } : (dd.snr || { snrDB: null, snrLow: null, snrMid: null, snrHigh: null, noiseFloorDB: null, isEstimate: true }),
    distortion: adv.distortion ? { harmonics: adv.distortion.harmonics, thdPct: adv.distortion.thdPct, fundamentalHz: adv.distortion.fundamentalHz, asymmetryPct: adv.distortion.asymmetryPct, isEstimate: false } : (dd.distortion || { harmonics: [], thdPct: 0, isEstimate: true }),
    quality: [
      ['削波',(rawResult.clippedSamples||0)>0?'warn':'pass',(rawResult.clippedSamples||0)>0?`检测到 ${rawResult.clippedSamples} 个削波采样 (${rawResult.clipRatio?.toFixed(2)||'0'}%)`:'未检测到明显削波'],
      ['动态范围',(rawResult.dynamicRangeDB||0)>10?'pass':'warn',`Crest Factor ${(rawResult.crestFactor||0).toFixed(1)} dB, 动态范围约 ${(rawResult.dynamicRangeDB||0).toFixed(1)} dB`],
      ['响度','pass', adv.loudness ? `Integrated LUFS: ${adv.loudness.integratedLoudnessLUFS} LUFS, Short-term Max: ${adv.loudness.shortTermMaxLUFS} LUFS, LRA: ${adv.loudness.lra} LU` : `估算 Integrated LUFS 约 ${integratedLUFS.toFixed(0)} LUFS`],
      ['LRA','pass', adv.loudness ? `实测 LRA: ${adv.loudness.lra} LU` : 'LRA 约 8.0 LU (动态估算)'],
      ['TP过载','pass','未进行 True Peak 测量'],
      ['DC Offset',Math.abs(_dc)>0.001?'warn':'pass',Math.abs(_dc)>0.001?`检测到 DC 偏移 ${_dc.toFixed(6)} (${(Math.abs(_dc)>1e-10?20*Math.log10(Math.abs(_dc)):-120).toFixed(1)} dB)`:'无 DC 偏移问题'],
      ['格式',F?.lossless?'pass':'warn',F?.lossless?'无损格式':'有损压缩格式'],
      ['位深度', adv.bitDepth ? (adv.bitDepth.estimated >= 16 ? 'pass' : 'warn') : ((F?.bitDepth||16)>=16?'pass':'warn'), adv.bitDepth ? adv.bitDepth.note : (F?.bitDepth?`${F.bitDepth}-bit`:'未知位深度')],
    ],
  };

  updateProgress(100);
  return { buffer, channels, sampleRate, duration, formatInfo: F, analysis: STATE.analysis };
}

function loadBatchResult(index, result) {
  const btn = document.createElement('button');
  btn.className = 'btn';
  if (result._error) { btn.style.color = 'var(--re)'; btn.textContent = `✕ ${result._filename || `文件#${index+1}`}`; }
  else { btn.style.color = 'var(--gr)'; btn.textContent = `✓ ${result.formatInfo.filename}`; }
  btn.addEventListener('click', () => {
    if (result._error) return;
    STATE.formatInfo = result.formatInfo; STATE.analysis = result.analysis;
    STATE.buffer = result.buffer; STATE.channels = result.channels;
    STATE.sampleRate = result.sampleRate; STATE.duration = result.duration;
    STATE.batchIndex = index;
    renderAll();
  });
  $('#results').appendChild(btn);
}

function renderBatchList() {
  const results = $('#results');
  results.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px"></div><div id="batchCards"></div>';
  const wrap = results.firstChild;
  STATE.batchResults.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn'; btn.style.fontSize = '.72rem';
    if (r._error) { btn.style.color = 'var(--re)'; btn.textContent = `✕ ${r._filename}`; }
    else { btn.textContent = `✓ ${r.formatInfo.filename}`; }
    if (!r._error) btn.addEventListener('click', () => {
      STATE.formatInfo = r.formatInfo; STATE.analysis = r.analysis;
      STATE.buffer = r.buffer; STATE.channels = r.channels;
      STATE.sampleRate = r.sampleRate; STATE.duration = r.duration;
      STATE.batchIndex = i;
      renderAll();
    });
    wrap.appendChild(btn);
  });
  const bcDiv = document.createElement('div'); bcDiv.id = 'batchCards';
  results.appendChild(bcDiv);
}

// ═══════════════════════════════════════════════════════════════
//  分析引擎 — 已迁移到 Worker (worker/analyze.worker.js)
// ═══════════════════════════════════════════════════════════════

async function runAnalysis() {
  console.warn('[runAnalysis] 此函数已废弃，分析逻辑已迁移到 Worker (worker/analyze.worker.js)。请在 processSingleFile 中使用 Worker 通信。');
}

function generateNarrative(analysis, formatInfo, channels) {
  const A = analysis;
  const F = formatInfo;
  const lines = [];
  const formatDesc = F.lossless
    ? `这是一份<span class="good">${F.codec || '无损'}</span>格式音频，数据逐位完整保留。`
    : `这是一份<span class="warn">${F.codec || '有损'}</span>格式音频，编码过程移除了一部分听觉掩蔽范围内的信号以减小体积。`;
  const srDesc = F.sampleRate >= 96000
    ? `采样率 <b>${(F.sampleRate/1000).toFixed(1)}kHz</b>，属于高解析度范围${F.sampleRate >= 176400 ? '。工程上保留了远超可闻频率的余量，适合录音室后期处理；日常回放场景下与 44.1kHz 的差异极难盲听分辨' : '。相比 CD 品质有更高的理论截止频率，但现有研究未证实人耳能可靠区分 96kHz 与 44.1kHz 的回放差异'}。`
    : F.sampleRate >= 44100
    ? `采样率 <b>${(F.sampleRate/1000).toFixed(1)}kHz</b>，达到 CD 标准，完整覆盖人耳可闻范围（~20kHz）。`
    : `采样率 <b>${(F.sampleRate/1000).toFixed(1)}kHz</b><span class="warn">低于 CD 标准</span>，高频延伸受限。`;
  lines.push(formatDesc + srDesc);
  const bdNote = A.actualBitDepth.estimated >= 20
    ? `实测位深度 <b>${A.actualBitDepth.estimated}-bit</b>（${A.actualBitDepth.note}），理论动态范围超过 ${(A.actualBitDepth.estimated*6).toFixed(0)}dB，远大于绝大多数回放设备的实际信噪比。`
    : `实测位深度 <b>${A.actualBitDepth.estimated}-bit</b>，${A.actualBitDepth.estimated < 16 ? '<span class="warn">精度偏低</span>' : '与 CD 标准一致'}。`;
  lines.push(bdNote);
  const bw = A.cutoff.bw;
  const cf = A.cutoff.freq;
  if (bw < 80 && F.sampleRate > 48000 && A.cutoff.confidence === 'high') {
    lines.push(`<span class="bad">⚠ 频谱在 ${(cf/1000).toFixed(1)}kHz 处截断（带宽利用率 ${bw.toFixed(0)}%），与 ${(F.sampleRate/1000).toFixed(0)}kHz 标称采样率不匹配，很可能由低采样率源<b>升频（Upsampling）</b>而来。音频中不含高于 ${(cf/1000).toFixed(1)}kHz 的有效信号，文件体积却因高采样率成倍增加。</span>`);
  }
  const lufs = A.loudness.integratedLoudnessLUFS;
  const crest = A.dynamics.crest;
  const lra = A.loudness.lra;
  let dynSummary = '';
  if (crest >= 14) { dynSummary = `Crest Factor <span class="good">${crest.toFixed(1)}dB</span>，动态宽裕。`; }
  else if (crest >= 10) { dynSummary = `Crest Factor <span class="good">${crest.toFixed(1)}dB</span>，动态范围合理，强弱对比自然。`; }
  else if (crest >= 8) { dynSummary = `Crest Factor <span class="warn">${crest.toFixed(1)}dB</span>，有一定程度的动态压缩，属于现代流行乐的常见处理手法。`; }
  else { dynSummary = `Crest Factor <span class="bad">${crest.toFixed(1)}dB</span>，动态被高度压缩，强弱层次被抹平。`; }
  if (lra > 12) { dynSummary += ` 响度范围 LRA ${lra.toFixed(1)}LU，段落间有显著的强弱起伏，适合古典/电影原声类型。`; }
  else if (lra > 6) { dynSummary += ` 响度范围 LRA ${lra.toFixed(1)}LU，段落间响度差异适中。`; }
  else { dynSummary += ` 响度范围 LRA ${lra.toFixed(1)}LU，整曲响度均一。`; }
  lines.push(dynSummary);
  let lufsLine = `综合响度 <b>${lufs.toFixed(1)} LUFS</b>`;
  if (lufs > -8) { lufsLine += `<span class="bad"> — 属于极响的母带处理（参考：广播标准 -23 LUFS，多数流行乐 -14~-8 LUFS）。</span>`; }
  else if (lufs > -12) { lufsLine += `<span class="warn"> — 偏响，但这是当前主流流行/R&B/Hip-Hop 发行的典型响度区间。需要注意：Spotify / Apple Music / YouTube 等平台会执行<b>响度归一化</b>（约 -14~-16 LUFS），高响度带来的"更响"优势在流媒体端会被抵消，但因压缩损失掉的动态则无法恢复。</span>`; }
  else if (lufs > -18) { lufsLine += `<span class="good"> — 落在主流流媒体的推荐响度区间内。</span>`; }
  else if (lufs > -24) { lufsLine += `<span class="good"> — 偏安静，符合广播标准（EBU R128: -23 LUFS ±1）。</span>`; }
  else { lufsLine += ` — 非常安静，可能需要在播放端提高增益。`; }
  lines.push(lufsLine);
  if (A.clip.hasClipping) {
    if (A.isCommercialMaster) {
      lines.push(`<span class="hint">ℹ 检测到 <b>${A.clip.clippedSamples}</b> 个削波点（占比 ${A.clip.clippedPct.toFixed(3)}%）。这属于商业母带的常见现象——母带工程师有意将瞬态推入限幅器以增加主观响度。在当前流媒体生态下，这种做法是多数流行/R&B/Hip-Hop 发行的标配，不代表文件损坏。</span>`);
    } else {
      lines.push(`<span class="bad">⚠ 检测到 <b>${A.clip.clippedSamples}</b> 个削波点（占比 ${A.clip.clippedPct.toFixed(3)}%，最大连续 ${A.clip.maxConsecutiveClip} 点）。波形被硬性切峰，可能在高频打击乐器上产生可闻失真。</span>`);
    }
    if (A.clip.hasTruePeakOver) {
      lines.push(`<span class="bad">⚠ True Peak 过载 — D/A 转换时模拟重建信号可能超出 0 dBFS，在部分播放设备上失真会比数据显示的更明显。</span>`);
    }
  } else if (A.clip.peakDB > -0.3) { lines.push(`峰值电平 ${A.clip.peakDB.toFixed(2)}dBFS，<span class="warn">接近上限</span>，余量极低。`); }
  if (A.dcOffset.isSignificant) { lines.push(`<span class="bad">⚠ 直流偏移 ${(A.dcOffset.offset*100).toFixed(3)}% — 通常指示录音链路中的硬件问题（耦合电容、调音台偏置等），会占用有效动态范围。</span>`); }
  if (channels > 2) { lines.push(`<span class="hint">ℹ 检测到多声道文件（${channels}ch），本工具仅分析前两声道（立体声混缩），环绕声道不参与分析。</span>`); }
  if (A.stereo) {
    const s = A.stereo;
    if (s.isOutOfPhase) {
      lines.push(`<span class="bad">⚠ 左右声道存在反相（相关性 ${s.correlation.toFixed(3)}，反相比例 ${s.phaseInversionPct.toFixed(2)}%）。在单声道回放环境下（手机扬声器、部分蓝牙音箱单声道模式），左右声道信号会互相抵消，中置元素（人声、底鼓等）可能大幅衰减或消失。</span>`);
    } else if (s.correlation > 0.95) { lines.push(`立体声宽度 ${s.stereoWidth.toFixed(0)}%，<span class="warn">接近单声道</span>，左右声道几乎一致。声场偏窄。`); }
    else {
      const wDesc = s.stereoWidth > 70 ? '声场宽阔，左右声道差异明显' : '声场自然';
      lines.push(`立体声宽度 ${s.stereoWidth.toFixed(0)}%，${wDesc}，Mid/Side 比值 ${s.midSideRatio.toFixed(1)}dB。`);
    }
  } else { lines.push(`此文件为单声道。`); }
  const diagnostics = diagnoseRootCause(analysis, formatInfo);
  if (diagnostics.length > 0) {
    lines.push(`<div style="margin-top:14px;padding:10px 14px;background:#0a1925;border-radius:6px;border-left:3px solid var(--ac)"><b style="color:var(--ac);font-size:.82rem">🔍 根因推断</b></div>`);
    for (const d of diagnostics) {
      const sevColor = d.severity === 'good' ? 'var(--gr)' : d.severity === 'bad' ? 'var(--re)' : d.severity === 'warn' ? 'var(--ye)' : 'var(--ac)';
      lines.push(`<p style="margin:6px 0;line-height:1.7"><span style="color:${sevColor};font-weight:600">${d.title}</span><br><span style="font-size:.78rem;color:var(--fg2)">${d.detail}</span></p>`);
    }
  }
  const filteredQ = analysis.quality.filter(([d]) => !['格式','位深度','响度','LRA','TP过载','DC Offset'].includes(d));
  const failCount = filteredQ.filter(([,r]) => r === 'fail').length;
  const warnCount = filteredQ.filter(([,r]) => r === 'warn').length;
  let verdict = '';
  if (A.isCommercialMaster) { verdict = `<span class="good">✅ 综合评估：检测到商业母带特征。削波和动态压缩是母带环节的常见处理，非文件缺陷。此音频质量正常。</span>`; }
  else if (failCount === 0 && warnCount === 0) { verdict = `<span class="good">✅ 综合评估：各项技术指标良好，无明显问题。</span>`; }
  else if (failCount === 0) { verdict = `<span class="good">✅ 综合评估：整体表现良好。有 ${warnCount} 项提示信息，不影响正常使用。</span>`; }
  else if (failCount <= 2 && !A.clip.hasClipping) { verdict = `<span class="warn">⚠ 综合评估：检测到 ${failCount} 项异常，建议了解原因。如用于正式发布或存档，建议检查原始录音链路或母带处理流程。</span>`; }
  else { verdict = `<span class="bad">❌ 综合评估：存在 ${failCount} 项问题。如果这是商业发行文件，这些"问题"大概率是母带风格所致，属于行业惯例。如果是自行录制的文件，建议排查录音链路。</span>`; }
  lines.push(verdict);
  return lines.map(l => `<p style="margin:6px 0;line-height:1.8">${l}</p>`).join('');
}

function narrateSpectrum(analysis) {
  const A = analysis;
  const { freqs, spectrum } = A;
  const sr = A.sampleRate;
  const lines = [], half = freqs.length;
  if (!half) return '';
  let loEnergy = 0, midEnergy = 0, hiEnergy = 0, ultraEnergy = 0;
  let loCount = 0, midCount = 0, hiCount = 0, ultraCount = 0;
  let peakFreq = 0, peakDB = -200;
  for (let i = 0; i < half; i++) {
    const f = freqs[i], db = spectrum[i];
    if (f <= 250) { loEnergy += db; loCount++; }
    else if (f <= 2000) { midEnergy += db; midCount++; }
    else if (f <= 8000) { hiEnergy += db; hiCount++; }
    else { ultraEnergy += db; ultraCount++; }
    if (db > peakDB) { peakDB = db; peakFreq = f; }
  }
  loEnergy /= loCount; midEnergy /= midCount; hiEnergy /= hiCount; ultraEnergy /= ultraCount;
  const peakDesc = peakFreq < 150 ? '重低音区（鼓、贝斯）' : peakFreq < 500 ? '低音区（吉他低音弦、大提琴）' : peakFreq < 3000 ? '中音区（人声、钢琴、主要乐器）' : '高音区（镲片、弦乐泛音）';
  let simple = `最强能量在 <b>${peakFreq < 1000 ? peakFreq.toFixed(0) + 'Hz' : (peakFreq/1000).toFixed(1) + 'kHz'}</b>（${peakDesc}）。`;
  const balance = loEnergy - midEnergy;
  if (balance > 12) simple += ' 低音很重，听起来"轰头"、有冲击力；适合电子/嘻哈，听人声歌曲可能会觉得闷。';
  else if (balance > 5) simple += ' 低音偏暖，鼓点有力度但不至于过重，听感比较舒服。';
  else if (balance < -8) simple += ' 低音偏少，听起来会比较"清淡"，缺少重量感。';
  else simple += ' 低音和中音搭配得刚刚好，不闷也不薄。';
  const hiBalance = hiEnergy - ultraEnergy;
  if (hiBalance > 15) simple += ' 高音很亮（细节多），但听久了可能会累耳朵。';
  else if (hiBalance < -5) simple += ' 高音自然衰减，听久了也不会刺耳。';
  else simple += ' 高音适中，清晰不刺耳。';
  const cf = A.cutoff;
  if (cf.bw < 80 && sr > 48000 && cf.confidence === 'high') { simple += ` ⚠️ 频谱在 ${(cf.freq/1000).toFixed(1)}kHz 就断掉了，可能不是真正的 ${(sr/1000).toFixed(0)}kHz 高解析度。`; }
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  lines.push(`峰值 ${peakDB.toFixed(1)}dB @ ${peakFreq < 1000 ? peakFreq.toFixed(0) + 'Hz' : (peakFreq/1000).toFixed(1) + 'kHz'} | 低频 ${loEnergy.toFixed(1)}dB | 中频 ${midEnergy.toFixed(1)}dB | 高频 ${hiEnergy.toFixed(1)}dB | 极高频 ${ultraEnergy.toFixed(1)}dB`);
  lines.push(`截止频率 ${(cf.freq/1000).toFixed(1)}kHz，带宽利用率 ${cf.bw.toFixed(0)}%`);
  if (cf.bw < 80 && sr > 48000 && cf.confidence === 'high') { lines.push(`<span class="bad">与 ${(sr/1000).toFixed(0)}kHz 采样率不匹配，可能升频</span>`); }
  lines.push(`</div>`);
  return lines.map(l => `<p style="margin:4px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateSpectrogram(analysis) {
  const A = analysis;
  if (!A.spectrogram) return '';
  const sr = A.sampleRate;
  const lines = [];
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">左边是开始，右边是结束。颜色越亮=声音越大。横条纹=持续的声音（弦乐长音），竖条纹=突然的打击声（鼓点）。${sr >= 96000 ? '顶部超声波区域人耳听不到，对实际听感没影响。' : ''}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">FFT 频谱随时间分布 | ${(sr/1000).toFixed(0)}kHz 采样率${sr >= 96000 ? '，可显示 20kHz+ 超声频段但无听感贡献' : ''}</div>`);
  return lines.map(l => `<p style="margin:4px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateBandSpectrum(analysis) {
  const A = analysis;
  const bs = A.bandSpectrum;
  if (!bs || !bs.values) return '';
  const lines = [];
  const vals = bs.values;
  let lowSum = 0, midSum = 0, highSum = 0;
  let lowN = 0, midN = 0, highN = 0;
  const n = vals.length;
  for (let i = 0; i < n; i++) {
    const f = bs.freqs[i];
    if (f < 250) { lowSum += vals[i]; lowN++; }
    else if (f < 2000) { midSum += vals[i]; midN++; }
    else { highSum += vals[i]; highN++; }
  }
  const lowAvg = lowN > 0 ? lowSum / lowN : -120;
  const midAvg = midN > 0 ? midSum / midN : -120;
  const highAvg = highN > 0 ? highSum / highN : -120;
  const lowDesc = lowAvg > -6 ? '低音充足饱满，底鼓和贝斯很有力' : lowAvg > -20 ? '低音适中' : '低音偏少，听起来比较清淡';
  const midDesc = midAvg > -3 ? '中音突出，人声和乐器靠前' : midAvg > -15 ? '中音自然均衡' : '中音偏弱';
  const hiDesc = highAvg > -3 ? '高音很亮，细节多但可能刺耳' : highAvg > -18 ? '高音自然舒适' : '高音偏暗，缺少细节';
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">🎚️ 三频解读：</div><span style="font-size:.82rem">${lowDesc} | ${midDesc} | ${hiDesc}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  const loMidDiff = lowAvg - midAvg;
  if (Math.abs(loMidDiff) < 5) lines.push(`低中频均衡（差 ${loMidDiff.toFixed(1)}dB）`);
  else if (loMidDiff > 0) lines.push(`低频比中频高 ${loMidDiff.toFixed(1)}dB`);
  else lines.push(`中频比低频高 ${(-loMidDiff).toFixed(1)}dB`);
  lines.push(`低频 ${lowAvg.toFixed(1)}dB | 中频 ${midAvg.toFixed(1)}dB | 高频 ${highAvg.toFixed(1)}dB</div>`);
  return lines.map(l => `<p style="margin:4px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateWaveform(analysis) {
  const A = analysis;
  const lines = [];
  const crest = A.dynamics.crest;
  let simple = '';
  if (crest >= 14) simple = '✅ 波形起伏很大，安静和激昂的段落对比明显。这是动态大、有呼吸感的录音，常见于古典乐、爵士乐。';
  else if (crest >= 10) simple = '✅ 波形有适度的高低变化，听起来自然不做作。现代摇滚/独立音乐常见。';
  else if (crest >= 7) simple = '💡 波形大部分时间都很满 — 这是现代流行乐的常见处理方式，像把声音"压扁"了，始终维持在较响的水平。不是问题，是风格选择。';
  else simple = '💡 波形几乎全程贴顶 — 声音被压得很紧，从头响到尾。EDM、嘻哈、金属里很常见，追求的是冲击力而非层次感。';
  if (A.clip.hasClipping) simple += ' ⚠️ 检测到"削波"（波形顶部被切平），就像音量开太大导致的声音变形。';
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  if (crest >= 14) lines.push(`Crest Factor <span class="good">${crest.toFixed(1)}dB</span>，动态范围大。`);
  else if (crest >= 10) lines.push(`Crest Factor <span class="good">${crest.toFixed(1)}dB</span>，动态范围合理。`);
  else if (crest >= 7) lines.push(`Crest Factor <span class="warn">${crest.toFixed(1)}dB</span>，动态偏窄，流行乐典型值。`);
  else lines.push(`Crest Factor <span class="warn">${crest.toFixed(1)}dB</span>，动态被高度压缩。`);
  if (A.clip.hasClipping) lines.push(`削波 ${A.clip.clippedSamples} 点（${A.clip.clippedPct.toFixed(3)}%）Brickwall Limiting。`);
  lines.push(`</div>`);
  return lines.map(l => `<p style="margin:4px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateDynamics(analysis) {
  const A = analysis;
  const d = A.dynamics;
  const l = A.loudness;
  const c = A.clip;
  const lines = [];
  const crest = d.crest;
  let simple = '';
  if (A.isCommercialMaster) simple = '💡 这是商业母带的典型动态范围，"声音被压扁了"从开头响到结尾，不是质量问题。';
  else if (crest >= 14) simple = '✅ 动态很好，音乐有"呼吸感"，安静和激昂对比明显。';
  else if (crest >= 11) simple = '✅ 动态不错，强弱对比清晰。';
  else if (crest >= 8) simple = '💡 动态被适度压缩，现代流行乐的常见处理。';
  else simple = '💡 动态被高度压缩，EDM/嘻哈/金属的风格特征。';
  const lufs = l.integratedLoudnessLUFS;
  if (lufs > -11) simple += ` 整体很响（${lufs.toFixed(0)} LUFS），Spotify/Apple Music 会自动拉回统一音量。`;
  else if (lufs > -18) simple += ` 响度适中（${lufs.toFixed(0)} LUFS），不会被压音量。`;
  else simple += ` 偏安静（${lufs.toFixed(0)} LUFS），有余量。`;
  if (c.hasClipping) simple += ' ⚠️ 有削波。';
  if (A.dcOffset.isSignificant) simple += ' ⚠️ 有直流偏移。';
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  lines.push(`Crest Factor ${crest.toFixed(1)}dB | 综合响度 ${lufs.toFixed(1)} LUFS | LRA ${l.lra.toFixed(1)} LU`);
  if (c.hasClipping) lines.push(`削波 ${c.clippedSamples}点（${c.clippedPct.toFixed(3)}%），峰值 ${c.peakDB.toFixed(2)}dBFS${c.hasTruePeakOver ? '，TP过载' : ''}`);
  if (A.dcOffset.isSignificant) lines.push(`直流偏移 ${(A.dcOffset.offset*100).toFixed(3)}%`);
  lines.push(`</div>`);
  return lines.map(l => `<p style="margin:5px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateStereo(analysis) {
  const A = analysis;
  if (!A.stereo) return '<p>此音频为单声道，不包含立体声信息。</p>';
  const s = A.stereo;
  const lines = [];
  let simple = '';
  if (s.isOutOfPhase) { simple = '⚠️ 左右声道反相！用手机或单声道音箱听时，人声可能变弱甚至消失。检查接线是不是反了。'; }
  else if (s.correlation > 0.95) { simple = '💡 左右声道几乎一模一样，声场很窄，听起来像单声道，乐器都挤在中间。'; }
  else if (s.correlation > 0.7) { simple = '✅ 左右声道有差异但协调，正常的立体声效果，乐器在左右两侧有分布。'; }
  else { simple = '🎧 声道差异较大，声场很宽阔，乐器分得很开。'; }
  const wDesc = s.stereoWidth > 80 ? '声场极宽（可能用了极端加宽效果器）' : s.stereoWidth > 60 ? '声场开阔' : s.stereoWidth > 30 ? '宽度自然舒适' : '偏窄接近单声道';
  simple += ` 立体声宽度：${wDesc}（${s.stereoWidth.toFixed(0)}%）。`;
  if (s.phaseInversionPct > 5) simple += ` 约 ${s.phaseInversionPct.toFixed(0)}% 的信号反相。`;
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  lines.push(`相关性 ${s.correlation.toFixed(3)} | 宽度 ${s.stereoWidth.toFixed(0)}% | Mid/Side ${s.midSideRatio.toFixed(1)}dB`);
  if (s.phaseInversionPct > 5) lines.push(`反相比例 ${s.phaseInversionPct.toFixed(1)}%`);
  lines.push(`</div>`);
  return lines.map(l => `<p style="margin:5px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateQuality(analysis, formatInfo) {
  const Q = analysis.quality;
  const failItems = Q.filter(([,r]) => r === 'fail');
  const warnItems = Q.filter(([,r]) => r === 'warn');
  const hintItems = Q.filter(([,r]) => r === 'hint');
  const A = analysis;
  const lines = [];
  if (failItems.length === 0 && warnItems.length === 0) {
    if (A.isCommercialMaster) { lines.push(`<span class="good">✅ 此音频检测到商业母带特征（削波+压缩），已自动标注为"提示"而非"失败"。这是 Apple Music / Spotify 等流媒体平台的标准母带处理，不影响音频品质。</span>`); }
    else { lines.push(`<span class="good">✅ 完美通过所有检测项，此音频在技术指标上无瑕疵。</span>`); }
    return lines.map(l => `<p style="margin:5px 0;line-height:1.7">${l}</p>`).join('');
  }
  for (const [dim, rating, detail] of failItems) {
    lines.push(`<span class="bad"><b>${dim}</b>：${detail}。${dim === '削波' ? '削波表示母带限幅阶段的增益过高，波形被硬性切平——这在流行/摇滚/Hip-Hop 的商业发行中极为常见，是母带工程师在响度与动态之间的取舍。' : dim === '立体声' ? '反相会导致单声道回放时声音空洞。检查录音或混音阶段是否有极性反转。' : dim === '动态' ? '动态被高度压缩，整曲持续处于高能量状态。这是母带环节的刻意选择：牺牲动态层次换取一致的感知响度和冲击力，在 EDM、嘻哈、金属等风格中属于标准操作。' : ''}</span>`);
  }
  for (const [dim, rating, detail] of hintItems.filter(([d]) => d === '削波' || d === '动态')) {
    if (A.isCommercialMaster) { lines.push(`<span class="hint"><b>${dim}</b>：${detail}。经检测此音频为商业母带，削波和动态压缩是母带工程师的刻意处理，属于行业惯例而非质量问题。</span>`); }
  }
  if (failItems.length === 1 && failItems[0][0] === '削波' && warnItems.length === 0) { lines.push(`<span class="hint">整体质量尚可，仅削波一项失败。这在商业发行音乐中极为常见，不代表文件损坏。</span>`); }
  const diagnostics = diagnoseRootCause(analysis, formatInfo).filter(d => d.severity !== 'info');
  if (diagnostics.length > 0) {
    lines.push(`<div style="margin-top:12px;padding:8px 12px;background:#0a1925;border-radius:6px;border-left:3px solid var(--ac);font-size:.8rem"><b style="color:var(--ac)">🔍 根因推断</b></div>`);
    for (const d of diagnostics) {
      const sevColor = d.severity === 'good' ? 'var(--gr)' : d.severity === 'bad' ? 'var(--re)' : d.severity === 'warn' ? 'var(--ye)' : 'var(--ac)';
      lines.push(`<p style="margin:5px 0;line-height:1.6"><span style="color:${sevColor};font-weight:600">${d.title}</span><br><span style="font-size:.75rem;color:var(--fg2)">${d.detail}</span></p>`);
    }
  }
  return lines.map(l => `<p style="margin:5px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateFileInfo(formatInfo, analysis) {
  const F = formatInfo;
  const A = analysis;
  const lines = [];
  if (F.lossless) {
    const br = F.actualBitrate / 1000;
    lines.push(`<span class="good">无损 ${F.codec || '音频'}</span> — 数据完整保留，${F.fileExt.toUpperCase()} 容器。码率约 <b>${br.toFixed(0)}kbps</b>（${br > 2000 ? '高码率，说明音频内容复杂或采样率/位深度高' : br > 800 ? '中等码率，典型的 CD 品质无损' : '低码率，可能为单声道或低采样率'}）。`);
  } else {
    const br = F.actualBitrate / 1000;
    lines.push(`<span class="warn">有损 ${F.codec || '编码'}</span> — 码率约 <b>${br.toFixed(0)}kbps</b>。${br > 256 ? '码率充足，在大多数设备上与无损难以区分' : br > 128 ? '中等码率，高频细节有轻微损失' : '<span class="bad">低码率，高频损失明显，可能出现金属音或水声伪影</span>'}。`);
  }
  const bd = A.actualBitDepth;
  if (bd.estimated >= 20) { lines.push(`<b>位深度 ${bd.estimated}-bit</b> — <span class="good">高精度，动态余量充足</span>（${bd.note}）。`); }
  else if (bd.estimated >= 16) { lines.push(`<b>位深度 ${bd.estimated}-bit</b> — CD 标准精度。`); }
  else { lines.push(`<b>位深度 ${bd.estimated}-bit</b> — <span class="warn">精度较低</span>。`); }
  const cf = A.cutoff;
  lines.push(`<b>截止频率 ${(cf.freq/1000).toFixed(1)}kHz</b> — ${cf.freq > F.sampleRate * 0.45 && cf.bw > 95 ? '<span class="good">频率响应完整</span>' : cf.bw < 85 && F.sampleRate > 48000 ? '<span class="bad">频率响应受限，高概率为升频文件</span>' : '<span class="hint">频率响应有衰减</span>'}。`);
  return lines.map(l => `<p style="margin:5px 0;line-height:1.7">${l}</p>`).join('');
}

function narrateLoudnessCurve(analysis) {
  const l = analysis.loudness;
  if (!l || !l.stLUFSvalues || l.stLUFSvalues.length < 2) { return `<p style="margin:5px 0">响度数据不足，无法生成曲线。文件可能太短。</p>`; }
  const lines = [];
  let imin = 0, imax = 0;
  for (let i = 0; i < l.stLUFSvalues.length; i++) {
    if (l.stLUFSvalues[i] < l.stLUFSvalues[imin]) imin = i;
    if (l.stLUFSvalues[i] > l.stLUFSvalues[imax]) imax = i;
  }
  const tStep = l.stTimeStep || 0.1;
  const spread = l.stLUFSvalues[imax] - l.stLUFSvalues[imin];
  let simple = `这条线展示了歌曲从头到尾的响度变化。线越高=越响。共 ${l.stLUFSvalues.length} 个采样点。`;
  if (spread > 15) simple += ' ✅ 响度起伏很大，有显著的安静和激昂段落。';
  else if (spread > 8) simple += ' ✅ 响度起伏适中，有一定强弱对比。';
  else simple += ' 💡 响度起伏很小，整首歌从头响到尾，几乎没有安静段落。';
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  const tMin = imin * tStep, tMax = imax * tStep;
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  lines.push(`${l.stLUFSvalues.length} 采样点（3s 窗口 / 100ms 步进）| 最安静 ${l.stLUFSvalues[imin].toFixed(1)} LUFS @ ${fmtDur(tMin)} | 最响 ${l.stLUFSvalues[imax].toFixed(1)} LUFS @ ${fmtDur(tMax)}`);
  lines.push(`响度起伏 ${spread.toFixed(1)} LU</div>`);
  return lines.map(ln => `<p style="margin:5px 0;line-height:1.7">${ln}</p>`).join('');
}

function drawSpectrumCanvas() {
  const canvas = $('#spectrumCanvas'); if (!canvas) return;
  const A = STATE.analysis;
  const { freqs, spectrum } = A;
  const sr = A.sampleRate;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(getCW(canvas), 300), H = 300;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(48,54,61,0.4)'; ctx.lineWidth = 0.5;
  for (let db = -120; db <= 0; db += 20) {
    const y = H - ((-db) / 120 * H * 0.88) - H * 0.06;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  const maxKhz = sr / 2000;
  for (let khz = 0; khz <= maxKhz; khz += Math.ceil(maxKhz / 10)) {
    const x = (khz / maxKhz) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  const x8 = (8 / maxKhz) * W, x16 = (16 / maxKhz) * W;
  ctx.fillStyle = 'rgba(63,185,80,.04)'; ctx.fillRect(0, 0, Math.min(x8, W), H);
  ctx.fillStyle = 'rgba(210,153,34,.04)'; ctx.fillRect(Math.min(x8, W), 0, Math.max(0, Math.min(x16, W) - x8), H);
  ctx.fillStyle = 'rgba(248,81,73,.04)'; ctx.fillRect(Math.min(x16, W), 0, Math.max(0, W - x16), H);
  ctx.beginPath();
  const maxIdx = Math.min(freqs.length - 1, Math.floor(freqs.length * maxKhz / (freqs[freqs.length - 1] || 1)));
  for (let i = 0; i <= maxIdx; i++) {
    const x = (freqs[i] / maxKhz) * W;
    const db = Math.max(-120, spectrum[i]);
    const y = H - ((db + 120) / 120 * H * 0.88) - H * 0.06;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#58a6ff'; ctx.lineWidth = 1.2; ctx.stroke();
  // 诊断：检查 spectrum 数据范围
  let specMin = Infinity, specMax = -Infinity;
  for (let i = 0; i <= maxIdx; i++) { const v = spectrum[i]; if (v < specMin) specMin = v; if (v > specMax) specMax = v; }
  D.ok('CANVAS', `spectrum range: ${specMin.toFixed(1)} ~ ${specMax.toFixed(1)} dB, ${maxIdx+1} bins, W=${W}, maxKhz=${maxKhz.toFixed(1)}`);
  ctx.lineTo((freqs[maxIdx] / maxKhz) * W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = 'rgba(88,166,255,.06)'; ctx.fill();
  ctx.fillStyle = '#6e7681'; ctx.font = '9px -apple-system,"Microsoft YaHei",sans-serif';
  for (let khz = 0; khz <= maxKhz; khz += Math.ceil(maxKhz / 8)) { ctx.fillText(khz.toFixed(0) + 'k', (khz / maxKhz) * W + 3, H - 4); }
  for (let db = -120; db <= 0; db += 20) {
    const y = H - ((-db) / 120 * H * 0.88) - H * 0.06;
    ctx.fillText(db + ' dB', 4, y - 4);
  }
}

function drawSpectrogramCanvas() {
  const canvas = $('#specCanvas'); if (!canvas) return;
  const sg = STATE.analysis.spectrogram;
  if (!sg || !sg.data || sg.data.length === 0) return;
  const { fAxis, tAxis, data } = sg;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(getCW(canvas), 300), H = 480;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  const bw = canvas.width, bh = canvas.height;
  const cols = data.length, rows = fAxis.length;
  D.ok('CANVAS', `spectrogram: ${cols}cols x ${rows}rows, tAxis=${tAxis.length}, fAxis[last]=${fAxis[rows-1]?.toFixed(0)}Hz, W=${W}, H=${H}`);
  const imgData = ctx.createImageData(bw, bh);
  const raw = imgData.data;
  const maxFreqIdx = Math.min(rows - 1, Math.floor(rows * Math.min(STATE.sampleRate / 2, 24000) / (fAxis[rows - 1] || 1)));
  const allVals = [];
  for (let c = 0; c < cols; c++) { const row = data[c]; for (let r = 0; r < rows; r++) allVals.push(row[r]); }
  allVals.sort((a, b) => a - b);
  const vMin = allVals[Math.floor(allVals.length * .1)];
  const vMax = allVals[Math.floor(allVals.length * .95)];
  const range = Math.max(1e-12, vMax / vMin);
  const logRange = Math.log(range);
  for (let px = 0; px < bw; px++) {
    const ci = Math.floor(px / bw * cols);
    for (let py = 0; py < bh; py++) {
      const ri = rows - 1 - Math.floor(py / bh * maxFreqIdx);
      const val = data[Math.min(ci, cols - 1)][Math.max(0, Math.min(ri, rows - 1))];
      const t = Math.max(0, Math.min(1, Math.log(Math.max(val, 1e-12) / vMin) / logRange));
      const [r, g, b] = magma(t);
      const idx = (py * bw + px) * 4;
      raw[idx] = r; raw[idx + 1] = g; raw[idx + 2] = b; raw[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#6e7681'; ctx.font = '9px -apple-system,"Microsoft YaHei",sans-serif';
  const mpf = Math.min(STATE.sampleRate / 2000, 24);
  for (let khz = 0; khz <= mpf; khz += Math.ceil(mpf / 6)) { ctx.fillText(khz + 'k', 4, H - (khz / mpf * H) - 2); }
  const maxT = tAxis[tAxis.length - 1];
  for (let t = 0; t <= maxT; t += Math.ceil(maxT / 8)) { ctx.fillText(t.toFixed(0) + 's', t / maxT * W + 2, H - 4); }
}

function drawSoundSpectrumCanvas() {
  const canvas = $('#bandCanvas'); if (!canvas) return;
  const bs = STATE.analysis.bandSpectrum;
  if (!bs || !bs.values || bs.values.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(getCW(canvas), 300), H = 280;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(48,54,61,0.3)'; ctx.lineWidth = 0.5;
  for (let db = -120; db <= 0; db += 20) {
    const y = H - ((-db) / 120 * (H - 30)) - 15;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = '#6e7681'; ctx.font = '8px -apple-system,"Microsoft YaHei",sans-serif';
    ctx.fillText(db + 'dB', 4, y - 2);
  }
  const vals = bs.values;
  const n = vals.length;
  const barGap = W * 0.02;
  const barW = (W - barGap * (n + 1)) / n;
  const peakDB = bs.peakDB;
  const minDB = Math.max(-120, peakDB - 60);
  const dbRange = peakDB - minDB || 1;
  for (let i = 0; i < n; i++) {
    const db = Math.max(minDB, vals[i]);
    const t = (db - minDB) / dbRange;
    const h = t * (H - 35);
    const x = barGap + i * (barW + barGap);
    const y = H - 15 - h;
    const hue = 240 - (i / n) * 240;
    const sat = 70 + t * 30;
    const light = 30 + t * 40;
    ctx.fillStyle = `hsl(${hue},${sat}%,${light}%)`;
    const r = Math.min(3, barW / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, H - 15);
    ctx.lineTo(x, H - 15);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
  }
  ctx.fillStyle = '#6e7681'; ctx.font = '8px -apple-system,"Microsoft YaHei",sans-serif';
  const labelIdx = [0, Math.floor(n/4), Math.floor(n/2), Math.floor(3*n/4), n-1];
  for (const idx of labelIdx) { const lx = barGap + idx * (barW + barGap) + barW / 2; ctx.fillText(bs.labels[idx], lx - 12, H - 1); }
}

function drawWaveformCanvas() {
  const canvas = $('#waveCanvas'); if (!canvas) return;
  const wf = STATE.analysis.waveform;
  if (!wf || wf.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(getCW(canvas), 300), H = 180;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
  const mid = H / 2;
  ctx.strokeStyle = 'rgba(48,54,61,0.4)'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
  ctx.fillStyle = 'rgba(88,166,255,.5)';
  const barW = W / wf.length;
  D.ok('CANVAS', `waveform: ${wf.length}pts, peak=${wf.length>0?Math.max(...wf).toFixed(3):'0'}, barW=${barW.toFixed(2)}, W=${W}`);
  for (let i = 0; i < wf.length; i++) {
    const h = wf[i] * mid * 0.9;
    ctx.fillRect(i * barW, mid - h, Math.max(0.5, barW * 0.85), h * 2);
  }
  ctx.fillStyle = '#6e7681'; ctx.font = '9px -apple-system,"Microsoft YaHei",sans-serif';
  ctx.fillText('0:00', 4, H - 4);
  ctx.fillText(fmtDur(STATE.duration), W - 40, H - 4);
}

function drawPhaseCanvas() {
  const canvas = $('#phaseCanvas'); if (!canvas || !STATE.analysis.phaseData) return;
  const pts = STATE.analysis.phaseData;
  const dpr = window.devicePixelRatio || 1;
  const S = Math.min(Math.max(getCW(canvas, 280), 200), 280);
  canvas.width = S * dpr; canvas.height = S * dpr;
  canvas.style.width = S + 'px'; canvas.style.height = S + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(48,54,61,0.5)'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(S, S); ctx.stroke();
  const half = S / 2;
  ctx.fillStyle = 'rgba(57,210,192,.4)';
  for (const { x, y } of pts) { ctx.fillRect(half + x * half * 0.9, half - y * half * 0.9, 1.2, 1.2); }
}

function drawLoudnessCurveCanvas() {
  const canvas = $('#loudnessCurveCanvas'); if (!canvas || !STATE.analysis.loudness || !STATE.analysis.loudness.stLUFSvalues) return;
  const dpr = window.devicePixelRatio || 1;
  const W = getCW(canvas, 700);
  const H = Math.min(Math.max(getCW(canvas, 240), 180), 280);
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
  const vals = STATE.analysis.loudness.stLUFSvalues;
  if (vals.length < 2) { D.err('CANVAS', `loudnesscurve: stLUFSvalues too short (${vals.length})`); return; }
  D.ok('CANVAS', `loudnesscurve: ${vals.length}pts, range=[${vals.length>0?Math.min(...vals).toFixed(1):'?'}..${vals.length>0?Math.max(...vals).toFixed(1):'?'}], W=${W}, H=${H}`);
  ctx.strokeStyle = 'rgba(48,54,61,0.4)'; ctx.lineWidth = 0.5;
  const margin = { top: 20, right: 30, bottom: 28, left: 42 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;
  let vMin = Infinity, vMax = -Infinity;
  for (const v of vals) { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
  if (!isFinite(vMin)) vMin = -20; if (!isFinite(vMax)) vMax = -6;
  const range = Math.max(vMax - vMin, 10);
  vMin = Math.floor(vMin - range * 0.1);
  vMax = Math.ceil(vMax + range * 0.1);
  const tSpan = vMax - vMin;
  const gridStep = tSpan > 30 ? 10 : (tSpan > 15 ? 5 : (tSpan > 8 ? 2 : 1));
  ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let lu = Math.ceil(vMin / gridStep) * gridStep; lu <= vMax; lu += gridStep) {
    const y = margin.top + ph * (1 - (lu - vMin) / tSpan);
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(W - margin.right, y); ctx.stroke();
    ctx.fillText(lu.toFixed(0), margin.left - 5, y + 4);
  }
  const dur = STATE.analysis.duration || (vals.length * (STATE.analysis.loudness.stTimeStep || 0.1));
  ctx.textAlign = 'center'; ctx.fillStyle = '#8b949e';
  const tSteps = dur > 600 ? 5 : (dur > 300 ? 4 : (dur > 120 ? 3 : 2));
  for (let i = 0; i <= tSteps; i++) {
    const tick = i / tSteps;
    const x = margin.left + pw * tick;
    ctx.beginPath(); ctx.moveTo(x, margin.top); ctx.lineTo(x, H - margin.bottom); ctx.stroke();
    const sec = dur * tick;
    ctx.fillText(sec < 60 ? Math.round(sec) + 's' : Math.floor(sec / 60) + 'm' + Math.round(sec % 60) + 's', x, H - 4);
  }
  ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('LUFS', 0, 0); ctx.restore();
  ctx.setLineDash([4, 4]);
  if (-23 >= vMin && -23 <= vMax) {
    const y23 = margin.top + ph * (1 - (-23 - vMin) / tSpan);
    ctx.strokeStyle = 'rgba(57,210,192,.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(margin.left, y23); ctx.lineTo(W - margin.right, y23); ctx.stroke();
    ctx.fillStyle = '#39d2c0'; ctx.textAlign = 'left'; ctx.fillText('-23 广播参考', margin.left + 4, y23 - 4);
  }
  if (-14 >= vMin && -14 <= vMax) {
    const y14 = margin.top + ph * (1 - (-14 - vMin) / tSpan);
    ctx.strokeStyle = 'rgba(210,153,34,.4)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(margin.left, y14); ctx.lineTo(W - margin.right, y14); ctx.stroke();
    ctx.fillStyle = '#d29922'; ctx.fillText('-14 流媒体典型', margin.left + 4, y14 - 4);
  }
  ctx.setLineDash([]);
  const gradient = ctx.createLinearGradient(0, margin.top, 0, H - margin.bottom);
  gradient.addColorStop(0, 'rgba(255,130,80,0.35)');
  gradient.addColorStop(0.5, 'rgba(88,166,255,0.2)');
  gradient.addColorStop(1, 'rgba(57,210,192,0.05)');
  ctx.beginPath();
  const x0 = margin.left, y0 = margin.top + ph * (1 - (vals[0] - vMin) / tSpan);
  ctx.moveTo(x0, y0);
  for (let i = 0; i < vals.length; i++) {
    const x = margin.left + pw * (i / (vals.length - 1));
    const y = margin.top + ph * (1 - (Math.max(vMin, Math.min(vMax, vals[i])) - vMin) / tSpan);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(margin.left + pw, H - margin.bottom);
  ctx.lineTo(margin.left, H - margin.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 0; i < vals.length; i++) {
    const x = margin.left + pw * (i / (vals.length - 1));
    const y = margin.top + ph * (1 - (Math.max(vMin, Math.min(vMax, vals[i])) - vMin) / tSpan);
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#ff8250'; ctx.lineWidth = 1.6; ctx.stroke();
}

function drawSNRCanvas() {
  const canvas = $('#snrCanvas');
  if (!canvas || !STATE.analysis.snr) return;
  const snr = STATE.analysis.snr;
  const dpr = window.devicePixelRatio || 1;
  const W = getCW(canvas, 560);
  const H = Math.min(Math.max(getCW(canvas, 240), 180), 280);
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
  if (snr.isEstimate || snr.noiseFloorDB === null) {
    ctx.fillStyle = '#8b949e'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('音频太短，无法计算 SNR', W / 2, H / 2);
    return;
  }
  const margin = { top: 20, right: 30, bottom: 50, left: 42 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;
  const bands = [
    { label: '低频\n20-250Hz', val: snr.snrLow, color: '#bc8cff' },
    { label: '中频\n250-4kHz', val: snr.snrMid, color: '#58a6ff' },
    { label: '高频\n4kHz+', val: snr.snrHigh, color: '#ff8250' },
    { label: '全频段', val: snr.snrDB, color: '#39d2c0' },
  ].filter(b => b.val !== null && b.val !== undefined);
  if (bands.length === 0) return;
  const maxVal = Math.max(...bands.map(b => b.val), 1);
  const gridMax = Math.ceil(maxVal / 10) * 10 || 20;
  ctx.strokeStyle = 'rgba(48,54,61,0.4)'; ctx.lineWidth = 0.5;
  ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let db = 0; db <= gridMax; db += gridMax > 50 ? 20 : (gridMax > 20 ? 10 : 5)) {
    const y = margin.top + ph * (1 - db / gridMax);
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(W - margin.right, y); ctx.stroke();
    ctx.fillText(db + ' dB', margin.left - 5, y + 4);
  }
  const bw = Math.min(pw / bands.length * 0.6, 80);
  const gap = (pw - bw * bands.length) / (bands.length + 1);
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const x = margin.left + gap + i * (bw + gap);
    const barH = ph * (b.val / gridMax);
    const y = margin.top + ph - barH;
    ctx.fillStyle = b.color;
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.arcTo(x + bw, y, x + bw, y + r, r);
    ctx.lineTo(x + bw, margin.top + ph);
    ctx.lineTo(x, margin.top + ph);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center'; ctx.font = '11px sans-serif';
    ctx.fillText(b.val.toFixed(1) + ' dB', x + bw / 2, y - 6);
    ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif';
    const lines = b.label.split('\n');
    lines.forEach((ln, li) => ctx.fillText(ln, x + bw / 2, margin.top + ph + 16 + li * 13));
  }
  ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('SNR (dB)', 0, 0); ctx.restore();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(248,81,73,.4)'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top + ph + 20); ctx.lineTo(W - margin.right, margin.top + ph + 20);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f85149'; ctx.textAlign = 'left'; ctx.font = '10px sans-serif';
  ctx.fillText(`噪底电平: ${snr.noiseFloorDB.toFixed(1)} dBFS`, margin.left + 4, margin.top + ph + 34);
}

function drawDistortionCanvas() {
  const canvas = $('#distortionCanvas');
  if (!canvas || !STATE.analysis.distortion) return;
  const d = STATE.analysis.distortion;
  const dpr = window.devicePixelRatio || 1;
  const W = getCW(canvas, 560);
  const H = Math.min(Math.max(getCW(canvas, 240), 180), 280);
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
  if (d.isEstimate || !d.harmonics || d.harmonics.length < 2) {
    ctx.fillStyle = '#8b949e'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('无法检测谐波结构', W / 2, H / 2);
    return;
  }
  const margin = { top: 20, right: 60, bottom: 50, left: 50 };
  const pw = W - margin.left - margin.right;
  const ph = H - margin.top - margin.bottom;
  const harmLabels = ['基频', 'H2', 'H3', 'H4', 'H5'];
  const harmColors = ['#58a6ff', '#bc8cff', '#ff8250', '#3fb950', '#d29922'];
  const harms = d.harmonics;
  const refDB = harms[0];
  const relDBs = harms.map(v => v - refDB);
  const gridMax = 0, gridMin = -80;
  const dbRange = gridMax - gridMin;
  ctx.strokeStyle = 'rgba(48,54,61,0.4)'; ctx.lineWidth = 0.5;
  ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let db = 0; db >= -80; db -= 10) {
    const y = margin.top + ph * (1 - (db - gridMin) / dbRange);
    ctx.beginPath(); ctx.moveTo(margin.left, y); ctx.lineTo(W - margin.right, y); ctx.stroke();
    ctx.fillText(db + ' dB', margin.left - 5, y + 4);
  }
  const barCount = harms.length;
  const bw2 = Math.min(pw / barCount * 0.55, 60);
  const gap2 = (pw - bw2 * barCount) / (barCount + 1);
  for (let i = 0; i < barCount; i++) {
    const db = relDBs[i];
    const barH = Math.max(2, ph * ((db - gridMin) / dbRange));
    const x = margin.left + gap2 + i * (bw2 + gap2);
    const y = margin.top + ph - barH;
    ctx.fillStyle = harmColors[i % harmColors.length];
    const r = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.arcTo(x + bw2, y, x + bw2, y + r, r);
    ctx.lineTo(x + bw2, margin.top + ph);
    ctx.lineTo(x, margin.top + ph);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center'; ctx.font = '10px sans-serif';
    ctx.fillText(db.toFixed(1) + ' dB', x + bw2 / 2, y - 5);
    ctx.fillStyle = '#8b949e';
    ctx.fillText(harmLabels[i] || `H${i+1}`, x + bw2 / 2, margin.top + ph + 16);
  }
  ctx.fillStyle = '#ff8250'; ctx.textAlign = 'right'; ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`THD: ${d.thdPct.toFixed(3)}%`, W - margin.right, margin.top + 12);
  ctx.save(); ctx.translate(14, H / 2); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.fillText('相对基频 (dB)', 0, 0); ctx.restore();
}

function magma(t) {
  const c = [[0.001,0.000,0.014],[0.016,0.009,0.084],[0.061,0.013,0.177],[0.118,0.011,0.269],[0.177,0.016,0.347],[0.236,0.024,0.388],[0.292,0.039,0.399],[0.345,0.063,0.393],[0.397,0.089,0.389],[0.447,0.116,0.385],[0.496,0.142,0.384],[0.544,0.169,0.384],[0.592,0.196,0.386],[0.639,0.223,0.389],[0.686,0.251,0.394],[0.732,0.278,0.401],[0.778,0.307,0.409],[0.824,0.335,0.419],[0.869,0.364,0.430],[0.914,0.393,0.442],[0.959,0.423,0.456],[0.992,0.460,0.479],[0.997,0.503,0.507],[0.998,0.547,0.536],[1.000,0.590,0.565],[1.000,0.634,0.595],[1.000,0.678,0.625],[1.000,0.723,0.656],[1.000,0.768,0.687],[1.000,0.813,0.719],[1.000,0.858,0.751],[1.000,0.904,0.784],[1.000,0.950,0.817],[1.000,0.997,0.850]];
  const idx = t * (c.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const f = idx - lo;
  return [Math.round((c[lo][0]*(1-f)+c[hi][0]*f)*255), Math.round((c[lo][1]*(1-f)+c[hi][1]*f)*255), Math.round((c[lo][2]*(1-f)+c[hi][2]*f)*255)];
}

// Navigation
$$('.nav-item').forEach(item => {
  item.addEventListener('click', function() {
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    this.classList.add('active');
    const sectionId = 'section-' + this.dataset.section;
    $$('.section').forEach(s => s.style.display = (s.id === sectionId) ? '' : 'none');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.dataset.section === 'spectrum') drawSpectrumCanvas();
        if (this.dataset.section === 'spectrogram') drawSpectrogramCanvas();
        if (this.dataset.section === 'soundspectrum') drawSoundSpectrumCanvas();
        if (this.dataset.section === 'waveform') drawWaveformCanvas();
        if (this.dataset.section === 'loudnesscurve') drawLoudnessCurveCanvas();
        if (this.dataset.section === 'snr') drawSNRCanvas();
        if (this.dataset.section === 'distortion') drawDistortionCanvas();
        if (this.dataset.section === 'stereo') drawPhaseCanvas();
      });
    });
  });
});

// Utility functions
function fmtSize(b) { return b < 1024 ? b + ' B' : (b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'); }
function fmtDur(s) { const m = Math.floor(s / 60); return s >= 3600 ? `${Math.floor(s/3600)}:${String(m%60).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}` : `${m}:${String(Math.floor(s%60)).padStart(2,'0')}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCW(canvas, fallback = 600) {
  const pw = canvas.parentElement?.clientWidth || 0;
  if (pw > 0) return pw;
  const rw = canvas.getBoundingClientRect().width;
  return rw > 0 ? rw : fallback;
}

function showLoading(show, text) {
  const overlay = $('#loadingOverlay');
  overlay.style.display = show ? 'flex' : 'none';
  if (text) $('#loadingText').textContent = text;
}

function updateProgress(pct) { $('#progressBar').style.width = pct + '%'; }

function setStatus(left, right, isError) {
  const el = $('#statusLeft');
  el.textContent = left;
  if (isError) el.style.color = 'var(--re)';
  else el.style.color = '';
  if (right) $('#statusRight').textContent = right;
}

function exportReport() {
  const F = STATE.formatInfo;
  const A = STATE.analysis;
  const lines = [
    '=== Audio Analyzer Pro v7.0 Report ===',
    `File: ${F.filename}`,
    `Size: ${fmtSize(F.fileSize)}`,
    `Format: ${F.codec} / ${F.container} ${F.lossless ? '(Lossless)' : '(Lossy)'}`,
    `Sample Rate: ${(F.sampleRate/1000).toFixed(1)} kHz`,
    `Channels: ${F.channels}`,
    `Duration: ${fmtDur(F.duration)}`,
    `Bitrate: ${(F.actualBitrate/1000).toFixed(1)} kbps`,
    `Actual Bit Depth: ${A.actualBitDepth.estimated}-bit (${A.actualBitDepth.note})`,
    '',
    '--- Quality Assessment ---',
    ...A.quality.map(([d, r, det]) => `[${r.toUpperCase()}] ${d}: ${det}`),
    '',
    '--- Dynamics ---',
    `Crest Factor: ${A.dynamics.crest.toFixed(1)} dB`,
    `Sample Peak: ${A.dynamics.peakDB.toFixed(2)} dBFS`,
    `True Peak (4x): ${typeof A.clip.truePeakDB === 'string' ? A.clip.truePeakDB : A.clip.truePeakDB + ' dBFS'}`,
    `RMS Level: ${A.dynamics.rmsDB.toFixed(2)} dBFS`,
    `Integrated LUFS (BS.1770): ${A.loudness.integratedLoudnessLUFS.toFixed(1)} LUFS`,
    `Short-term LUFS Max: ${A.loudness.shortTermMaxLUFS.toFixed(1)} LUFS`,
    `LRA (Loudness Range): ${A.loudness.lra.toFixed(1)} LU`,
    `Clipping: ${A.clip.hasClipping ? 'YES (' + A.clip.clippedSamples + ' samples, ' + A.clip.clippedPct.toFixed(3) + '%)' : 'No'}`,
    `True Peak Overload: ${A.clip.hasTruePeakOver ? 'YES' : 'No'}`,
    `DC Offset: ${A.dcOffset.isSignificant ? 'YES (' + (A.dcOffset.offset*100).toFixed(3) + '%)' : 'No'}`,
    `Cutoff Frequency: ${(A.cutoff.freq/1000).toFixed(1)} kHz (BW ${A.cutoff.bw.toFixed(0)}%, confidence: ${A.cutoff.confidence})`,
    '',
    ...(A.stereo ? [`Stereo Correlation: ${A.stereo.correlation.toFixed(4)}`, `Stereo Width: ${A.stereo.stereoWidth.toFixed(0)}%`, `Mid/Side Ratio: ${A.stereo.midSideRatio.toFixed(1)} dB`] : ['Audio: Mono']),
    '',
    'Generated by Audio Analyzer Pro v7.0',
    new Date().toISOString()
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (F.filename || 'audio') + '_report.txt';
  a.click(); URL.revokeObjectURL(url);
}

// FFmpeg fallback init
initFFmpegFallback().catch(() => {
  $('#statusRight').textContent = '通用解码引擎加载失败 — 部分格式可能无法分析';
});

function renderAll() {
  __TRACE.step('before render');
  const wrap = $('#results');
  wrap.innerHTML = '';
  const sections = [
    ['overview', renderOverview],
    ['spectrum', renderSpectrum],
    ['spectrogram', renderSpectrogramChart],
    ['soundspectrum', renderSoundSpectrum],
    ['waveform', renderWaveform],
    ['dynamics', renderDynamics],
    ['loudnesscurve', renderLoudnessCurve],
    ['snr', renderSNR],
    ['distortion', renderDistortion],
    ['stereo', renderStereo],
    ['quality', renderQuality],
    ['info', renderFileInfo],
  ];
  D.info('RENDER', `开始渲染 ${sections.length} 个 section, analysis keys: ${STATE.analysis?Object.keys(STATE.analysis).join(','):'NULL'}`);
  for (const [id, fn] of sections) {
    try {
      const div = document.createElement('div');
      div.className = 'section';
      div.id = 'section-' + id;
      div.innerHTML = fn();
      wrap.appendChild(div);
      D.info('RENDER', `section-${id} OK`);
    } catch(e) {
      D.err('RENDER', `section-${id} 渲染失败: ${e.message}`);
      const div = document.createElement('div');
      div.className = 'section';
      div.id = 'section-' + id;
      div.innerHTML = `<div class="card"><div class="card-header">${id}</div><div class="card-body" style="color:var(--re)">渲染错误: ${e.message}</div></div>`;
      wrap.appendChild(div);
    }
  }
  $$('.section').forEach(s => s.style.display = (s.id === 'section-overview') ? '' : 'none');
  $('#section-overview').style.display = '';
  // 更新静态叙事区域
  try {
    const nb = $('#narrativeBody');
    if (nb) nb.innerHTML = generateNarrative(STATE.analysis, STATE.formatInfo, STATE.channels || 0);
  } catch(e) { D.err('RENDER', `叙事渲染失败: ${e.message}`); }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const drawFns = [
        ['spectrum', drawSpectrumCanvas],
        ['spectrogram', drawSpectrogramCanvas],
        ['soundspectrum', drawSoundSpectrumCanvas],
        ['waveform', drawWaveformCanvas],
        ['phase', drawPhaseCanvas],
        ['loudnesscurve', drawLoudnessCurveCanvas],
        ['snr', drawSNRCanvas],
        ['distortion', drawDistortionCanvas],
      ];
      for (const [name, fn] of drawFns) {
        try { fn(); D.ok('CANVAS', `draw-${name} OK`); }
        catch(e) { D.err('CANVAS', `draw-${name} 失败: ${e.message}`); }
      }
    });
  });
}

function renderOverview() {
  const F = STATE.formatInfo;
  const A = STATE.analysis;
  const Q = A.quality.filter(([d]) => !['格式','位深度','响度','LRA','TP过载','DC Offset'].includes(d));
  const hid1 = 'help-分析总览';
  let html = '';
  html += `<div class="card" style="border-left:3px solid var(--ac)"><div class="card-header" style="color:var(--ac)">📋 智能解读</div><div class="card-body">`;
  html += generateNarrative(STATE.analysis, STATE.formatInfo, STATE.channels);
  html += `</div></div>`;
  html += `<div class="card"><div class="card-header">分析总览<button class="help-toggle" onclick="toggleHelp('${hid1}')" id="bt-${hid1}">? 解读</button></div><div class="card-body">`;
  html += `<div class="row-grid">`;
  html += row('文件', F.filename, true);
  html += row('时长', fmtDur(F.duration));
  html += row('格式', `${F.codec || '?'} / ${F.container || F.fileExt.toUpperCase()}`, false, F.lossless ? 'var(--gr)' : 'var(--ye)');
  html += row('采样率', `${(F.sampleRate/1000).toFixed(1)} kHz`);
  const chanLabel = F.channels === 1 ? '单声道' : F.channels === 2 ? '立体声' : `多声道 (${F.channels}ch)`;
  html += row('声道', chanLabel);
  html += row('文件大小', fmtSize(F.fileSize));
  html += row('码率', `${(F.actualBitrate/1000).toFixed(0)} kbps`);
  html += row('实测位深度', `${A.actualBitDepth.estimated}-bit (${A.actualBitDepth.note})`);
  html += row('峰值电平 (Sample)', `${A.clip.peakDB.toFixed(2)} dBFS`, false, A.clip.hasClipping ? 'var(--re)' : '');
  html += row('True Peak (4x)', `${A.clip.truePeakDB} dBFS`, false, A.clip.hasTruePeakOver ? 'var(--re)' : '');
  html += row('Crest Factor', `${A.dynamics.crest.toFixed(1)} dB`);
  html += row('Integrated LUFS', `${A.loudness.integratedLoudnessLUFS.toFixed(1)} LUFS`);
  html += row('Short-term LUFS Max', `${A.loudness.shortTermMaxLUFS.toFixed(1)} LUFS`);
  html += row('LRA (响度范围)', `${A.loudness.lra.toFixed(1)} LU`);
  html += row('DC Offset', `${A.dcOffset.isSignificant ? '⚠ ' + (A.dcOffset.offset*100).toFixed(3) + '%' : '正常 (' + A.dcOffset.dcDB.toFixed(1) + ' dB)'}`, false, A.dcOffset.isSignificant ? 'var(--ye)' : '');
  html += row('立体声宽度', A.stereo ? `${A.stereo.stereoWidth.toFixed(0)}%` : 'N/A (单声道)');
  html += `</div>`;
  html += `<div class="help-body" id="${hid1}"><dl>
    <dt>格式</dt><dd>编解码器 / 容器格式。<span class="good">ALAC / FLAC = 无损</span>，<span class="warn">AAC / MP3 = 有损</span>。M4A 即 MP4 音频容器，内部可能是 AAC 或 ALAC。</dd>
    <dt>采样率</dt><dd>44.1kHz = CD 音质，48kHz = 影视标准。高于 48kHz 的文件体积大、普通人难以分辨差异，但录音室常用 96kHz 母带。</dd>
    <dt>码率</dt><dd>有损格式的码率直接决定音质 — AAC 256kbps 已接近透明。无损格式码率可变，由原始信号复杂度决定。</dd>
    <dt>实测位深度</dt><dd>通过分析最低有效位的活跃度估算的实际精度。<span class="warn">16-bit 文件标为 24-bit</span> 说明高位填充了零。</dd>
    <dt>峰值电平 / True Peak</dt><dd>dBFS = 满刻度分贝，0 为最大值。<span class="bad">&gt;0 dBFS</span> = 削波。True Peak 考虑了采样点之间模拟重建的峰值，比 Sample Peak 更准确。</dd>
    <dt>Crest Factor</dt><dd>峰值与平均值的比值，体现音乐动态。数值越高，强弱对比越明显。流行乐 8-12dB，古典/爵士 ≥14dB。</dd>
    <dt>Integrated LUFS</dt><dd>国际标准响度单位。流媒体平台通常要求 -14 ~ -11 LUFS；广播标准 -23 LUFS。<span class="bad">＞-8 LUFS</span> = 过度压缩。</dd>
    <dt>LRA</dt><dd>响度范围，排除极端值后的响度跨度。越大 = 强弱段落差异越大。古典乐 15-25 LU，流行乐 4-10 LU。</dd>
    <dt>DC Offset</dt><dd>波形平均值的直流偏移。<span class="bad">＞0.1%</span> 需修复，否则浪费余量并影响后续处理。</dd>
    <dt>立体声宽度</dt><dd>0% = 完全单声道，100% = 完全分离。30-70% 为正常立体声范围。</dd>
  </dl></div>`;
  html += `</div></div>`;
  const failCount = Q.filter(([,r]) => r === 'fail').length;
  const warnCount = Q.filter(([,r]) => r === 'warn').length;
  const passCount = Q.filter(([,r]) => r === 'pass').length;
  const hintCount = Q.filter(([,r]) => r === 'hint').length;
  html += `<div class="card"><div class="card-header">快速质量摘要</div><div class="card-body">`;
  html += `<div class="row-grid">`;
  html += row('通过', `${passCount} 项`, false, 'var(--gr)');
  html += row('提示', `${hintCount} 项`, false, 'var(--ye)');
  html += row('失败', `${failCount} 项`, false, failCount > 0 ? 'var(--re)' : 'var(--fg2)');
  html += `</div>`;
  const badItems = Q.filter(([,r]) => r === 'fail' || r === 'warn');
  if (badItems.length > 0) {
    html += `<div style="margin-top:8px;font-size:.75rem;line-height:1.8">`;
    for (const [dim, rating, detail] of badItems) {
      const color = rating === 'fail' ? 'var(--re)' : 'var(--ye)';
      html += `<div style="display:flex;gap:8px;align-items:baseline"><b style="color:${color};min-width:60px">${dim}</b><span style="color:var(--fg2)">${detail}</span></div>`;
    }
    html += `</div>`;
  }
  if (A.isCommercialMaster) {
    html += `<div style="margin-top:10px;padding:8px 12px;background:#1a2a1a;border-radius:6px;font-size:.75rem;color:var(--gr);line-height:1.6">
      ℹ <b>商业母带</b> — 检测到的削波和动态压缩属于 Apple Music / Spotify 等流媒体平台的<b>标准母带处理</b>，非文件缺陷。母带工程师刻意将响度推到上限以保证在流媒体中的竞争力，少量削波是可接受的代价。
    </div>`;
  }
  html += `</div></div></div>`;
  return html;
}

function renderSpectrum() {
  return `<div class="card"><div class="card-header">频率频谱 (平均 FFT)</div><div class="card-body">
    <div class="canvas-wrap"><div class="label"><span>频率 (kHz)</span><span>幅度 (dB)</span></div>
    <canvas id="spectrumCanvas" height="300"></canvas></div>
    <div style="display:flex;gap:16px;font-size:.68rem;color:var(--fg3);margin-top:4px">
      <span>■ 低音/中音 0-8k</span><span>■ 高音 8-16k</span><span>■ 超声波 16k+</span>
    </div>
    <div class="smart-card">${narrateSpectrum(STATE.analysis)}</div>
    </div></div>`;
}

function renderSpectrogramChart() {
  return `<div class="card"><div class="card-header">频谱图 (Spectrogram)</div><div class="card-body">
    <canvas id="specCanvas" height="480"></canvas>
    <div style="font-size:.65rem;color:var(--fg3);margin-top:2px">时间 →</div>
    <div class="smart-card">${narrateSpectrogram(STATE.analysis)}</div>
    </div></div>`;
}

function renderSoundSpectrum() {
  return `<div class="card"><div class="card-header">声谱（频段能量）</div><div class="card-body">
    <canvas id="bandCanvas" height="280"></canvas>
    <div style="display:flex;justify-content:space-between;font-size:.65rem;color:var(--fg3);margin-top:2px">
      <span>20Hz</span><span>100Hz</span><span>1kHz</span><span>10kHz</span><span>20kHz</span>
    </div>
    <div class="smart-card" style="margin-top:8px">${narrateBandSpectrum(STATE.analysis)}</div>
    </div></div>`;
}

function renderWaveform() {
  return `<div class="card"><div class="card-header">波形预览</div><div class="card-body">
    <canvas id="waveCanvas" height="180"></canvas>
    <div class="smart-card">${narrateWaveform(STATE.analysis)}</div>
    </div></div>`;
}

function renderDynamics() {
  const A = STATE.analysis;
  const d = A.dynamics;
  const l = A.loudness;
  const c = A.clip;
  let html = '';
  html += buildCard('动态范围分析', [
    ['Crest Factor (峰值因数)', `${d.crest.toFixed(1)} dB`, d.crest >= 14 ? 'var(--gr)' : (d.crest >= 8 ? 'var(--ye)' : 'var(--re)')],
    ['Sample Peak (采样峰值)', `${c.peakDB.toFixed(2)} dBFS`],
    ['True Peak (4x 过采样)', `${typeof c.truePeakDB === 'string' ? c.truePeakDB : c.truePeakDB + ' dBFS'}`, c.hasTruePeakOver ? 'var(--re)' : ''],
    ['RMS 电平', `${d.rmsDB.toFixed(2)} dBFS`],
    ['Integrated LUFS (ITU-R BS.1770)', `${l.integratedLoudnessLUFS.toFixed(1)} LUFS`],
    ['Short-term LUFS Max', `${l.shortTermMaxLUFS.toFixed(1)} LUFS`],
    ['LRA (Loudness Range)', `${l.lra.toFixed(1)} LU`],
    ['EBU R128 广播标准', '-23 LUFS (±1 LU)'],
    ['DC Offset', `${A.dcOffset.isSignificant ? '⚠ 检测到: ' + (A.dcOffset.offset*100).toFixed(3) + '%' : '未检测到 (' + A.dcOffset.dcDB.toFixed(1) + ' dB)'}`, A.dcOffset.isSignificant ? 'var(--ye)' : 'var(--gr)'],
    ['削波检测', c.hasClipping ? `检测到削波 (${c.clippedSamples} 采样点)` : '未检测到削波', c.hasClipping ? 'var(--re)' : 'var(--gr)'],
    ['削波比例', `${c.clippedPct.toFixed(4)}%`],
    ['连续削波最大长度', `${c.maxConsecutiveClip} 采样点`],
    ['说明', d.crest >= 14 ? '优秀动态范围 — 音频自然呼吸' : (d.crest >= 10 ? '良好' : (d.crest >= 8 ? '适度压缩 — 现代母带常见处理' : '高度压缩 — 冲击力导向风格典型')), d.crest >= 14 ? 'var(--gr)' : (d.crest >= 8 ? 'var(--ye)' : 'var(--re)')],
  ], `<dl>
    <dt>Crest Factor（峰值因数）</dt><dd>峰值与 RMS 的差值，反映音频「呼吸空间」。<br><span class="good">≥14 dB</span>：自然动态，适合古典/爵士 | <span class="warn">8-14 dB</span>：适度压缩，现代流行常见 | <span class="warn">&lt;8 dB</span>：高度压缩，EDM/嘻哈/金属等风格常见。</dd>
    <dt>Sample Peak vs True Peak</dt><dd>Sample Peak 只看离散采样点，True Peak 用 4 倍过采样检测模拟信号重建后的真实峰值。<span class="bad">True Peak &gt; 0 dBTP</span> 意味着 DAC 输出可能削波。</dd>
    <dt>RMS 电平</dt><dd>均方根平均值，代表主观响度感知。流行乐通常在 -12 ~ -6 dBFS。</dd>
    <dt>Integrated LUFS（综合响度）</dt><dd>ITU-R BS.1770-4 标准，模拟人耳感知的整曲响度。<br><span class="good">-24 ~ -18 LUFS</span>：广播/古典 | <span class="warn">-18 ~ -12 LUFS</span>：流媒体正常范围 | <span class="bad">&gt; -8 LUFS</span>：极度压缩。</dd>
    <dt>Short-term LUFS Max</dt><dd>3 秒滑动窗中最响的段落。与 Integrated 差值大说明强弱对比明显。</dd>
    <dt>LRA（响度范围）</dt><dd>排除极端 10% 后的响度跨度，单位 LU。古典乐通常 15-25 LU，流行 4-10 LU，播客 3-6 LU。</dd>
    <dt>DC Offset（直流偏移）</dt><dd>波形平均偏离零线的程度。<span class="bad">偏移＞0.1%</span> 表明录音设备或处理链有问题，会浪费动态余量并导致削波。</dd>
    <dt>削波 (Clipping)</dt><dd>当信号幅度超过 0 dBFS 时发生。<span class="bad">有削波</span> 说明母带推得过响或录音增益过高，会产生失真。</dd>
  </dl>`, narrateDynamics(STATE.analysis));
  return html;
}

function renderStereo() {
  const A = STATE.analysis;
  if (!A.stereo) {
    return buildCard('立体声与相位分析', [['声道', '单声道 (1ch)'], ['说明', '此文件为单声道录音，无立体声信息']], null, narrateStereo(STATE.analysis));
  }
  const s = A.stereo;
  return buildCard('立体声与相位分析', [
    ['声道数', `${STATE.channels} 声道`],
    ['相关性系数 (r)', `${s.correlation.toFixed(4)}`, s.correlation > 0.9 ? 'var(--ye)' : (s.isOutOfPhase ? 'var(--re)' : 'var(--gr)')],
    ['立体声宽度', `${s.stereoWidth.toFixed(0)}%`],
    ['Mid/Side 比值', `${s.midSideRatio.toFixed(1)} dB`],
    ['反相检测', s.isOutOfPhase ? '检测到反相 (相位问题!)' : '正常', s.isOutOfPhase ? 'var(--re)' : 'var(--gr)'],
    ['反相采样比例', `${s.phaseInversionPct.toFixed(2)}%`],
  ], `<dl>
    <dt>相关性系数 (Correlation)</dt><dd>左右声道相位一致性，范围 -1 ~ +1。<br><span class="good">0.2 ~ 0.8</span>：自然立体声 | <span class="warn">&gt;0.9</span>：接近单声道，声场窄 | <span class="bad">&lt;0（负数）</span>：反相，可能造成单声道兼容问题。</dd>
    <dt>立体声宽度</dt><dd>信号立体声成分与单声成分的比值。0% = 完全单声道，100% = 纯侧边信号。<span class="good">30-70%</span> 是比较舒适的立体声宽度。</dd>
    <dt>Mid/Side 比值</dt><dd>中间信号（L+R）与侧边信号（L-R）的电平比。<span class="warn">&gt;6 dB</span> 接近单声道，<span class="warn">&lt;-3 dB</span> 侧边过强可能导致相位问题。</dd>
    <dt>反相检测</dt><dd><span class="bad">有反相</span> 意味着左右声道存在大量极性相反的采样点，在单声道下混时会造成信号抵消、声音变薄。</dd>
  </dl>`, narrateStereo(STATE.analysis)) + `<div class="card"><div class="card-header">相位示波器 (Lissajous)</div><div class="card-body">
    <canvas id="phaseCanvas" height="280" style="max-height:280px;aspect-ratio:1;margin:0 auto;display:block;width:auto"></canvas>
    <div style="text-align:center;font-size:.68rem;color:var(--fg3);margin-top:4px">左声道 → · ← 右声道 | 对角线 = 单声道 | 圆形 = 宽阔立体声</div></div></div>`;
}

function renderQuality() {
  const Q = STATE.analysis.quality;
  const title = '综合质量评估';
  const hid = 'help-' + title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  let html = `<div class="card"><div class="card-header">${title}<button class="help-toggle" onclick="toggleHelp('${hid}')" id="bt-${hid}">? 解读</button></div><div class="card-body">`;
  for (const [dim, rating, detail] of Q) {
    const labels = { pass: '通过', hint: '提示', warn: '警告', fail: '失败' };
    html += `<div class="card-row"><span class="lbl">${dim}</span><span><span class="badge badge-${rating}">${labels[rating]}</span> <span class="val" style="font-size:.78rem">${detail}</span></span></div>`;
  }
  html += `<div class="smart-card">${narrateQuality(STATE.analysis, STATE.formatInfo)}</div>`;
  html += `<div class="help-body" id="${hid}"><dl>
    <dt>通过 <span class="badge badge-pass" style="vertical-align:middle">通过</span></dt><dd>此项指标符合专业音频质量标准，无需关注。</dd>
    <dt>提示 <span class="badge badge-hint" style="vertical-align:middle">提示</span></dt><dd>有可供参考的信息，不影响质量判定。例如采样率、位深度等属性。</dd>
    <dt>警告 <span class="badge badge-warn" style="vertical-align:middle">警告</span></dt><dd>指标存在轻微问题或边缘情况。建议了解原因，但不一定需要修复。</dd>
    <dt>失败 <span class="badge badge-fail" style="vertical-align:middle">失败</span></dt><dd>检测到明显缺陷（削波、反相、DC偏移等）。建议检查原始录音或母带处理。</dd>
    <dt>检测项目说明</dt><dd>
      <b>采样率/过采样</b>：检查采样率与频率上限是否匹配。96kHz 但频谱在 22kHz 截止 = 可能从 44.1k 升频而来。<br>
      <b>削波</b>：采样点或 True Peak 超过 0 dBFS，会产生可闻失真。<br>
      <b>动态</b>：Crest Factor 过低说明音频被高度压缩，是现代母带在响度与动态之间的常见取舍。<br>
      <b>立体声</b>：反相可能导致单声道回放时声音空洞或消失。<br>
      <b>DC 偏移</b>：直流分量浪费动态余量，应由录音设备过滤。
    </dd>
  </dl></div>`;
  html += '</div></div>';
  return html;
}

function renderFileInfo() {
  const F = STATE.formatInfo;
  const A = STATE.analysis;
  return buildCard('详细文件信息', [
    ['文件名', F.filename],
    ['文件大小', fmtSize(F.fileSize)],
    ['扩展名', F.fileExt.toUpperCase()],
    ['容器格式', F.container || '由文件头解析'],
    ['编解码器', F.codec || '由浏览器解码'],
    ['无损 / 有损', F.lossless ? '无损' : '有损', F.lossless ? 'var(--gr)' : 'var(--ye)'],
    ['标称采样率', `${(F.sampleRate/1000).toFixed(1)} kHz`],
    ['声道数', F.channels === 1 ? '单声道' : F.channels === 2 ? '立体声' : `多声道 (${F.channels}ch)`],
    ['时长', fmtDur(F.duration)],
    ['平均码率', `${(F.actualBitrate/1000).toFixed(1)} kbps`],
    ['实测位深度', `${A.actualBitDepth.estimated}-bit — ${A.actualBitDepth.note} (${A.actualBitDepth.detail})`],
    ['截止频率', `${(A.cutoff.freq/1000).toFixed(1)} kHz (BW ${A.cutoff.bw.toFixed(0)}%, 置信度: ${A.cutoff.confidence})`],
  ], `<dl>
    <dt>容器 vs 编解码器</dt><dd>容器（如 M4A/FLAC/MP3）是文件的"外壳"，定义数据如何组织；编解码器（如 ALAC/AAC/MP3）是音频数据实际的压缩算法。M4A 容器内可能是 AAC（有损）或 ALAC（无损）。</dd>
    <dt>采样率 (Sample Rate)</dt><dd>每秒采集的音频样本数。<span class="good">44.1 kHz</span> = CD 标准，覆盖 0-22.05 kHz 人耳可闻范围；<span class="good">48 kHz</span> = 影视标准；<span class="warn">96/192 kHz</span> = 录音室母带，文件体积巨大，普通回放设备未必受益。</dd>
    <dt>位深度 (Bit Depth)</dt><dd>每个采样点的精度。16-bit = CD 标准（96 dB 动态范围）；24-bit = 录音室标准（144 dB）。<span class="warn">16-bit 文件标为 24-bit</span> 说明实际有效位数不足。</dd>
    <dt>码率 (Bitrate)</dt><dd>每秒音频数据量。<span class="bad">有损格式码率低</span> 意味着信息被丢弃，高频细节损失；<span class="good">无损格式码率高</span> 是好事，代表完整保留。</dd>
    <dt>截止频率</dt><dd>频谱中高频能量开始明显衰减的频率。<span class="bad">CD 源 22 kHz 截止是正常的</span>；<span class="warn">96kHz 文件却在 22kHz 截止</span> 说明可能从 CD 源升频而来，并非真 96kHz 录音。</dd>
  </dl>`, narrateFileInfo(STATE.formatInfo, STATE.analysis));
}

function renderLoudnessCurve() {
  return `<div class="card"><div class="card-header">响度历史曲线 (LUFS over time)</div><div class="card-body">
    <canvas id="loudnessCurveCanvas" height="240"></canvas>
    <div style="font-size:.65rem;color:var(--fg3);margin-top:2px">时间 → | 横轴: 完整音频时长 | 纵轴: LUFS</div>
    <div class="smart-card" style="margin-top:8px">${narrateLoudnessCurve(STATE.analysis)}</div>
    </div></div>`;
}

function renderSNR() {
  return `<div class="card"><div class="card-header">信噪比与噪底分析</div><div class="card-body">
    <canvas id="snrCanvas" height="240"></canvas>
    <div style="font-size:.65rem;color:var(--fg3);margin-top:2px">分段信噪比 | ■ 低频 20-250Hz ■ 中频 250-4kHz ■ 高频 4kHz+</div>
    <div class="smart-card" style="margin-top:8px">${narrateSNR(STATE.analysis)}</div>
    </div></div>`;
}

function renderDistortion() {
  return `<div class="card"><div class="card-header">失真分析 (THD)</div><div class="card-body">
    <canvas id="distortionCanvas" height="240"></canvas>
    <div style="font-size:.65rem;color:var(--fg3);margin-top:2px">谐波结构 | ■ 基频 ■ H2(2x) ■ H3(3x) ■ H4(4x) ■ H5(5x)</div>
    <div class="smart-card" style="margin-top:8px">${narrateDistortion(STATE.analysis)}</div>
    </div></div>`;
}

function buildCard(title, items, helpHtml, smartHtml) {
  const hid = 'help-' + title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  let html = `<div class="card"><div class="card-header">${title}`;
  if (helpHtml) { html += `<button class="help-toggle" onclick="toggleHelp('${hid}')" id="bt-${hid}">? 解读</button>`; }
  html += `</div><div class="card-body">`;
  for (const [label, value, color] of items) {
    const c = color ? `color:${color};` : '';
    html += `<div class="card-row"><span class="lbl">${label}</span><span class="val" style="${c}">${value}</span></div>`;
  }
  if (smartHtml) { html += `<div class="smart-card">${smartHtml}</div>`; }
  if (helpHtml) { html += `<div class="help-body" id="${hid}">${helpHtml}</div>`; }
  html += '</div></div>';
  return html;
}

function toggleHelp(hid) {
  const body = document.getElementById(hid);
  const btn = document.getElementById('bt-' + hid);
  if (!body || !btn) return;
  const isOpen = body.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  btn.textContent = isOpen ? '✕ 收起' : '? 解读';
}
window.toggleHelp = toggleHelp;

function row(label, value, fullWidth, color) {
  const c = color ? `color:${color};` : '';
  const colSpan = fullWidth ? 'style="grid-column:1/-1"' : '';
  return `<div class="info-item card-row" ${colSpan}><span class="lbl">${label}</span><span class="val" style="${c}">${value}</span></div>`;
}

function diagnoseRootCause(analysis, formatInfo) {
  const A = analysis;
  const F = formatInfo;
  const diag = [];
  const sr = F.sampleRate;
  const crest = A.dynamics.crest;
  const lufs = A.loudness.integratedLoudnessLUFS;
  const lra = A.loudness.lra;
  const cf = A.cutoff;
  const clip = A.clip;
  const loudnessWar = F.lossless && clip.hasClipping && crest < 10 && lufs > -12;
  if (loudnessWar) {
    const era = crest < 6 ? '2000-2010 年代高响度母带处理（Brickwall Limiting）' : crest < 8 ? '2010 年代母带响度优化' : '现代母带响度处理';
    diag.push({ title: '母带风格：硬限幅（Brickwall Limiter）', severity: 'info', detail: `此音频符合<b>${era}</b>的母带特征：使用硬限幅器将响度推至 ${lufs.toFixed(0)} LUFS，Crest Factor 仅 ${crest.toFixed(1)}dB，产生 ${clip.clippedSamples} 个削波点。这不是文件损坏——母带工程师刻意牺牲动态以换取持续的感知响度。在 Apple Music / Spotify / CD 发行版中，这种处理极为普遍。` });
  }
  if (!clip.hasClipping && crest < 7 && clip.peakDB > -0.3 && !loudnessWar) {
    diag.push({ title: '母带风格：软削波 / 饱和式限幅', severity: 'info', detail: `虽然没有检测到数字削波，但 Crest Factor 仅 ${crest.toFixed(1)}dB 且峰值 ${clip.peakDB.toFixed(2)}dBFS——这是用<b>软削波</b>（Soft Clipper / Tape Saturation）替代硬限幅器的结果。失真更柔和，但"响声"本质不变。在 EDM / Hip-Hop / 电子乐中非常常见。` });
  }
  if (sr >= 88200 && cf.confidence === 'high' && cf.bw < 85) {
    const realSR = cf.freq * 2.2;
    diag.push({ title: '根因推断：伪高解析度（升频文件）', severity: 'bad', detail: `文件声称采样率 <b>${(sr/1000).toFixed(0)}kHz</b>，但频谱在 <b>${(cf.freq/1000).toFixed(1)}kHz</b> 处明显截断（带宽仅 ${cf.bw.toFixed(0)}%）。<b>高概率从 ${realSR < 50000 ? '44.1/48kHz' : (realSR/1000).toFixed(0)+'kHz'} 源升频而来</b>，并非原生高解析度录音。实际音频信息未增加，但文件体积膨胀了 ${((sr / (cf.freq * 2.2)) ** 2).toFixed(1)} 倍。` });
  }
  if (clip.hasClipping && crest > 10 && lufs < -14 && !loudnessWar) {
    diag.push({ title: '根因推断：录音增益设置过高', severity: 'warn', detail: `削波与良好动态同时出现：整体动态范围宽裕（Crest ${crest.toFixed(1)}dB），响度适中（${lufs.toFixed(0)} LUFS），但仍有 ${clip.clippedSamples} 个削波点。<b>高概率是录音阶段增益过高</b>——个别的瞬态尖峰（如鼓点、镲片、钢琴强音）击穿了电平上限，而主体音频是干净的。建议在录音/混音阶段降低 2-4 dB 增益后重新导出。` });
  }
  if (clip.hasClipping && A.actualBitDepth.estimated >= 20 && !loudnessWar) {
    diag.push({ title: '异常信号：高比特深度下的削波', severity: 'warn', detail: `${A.actualBitDepth.estimated}-bit 拥有超过 120dB 的理论动态范围，此文件却在如此大的余量下仍然削波。<b>高概率是录音链路增益设置严重不当</b>——话筒前置放大器或音频接口的输出电平过高。建议检查整个录音链路的增益级联（Gain Staging）。` });
  }
  if (A.dcOffset.isSignificant && clip.hasClipping) {
    diag.push({ title: '根因推断：录音硬件问题（DC Offset）', severity: 'bad', detail: `直流偏移 ${(A.dcOffset.offset * 100).toFixed(3)}% 与削波 ${clip.clippedSamples} 点同时出现，<b>强烈暗示录音硬件存在故障</b>。常见原因：音频接口的耦合电容老化、调音台 DC 偏置、或电源接地环路。建议排查录音设备硬件。` });
  }
  if (A.stereo && A.stereo.isOutOfPhase) {
    diag.push({ title: '根因推断：立体声极性反转', severity: 'bad', detail: `左右声道相关性 ${A.stereo.correlation.toFixed(3)}，反相采样比例 ${A.stereo.phaseInversionPct.toFixed(1)}%。${A.stereo.correlation < 0 ? '整体呈<b>反相</b>，左右声道<b>极性完全相反</b>——' : '<b>部分反相</b>——'}在单声道设备上播放会导致信号抵消、中置元素（人声/贝斯/底鼓）消失。常见原因：XLR 线材的一端焊接错误（Pin 2/3 反接）、插件极性反转、或多麦克风录音时的相位干涉。` });
  }
  if (A.stereo && A.stereo.stereoWidth > 80 && A.stereo.correlation < 0.3) {
    diag.push({ title: '提示：极端立体声加宽', severity: 'hint', detail: `立体声宽度 ${A.stereo.stereoWidth.toFixed(0)}%，相关性仅 ${A.stereo.correlation.toFixed(3)}。这可能源于<b>立体声加宽效果器</b>（Stereo Widener / Haas Effect），虽然声场宽阔，但在单声道下混时中置元素会<b>严重衰减</b>（通常 -6 ~ -12 dB）。建议检查单声道兼容性。` });
  }
  if (lra < 4 && lufs > -10) {
    diag.push({ title: '提示：广播/电台级压缩', severity: 'hint', detail: `LRA 仅 ${lra.toFixed(1)} LU（整曲响度几乎无变化），配合 ${lufs.toFixed(0)} LUFS 的综合响度——这是<b>广播/电台的典型处理方式</b>，确保在嘈杂环境中每个字都能听清。如果这来自商业电台版本而非原始母带，则属于正常现象。` });
  }
  if (crest > 16 && lufs < -18) {
    diag.push({ title: '判断：古典乐 / 原声录音特征', severity: 'good', detail: `Crest Factor ${crest.toFixed(1)}dB，LRA ${lra.toFixed(1)} LU，响度仅 ${lufs.toFixed(0)} LUFS——这是<b>古典乐、原声爵士或电影原声</b>的典型特征。动态范围完整保留，强弱对比鲜明。在普通设备上聆听可能需要调高音量；如需在现代流媒体平台发行，建议做适度响度提升（-2 ~ -4 dB）而非压缩。` });
  }
  if (A.actualBitDepth.estimated >= 20 && sr <= 48000 && cf.bw > 95 && !F.lossless) {
    diag.push({ title: '提示：升比特文件', severity: 'hint', detail: `有损格式搭配 ${A.actualBitDepth.estimated}-bit，实际上有损编码的位深度是浮动的，探测到的位深度可能来自编码器的内部处理精度，而非源文件品质。` });
  }
  if (A.actualBitDepth.estimated <= 17 && A.actualBitDepth.estimated >= 15 && F.bitDepth && F.bitDepth >= 24) {
    diag.push({ title: '根因推断：16-bit 音频装入 24-bit 容器', severity: 'hint', detail: `文件容器声明 ${F.bitDepth}-bit，但实际可检测的信号精度仅 ~16-bit。这在从 CD 翻录并导出为 24-bit ALAC/FLAC 时非常常见——额外的 8 位全是零填充，对音质无实际贡献，仅增加约 50% 的文件体积。` });
  }
  return diag;
}

function narrateSNR(analysis) {
  const snr = analysis.snr;
  if (!snr || snr.isEstimate || snr.noiseFloorDB === null) { return `<p style="margin:5px 0">音频太短或全为静音，无法计算 SNR。</p>`; }
  const lines = [];
  let simple = '信噪比 = 有用声音 ÷ 背景噪声。越大=越干净，像房间里音乐声和空调声的比例。';
  if (snr.noiseFloorDB < -80) simple += ` ✅ 背景噪声极低（${snr.noiseFloorDB.toFixed(0)} dB），录音环境或设备非常安静。`;
  else if (snr.noiseFloorDB < -60) simple += ` ✅ 噪底适中（${snr.noiseFloorDB.toFixed(0)} dB），正常水平。`;
  else if (snr.noiseFloorDB < -40) simple += ` 💡 噪底偏高（${snr.noiseFloorDB.toFixed(0)} dB），可能有背景噪声。`;
  else simple += ` ⚠️ 背景噪声很高（${snr.noiseFloorDB.toFixed(0)} dB），安静段能听到明显底噪。`;
  if (snr.snrDB > 60) simple += ' 整体非常干净。';
  else if (snr.snrDB > 30) simple += ' 信噪比适中。';
  else simple += ' 噪声较明显。';
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  lines.push(`噪底 ${snr.noiseFloorDB.toFixed(1)} dBFS | 整体 SNR ${snr.snrDB.toFixed(1)} dB`);
  const parts = [];
  if (snr.snrLow !== null && snr.snrLow !== undefined) parts.push(`低频 ${snr.snrLow.toFixed(1)}dB`);
  if (snr.snrMid !== null && snr.snrMid !== undefined) parts.push(`中频 ${snr.snrMid.toFixed(1)}dB`);
  if (snr.snrHigh !== null && snr.snrHigh !== undefined) parts.push(`高频 ${snr.snrHigh.toFixed(1)}dB`);
  if (parts.length > 0) lines.push(`分段 SNR：${parts.join(' | ')}`);
  if (snr.snrHigh !== null && snr.snrLow !== null && snr.snrHigh < snr.snrLow * 0.6) { lines.push(`高频 SNR 低于低频，常见于磁带/老录音/降噪处理`); }
  lines.push(`</div>`);
  return lines.map(ln => `<p style="margin:5px 0;line-height:1.7">${ln}</p>`).join('');
}

function narrateDistortion(analysis) {
  const d = analysis.distortion;
  if (!d || d.isEstimate || !d.harmonics || d.harmonics.length < 2) { return `<p style="margin:5px 0">无法检测到稳定的基频和谐波结构，可能为复杂合奏/噪声信号。</p>`; }
  const lines = [];
  const fundHz = d.fundamentalHz || '?';
  let simple = `THD（总谐波失真）= 声音"干净"程度。越小=越干净。追踪到 ${d.harmonics.length} 次谐波。`;
  if (d.thdPct < 0.05) simple += ` ✅ THD ${d.thdPct.toFixed(3)}% — 基本"纯净"。`;
  else if (d.thdPct < 0.3) simple += ` ✅ THD ${d.thdPct.toFixed(3)}% — 很低，人耳难察觉。`;
  else if (d.thdPct < 1) simple += ` 💡 THD ${d.thdPct.toFixed(2)}% — 轻微失真。`;
  else if (d.thdPct < 5) simple += ` ⚠️ THD ${d.thdPct.toFixed(2)}% — 偏高，安静段可能听出失真。`;
  else simple += ` ⚠️ THD ${d.thdPct.toFixed(2)}% — 很高，有明显失真。`;
  if (d.asymmetryPct > 5) simple += ` 波形不对称 ${d.asymmetryPct.toFixed(0)}%。`;
  lines.push(`<div style="font-weight:600;color:var(--ac);margin-bottom:2px">📊 怎么看：</div><span style="font-size:.82rem">${simple}</span>`);
  lines.push(`<div style="margin-top:8px;font-size:.72rem;color:var(--fg3)">`);
  lines.push(`THD ${d.thdPct.toFixed(3)}% | ${d.harmonics.length} 次谐波`);
  if (d.harmonics.length >= 4) {
    const dropH1H2 = d.harmonics[0] - d.harmonics[1];
    lines.push(`H1→H2 ${dropH1H2.toFixed(0)}dB ${dropH1H2 > 20 ? '（陡峭衰减）' : dropH1H2 > 10 ? '（自然衰减）' : '（平缓）'}`);
  }
  if (d.asymmetryPct > 5) lines.push(`不对称性 ${d.asymmetryPct.toFixed(1)}%`);
  lines.push(`</div>`);
  return lines.map(ln => `<p style="margin:5px 0;line-height:1.7">${ln}</p>`).join('');
}

// ═══════════════════════════════════════════════════════════════
//  入口初始化（DOMContentLoaded，双击 index.html 即可运行）
// ═══════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  try {
    console.log('[AudioAnalyzer] START');

    // 导出按钮
    const btn = document.getElementById('btnExport');
    if (btn && typeof exportReport === 'function') {
      btn.addEventListener('click', exportReport);
    }

    // AudioContext 在用户首次交互后恢复（浏览器自动静音策略）
    document.addEventListener('click', () => {
      if (typeof audioCtx !== 'undefined' && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    }, { once: true });

    D.info('INIT', '就绪，等待音频文件...');
    console.log('[AudioAnalyzer] READY');
  } catch (e) {
    console.error('[AudioAnalyzer] INIT ERROR:', e);
  }
});

// ═══════════════════════════════════════════════════════════════
//  补丁1：强制入口（防 init 丢失）
// ═══════════════════════════════════════════════════════════════

(function () {

  function bootSafe() {
    console.log('[PATCH] boot start');

    if (document.readyState !== 'complete') {
      window.addEventListener('load', bootSafe);
      return;
    }

    // 1. init兜底
    if (typeof init === 'function') {
      try {
        init();
        console.log('[PATCH] init OK');
      } catch (e) {
        console.error('[PATCH] init error', e);
      }
    }

    // 2. export兜底
    const btn = document.getElementById('btnExport');
    if (btn && typeof exportReport === 'function') {
      btn.addEventListener('click', exportReport);
    }

    console.log('[PATCH] boot ready');
  }

  bootSafe();

})();

// ═══════════════════════════════════════════════════════════════
//  兜底：全局 drop 事件（确保 UI 一定能触发分析链）
// ═══════════════════════════════════════════════════════════════

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;

  console.log('[DROP FILE]', file.name);
  __TRACE.step('drop triggered');

  try {
    if (typeof processFiles === 'function') {
      await processFiles([file]);
    }
  } catch (err) {
    console.error('[DROP ERROR]', err);
  }
});

document.addEventListener('dragover', (e) => e.preventDefault());

// ═══════════════════════════════════════════════════════════════
//  补丁2：强制文件入口（解决"UI没反应"核心问题）
// ═══════════════════════════════════════════════════════════════

(function () {

  function hookFileInput() {

    const input = document.getElementById('fileInput');
    if (input) {
      input.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        console.log('[PATCH] file input triggered');

        if (typeof processFiles === 'function') {
          processFiles([file]);
        }
      });
    }

    // drag & drop
    document.addEventListener('drop', (e) => {
      e.preventDefault();

      const file = e.dataTransfer?.files?.[0];
      if (!file) return;

      console.log('[PATCH] file drop triggered');

      if (typeof processFiles === 'function') {
        processFiles([file]);
      }
    });

    document.addEventListener('dragover', (e) => e.preventDefault());
  }

  hookFileInput();

})();

// ═══════════════════════════════════════════════════════════════
//  补丁3：防重复 runAnalysis + 强制收尾 + 结果追踪
// ═══════════════════════════════════════════════════════════════

(function () {

  if (typeof runAnalysis !== 'function') return;

  let __ANALYSIS_LOCK = false;
  const _originalAnalysis = runAnalysis;

  // debug 结果追踪
  window.__TRACE_RESULT = function (result) {
    console.log('[RESULT]', result);
  };

  window.runAnalysis = async function (...args) {
    if (__ANALYSIS_LOCK) {
      console.warn('[runAnalysis] blocked: already running');
      return;
    }

    __ANALYSIS_LOCK = true;

    try {
      console.time('ANALYZE_TOTAL');
      console.log('[runAnalysis] start');

      const result = await _originalAnalysis.apply(this, args);

      console.log('[runAnalysis] done');

      // 强制 UI 收尾
      requestAnimationFrame(() => {
        if (typeof renderAll === 'function') {
          renderAll();
        }
      });

      window.__TRACE_RESULT(result);
      return result;

    } catch (err) {
      console.error('[runAnalysis] error:', err);
    } finally {
      console.timeEnd('ANALYZE_TOTAL');
      __ANALYSIS_LOCK = false;
    }
  };

})();