const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');

let mainWindow = null;

// 窗口/任务栏图标。
// 打包后 exe 本身已内嵌图标（electron-builder 由 build/icon.ico 写入），
// 但开发模式（npm start）跑的是 node_modules 里的 electron.exe，
// 任务栏会显示 Electron 默认图标 —— 所以这里显式指定，两种模式保持一致。
// build/ 不在 files 白名单里，打包后不存在，回退到 icon.ico/png 并用存在性判断兜底。
function resolveAppIcon() {
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'icon.ico'),
    path.join(__dirname, 'icon.png'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return undefined;   // 不传 icon 时 Electron 用默认图标，不报错
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Audio Analyzer Pro',
    backgroundColor: '#0d1117',
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

// ── IPC: 打开文件对话框 ──
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音频文件',
    filters: [
      { name: '音频文件', extensions: ['wav','flac','aiff','aif','mp3','m4a','aac','ogg','opus','wma','ape','wv','tta','dsf','dff','caf','ac3','eac3','mka','webm','alac'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });
  return result.canceled ? [] : result.filePaths;
});

// ── IPC: 读取文件为 ArrayBuffer（支持分段读取，避免为了看文件头把整首歌读进内存） ──
ipcMain.handle('file:readBuffer', async (_event, filePath, opts) => {
  try {
    const offset = Math.max(0, Number(opts && opts.offset) || 0);
    const length = Number(opts && opts.length);
    if (!offset && (!length || length <= 0)) {
      const buffer = await fs.promises.readFile(filePath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    if (!length || length <= 0) {
      const buffer = await fs.promises.readFile(filePath);
      const sliced = buffer.subarray(offset);
      return sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength);
    }
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buffer, 0, length, offset);
      const sliced = buffer.subarray(0, bytesRead);
      return sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength);
    } finally {
      await fh.close();
    }
  } catch (e) {
    console.error('[main] readBuffer error:', e.message);
    return null;
  }
});

// ── IPC: 只取文件大小，不做任何读取 ──
ipcMain.handle('file:size', async (_event, filePath) => {
  try {
    const st = await fs.promises.stat(filePath);
    return st.size;
  } catch (e) {
    return -1;
  }
});

// ── FFmpeg 路径解析（打包内置优先，其次 PATH） ──
//
// 关键：打包后必须优先取 app.asar.unpacked 里的副本。
// app.asar 是归档文件而非目录，**外部进程无法执行 asar 内的文件**
// （execFile/spawn 会失败），所以 package.json 里用 asarUnpack
// 把 ffmpeg/ffprobe 解包到磁盘。若只查 __dirname（asar 内路径），
// 打包版会静默退回系统 PATH，用户没装 FFmpeg 时兜底解码全部失效。
function assetCandidates(binName) {
  const base = binName.replace(/\.exe$/i, '');
  const names = process.platform === 'win32' ? [`${base}.exe`, base] : [base, `${base}.exe`];
  const roots = [];
  // 1) asar 解包目录（打包后真正可执行的位置）
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets'));
    roots.push(path.join(process.resourcesPath, 'assets'));
  }
  // 2) 开发环境 / 未打包
  roots.push(path.join(__dirname, 'assets'));
  if (typeof __dirname === 'string' && __dirname.includes('app.asar')) {
    roots.push(path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'assets'));
  }
  // 3) 安装目录旁（兜底）
  try { roots.push(path.join(path.dirname(app.getPath('exe')), 'assets')); } catch (_) {}

  const out = [];
  for (const r of roots) for (const n of names) out.push(path.join(r, n));
  return out;
}

function resolveBinary(binName, fallback) {
  for (const p of assetCandidates(binName)) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return fallback;
}

function resolveFfmpegPath() {
  return resolveBinary('ffmpeg', 'ffmpeg');   // 回退到系统 PATH
}

ipcMain.handle('app:getFfmpegPath', () => resolveFfmpegPath());
// 应用版本单一来源：package.json。界面与导出报告都从这里取，
// 避免在 HTML/JS 里手写版本号后在升级时漏改（历史上就漏过）。
ipcMain.handle('app:getVersion', () => app.getVersion());

// ── 解析 WAV 头，取出真实采样率/声道数 ──
// 这样就不必把任何采样率写死，高采样率源可以原样保留
function parseWavHeader(buf) {
  try {
    if (buf.length < 44) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12;
    let fmt = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        fmt = {
          channels: buf.readUInt16LE(off + 10),
          sampleRate: buf.readUInt32LE(off + 12),
        };
      } else if (id === 'data') {
        const dataOffset = off + 8;
        const dataSize = Math.min(size, buf.length - dataOffset);
        return fmt ? { ...fmt, dataOffset, dataSize } : null;
      }
      off += 8 + size + (size % 2);
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── IPC: 异步运行 ffmpeg（不阻塞主进程） ──
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ff = resolveFfmpegPath();
    const child = execFile(ff, args, { maxBuffer: 8 << 20, windowsHide: true }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (err) {
        reject(new Error(`ffmpeg ${describeFfmpegError(err, stderr)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    // 自己实现超时：execFile 的 timeout 只发信号并回报错误，
    // 不保证进程真的退出；这里显式 kill，避免一次挂起卡死整条分析队列。
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）已终止`));
    }, timeoutMs);
  });
}

// 从 ffmpeg 冗长的 stderr 里挑出最有信息量的一行作为错误描述。
// 直接取最后 3 行往往只得到「Error opening input files」这种无用的兜底信息。
function describeFfmpegError(err, stderr) {
  const text = (stderr || '').toString();
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pick =
    lines.find(l => /Invalid data found|moov atom not found|Decoder .* not found|Unknown decoder|No such file|Permission denied|Protocol not found|does not contain any stream|Conversion failed/i.test(l))
    || lines.find(l => /^\[[^\]]+\]\s*(Error|error)/.test(l))
    || lines[lines.length - 1]
    || err.message;
  // 去掉 ffmpeg 的 [in#0 @ 0x...] 前缀噪声
  return pick.replace(/^\[[^\]]*\]\s*/, '').slice(0, 300);
}

// ── IPC: FFmpeg 解码 ──
// 关键点：
//  1) 走 resolveFfmpegPath()，打包内置的 assets/ffmpeg.exe 才会被用上
//  2) 采样率由渲染进程按 ffprobe 实测值指定，**不写死** ——
//     写死会把 96kHz 母带重采样掉，直接毁掉“检测升采样假无损”这个核心能力
//  3) 只解码前 N 秒（maxSeconds）：QC 判定不需要整首歌，
//     1.5GB 文件全解码会产出 457MB PCM，既慢又顶内存
//  4) 仅当采样率超过 rateCap 时才降采样（352.8kHz DSD 等）
//  5) 输出 WAV，头部自带真实采样率/声道数，交回渲染进程
ipcMain.handle('ffmpeg:decode', async (_event, filePath, opts) => {
  let outPath = null;
  try {
    if (!filePath || typeof filePath !== 'string') throw new Error('无效的文件路径');
    const o = opts || {};

    let inputBytes = 0;
    try { inputBytes = (await fs.promises.stat(filePath)).size; } catch (_) {}

    await fs.promises.mkdir(TMP_DIR, { recursive: true });
    outPath = path.join(TMP_DIR, `decoded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);

    const args = ['-hide_banner', '-nostdin', '-y', '-i', filePath, '-vn', '-map', 'a:0'];

    // 只解码指定区段：QC 判定不需要整首歌；1.5GB 文件全解码会产出 457MB PCM，
    // 既拖慢分析也把内存顶上去。渲染进程会多次调用本接口，
    // 分别在开头/中间/结尾取一段，拼出有代表性的样本（见 decodeLargeViaFFmpeg）。
    const startSec = Number(o.startSeconds);
    if (startSec > 0) args.push('-ss', String(startSec));
    const maxSec = Number(o.maxSeconds);
    if (maxSec > 0) args.push('-t', String(maxSec));
    console.log(`[main] ffmpeg:decode opts=${JSON.stringify(o)}`);

    // 采样率策略：能保留就保留（升采样检测依赖真实采样率），
    // 仅在超出分辨率上限时才降采样
    const rate = Number(o.sampleRate);
    const rateCap = Number(o.rateCap) || 192000;
    if (rate > 0 && rate <= rateCap) {
      args.push('-ar', String(Math.round(rate)));
    } else if (rate > rateCap) {
      console.log(`[main] 采样率 ${rate}Hz 超过上限 ${rateCap}Hz，降采样`);
      args.push('-ar', String(rateCap));
    }

    const ch = Number(o.channels);
    if (ch > 0 && ch <= 8) args.push('-ac', String(ch));

    args.push('-c:a', 'pcm_f32le', outPath);
    await runFfmpeg(args, 300000);

    const wav = await fs.promises.readFile(outPath);
    const info = parseWavHeader(wav);
    if (!info || !info.dataSize) throw new Error('FFmpeg 输出无法解析为 WAV');

    const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataSize);
    return {
      buffer: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
      channels: info.channels,
      sampleRate: info.sampleRate,
      format: 'f32le',
      inputBytes,
      trimmed: maxSec > 0,
    };
  } catch (e) {
    throw new Error('FFmpeg 解码失败: ' + e.message);
  } finally {
    // 无论成功失败都清理临时文件
    if (outPath) { try { await fs.promises.unlink(outPath); } catch (_) {} }
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── 音乐库扫描（严格只读） ──
// 只做 readdir + stat，不打开文件内容、不写入、不移动、不删除任何东西。
const AUDIO_EXT = new Set([
  '.wav','.flac','.aiff','.aif','.mp3','.m4a','.aac','.ogg','.opus','.wma',
  '.ape','.wv','.tta','.dsf','.dff','.caf','.ac3','.eac3','.mka','.webm','.mp4','.alac',
]);

// 解码临时文件目录（FFmpeg 中间产物），必须排除在库扫描之外，
// 否则那些 GB 级的 decoded_*.wav 会被当成音频文件列进音乐库
const TMP_DIR = path.join(os.tmpdir(), 'audio-analyzer-ffmpeg');

function walkAudio(dir, opts, out, depth) {
  if (depth > opts.maxDepth) return out;
  // 不进入解码临时目录
  if (path.resolve(dir) === path.resolve(TMP_DIR)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (out.files.length >= opts.limit) return out;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.dirs++;
      walkAudio(full, opts, out, depth + 1);
    } else if (e.isFile()) {
      // 跳过我们自己的解码中间产物
      if (e.name.startsWith('decoded_') && /^decoded_\d+_[a-z0-9]+\.wav$/i.test(e.name)) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      out.files.push({
        path: full,
        name: e.name,
        dir: path.relative(opts.root, path.dirname(full)),
        ext: ext.slice(1),
        size: st.size,
        mtime: st.mtimeMs,
      });
      out.bytes += st.size;
    }
  }
  return out;
}

// IPC: 扫描一个目录，返回音频文件清单（只读元数据）
ipcMain.handle('lib:scan', async (_event, dirPath, options) => {
  try {
    if (!dirPath || typeof dirPath !== 'string') throw new Error('无效目录');
    const st = await fs.promises.stat(dirPath);
    if (!st.isDirectory()) throw new Error('不是目录');

    const opts = {
      root: dirPath,
      maxDepth: Math.min(Math.max(Number(options && options.maxDepth) || 8, 1), 24),
      limit: Math.min(Math.max(Number(options && options.limit) || 200000, 1), 500000),
    };
    const t0 = Date.now();
    const out = walkAudio(dirPath, opts, { files: [], bytes: 0, dirs: 0 }, 0);
    const ms = Date.now() - t0;

    return {
      ok: true,
      root: dirPath,
      files: out.files,
      bytes: out.bytes,
      dirCount: out.dirs,
      truncated: out.files.length >= opts.limit,
      elapsedMs: ms,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// IPC: 让用户挑一个库根目录
ipcMain.handle('lib:chooseRoot', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择音乐库根目录',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// ── ffprobe 路径解析（与 ffmpeg 同目录，或 PATH） ──
function resolveFfprobePath() {
  // 先按与 ffmpeg 同目录找，再走统一的候选列表（含 asarUnpack 解包目录）
  const ff = resolveFfmpegPath();
  if (ff && ff !== 'ffmpeg') {
    const dir = path.dirname(ff);
    for (const n of (process.platform === 'win32' ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe', 'ffprobe.exe'])) {
      const p = path.join(dir, n);
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
  }
  return resolveBinary('ffprobe', 'ffprobe');
}

function runFfprobe(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fp = resolveFfprobePath();
    const child = execFile(fp, args, { maxBuffer: 8 << 20, windowsHide: true }, (err, stdout) => {
      clearTimeout(timer);
      if (err) { reject(new Error(err.message)); return; }
      resolve(stdout);
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('ffprobe 超时'));
    }, timeoutMs);
  });
}

// IPC: 探测音频流参数（真实采样率/声道/时长），用于大文件按原采样率解码
ipcMain.handle('audio:probe', async (_event, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') throw new Error('无效路径');
    const out = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate,channels,codec_name,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ], 30000);
    const j = JSON.parse(out);
    const st = (j.streams && j.streams[0]) || {};
    const dur = Number(st.duration) || Number((j.format && j.format.duration)) || 0;
    return {
      ok: true,
      sampleRate: Number(st.sample_rate) || 0,
      channels: Number(st.channels) || 0,
      codec: st.codec_name || null,
      duration: dur,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// IPC: 参数透传自检（确认多参数 invoke 是否完整送达）
ipcMain.handle('debug:echoArgs', async (_event, ...args) => {
  return { count: args.length, args: args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))) };
});

// ── 全局异常保护（防 EXE 静默崩溃） ──
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
