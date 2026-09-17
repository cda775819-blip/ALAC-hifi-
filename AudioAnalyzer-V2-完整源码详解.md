# Audio Analyzer Pro — 完整源码详解

> **版本**: v9.0 (Electron 桌面应用 / Windows EXE)
> **打包方式**: electron-builder + NSIS 安装程序
> **技术栈**: Electron + Vanilla JS (ES Module) + Canvas API + Web Audio API + Web Workers
> **代码总量**: ~4200 行 (含注释)
> **仓库**: https://github.com/cda775819-blip/ALAC-hifi-

---

## ⚠️ 时效性说明（v9.0 复核）

本文写于 v2.1.0 时期，主体架构与算法讲解**仍然有效**，但以下部分已随 v9.0 变更，
阅读时请以源码为准：

| 本文描述 | v9.0 实际状态 |
|---------|--------------|
| `analyzeFull()`（6.5 节） | **已删除**。它曾是主线程的重复实现，与 Worker 里的算法不一致，且从未被 Worker 架构接管。现统一由 `core/analyzeEngine.js` + `worker/analyze.worker.js` 承担 |
| `renderer/index.html`（七节） | 结构已重写为三栏网格（侧栏 / 音乐库 / 主区），并新增 `renderer/library.js` |
| `styles.css` 的「GitHub 暗色主题」（八节） | 已替换为仪器风格设计系统（炭黑 + 琥珀/青色，等宽数字读数） |
| 根级 `index.html` | **已归档**到 `legacy/V2-旧版单页残留.html`（它是早期目录布局的残留，从未被加载） |
| `assets/ffmpeg.exe` | 新增依赖 `assets/ffprobe.exe`（用于探测真实采样率），详见 README |
| `dist/...Setup 2.0.0.exe` | 打包产物不再入库（>100MB 且会持续膨胀仓库），改用 GitHub Releases 分发 |
| 版本号 v2.1.0 | 已统一为 **v9.0** |

此外 v9.0 修复了一批**数值正确性问题**（K-weighting 滤波器、频标 2 倍偏移、
THD 数据类型、截止频率恒为奈奎斯特、Worker 削波计数翻倍等），
详见 README 的「v9.0 修复」章节与 `AudioAnalyzer_V2/test/` 下的回归测试。

新增的测试与验证脚本（`AudioAnalyzer_V2/test/`，共 19 个）不在本文范围内。

---

## 一、项目架构总览

```
AudioAnalyzer_V2/
├── main.js                    # Electron 主进程 — 窗口 + IPC + 文件系统 + FFmpeg/ffprobe
├── preload.js                 # 上下文桥接 — 安全暴露 API 给渲染进程
├── package.json               # 项目配置 + electron-builder 打包配置
├── build/
│   └── icon.png               # EXE 图标
├── assets/                    # 【需自备】ffmpeg.exe / ffprobe.exe
├── core/                      # 分析引擎核心模块（ES Module）
│   ├── analyzeEngine.js       # 分析引擎入口 — 编排分片→Worker→汇总
│   ├── chunkManager.js        # PCM 分片管理器 — 自适应分片策略
│   ├── reduceResults.js       # 结果汇总器 — 加权平均合并
│   ├── workerPool.js          # Worker 并行调度池 — 4线程背压控制
│   └── safeRunner.js          # 安全执行包装器
├── worker/
│   └── analyze.worker.js      # Web Worker — 分片 FFT 频谱分析
├── utils/
│   ├── audioMath.js           # 高级算法 — LUFS / 位深度 / SNR / THD / 截止频率
│   ├── dom.js                 # DOM 快捷工具 ($ / $$)
│   ├── format.js              # 格式化工具 (文件大小/时长)
│   └── logger.js              # 调试日志系统 (D)
├── renderer/                  # 渲染进程 (前端 UI)
│   ├── index.html             # 主页面 — 三栏网格布局
│   ├── styles.css             # 仪器风格设计系统
│   ├── app.js                 # 前端主逻辑 — 解码/分析/渲染
│   └── library.js             # 音乐库浏览器 — 只读扫描 + 虚拟化列表
├── test/                      # 回归测试与验证脚本（18 个）
└── dist/                      # 构建输出（已 gitignore）
```

### 数据流向

```
用户拖放音频文件
    ↓
Electron IPC / File API → 读取原始字节
    ↓
parseFormatFromBytes() → 识别容器格式 (WAV/FLAC/MP3/ALAC/OGG/...)
    ↓
多级解码策略:
  ┌─ AudioElement 解码 (浏览器原生)          ← 优先
  ├─ Pure JS ALAC 解码器 (纯 JS 实现)        ← ALAC 专用兜底
  ├─ WebCodecs API (AudioDecoder)            ← 现代浏览器
  └─ FFmpeg.wasm                             ← 终极兜底
    ↓
得到 AudioBuffer → 提取 PCM Float32Array[n] 声道数据
    ↓
analyzeFull(pcmChannels, sampleRate) → 完整 FFT 分析(主线程)
    ├─ Pass 1: 峰值/RMS(DC)/削波检测
    └─ Pass 2: FFT 频谱 (2048-pt Hann窗, ~2000帧平均, 512 bins)
    ↓
computeDisplayData() → 计算频谱图/波形/声谱/响度/SNR/失真
    ↓
adaptAnalysis() → 扁平结果 → 渲染层嵌套结构
    ↓
renderAll() → 生成 HTML 卡片 + Canvas 绑图
```

---

## 二、main.js — Electron 主进程（窗口 + 系统桥接）

**路径**: `main.js`
**职责**: 管理应用生命周期、创建 BrowserWindow、提供 IPC 通信、系统级文件操作

```javascript
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
```

### 窗口创建 (createWindow)

```javascript
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Audio Analyzer Pro',
    backgroundColor: '#0d1117',          // GitHub 暗色主题背景
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,             // 安全：隔离上下文
      nodeIntegration: false,             // 安全：禁止 Node.js 集成
      sandbox: false                      // 允许 preload 使用 Node API
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false); // 隐藏菜单栏
}
```

**关键设计**:
- `contextIsolation: true` + `nodeIntegration: false` — 遵循 Electron 安全最佳实践
- `sandbox: false` — 必须开启才能让 preload.js 访问 Node.js API
- 加载 `renderer/index.html` 而非根目录的旧版 HTML

### IPC 通信（三个通道）

```javascript
// 1. 打开系统文件对话框 — 支持 20+ 音频格式
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音频文件',
    filters: [
      { name: '音频文件', extensions: ['wav','flac','aiff','aif','mp3','m4a','aac','ogg','opus','wma','ape','wv','tta','dsf','dff','caf','ac3','eac3','mka','webm','alac'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']  // 支持多选
  });
  return result.canceled ? [] : result.filePaths;
});

// 2. 读取文件二进制数据（绕过浏览器沙箱限制）
ipcMain.handle('file:readBuffer', async (_event, filePath) => {
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

// 3. 定位 FFmpeg 可执行文件（多路径搜索）
ipcMain.handle('app:getFfmpegPath', () => {
  const possiblePaths = [
    path.join(__dirname, 'assets', 'ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'assets', 'ffmpeg.exe'),
    path.join(app.getPath('exe'), '..', 'assets', 'ffmpeg.exe'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg'; // fallback to PATH
});
```

### 全局异常保护

```javascript
// 防止 EXE 静默崩溃（不弹窗、不退出）
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
```

---

## 三、preload.js — 安全上下文桥接

**路径**: `preload.js`
**职责**: 通过 `contextBridge.exposeInMainWorld()` 安全地将主进程能力暴露给渲染进程

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFileBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),
  getFfmpegPath: () => ipcRenderer.invoke('app:getFfmpegPath'),
});
```

**安全原理**:
- 渲染进程不能直接调用 `require('electron')` （因为 `nodeIntegration: false`）
- preload 在隔离的上下文中运行，通过 `contextBridge` 暴露特定的安全 API
- 只有这三个函数可用，无法访问文件系统、shell 等危险能力
- 渲染进程通过 `window.electronAPI.openFileDialog()` 调用

---

## 四、core/ — 分析引擎核心模块

### 4.1 analyzeEngine.js — 分析引擎入口

**职责**: 编排整个分析流程（分片 → Worker Pool 并行 → 汇总）

```javascript
import { splitPCM } from "./chunkManager.js";
import { WorkerPool } from "./workerPool.js";
import { reduceResults } from "./reduceResults.js";

export class AnalyzeEngine {
  constructor() {
    this.pool = new WorkerPool("../worker/analyze.worker.js", 4);
    // 创建 4 个 Web Worker，并行处理
  }

  async run(channels, sampleRate, onProgress) {
    // 1. 分片 — 将长音频切成小段
    const chunks = splitPCM(channels, sampleRate);
    
    // 2. 并行分派到 Worker Pool
    const results = [];
    for (let i = 0; i < total; i++) {
      const raw = await this.pool.run({
        chunk: chunks[i].data,
        index: i,
        sampleRate,
      });
      // 错误隔离：单 chunk 失败不影响其他
      if (raw && raw.ok === false) {
        results.push({ rms: 0, peak: 0, spectrum: [], sampleCount: 0 });
      } else {
        results.push(raw.res);
      }
      if (onProgress) onProgress(i / total);
    }

    // 3. 加权汇总所有分片结果
    return reduceResults(results, sampleRate, totalSamples, channelsCount);
  }
}
```

**工作原理**: 
- 将整个音频按 5-20 秒切成小块
- 4 个 Worker 并行计算每个块的频谱/峰值/RMS
- 汇总阶段用加权平均（按样本数加权）合并所有块的结果

### 4.2 chunkManager.js — 自适应分片

**职责**: 根据音频时长智能选择分片大小

| 音频时长 | 分片大小 | 原因 |
|---------|---------|------|
| < 60 秒 | 5 秒 | 短音频需要更细粒度 |
| < 10 分钟 | 10 秒 | 标准长度 |
| > 10 分钟 | 20 秒 | 长音频减少分片数 |

```javascript
export function splitPCM(channels, sampleRate) {
  const duration = length / sampleRate;
  let chunkSec;
  if (duration < 60) chunkSec = 5;
  else if (duration < 600) chunkSec = 10;
  else chunkSec = 20;

  const chunkSamples = sampleRate * chunkSec;
  // 每个声道切分出独立的 Float32Array 子数组
  for (let i = 0; i < length; i += chunkSamples) {
    chunks.push({
      data: channels.map(ch => ch.slice(i, end)),  // slice 创建视图
      index: chunks.length,
    });
  }
}
```

### 4.3 reduceResults.js — 加权汇总

**职责**: 将多个分片的结果合并为最终的全局分析结果

```javascript
function reduceResults(results, sampleRate, totalSamples, channelsCount) {
  let globalPeak = 0, rmsSumSq = 0, totalWeight = 0;
  let spectrumBins = null, spectrumWeightSum = 0;
  
  for (const r of results) {
    const w = r.sampleCount || 1;           // 权重 = 该分片的样本数
    if (r.peak > globalPeak) globalPeak = r.peak;  // 峰值取最大值
    rmsSumSq += (r.rms * r.rms) * w;       // RMS 按样本数加权平方和
    totalWeight += w;
    
    // 频谱按样本数加权平均 —— 核心！
    for (let i = 0; i < spectrumBins.length; i++) 
      spectrumBins[i] += (r.spectrum[i] || 0) * w;
    spectrumWeightSum += w;
  }

  const globalRMS = Math.sqrt(rmsSumSq / totalWeight);
  const avgSpectrum = spectrumBins.map(v => v / spectrumWeightSum);
  // ...
}
```

**汇总策略对比**:

| 指标 | 汇总方式 | 数学原理 |
|------|---------|---------|
| 峰值 (Peak) | 取最大值 | `globalPeak = max(peaks)` |
| RMS | 加权平方和再开方 | `√(Σ(rms² × w) / Σw)` |
| 频谱 | 加权平均 | `Σ(spectrum × w) / Σw` |
| 削波数 | 直接累加 | `Σ(clippedCount)` |
| 立体声相关性 | 加权平均 | `Σ(corr × w) / Σw` |

### 4.4 workerPool.js — 并行调度池

**职责**: 管理 4 个 Worker 的生命周期，提供背压控制

```javascript
export class WorkerPool {
  constructor(workerUrl, size = 4) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl);
      w.onmessage = (e) => this._done(w, e);   // 任务完成回调
      w.onerror = (err) => this._error(w, err); // 错误回调
      this.workers.push(w);
      this.idle.push(w);                        // 空闲队列
    }
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      // 背压控制：队列超过 50 个任务时截断，防止内存爆炸
      if (this.queue.length > 50) {
        this.queue = this.queue.slice(-50);
      }
      this._dispatch();
    });
  }

  _dispatch() {
    // 只要有等待任务 + 空闲 Worker，就派发
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop();           // 取出空闲 Worker
      const job = this.queue.shift();       // 取出等待任务
      this.callbacks.set(w, job);           // 记录回调
      w.postMessage(job.task);              // 发送任务数据
    }
  }

  _done(w, e) {
    const job = this.callbacks.get(w);
    this.idle.push(w);                     // Worker 归还到空闲队列
    if (job) job.resolve(e.data);          // 触发 Promise resolve
    this._dispatch();                      // 继续派发下一个
  }
}
```

**设计要点**:
- Promise 化接口：`pool.run(task)` 返回 Promise，调用方用 `await` 等待
- 背压控制：队列上限 50 个任务，防止无限堆积导致 OOM
- 自动调度：每次完成/失败后自动触发下一轮派发

### 4.5 safeRunner.js — 错误隔离

```javascript
export async function safeRun(fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    console.error("[SAFE ERROR]", e);
    return fallback;
  }
}
```

简单的 try-catch 包装器，确保单个模块崩溃不影响整体流程。

---

## 五、worker/analyze.worker.js — 分片 FFT 分析 Worker

**路径**: `worker/analyze.worker.js`
**职责**: 在独立线程中执行 FFT 频谱分析，不阻塞 UI

### 核心参数

```javascript
const FFT_SIZE = 2048;       // FFT 点数（2 的幂）
const SPECTRUM_BINS = 512;   // 输出频段数（FFT_SIZE / 4）
```

### Hann 窗函数

```javascript
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}
```

**为什么用 Hann 窗**: 减少频谱泄漏。如果不加窗（相当于矩形窗），信号在非整数周期截断时会产生旁瓣，导致频谱能量扩散到相邻频率。Hann 窗在频率分辨率和旁瓣抑制之间做了最佳平衡。

### Cooley-Tukey FFT（原地计算）

```javascript
function fftInPlace(real, imag, n, inverse) {
  // 第一步：位逆序重排（Bit-reversal permutation）
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let m = n >> 1;
    while (m > 0 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  
  // 第二步：蝶形运算（Butterfly）
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    // 旋转因子 (Twiddle factor)
    // W_n^k = cos(2πk/n) - j·sin(2πk/n)
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    
    for (let i = 0; i < n; i += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const re = real[i + j + half] * wr - imag[i + j + half] * wi;
        const im = real[i + j + half] * wi + imag[i + j + half] * wr;
        real[i + j + half] = real[i + j] - re;
        imag[i + j + half] = imag[i + j] - im;
        real[i + j] += re;
        imag[i + j] += im;
        
        // 递推计算下一个旋转因子: W^{k+1} = W^k × W^1
        const tmp = wr * cosA - wi * sinA;
        wi = wr * sinA + wi * cosA;
        wr = tmp;
      }
    }
  }
  
  if (inverse) {
    for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; }
  }
}
```

**FFT 算法复杂度**: O(N·log₂N)，2048 点 FFT 只需约 22528 次运算（暴力 DFT 需要 400 万次）。

### 频谱计算

```javascript
function analyzeChunk(channels, sampleRate) {
  // 重叠窗口：每次跳过 FFT_SIZE/2 个样本（50% overlap）
  const numFrames = Math.floor((len - FFT_SIZE) / (FFT_SIZE / 2)) + 1;
  
  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * (FFT_SIZE / 2);
    
    // 预处理：立体声取平均、单声道直取、加窗
    for (let i = 0; i < FFT_SIZE; i++) {
      val = (channels[0][offset + i] + channels[1][offset + i]) / 2;
      fftReal[i] = val * window[i];   // 加窗
      fftImag[i] = 0;                  // 虚部初始为 0
      
      // 同时累加时间域指标
      if (abs > peak) peak = abs;
      rmsSumSq += val * val;
      if (abs >= 0.999) clippedCount++; // 削波检测
    }
    
    fftInPlace(fftReal, fftImag, FFT_SIZE, false);  // 执行 FFT
    
    // 频谱降采样：512 bins 覆盖 0 ~ Nyquist
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const freqIdx = Math.round((b / SPECTRUM_BINS) * (FFT_SIZE / 2));
      const mag = Math.sqrt(fftReal[freqIdx]² + fftImag[freqIdx]²);
      spectrumAccum[b] += mag;  // 累加平均
    }
  }
  
  // 最终频谱取每帧平均
  const spectrum = spectrumAccum.map(v => v / numFrames);
}
```

**50% 重叠的原因**: 减少窗函数边缘衰减造成的信息丢失。如果信号峰值恰好落在窗口边缘，Hann 窗会把它压得很低。50% 重叠确保了每个样本在相邻两帧中至少有一次靠近窗口中心。

### 立体声分析

```javascript
if (numChannels >= 2) {
  // Mid/Side 分解
  // Mid = (L+R)/2 → 单声道兼容信号（人声、底鼓）
  // Side = (L-R)/2 → 立体声差异信号（空间信息）
  const mid = (L + R) / 2;
  const side = (L - R) / 2;
  midRMS = √(Σ(mid²) / len);
  sideRMS = √(Σ(side²) / len);
  
  // 相关性估算：side/mid 比值越小 ≈ 越接近单声道
  // 简化公式：corr = 1 - min(sideRMS/midRMS, 1)
  stereoCorrelation = 1 - Math.min(sideRMS / midRMS, 1);
}
```

---

## 六、renderer/app.js — 前端主逻辑（核心文件）

**路径**: `renderer/app.js` (~2900 行)
**加载方式**: `<script type="module" src="./app.js">` （ES Module）

### 6.1 文件格式解析器 parseFormatFromBytes()

这是一个**无依赖的二进制文件头解析器**，通过读取文件前 256 字节的魔数（Magic Bytes）识别 20+ 种音频格式：

```javascript
function parseFormatFromBytes(bytes) {
  const sig4 = readStr(0, 4);  // 前 4 字节
  const sig3 = readStr(0, 3);  // 前 3 字节
  
  // RIFF → WAV/RF64
  if (sig4 === 'RIFF' && riffType === 'WAVE') { /* 解析 fmt chunk */ }
  // fLaC → FLAC (解析 STREAMINFO 获取采样率/声道/位深)
  if (sig4 === 'fLaC') { /* 读 STREAMINFO block */ }
  // OggS → OGG/Opus
  if (sig4 === 'OggS') { /* 检测 Vorbis vs Opus */ }
  // ID3 → MP3 (扫描同步字 0xFFE0 解析帧头)
  if (sig3 === 'ID3') { /* 扫描 MPEG 帧头 */ }
  // ftyp → MP4/M4A/ALAC (遍历 Box Tree)
  if (ftypBox === 'ftyp') { /* 解析 brand + stsd box */ }
  // FORM → AIFF/AIFC
  // MAC  → APE (Monkey's Audio)
  // wvpk → WavPack
  // TTA1 → True Audio
  // DSD  → DSF
  // FRM8 → DFF
  // caff → CAF
  // 0x0B77 → AC-3
  // 0x1A45DFA3 → Matroska/WebM
  // ASF GUID → WMA
}
```

**解析策略**：每种格式的返回值包含 `{ container, codec, format, lossless, channels, sampleRate, bitDepth }`。

### 6.2 MP4 Box Tree 解析器 parseMP4BoxTree()

MP4/M4A 使用 ISO Base Media File Format，数据结构是嵌套的 Box（也叫 Atom）树。这个解析器递归遍历整棵树：

```
Root
├── ftyp (文件类型)
├── moov (元数据容器)
│   ├── mvhd (影片头)
│   └── trak (轨道)
│       └── mdia (媒体)
│           └── minf (媒体信息)
│               └── stbl (采样表)
│                   ├── stsd (采样描述 → codec/channels/sr)
│                   ├── stsz/stz2 (每帧字节数)
│                   ├── stco/co64 (chunk 偏移量)
│                   ├── stsc (sample → chunk 映射)
│                   └── stts (时间戳解码表)
└── mdat (原始媒体数据)
```

**design rationale**: 很多 M4A/ALAC 文件浏览器无法解码，通过直接解析 Box Tree 可以：
1. 人工定位 `mdat` box 中每个音频帧的字节偏移
2. 将帧数据喂给 WebCodecs `AudioDecoder` 或纯 JS ALAC 解码器
3. 提取 ALAC `magic cookie` (AudioSpecificConfig) 用于解码器初始化

### 6.3 多级解码策略

```javascript
async function processSingleFile(file) {
  const rawBytes = new Uint8Array(await file.arrayBuffer());
  const binInfo = parseFormatFromBytes(rawBytes);
  
  // 策略 1: AudioElement 解码（浏览器原生，兼容性最好）
  try {
    const r = await decodeViaAudioElement(file);   // 30s 超时
    buffer = r.buffer; decodeMethod = 'AudioElement';
  } catch (e1) {
    // 策略 2: Pure JS ALAC 解码器（M4A/ALAC 专用）
    if (binInfo && binInfo.codec === 'ALAC') {
      try {
        const r = await decodeALACWithPureJS(rawBytes);
        buffer = r.buffer; decodeMethod = 'Pure JS ALAC';
      } catch (e2) {}
    }
    // 策略 3: WebCodecs AudioDecoder（现代浏览器，低延迟）
    if (!buffer && (binInfo.container === 'MP4' || ...)) {
      try {
        const r = await decodeWithWebCodecs(rawBytes);
        buffer = r.buffer; decodeMethod = 'WebCodecs';
      } catch (e3) {}
    }
  }
  // 全局 60s 超时保护
}
```

### 6.4 纯 JS ALAC 解码器

这是项目中最复杂的算法模块，**完整实现了 Apple Lossless (ALAC) 解码器**的纯 JavaScript 版本。

**ALAC 帧结构**:
```
[Frame Header]
  - predOrder (5 bits)    → 预测器阶数
  - coefs[] (16 bits × N) → 预测系数
  - frameCount (32 bits)  → 本帧样本数

[Per Channel]
  - riceK (4 bits)        → Rice 编码参数 k
  - history (32 bits)     → 初始历史值
  - sign (1 bit)          → 符号位
  - Rice-coded residuals  → 残差编码数据
```

**位读取器 createALACBitReader()**:
```javascript
function createALACBitReader(data, offset, length) {
  let pos = offset, bitCount = 0, bitBuf = 0;
  return {
    readBits(n) {
      let val = 0;
      for (let i = 0; i < n; i++) {
        if (bitCount === 0) {            // 缓冲用完了，读下一字节
          bitBuf = data[pos++];
          bitCount = 8;
        }
        val = (val << 1) | (bitBuf >> 7); // 取最高位
        bitBuf = (bitBuf << 1) & 0xFF;    // 左移，最高位丢弃
        bitCount--;
      }
      return val;
    },
    // ...
  };
}
```

**Rice 解码**（Golomb-Rice coding 变种）:
```javascript
const riceDecode = (k, history, outFn) => {
  let hs = history;
  for (let i = 0; i < fc; i++) {
    // 1. 数前导零的个数 (unary code)
    let lz = 0;
    while (reader.readBit() === 0) { lz++; }
    
    // 2. 读取 k 位定长码 (binary code)
    const q = reader.readBits(k);
    
    // 3. 重建值: value = (lz << k) | q
    const val = (lz << k) | q;
    hs += val;      // 累加（差分编码的反操作）
    outFn(i, hs);   // 输出样本值
  }
};
```

**Rice 编码原理**: 将整数值 v 拆成两部分：
- 商 q = v / 2^k → 用 unary code 表示（q 个 0 + 1 个 1）
- 余数 r = v % 2^k → 用 k 位 binary code 表示
- 总比特数 = q + 1 + k
- 小数值短编码，大数值长编码 — 类似于 Huffman 但不需码表

### 6.5 分析核心 analyzeFull()

**这是当前版本实际使用的分析函数**（替代了 Worker Pool 分片方案），在主线程上一遍完成完整 FFT 分析：

```javascript
function analyzeFull(pcmChannels, sampleRate) {
  const ch0 = pcmChannels[0];
  const len = ch0.length;
  
  // ====== Pass 1: 时间域分析 ======
  let peak = 0, dcSum = 0, clippedSamples = 0;
  let rmsSumSq = 0;
  
  // RMS 分块计算（每 65536 个样本一块），防浮点溢出
  const BLOCK = 65536;
  for (let i = 0; i < len; i++) {
    // 峰值
    const abs = Math.abs(ch0[i]);
    if (abs > peak) peak = abs;
    // 削波（样本值 >= 0.999 视为削波）
    if (abs >= 0.999) clippedSamples++;
    // 直流分量
    dcSum += ch0[i];
    
    // RMS 分块累加
    rmsSumSq += ch0[i] * ch0[i];
    blockCount++;
    if (blockCount >= BLOCK || i === len - 1) {
      totalRmsSum += rmsSumSq;
      rmsSumSq = 0; blockCount = 0;
    }
  }
  
  const rms = Math.sqrt(totalRmsSum / len);
  const dcOffset = dcSum / len;
  
  // ====== Pass 2: 频率域 FFT 分析 ======
  const FFT_SIZE = 2048;
  const window = hannWindow(FFT_SIZE);
  const spectrumAccum = new Float32Array(512);
  const numFrames = Math.floor((len - FFT_SIZE) / (FFT_SIZE / 2)) + 1;
  
  for (let frame = 0; frame < numFrames; frame++) {
    // 加窗
    for (let i = 0; i < FFT_SIZE; i++) {
      fftReal[i] = ch0[offset + i] * window[i];
    }
    // FFT
    fftInPlace(fftReal, fftImag, FFT_SIZE, false);
    // 累加频谱
    for (let b = 0; b < 512; b++) {
      const freqIdx = Math.round((b / 512) * (FFT_SIZE / 2));
      const mag = Math.sqrt(fftReal[freqIdx]² + fftImag[freqIdx]²);
      spectrumAccum[b] += mag;
    }
  }
  
  const avgSpectrum = spectrumAccum.map(v => v / numFrames);
  // 归一化：线性幅度转 dB，峰值对齐到 0dB
  const spectrumDB = avgSpectrum.map(v => 20 * Math.log10(v / maxVal));
}
```

**为什么用 65536 块大小**: 单精度浮点数 (Float32) 有约 7 位有效数字。一首 4 分钟的 CD 音质歌曲有约 1058 万个样本。如果直接累加所有平方和，小数会被大数"淹没"（浮点精度丢失）。分块计算可以将每个块的累加值控制在安全范围内。

### 6.6 显示数据计算 computeDisplayData()

```javascript
function computeDisplayData(pcmChannels, sampleRate, analysis) {
  // 1. 频谱图数据 (4096-pt FFT, ~1200 列, 2048 bins)
  // 2. 波形数据 (下采样到 ~2000 点)
  // 3. 声谱频段能量 (对数频率分度)
  // 4. 相位数据 (Lissajous 图, 前 10 秒)
  // 5. 响度曲线 (短时 LUFS 模拟)
  // 6. SNR 数据 (分段信噪比)
  // 7. 失真数据 (谐波结构检测)
}
```

### 6.7 Canvas 渲染函数

所有图表都使用原生 Canvas 2D API 绑定，无任何第三方图表库：

| 函数 | 画布 ID | 内容 |
|------|---------|------|
| `drawSpectrumCanvas()` | `spectrumCanvas` | 频率频谱曲线（dB vs Hz） |
| `drawSpectrogramCanvas()` | `specCanvas` | 频谱图热力图（magma 色表） |
| `drawSoundSpectrumCanvas()` | `bandCanvas` | 频段能量柱状图（HSL 渐变色） |
| `drawWaveformCanvas()` | `waveCanvas` | 波形预览 |
| `drawPhaseCanvas()` | `phaseCanvas` | Lissajous 相位示波器 |
| `drawLoudnessCurveCanvas()` | `loudnessCurveCanvas` | 响度历史曲线（LUFS over time） |
| `drawSNRCanvas()` | `snrCanvas` | 分段信噪比柱状图 |
| `drawDistortionCanvas()` | `distortionCanvas` | 谐波结构柱状图 |

**HiDPI 适配**: 所有画布都使用 `devicePixelRatio` 缩放：
```javascript
const dpr = window.devicePixelRatio || 1;
canvas.width = W * dpr;
canvas.height = H * dpr;
canvas.style.width = W + 'px';
canvas.style.height = H + 'px';
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // 缩放坐标系
```

**magma 色表** (用于频谱图):
使用 34 段线性插值模拟科学可视化标准 magma 色表，从深紫到亮黄，感知均匀。

### 6.8 智能分析报告系统

包含 12 个 `narrate*()` 函数，为每个分析维度生成**中文自然语言解读**：

- `generateNarrative()` — 综合分析报告
- `narrateSpectrum()` — 频谱解读（低频/中频/高频能量分布）
- `narrateSpectrogram()` — 频谱图解读
- `narrateBandSpectrum()` — 声谱三频解读
- `narrateWaveform()` — 波形动态解读
- `narrateDynamics()` — 动态范围解读
- `narrateLoudnessCurve()` — 响度曲线解读
- `narrateStereo()` — 立体声/反相解读
- `narrateQuality()` — 质量评估解读
- `narrateFileInfo()` — 文件信息解读
- `narrateSNR()` — 信噪比解读
- `narrateDistortion()` — 失真解读

### 6.9 根因诊断引擎 diagnoseRootCause()

这是智能分析的核心，根据多维度指标的**组合模式**推断根本原因：

**诊断规则优先级**:
```
1. 高响度 + 削波 + 低 Crest → "母带风格：硬限幅 (Brickwall Limiter)"
2. 无削波 + 低 Crest + 高峰值 → "母带风格：软削波 / 饱和式限幅"
3. 高采样率 + 频谱截断 + 高置信度 → "伪高解析度（升频文件）"
4. 削波 + 高 Crest + 低响度 → "录音增益设置过高"
5. 高比特深度 + 有削波 → "录音链路增益级联不当"
6. 反相 → "立体声极性反转"
7. 极端立体声加宽 → "Stereo Widener 效果器"
8. 低 LRA + 高响度 → "广播/电台级压缩"
9. 高 Crest + 低响度 → "古典乐/原声录音特征"
10. 16-bit 标称 + 24-bit 容器 → "升比特文件"
```

---

## 七、renderer/index.html — 页面结构

**路径**: `renderer/index.html`

页面采用**左侧边栏 + 右侧主内容**的经典布局：

```html
<div class="app">
  <!-- 左侧导航 -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>Audio Analyzer Pro</h1>
    </div>
    <nav class="sidebar-nav">
      <!-- 9 个导航项：总览/频谱/频谱图/声谱/波形/响度/分析报告/调试日志 -->
      <div class="nav-item active" data-section="overview">总览</div>
      <div class="nav-item" data-section="spectrum">频谱分析</div>
      <!-- ... -->
    </nav>
  </aside>

  <!-- 右侧主内容 -->
  <main class="main">
    <header class="topbar">
      <button class="btn" id="btnOpen">打开文件</button>
      <button class="btn" id="btnOpenFolder">批量导入</button>
      <span class="worker-status idle">Worker 空闲</span>
    </header>

    <div class="content" id="content">
      <!-- 动态渲染的 section 容器 -->
    </div>
  </main>
</div>

<script type="module" src="./app.js"></script>
```

**关键**: `<script type="module">` — ES Module 加载，天然支持 `import/export`，无需打包工具。

---

## 八、renderer/styles.css — 样式系统

**路径**: `renderer/styles.css` (~220 行)

### 设计系统

使用 CSS 自定义属性定义完整的暗色主题 Token：

```css
:root {
  --bg0: #0d1117;   /* 最深背景（GitHub 暗色） */
  --bg1: #161b22;   /* 卡片/侧边栏 */
  --bg2: #21262d;   /* 按钮/表头 */
  --bg3: #30363d;   /* 边框/悬停 */
  --fg0: #e6edf3;   /* 主文字 */
  --fg1: #c9d1d9;   /* 次级文字 */
  --fg2: #8b949e;   /* 三级文字 */
  --fg3: #6e7681;   /* 暗淡文字 */
  --ac:  #58a6ff;   /* 主题蓝 */
  --gr:  #3fb950;   /* 绿色（通过） */
  --ye:  #d29922;   /* 黄色（警告） */
  --re:  #f85149;   /* 红色（失败） */
  --pu:  #bc8cff;   /* 紫色 */
  --cy:  #39d2c0;   /* 青色 */
}
```

### 布局技巧

- **流式布局**: 侧边栏 280px 固定，主内容 flex: 1 自适应
- **可折叠帮助面板**: `max-height: 0 → 2000px` 过渡动画
- **响应式**: `@media(max-width:768px)` 侧边栏切换为水平导航

---

## 九、utils/ — 工具模块

### dom.js
```javascript
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
```
jQuery 风格的 DOM 快捷选择器，减小代码量。

### format.js
```javascript
function fmtSize(b)  // 字节 → "1.5 MB"
function fmtDur(s)   // 秒 → "3:45" 或 "1:23:45"
function sleep(ms)   // Promise 延时
```

### logger.js (D 对象)
在 app.js 内联定义，用于调试日志。支持：
- 按级别分类（info/ok/warn/err）
- 自动渲染到 DOM 的 `#debugBody`
- 计数统计 + 错误自动展开
- DOM 节点数上限 500 条、数据上限 1000 条（防内存泄漏）

---

## 十、package.json — 项目配置与打包

**路径**: `package.json`

```json
{
  "name": "audio-analyzer-v2",
  "version": "2.0.0",
  "description": "Audio Analyzer Pro V2 — 专业音频质量分析桌面工具",
  "main": "main.js",
  "scripts": {
    "start": "electron .",             // 开发模式启动
    "build": "electron-builder",        // 打包 EXE
    "postinstall": "electron-builder install-app-deps"
  },
  "build": {
    "appId": "audio.analyzer.v2",
    "productName": "Audio Analyzer Pro",
    "directories": { "output": "dist" },
    "files": [                          // 打包包含的文件
      "main.js",
      "preload.js",
      "renderer/**/*",
      "worker/**/*",
      "core/**/*",
      "utils/**/*",
      "assets/**/*"
    ],
    "win": {
      "target": "nsis",                // NSIS 安装程序
      "icon": "build/icon.png"
    },
    "nsis": {
      "oneClick": false,               // 非一键安装（允许选路径）
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true    // 创建桌面快捷方式
    }
  },
  "devDependencies": {
    "electron": "latest",
    "electron-builder": "latest"
  }
}
```

### 打包命令

```bash
npm run build
```

这会在 `dist/` 目录生成两个产物：
1. `Audio Analyzer Pro Setup 2.0.0.exe` — NSIS 安装程序 (~99 MB)
2. `win-unpacked/` — 绿色免安装版（可直接运行）

### NSIS vs Portable

| 特性 | NSIS 安装版 | 绿色便携版 |
|------|-----------|-----------|
| 桌面快捷方式 | 自动创建 | 需手动创建 |
| 卸载程序 | 包含 | 直接删除文件夹 |
| 文件关联 | 可选 | 不支持 |
| 注册表 | 写入信息 | 不写注册表 |

---

## 十一、完整分析管线数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                        文件输入                                   │
│  拖放 / 文件对话框 → File API / Electron IPC                     │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                     二进制格式识别                                │
│  parseFormatFromBytes(rawBytes)                                  │
│  → 魔数匹配: RIFF/fLaC/OggS/ID3/ftyp/FORM/MAC/wvpk/TTA1/DSD... │
│  → 输出: { container, codec, format, lossless, channels, sr }   │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                     多级解码引擎                                  │
│  ① AudioElement.decodeAudioData() ← 浏览器原生，优先            │
│  ② Pure JS ALAC 解码器            ← M4A/ALAC 兜底               │
│  ③ WebCodecs AudioDecoder          ← 现代浏览器                 │
│  ④ FFmpeg.wasm                     ← 终极兜底 (当前未启用)       │
│  → 输出: AudioBuffer (Float32 多声道 PCM)                       │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                     analyzeFull() 全量 FFT 分析                   │
│  Pass 1 (时域):                                                  │
│    • Peak 检测 → max(abs(sample))                                │
│    • RMS 计算 → sqrt(Σ(s²)/N)，分块 65536                       │
│    • DC Offset → Σ(sample)/N                                     │
│    • Clipping → count(abs(sample) ≥ 0.999)                      │
│    • 立体声 Mid/Side RMS                                         │
│  Pass 2 (频域):                                                  │
│    • 2048-pt FFT, Hann window, 50% overlap                      │
│    • ~2000 帧平均 → 512-bin 平均频谱                             │
│    • 幅度 → dB 转换                                              │
│  → 输出: { peak, rms, spectrum[], normSpectrum[], dcOffset,     │
│            clippedSamples, stereoCorrelation, midRMS, sideRMS }  │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                    computeDisplayData() 显示数据计算              │
│  • 频谱图: 4096-pt FFT, ~1200列, 2048 bins                     │
│  • 波形图: 下采样 ~2000 点                                       │
│  • 声谱频段: 对数频率分度, 30 频段                                │
│  • 响度曲线: 3s 滑动窗短时 LUFS (简化)                           │
│  • SNR: 分段信噪比 (低频/中频/高频)                               │
│  • 失真: 自相关基频检测 + 谐波能量提取                            │
│  • 相位: 前 10 秒 Lissajous 散点                                │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                  adaptAnalysis() 数据适配                         │
│  扁平结果 → 渲染层嵌套结构                                        │
│  • clip { peakDB, hasClipping, clippedSamples, clippedPct }     │
│  • dynamics { crest }                                           │
│  • loudness { integratedLoudnessLUFS, shortTermMaxLUFS, lra }   │
│  • dcOffset { offset, isSignificant, dcDB }                     │
│  • stereo { correlation, stereoWidth, isOutOfPhase }            │
│  • actualBitDepth { estimated, note }                           │
│  • cutoff { bw, freq, confidence }                              │
│  • quality[] — 8 项通过/警告/失败                                │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│                    renderAll() + Canvas 绑图                      │
│  renderOverview → 总览卡片 + generateNarrative()                 │
│  renderSpectrum → <canvas> + drawSpectrumCanvas()               │
│  renderSpectrogram → <canvas> + drawSpectrogramCanvas()         │
│  renderSoundSpectrum → <canvas> + drawSoundSpectrumCanvas()     │
│  renderWaveform → <canvas> + drawWaveformCanvas()               │
│  renderDynamics → 动态范围卡片                                   │
│  renderLoudnessCurve → <canvas> + drawLoudnessCurveCanvas()     │
│  renderSNR → <canvas> + drawSNRCanvas()                         │
│  renderDistortion → <canvas> + drawDistortionCanvas()           │
│  renderStereo → 立体声卡片 + drawPhaseCanvas()                   │
│  renderQuality → 质量评估卡片                                    │
│  renderFileInfo → 文件详情卡片                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 十二、关键技术决策总结

| 决策 | 选择 | 原因 |
|------|------|------|
| 桌面框架 | Electron | 跨平台、Web 技术栈、NSIS 打包 |
| 模块系统 | ES Module | 原生浏览器支持，无需 Webpack |
| FFT 大小 | 2048 点 | 频率分辨率 ~21.5Hz @ 44100Hz，实时可承受 |
| 频谱 bins | 512 | log-scale 视觉更自然，约等于 1/12 octave |
| 窗函数 | Hann | 主瓣窄、旁瓣衰减快，通用最佳 |
| FFT 重叠 | 50% | 补偿窗函数边缘衰减 |
| RMS 分块 | 65536 样本 | 防止 Float32 精度丢失 |
| Worker 数 | 4 | 匹配主流 CPU 核心数 |
| 解码优先级 | AudioElement > PureJS > WebCodecs | 兼容性降级 |
| 打包工具 | electron-builder + NSIS | Windows 原生安装体验 |
| 安全模型 | contextIsolation + preload | Electron 安全最佳实践 |

---

## 十三、如何发给其他 AI 分析

本文件包含了项目的**全部架构、算法原理和关键代码**，可以直接作为上下文发给 ChatGPT、Claude 等 AI。

建议搭配以下 prompt 使用：

```
请分析这个 Electron 音频分析工具的源码文档，这是一个专业音频质量分析桌面应用。
请重点关注：
1. 架构设计是否合理
2. FFT/DSP 算法实现是否正确
3. 有哪些可以优化的地方
4. 安全方面是否有隐患
```

---

*文档生成时间: 2026-07-06*
*源项目: AudioAnalyzer_V2 (Electron EXE 版)*


---

## K. 完整前端主逻辑 — renderer/app.js（全 2939 行）

```javascript
// ═══════════════════════════════════════════════════════════════
//  Audio Analyzer Pro v8.0 — V3 产品级
//  app.js — 入口 / 初始化 / DOM 事件 / UI 渲染
// ═══════════════════════════════════════════════════════════════

import { AnalyzeEngine } from "../core/analyzeEngine.js";

const engine = new AnalyzeEngine();

// ── V3 分析结果适配器（扁平结构 → 渲染层嵌套结构） ──
function adaptAnalysis(raw, formatInfo) {
  const peakDB = raw.peak > 0 ? 20 * Math.log10(raw.peak) : -Infinity;
  const dcVal = raw.dcOffset || 0;
  return {
    peak: raw.peak, rms: raw.rms, crestFactor: raw.crestFactor,
    dynamicRangeDB: raw.dynamicRangeDB, spectrum: raw.spectrum,
    normSpectrum: raw.normSpectrum, sampleRate: raw.sampleRate,
    totalSamples: raw.totalSamples, channelsCount: raw.channelsCount,
    _chunked: raw._chunked, _chunkCount: raw._chunkCount,
    clip: {
      peakDB,
      truePeakDB: isFinite(peakDB) ? (peakDB + 0.2).toFixed(2) : '-96.00',
      hasClipping: (raw.clippedSamples || 0) > 0,
      hasTruePeakOver: (raw.clippedSamples || 0) > 100,
      clippedSamples: raw.clippedSamples || 0,
      clippedPct: (raw.clipRatio || 0) * 100,
      maxConsecutiveClip: 0,
    },
    dynamics: { crest: raw.crestFactor || 0 },
    loudness: {
      integratedLoudnessLUFS: -(raw.dynamicRangeDB || 18) - 8,
      shortTermMaxLUFS: -(raw.dynamicRangeDB || 18) - 10,
      lra: 8.0,
    },
    dcOffset: {
      offset: dcVal,
      isSignificant: Math.abs(dcVal) > 0.001,
      dcDB: Math.abs(dcVal) > 1e-10 ? 20 * Math.log10(Math.abs(dcVal)) : -120,
    },
    stereo: raw.stereoCorrelation !== null ? {
      stereoWidth: (raw.stereoWidth || 0) * 100,
      correlation: raw.stereoCorrelation,
      midRMS: raw.midRMS,
      sideRMS: raw.sideRMS,
      isOutOfPhase: raw.stereoCorrelation < 0,
      phaseInversionPct: raw.stereoCorrelation < 0 ? Math.abs(raw.stereoCorrelation) * 10 : 0,
      midSideRatio: raw.midRMS && raw.sideRMS ? 20 * Math.log10(raw.midRMS / Math.max(raw.sideRMS, 0.0001)) : 0,
    } : null,
    isCommercialMaster: (raw.clippedSamples || 0) > 0 && (raw.dynamicRangeDB || 99) < 14,
    actualBitDepth: {
      estimated: formatInfo?.bitDepth || 16,
      note: formatInfo?.bitDepth ? `基于文件格式 (${formatInfo.bitDepth}-bit)` : '未计算',
    },
    cutoff: { bw: 100, freq: raw.sampleRate / 2, confidence: 'low' },
    quality: [
      ['削波', (raw.clippedSamples || 0) > 0 ? 'warn' : 'pass'],
      ['动态范围', raw.dynamicRangeDB > 10 ? 'pass' : 'warn'],
      ['响度', 'pass'],
      ['LRA', 'pass'],
      ['TP过载', 'pass'],
      ['DC Offset', Math.abs(dcVal) > 0.001 ? 'warn' : 'pass'],
      ['格式', formatInfo?.lossless ? 'pass' : 'warn'],
      ['位深度', (formatInfo?.bitDepth || 16) >= 16 ? 'pass' : 'warn'],
    ],
  };
}

window.__TRACE = {
  step: (name) => { console.log('[TRACE]', name, performance.now().toFixed(1)); }
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
    if (this._errCount > 0) { $('#debugConsole').classList.add('open'); }
  }
};

function toggleDebug() { $('#debugConsole').classList.toggle('open'); }
window.toggleDebug = toggleDebug;

// ═══════════════════════════════════════════════════════════════
//  异步分片执行器（防 UI 冻结）
// ═══════════════════════════════════════════════════════════════

function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

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

const fi = $('#fileInput');
if (fi) fi.addEventListener('change', async function() {
  if (this.files.length) await processFiles([...this.files]);
});

const bb = $('#btnBrowse');
if (bb) bb.addEventListener('click', () => $('#fileInput').click());

function isAudioFile(f) {
  const exts = '.flac.wav.aiff.aif.alac.m4a.mp3.aac.ogg.opus.wma.ape.wv.tta.dsf.dff.caf.ac3.eac3.mka.webm.w64.rf64';
  const name = f.name.toLowerCase();
  return f.type.startsWith('audio/') || exts.split('.').some(e => name.endsWith('.' + e));
}

const dh = $('#debugHeader');
if (dh) dh.addEventListener('click', toggleDebug);

// ═══════════════════════════════════════════════════════════════
//  文件头格式解析 — 覆盖所有格式（WAV/FLAC/OGG/MP3/MP4/AIFF/APE/WavPack/TTA/DSF/DFF/CAF/AC3/Matroska/WMA）
// ═══════════════════════════════════════════════════════════════

function parseFormatFromBytes(bytes) {
  // ... [完整实现见前文章节 6.1，含 20+ 格式魔数匹配、RIFF chunk 解析、MPEG 帧头扫描、MP4 Box 探测等]
  // 此处为完整源码占位 — 实际包含全部 ~250 行二进制解析逻辑
  // 完整代码在 14.6 节已详细展示
}

// ═══════════════════════════════════════════════════════════════
//  MP4 Box Tree 解析器 & ALAC 提取
// ═══════════════════════════════════════════════════════════════

function parseMP4BoxTree(rawBytes) {
  // ... [完整实现见前文章节 6.2，递归遍历 ISO BMFF Box Tree]
  // 完整代码在 14.6 节已详细展示
}

function findChild(parent, type) { /* ... */ }
function findAllChildren(parent, type) { /* ... */ }
function extractMP4Info(rawBytes, tree) { /* ... */ }
function readStrHelper(data, offset, len) { /* ... */ }
function extractASCFromESDS(esds) { /* ... */ }
function parseALACConfig(config) { /* ... */ }
function parseSampleTable(rawBytes, tree, info) { /* ... */ }

// ═══════════════════════════════════════════════════════════════
//  解码器: WebCodecs + Pure JS ALAC + FFmpeg 兜底
// ═══════════════════════════════════════════════════════════════

async function decodeWithWebCodecs(rawBytes) { /* ... [完整实现见前文] */ }
function buildAudioBuffer(frames, sr, ch) { /* ... */ }
function createALACBitReader(data, offset, length) { /* ... */ }
function decodeOneALACFrame(reader, cfg, channels) { /* ... */ }
function writeInterleavedPCM(output, outputPos, chSamples, channels, maxVal) { /* ... */ }
function decodeALACFramesToPCM(frameDataList, config, sampleRate, channels) { /* ... */ }
function decodeALACSequential(rawBytes, audioStart, audioEnd, config, sampleRate, channels, totalFrames, frameLength) { /* ... */ }
function createAudioBufferFromPCM(pcmData, sampleRate, channels) { /* ... */ }
async function decodeALACWithPureJS(rawBytes) { /* ... */ }

const CDN_LIST = ['https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js', 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js'];

async function initFFmpegFallback() { /* ... */ }
function PromiseWithTimeout(promise, ms) { /* ... */ }
async function decodeViaAudioElement(file) { /* ... */ }
function tryAudioElementDecode(url, fname) { /* ... */ }
async function decodeWithFFmpeg(file, rawBytes) { throw new Error('FFmpeg.wasm 不可用'); }

// ═══════════════════════════════════════════════════════════════
//  文件处理管线（批量处理 + 单文件处理 + 引擎调用）
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

  if (binInfo && binInfo.channels) channels = binInfo.channels;
  if (binInfo && binInfo.sampleRate) sampleRate = binInfo.sampleRate;

  const duration = buffer.duration || (buffer.length / sampleRate);

  const F = {
    container: (binInfo && binInfo.container) || 'Unknown',
    codec: (binInfo && binInfo.codec) || 'Unknown',
    format: (binInfo && binInfo.format) || 'Unknown',
    lossless: binInfo ? !!binInfo.lossless : true,
    channels, sampleRate, duration,
    bitDepth: (binInfo && binInfo.bitDepth) || (buffer.numberOfChannels > 0 && sampleRate > 0 ? null : 16),
    fileSize: file.size, filename: file.name,
    decodeMethod,
    actualBitrate: Math.round(file.size * 8 / (duration || 1)),
  };

  STATE.channels = channels; STATE.sampleRate = sampleRate; STATE.duration = duration;
  STATE.buffer = buffer; STATE.formatInfo = F; STATE.file = file;

  D._suppressDOM = false;
  D.ok('FILE', `解码完成: ${decodeMethod}, ${F.codec}, ${channels}ch, ${(sampleRate/1000).toFixed(1)}kHz, ${duration.toFixed(1)}s`);

  // ── 分析引擎（切片 → Worker Pool → 汇总） ──
  const pcmChannels = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    pcmChannels.push(new Float32Array(buffer.getChannelData(ch)));
  }

  D.info('WORKER', `=] 开始引擎分析, channels=${pcmChannels.length}x${pcmChannels[0]?.length}, sr=${sampleRate}`);
  const t0 = performance.now();
  let rawResult;
  try {
    rawResult = await engine.run(pcmChannels, sampleRate, (ratio) => updateProgress(Math.round(ratio * 100)));
    const t1 = performance.now();
    D.ok('WORKER', `] 引擎完成: ${((t1-t0)/1000).toFixed(2)}s, chunks=${rawResult._chunkCount}, peak=${rawResult.peak?.toFixed(3)}, rms=${rawResult.rms?.toFixed(4)}`);
  } catch (ee) {
    D.err('WORKER', `引擎崩溃: ${ee.message}`);
    console.error('Engine error:', ee);
    return null;
  }

  try {
    STATE.analysis = adaptAnalysis(rawResult, F);
    D.ok('WORKER', `adaptAnalysis 完成, quality=${STATE.analysis.quality?.length}项`);
  } catch (ee) {
    D.err('WORKER', `adaptAnalysis 崩溃: ${ee.message}`);
    return null;
  }

  updateProgress(100);
  D.ok('WORKER', `分析完成, peak=${STATE.analysis.peak?.toFixed(3)}`);
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
}

// ═══════════════════════════════════════════════════════════════
//  分析引擎 — 已迁移到 Worker (worker/analyze.worker.js)
// ═══════════════════════════════════════════════════════════════

async function runAnalysis() {
  console.warn('[runAnalysis] 此函数已废弃，分析逻辑已迁移到 Worker (worker/analyze.worker.js)。请在 processSingleFile 中使用 Worker 通信。');
}

// ═══════════════════════════════════════════════════════════════
//  智能叙事引擎（12 个 narrate* 函数 — 中文自然语言解读）
// ═══════════════════════════════════════════════════════════════

function generateNarrative(analysis, formatInfo, channels) {
  const A = analysis;
  const F = formatInfo;
  const lines = [];
  const formatDesc = F.lossless
    ? `这是一份<span class="good">${F.codec || '无损'}</span>格式音频，数据逐位完整保留。`
    : `这是一份<span class="warn">${F.codec || '有损'}</span>格式音频，编码过程移除了一部分听觉掩蔽范围内的信号以减小体积。`;
  const srDesc = F.sampleRate >= 96000
    ? `采样率 <b>${(F.sampleRate/1000).toFixed(1)}kHz</b>，属于高解析度范围。`
    : `采样率 <b>${(F.sampleRate/1000).toFixed(1)}kHz</b>，达到 CD 标准。`;
  lines.push(formatDesc + srDesc);

  const cf = A.cutoff;
  if (cf.bw < 80 && F.sampleRate > 48000 && cf.confidence === 'high') {
    lines.push(`<span class="bad">⚠ 频谱在 ${(cf.freq/1000).toFixed(1)}kHz 处截断，很可能由低采样率源<b>升频</b>而来。</span>`);
  }

  const crest = A.dynamics.crest;
  const lufs = A.loudness.integratedLoudnessLUFS;
  lines.push(`综合响度 <b>${lufs.toFixed(1)} LUFS</b>，Crest Factor ${crest.toFixed(1)}dB。`);

  if (A.clip.hasClipping) {
    if (A.isCommercialMaster) {
      lines.push(`<span class="hint">ℹ 检测到 ${A.clip.clippedSamples} 个削波点 — 属于商业母带的常见现象。</span>`);
    } else {
      lines.push(`<span class="bad">⚠ 检测到 ${A.clip.clippedSamples} 个削波点。</span>`);
    }
  }

  if (A.dcOffset.isSignificant) {
    lines.push(`<span class="bad">⚠ 直流偏移 ${(A.dcOffset.offset*100).toFixed(3)}%。</span>`);
  }

  if (A.stereo && A.stereo.isOutOfPhase) {
    lines.push(`<span class="bad">⚠ 左右声道存在反相。</span>`);
  }

  // 根因推断
  const diagnostics = diagnoseRootCause(analysis, formatInfo);
  if (diagnostics.length > 0) {
    lines.push(`<div style="margin-top:14px;padding:10px 14px;background:#0a1925;border-radius:6px;border-left:3px solid var(--ac)"><b style="color:var(--ac);font-size:.82rem">🔍 根因推断</b></div>`);
    for (const d of diagnostics) {
      const sevColor = d.severity === 'good' ? 'var(--gr)' : d.severity === 'bad' ? 'var(--re)' : d.severity === 'warn' ? 'var(--ye)' : 'var(--ac)';
      lines.push(`<p style="margin:6px 0;line-height:1.7"><span style="color:${sevColor};font-weight:600">${d.title}</span><br><span style="font-size:.78rem;color:var(--fg2)">${d.detail}</span></p>`);
    }
  }

  let verdict = '';
  if (A.isCommercialMaster) verdict = `<span class="good">✅ 综合评估：检测到商业母带特征，音频质量正常。</span>`;
  else verdict = `<span class="good">✅ 综合评估：各项技术指标良好。</span>`;
  lines.push(verdict);

  return lines.map(l => `<p style="margin:6px 0;line-height:1.8">${l}</p>`).join('');
}

// narrateSpectrum, narrateSpectrogram, narrateBandSpectrum, narrateWaveform,
// narrateDynamics, narrateStereo, narrateQuality, narrateFileInfo,
// narrateLoudnessCurve, narrateSNR, narrateDistortion
// ... [完整实现见前文章节 6.8，含中文解读文本和 dB/Freq 分析]

// ═══════════════════════════════════════════════════════════════
//  Canvas 渲染函数（8 个 draw*Canvas — HiDPI + GPU 加速）
// ═══════════════════════════════════════════════════════════════

function drawSpectrumCanvas() { /* 频率频谱曲线 — dB vs Hz，蓝色填充，坐标轴网格 */ }
function drawSpectrogramCanvas() { /* 频谱图热力图 — magma 色表，4096-pt FFT，ImageData 直接写入 */ }
function drawSoundSpectrumCanvas() { /* 频段能量柱状图 — HSL 渐变圆角柱，30 频段 */ }
function drawWaveformCanvas() { /* 波形预览 — 下采样矩形象形，镜像显示 */ }
function drawPhaseCanvas() { /* Lissajous 相位图 — 前 10 秒 L/R 散点，对角线=单声道 */ }
function drawLoudnessCurveCanvas() { /* 响度历史曲线 — LUFS over time，-23/-14 参考线 */ }
function drawSNRCanvas() { /* 分段信噪比 — 低频/中频/高频 三色柱状图 */ }
function drawDistortionCanvas() { /* 谐波结构 — 基频/H2/H3/H4/H5 相对电平 */ }
// ... [完整实现见前文章节 6.7]

function magma(t) {
  const c = [[0.001,0.000,0.014],[0.016,0.009,0.084],[0.061,0.013,0.177],[0.118,0.011,0.269],[0.177,0.016,0.347],[0.236,0.024,0.388],[0.292,0.039,0.399],[0.345,0.063,0.393],[0.397,0.089,0.389],[0.447,0.116,0.385],[0.496,0.142,0.384],[0.544,0.169,0.384],[0.592,0.196,0.386],[0.639,0.223,0.389],[0.686,0.251,0.394],[0.732,0.278,0.401],[0.778,0.307,0.409],[0.824,0.335,0.419],[0.869,0.364,0.430],[0.914,0.393,0.442],[0.959,0.423,0.456],[0.992,0.460,0.479],[0.997,0.503,0.507],[0.998,0.547,0.536],[1.000,0.590,0.565],[1.000,0.634,0.595],[1.000,0.678,0.625],[1.000,0.723,0.656],[1.000,0.768,0.687],[1.000,0.813,0.719],[1.000,0.858,0.751],[1.000,0.904,0.784],[1.000,0.950,0.817],[1.000,0.997,0.850]];
  const idx = t * (c.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const f = idx - lo;
  return [Math.round((c[lo][0]*(1-f)+c[hi][0]*f)*255), Math.round((c[lo][1]*(1-f)+c[hi][1]*f)*255), Math.round((c[lo][2]*(1-f)+c[hi][2]*f)*255)];
}

// ═══════════════════════════════════════════════════════════════
//  导航系统
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════

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
    `Integrated LUFS (BS.1770): ${A.loudness.integratedLoudnessLUFS.toFixed(1)} LUFS`,
    '',
    ...(A.stereo ? [`Stereo Correlation: ${A.stereo.correlation.toFixed(4)}`, `Stereo Width: ${A.stereo.stereoWidth.toFixed(0)}%`] : ['Audio: Mono']),
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

// ═══════════════════════════════════════════════════════════════
//  渲染总控（12 个 render* 函数 → section HTML）
// ═══════════════════════════════════════════════════════════════

function renderAll() {
  const wrap = $('#results');
  wrap.innerHTML = '';
  const sections = [
    ['overview', renderOverview], ['spectrum', renderSpectrum],
    ['spectrogram', renderSpectrogramChart], ['soundspectrum', renderSoundSpectrum],
    ['waveform', renderWaveform], ['dynamics', renderDynamics],
    ['loudnesscurve', renderLoudnessCurve], ['snr', renderSNR],
    ['distortion', renderDistortion], ['stereo', renderStereo],
    ['quality', renderQuality], ['info', renderFileInfo],
  ];
  for (const [id, fn] of sections) {
    const div = document.createElement('div');
    div.className = 'section';
    div.id = 'section-' + id;
    div.innerHTML = fn();
    wrap.appendChild(div);
  }
  $$('.section').forEach(s => s.style.display = (s.id === 'section-overview') ? '' : 'none');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawSpectrumCanvas(); drawSpectrogramCanvas(); drawSoundSpectrumCanvas();
      drawWaveformCanvas(); drawPhaseCanvas(); drawLoudnessCurveCanvas();
      drawSNRCanvas(); drawDistortionCanvas();
    });
  });
}

// renderOverview, renderSpectrum, renderSpectrogramChart, renderSoundSpectrum,
// renderWaveform, renderDynamics, renderStereo, renderQuality, renderFileInfo,
// renderLoudnessCurve, renderSNR, renderDistortion
// ... [完整实现见前文章节 6.6/6.7，生成带 Canvas 的卡片 HTML]

function buildCard(title, items, helpHtml, smartHtml) {
  const hid = 'help-' + title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  let html = `<div class="card"><div class="card-header">${title}`;
  if (helpHtml) html += `<button class="help-toggle" onclick="toggleHelp('${hid}')" id="bt-${hid}">? 解读</button>`;
  html += `</div><div class="card-body">`;
  for (const [label, value, color] of items) {
    const c = color ? `color:${color};` : '';
    html += `<div class="card-row"><span class="lbl">${label}</span><span class="val" style="${c}">${value}</span></div>`;
  }
  if (smartHtml) html += `<div class="smart-card">${smartHtml}</div>`;
  if (helpHtml) html += `<div class="help-body" id="${hid}">${helpHtml}</div>`;
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

function row(label, value, fullWidth, color) {
  const c = color ? `color:${color};` : '';
  const colSpan = fullWidth ? 'style="grid-column:1/-1"' : '';
  return `<div class="info-item card-row" ${colSpan}><span class="lbl">${label}</span><span class="val" style="${c}">${value}</span></div>`;
}

// ═══════════════════════════════════════════════════════════════
//  根因诊断引擎（10 条规则 — 多维度组合推断）
// ═══════════════════════════════════════════════════════════════

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
    diag.push({ title: '母带风格：硬限幅（Brickwall Limiter）', severity: 'info',
      detail: `此音频符合商业母带处理特征：使用硬限幅器将响度推至 ${lufs.toFixed(0)} LUFS，Crest Factor 仅 ${crest.toFixed(1)}dB。这是母带工程师的刻意选择。` });
  }

  if (sr >= 88200 && cf.confidence === 'high' && cf.bw < 85) {
    const realSR = cf.freq * 2.2;
    diag.push({ title: '根因推断：伪高解析度（升频文件）', severity: 'bad',
      detail: `文件声称采样率 ${(sr/1000).toFixed(0)}kHz，但频谱在 ${(cf.freq/1000).toFixed(1)}kHz 处明显截断。高概率从 ${realSR < 50000 ? '44.1/48kHz' : (realSR/1000).toFixed(0)+'kHz'} 源升频而来。` });
  }

  if (clip.hasClipping && crest > 10 && lufs < -14 && !loudnessWar) {
    diag.push({ title: '根因推断：录音增益设置过高', severity: 'warn',
      detail: `削波与良好动态同时出现。高概率是录音阶段增益过高，瞬态尖峰击穿了电平上限。` });
  }

  if (A.dcOffset.isSignificant && clip.hasClipping) {
    diag.push({ title: '根因推断：录音硬件问题（DC Offset）', severity: 'bad',
      detail: `直流偏移与削波同时出现，强烈暗示录音硬件存在故障。` });
  }

  if (A.stereo && A.stereo.isOutOfPhase) {
    diag.push({ title: '根因推断：立体声极性反转', severity: 'bad',
      detail: `左右声道极性相反，在单声道设备上会导致信号抵消。` });
  }

  if (lra < 4 && lufs > -10) {
    diag.push({ title: '提示：广播/电台级压缩', severity: 'hint',
      detail: `LRA 仅 ${lra.toFixed(1)} LU，整曲响度几乎无变化。这是广播/电台的典型处理方式。` });
  }

  if (crest > 16 && lufs < -18) {
    diag.push({ title: '判断：古典乐 / 原声录音特征', severity: 'good',
      detail: `Crest Factor ${crest.toFixed(1)}dB，响度仅 ${lufs.toFixed(0)} LUFS，动态范围完整保留。` });
  }

  if (A.actualBitDepth.estimated <= 17 && A.actualBitDepth.estimated >= 15 && F.bitDepth && F.bitDepth >= 24) {
    diag.push({ title: '根因推断：16-bit 音频装入 24-bit 容器', severity: 'hint',
      detail: `实际可检测的信号精度仅 ~16-bit。从 CD 翻录并导出为 24-bit ALAC/FLAC 时非常常见。` });
  }

  return diag;
}

// ═══════════════════════════════════════════════════════════════
//  入口初始化
// ═══════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  try {
    console.log('[AudioAnalyzer] START');
    const btn = document.getElementById('btnExport');
    if (btn && typeof exportReport === 'function') btn.addEventListener('click', exportReport);
    document.addEventListener('click', () => {
      if (typeof audioCtx !== 'undefined' && audioCtx.state === 'suspended') audioCtx.resume();
    }, { once: true });
    D.info('INIT', '就绪，等待音频文件...');
    console.log('[AudioAnalyzer] READY');
  } catch (e) {
    console.error('[AudioAnalyzer] INIT ERROR:', e);
  }
});

// ═══════════════════════════════════════════════════════════════
//  补丁：兜底 drop 事件 + 全局文件入口 + runAnalysis 防重复
// ═══════════════════════════════════════════════════════════════

(function () {
  function bootSafe() {
    if (document.readyState !== 'complete') { window.addEventListener('load', bootSafe); return; }
    if (typeof init === 'function') { try { init(); } catch (e) {} }
    const btn = document.getElementById('btnExport');
    if (btn && typeof exportReport === 'function') btn.addEventListener('click', exportReport);
  }
  bootSafe();
})();

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  try { if (typeof processFiles === 'function') await processFiles([file]); } catch (err) {}
});
document.addEventListener('dragover', (e) => e.preventDefault());

(function () {
  function hookFileInput() {
    const input = document.getElementById('fileInput');
    if (input) input.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (typeof processFiles === 'function') processFiles([file]);
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (typeof processFiles === 'function') processFiles([file]);
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
  }
  hookFileInput();
})();

(function () {
  if (typeof runAnalysis !== 'function') return;
  let __ANALYSIS_LOCK = false;
  const _originalAnalysis = runAnalysis;
  window.runAnalysis = async function (...args) {
    if (__ANALYSIS_LOCK) { console.warn('[runAnalysis] blocked: already running'); return; }
    __ANALYSIS_LOCK = true;
    try {
      console.time('ANALYZE_TOTAL');
      const result = await _originalAnalysis.apply(this, args);
      requestAnimationFrame(() => { if (typeof renderAll === 'function') renderAll(); });
      return result;
    } catch (err) {
      console.error('[runAnalysis] error:', err);
    } finally {
      console.timeEnd('ANALYZE_TOTAL');
      __ANALYSIS_LOCK = false;
    }
  };
})();
```

> **重要说明**: app.js 中的 `parseFormatFromBytes`、`parseMP4BoxTree`、`extractMP4Info`、`parseSampleTable`、`decodeWithWebCodecs`、`decodeALACWithPureJS`、所有 `narrate*` 函数、所有 `draw*Canvas` 函数、以及所有 `render*` 函数的**完整逐行实现**已在本文档的第 6.1-6.9 节以及此前各次读取中完整呈现。为控制文档体积，此处展示了完整的函数签名和核心逻辑流，AI 可结合前文的详细分析章节理解全貌。


---

# 十四、完整源代码（按模块分类）

## A. 主进程 — main.js

```javascript
// main.js — Electron 主进程
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'Audio Analyzer Pro', backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// IPC: 打开文件对话框 (支持 20+ 格式，多选)
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择音频文件',
    filters: [
      { name: '音频文件', extensions: ['wav','flac','aiff','aif','mp3','m4a','aac','ogg','opus','wma','ape','wv','tta','dsf','dff','caf','ac3','eac3','mka','webm','alac'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

// IPC: 读取文件二进制数据
ipcMain.handle('file:readBuffer', async (_event, filePath) => {
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

// IPC: 获取 FFmpeg 路径（多路径搜索）
ipcMain.handle('app:getFfmpegPath', () => {
  const possiblePaths = [
    path.join(__dirname, 'assets', 'ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'assets', 'ffmpeg.exe'),
    path.join(app.getPath('exe'), '..', 'assets', 'ffmpeg.exe'),
  ];
  for (const p of possiblePaths) { if (fs.existsSync(p)) return p; }
  return 'ffmpeg';
});

// 全局异常保护（防止 EXE 静默崩溃）
process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('[main] unhandledRejection:', reason));
```

---

## B. 桥接层 — preload.js

```javascript
// preload.js — 安全上下文桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFileBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),
  getFfmpegPath: () => ipcRenderer.invoke('app:getFfmpegPath'),
});
```

---

## C. 分析引擎核心 — core/analyzeEngine.js

```javascript
// core/analyzeEngine.js — 分析引擎入口
import { splitPCM } from "./chunkManager.js";
import { WorkerPool } from "./workerPool.js";
import { reduceResults } from "./reduceResults.js";

export class AnalyzeEngine {
  constructor() {
    this.pool = new WorkerPool("../worker/analyze.worker.js", 4);
  }

  async run(channels, sampleRate, onProgress) {
    const chunks = splitPCM(channels, sampleRate);
    const results = [];
    const total = chunks.length;

    for (let i = 0; i < total; i++) {
      const raw = await this.pool.run({
        chunk: chunks[i].data,
        index: i,
        sampleRate,
      });
      if (raw && raw.ok === false) {
        results.push({ rms: 0, peak: 0, spectrum: [], sampleCount: 0 });
      } else {
        results.push(raw.res);
      }
      if (onProgress) onProgress(i / total);
    }

    const totalSamples = channels[0].length;
    const channelsCount = channels.length;
    return reduceResults(results, sampleRate, totalSamples, channelsCount);
  }
}
```

---

## D. 分片管理器 — core/chunkManager.js

```javascript
// core/chunkManager.js — 自适应分片
export function splitPCM(channels, sampleRate) {
  const length = channels[0].length;
  const duration = length / sampleRate;
  let chunkSec;
  if (duration < 60) chunkSec = 5;
  else if (duration < 600) chunkSec = 10;
  else chunkSec = 20;

  const chunkSamples = sampleRate * chunkSec;
  const chunks = [];
  for (let i = 0; i < length; i += chunkSamples) {
    const end = Math.min(i + chunkSamples, length);
    chunks.push({
      data: channels.map(ch => ch.slice(i, end)),
      index: chunks.length,
    });
  }
  return chunks;
}
```

---

## E. 结果汇总 — core/reduceResults.js

```javascript
// core/reduceResults.js — 加权汇总
export function reduceResults(results, sampleRate, totalSamples, channelsCount) {
  let globalPeak = 0, rmsSumSq = 0, totalWeight = 0;
  let spectrumBins = null, spectrumWeightSum = 0;
  let totalDC = 0, totalClipped = 0, stereoCorrSum = 0, stereoCorrW = 0;
  let midRMSSq = 0, sideRMSSq = 0;

  for (const r of results) {
    const w = r.sampleCount || 1;
    if (r.peak > globalPeak) globalPeak = r.peak;
    rmsSumSq += (r.rms * r.rms) * w;
    totalWeight += w;
    totalDC += (r.dcOffset || 0) * w;
    totalClipped += (r.clippedCount || 0);

    if (r.spectrum && r.spectrum.length > 0) {
      if (!spectrumBins) spectrumBins = new Float32Array(r.spectrum.length);
      for (let i = 0; i < spectrumBins.length; i++) {
        spectrumBins[i] += (r.spectrum[i] || 0) * w;
      }
      spectrumWeightSum += w;
    }

    if (r.stereoCorrelation !== undefined && r.stereoCorrelation !== null) {
      stereoCorrSum += r.stereoCorrelation * w;
      stereoCorrW += w;
    }
    if (r.midRMS !== undefined) midRMSSq += (r.midRMS * r.midRMS) * w;
    if (r.sideRMS !== undefined) sideRMSSq += (r.sideRMS * r.sideRMS) * w;
  }

  const globalRMS = Math.sqrt(rmsSumSq / totalWeight);
  const crestFactor = globalRMS > 0 ? 20 * Math.log10(globalPeak / globalRMS) : 0;
  const dynamicRangeDB = crestFactor + 3;
  const dcOffset = totalDC / totalWeight;
  const clippedSamples = totalClipped;
  const clipRatio = totalSamples > 0 ? totalClipped / totalSamples : 0;

  const avgSpectrum = spectrumBins
    ? Array.from(spectrumBins).map(v => v / spectrumWeightSum)
    : [];

  const maxSpec = Math.max(...avgSpectrum, 1e-12);
  const normSpectrum = avgSpectrum.map(v => {
    const db = 20 * Math.log10(v / maxSpec);
    return Math.max(-120, db);
  });

  const stereoCorrelation = stereoCorrW > 0 ? stereoCorrSum / stereoCorrW : null;
  const midRMS = totalWeight > 0 ? Math.sqrt(midRMSSq / totalWeight) : null;
  const sideRMS = totalWeight > 0 ? Math.sqrt(sideRMSSq / totalWeight) : null;

  return {
    peak: globalPeak, rms: globalRMS, crestFactor, dynamicRangeDB,
    spectrum: avgSpectrum, normSpectrum, sampleRate, totalSamples,
    channelsCount, dcOffset, stereoCorrelation,
    stereoWidth: midRMS && sideRMS ? (sideRMS / Math.max(midRMS, 1e-12)) * 100 : null,
    midRMS, sideRMS, clippedSamples, clipRatio,
  };
}
```

---

## F. Worker 并行池 — core/workerPool.js

```javascript
// core/workerPool.js — Worker 并行调度池
export class WorkerPool {
  constructor(workerUrl, size = 4) {
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.callbacks = new Map();

    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      w.onmessage = (e) => this._done(w, e);
      w.onerror = (err) => this._error(w, err);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      if (this.queue.length > 50) this.queue = this.queue.slice(-50);
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.callbacks.set(w, job);
      w.postMessage(job.task);
    }
  }

  _done(w, e) {
    const job = this.callbacks.get(w);
    this.callbacks.delete(w);
    this.idle.push(w);
    if (job) job.resolve(e.data);
    this._dispatch();
  }

  _error(w, err) {
    const job = this.callbacks.get(w);
    this.callbacks.delete(w);
    this.workers = this.workers.filter(x => x !== w);
    w.terminate();
    if (job) job.reject(err);
    this._dispatch();
  }
}
```

---

## G. 安全运行器 — core/safeRunner.js

```javascript
// core/safeRunner.js — 错误隔离包装器
export async function safeRun(fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    console.error("[SAFE ERROR]", e);
    return fallback;
  }
}
```

---

## H. 分片分析 Worker — worker/analyze.worker.js

```javascript
// worker/analyze.worker.js — 分片 FFT 频谱分析 Worker
const FFT_SIZE = 2048;
const SPECTRUM_BINS = 512;

function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  return w;
}

function fftInPlace(real, imag, n, inverse) {
  // Bit-reversal permutation
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let m = n >> 1;
    while (m > 0 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  // Butterfly
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
        real[i + j] += re;
        imag[i + j] += im;
        const tmp = wr * cosA - wi * sinA;
        wi = wr * sinA + wi * cosA;
        wr = tmp;
      }
    }
  }
  if (inverse) { for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n; } }
}

const window_ = hannWindow(FFT_SIZE);

self.onmessage = (e) => {
  const { chunk, sampleRate } = e.data;
  const channels = chunk.length;

  const fftReal = new Float32Array(FFT_SIZE);
  const fftImag = new Float32Array(FFT_SIZE);
  const spectrumAccum = new Float32Array(SPECTRUM_BINS);

  let peak = 0, rmsSumSq = 0, dcSum = 0, clippedCount = 0;
  const len = Math.min(channels[0].length, 5 * 60 * sampleRate);
  const numFrames = Math.floor((len - FFT_SIZE) / (FFT_SIZE / 2)) + 1;

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * (FFT_SIZE / 2);
    for (let i = 0; i < FFT_SIZE; i++) {
      let val = channels[0][offset + i];
      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      rmsSumSq += val * val;
      dcSum += val;
      if (abs >= 0.999) clippedCount++;
      fftReal[i] = val * window_[i];
      fftImag[i] = 0;
    }
    fftInPlace(fftReal, fftImag, FFT_SIZE, false);
    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const freqIdx = Math.round((b / SPECTRUM_BINS) * (FFT_SIZE / 2));
      const mag = Math.sqrt(fftReal[freqIdx] * fftReal[freqIdx] + fftImag[freqIdx] * fftImag[freqIdx]);
      spectrumAccum[b] += mag;
    }
  }

  const rms = Math.sqrt(rmsSumSq / (numFrames * FFT_SIZE));
  const spectrum = Array.from(spectrumAccum).map(v => v / numFrames);
  const dcOffset = dcSum / (numFrames * FFT_SIZE);

  let stereoCorrelation = null, midRMS = null, sideRMS = null;
  if (channels.length >= 2) {
    let midSum = 0, sideSum = 0;
    const ch1 = channels[1];
    const n = Math.min(channels[0].length, ch1.length, 10 * sampleRate);
    for (let i = 0; i < n; i++) {
      const mid = (channels[0][i] + ch1[i]) / 2;
      const side = (channels[0][i] - ch1[i]) / 2;
      midSum += mid * mid;
      sideSum += side * side;
    }
    midRMS = n > 0 ? Math.sqrt(midSum / n) : 0;
    sideRMS = n > 0 ? Math.sqrt(sideSum / n) : 0;
    stereoCorrelation = midRMS > 0 ? 1 - Math.min(sideRMS / midRMS, 1) : 0;
  }

  self.postMessage({
    ok: true,
    res: {
      peak, rms, spectrum, sampleCount: numFrames * FFT_SIZE,
      clippedCount, dcOffset, stereoCorrelation, midRMS, sideRMS,
    },
  });
};
```

---

## I. 工具模块

### utils/dom.js

```javascript
// utils/dom.js — DOM 快捷选择器
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
```

### utils/format.js

```javascript
// utils/format.js — 格式化工具
function fmtSize(b) {
  if (typeof b !== 'number' || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : b.toFixed(2)) + ' ' + u[i];
}

function fmtDur(s) {
  if (typeof s !== 'number' || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### utils/logger.js

```javascript
// utils/logger.js — 调试日志系统 (在 app.js 内联)
// D 对象提供分级日志: D.info / D.ok / D.warn / D.err
// 自动渲染到 #debugBody，支持计数统计和错误自动展开
// 防御性限制: DOM 节点 ≤500，数据缓存 ≤1000 条
```

---

## J. 界面层

### renderer/index.html

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Audio Analyzer Pro</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebar-header"><h1> Audio Analyzer Pro</h1></div>
      <nav class="sidebar-nav">
        <div class="nav-item active" data-section="overview"> 总览</div>
        <div class="nav-item" data-section="spectrum"> 频谱</div>
        <div class="nav-item" data-section="spectrogram"> 频谱图</div>
        <div class="nav-item" data-section="soundspectrum"> 声谱</div>
        <div class="nav-item" data-section="waveform"> 波形</div>
        <div class="nav-item" data-section="dynamics"> 动态</div>
        <div class="nav-item" data-section="loudnessCurve"> 响度曲线</div>
        <div class="nav-item" data-section="snr"> SNR</div>
        <div class="nav-item" data-section="distortion"> 失真</div>
        <div class="nav-item" data-section="stereo"> 立体声</div>
        <div class="nav-item" data-section="quality"> 质量</div>
        <div class="nav-item" data-section="info"> 文件</div>
        <div class="nav-item" data-section="debug"> 日志</div>
      </nav>
    </aside>

    <main class="main">
      <header class="topbar">
        <button class="btn" onclick="window._openFileDialog()"> 打开文件</button>
        <button class="btn" onclick="window._openFolderDialog()">批量导入</button>
        <span class="worker-status" id="statusText">就绪</span>
      </header>
      <div class="content" id="content">
        <div class="welcome-block">
          <h2>Audio Analyzer Pro V2</h2>
          <p>拖放音频文件或文件夹到此处，或点击上方按钮选择文件。</p>
          <p style="color:var(--fg3);font-size:.8rem">支持: WAV · FLAC · AIFF · MP3 · M4A · ALAC · AAC · OGG · WMA · APE · WavPack · DSF · DFF · CAF · AC3 · WebM · Opus · TTA · MKA</p>
          <div class="section-narrative"><span class="progress-text" id="progressText"></span></div>
        </div>
      </div>
    </main>
  </div>

  <div id="results" style="display:none"></div>

  <script type="module" src="./app.js"></script>
</body>
</html>
```

### renderer/styles.css

```css
/* styles.css — GitHub 暗色主题设计系统 */
:root {
  --bg0: #0d1117;
  --bg1: #161b22;
  --bg2: #21262d;
  --bg3: #30363d;
  --fg0: #e6edf3;
  --fg1: #c9d1d9;
  --fg2: #8b949e;
  --fg3: #6e7681;
  --ac:  #58a6ff;
  --gr:  #3fb950;
  --ye:  #d29922;
  --re:  #f85149;
  --pu:  #bc8cff;
  --cy:  #39d2c0;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { font-size: 14px; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: var(--bg0); color: var(--fg0); overflow: hidden; height: 100vh;
}

/* 应用布局 */
.app { display: flex; height: 100vh; }

/* 侧边栏 */
.sidebar {
  width: 240px; min-width: 240px; background: var(--bg1);
  border-right: 1px solid var(--bg3); overflow-y: auto;
  display: flex; flex-direction: column;
}
.sidebar-header { padding: 16px; border-bottom: 1px solid var(--bg3); }
.sidebar-header h1 { font-size: 1rem; color: var(--fg0); font-weight: 600; }
.sidebar-nav { padding: 8px 0; flex: 1; }
.nav-item {
  padding: 8px 16px; cursor: pointer; color: var(--fg2);
  font-size: .82rem; transition: all .15s; border-left: 2px solid transparent;
}
.nav-item:hover { color: var(--fg1); background: rgba(255,255,255,.03); }
.nav-item.active { color: var(--ac); border-left-color: var(--ac); background: rgba(88,166,255,.06); }

/* 主区域 */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.topbar {
  padding: 10px 16px; background: var(--bg1); border-bottom: 1px solid var(--bg3);
  display: flex; align-items: center; gap: 10px; flex-shrink: 0;
}
.content { flex: 1; overflow-y: auto; padding: 16px; }

/* 按钮 */
.btn {
  padding: 6px 14px; background: var(--bg2); color: var(--fg1);
  border: 1px solid var(--bg3); border-radius: 6px; cursor: pointer;
  font-size: .8rem; transition: all .15s;
}
.btn:hover { background: var(--bg3); border-color: var(--ac); }

/* 状态 */
.worker-status { font-size: .75rem; color: var(--fg3); margin-left: auto; }

/* 卡片 */
.card {
  background: var(--bg1); border: 1px solid var(--bg3);
  border-radius: 8px; margin-bottom: 12px; overflow: hidden;
}
.card-header {
  padding: 10px 14px; background: var(--bg2); font-weight: 600;
  font-size: .85rem; border-bottom: 1px solid var(--bg3);
  display: flex; align-items: center; justify-content: space-between;
}
.card-body { padding: 12px 14px; }
.card-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 4px 0; font-size: .8rem;
}
.lbl { color: var(--fg2); } .val { color: var(--fg0); }

/* 帮助 */
.help-toggle {
  background: none; border: 1px solid var(--bg3); color: var(--fg2);
  font-size: .68rem; padding: 2px 8px; border-radius: 4px; cursor: pointer;
}
.help-toggle:hover, .help-toggle.open { color: var(--ac); border-color: var(--ac); }
.help-body {
  max-height: 0; overflow: hidden; transition: max-height .4s ease;
  font-size: .75rem; color: var(--fg2); border-top: 1px solid transparent;
}
.help-body.open { max-height: 2000px; border-color: var(--bg3); }
.help-body dl { padding: 10px 14px; }
.help-body dt { color: var(--fg1); font-weight: 600; margin-top: 8px; }
.help-body dd { margin-left: 0; margin-top: 2px; line-height: 1.65; }

/* 徽章 */
.badge { font-size: .68rem; padding: 1px 8px; border-radius: 10px; }
.badge-pass { background: rgba(63,185,80,.15); color: var(--gr); }
.badge-hint { background: rgba(88,166,255,.15); color: var(--ac); }
.badge-warn { background: rgba(210,153,34,.15); color: var(--ye); }
.badge-fail { background: rgba(248,81,73,.15); color: var(--re); }

/* 解读卡片 */
.smart-card {
  margin: 8px 0; padding: 10px 14px; background: rgba(88,166,255,.04);
  border-radius: 6px; font-size: .78rem; line-height: 1.7; color: var(--fg1);
}

/* 颜色 */
.good { color: var(--gr); } .bad { color: var(--re); }
.warn { color: var(--ye); } .hint { color: var(--ac); }

/* Canvas */
canvas { border-radius: 4px; max-width: 100%; }
#specCanvas { image-rendering: pixelated; }

/* 欢迎 */
.welcome-block { text-align: center; padding: 60px 20px; color: var(--fg2); }
.welcome-block h2 { font-size: 1.3rem; color: var(--fg0); margin-bottom: 10px; }

/* 进度 */
.progress-text { font-size: .72rem; color: var(--fg3); }

/* 拖放区紧凑模式 */
#dropZone.compact { padding: 12px; }

/* 滚动条 */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg3); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--fg3); }
```

### package.json

```json
{
  "name": "audio-analyzer-v2",
  "version": "2.0.0",
  "description": "Audio Analyzer Pro V2 — 专业音频质量分析桌面工具",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "postinstall": "electron-builder install-app-deps"
  },
  "build": {
    "appId": "audio.analyzer.v2",
    "productName": "Audio Analyzer Pro",
    "directories": { "output": "dist" },
    "files": [
      "main.js",
      "preload.js",
      "renderer/**/*",
      "worker/**/*",
      "core/**/*",
      "utils/**/*",
      "assets/**/*"
    ],
    "win": {
      "target": "nsis",
      "icon": "build/icon.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true
    }
  },
  "devDependencies": {
    "electron": "latest",
    "electron-builder": "latest"
  }
}
```

---

*文档生成时间: 2026-07-06*
*源项目: AudioAnalyzer_V2 (Electron EXE 版)*

---

## 十五、v2.1.0 新增：5 大高级实测算法

> v2.0.0 的响度、位深度、SNR、失真、截止频率均为估算值。v2.1.0 加入了 5 个主线程实测算法。

### 15.1 架构与集成

```
analyzeFull() → rawResult (peak/rms/频谱)
    ↓
[新增] 5 个高级算法（主线程）
    ├── computeLoudness(ch0, sampleRate)        → 需要 PCM
    ├── estimateBitDepth(ch0, F)                 → 需要 PCM
    ├── computeSNR(ch0, sampleRate)              → 需要 PCM
    ├── computeDistortion(ch0, sr, freqs, norm)  → 需要频谱
    └── detectCutoff(freqs, norm, sampleRate)    → 需要频谱
    ↓
adaptAnalysis() ← 用实测值替换估算值
    ↓
renderAll() → 12 个 section
```

### 15.2 五个算法原理

| 算法 | 方法 | 输出 |
|------|------|------|
| `computeLoudness` | ITU-R BS.1770-4 K-weighting（预加重→RLB高通→高架滤波→400ms块→双门控→LRA） | integratedLUFS, shortTermMax, LRA, stLUFSvalues |
| `estimateBitDepth` | GCD 量化步长直方图法（差值分桶→峰值间距→GCD→-log₂） | estimated, note, detail |
| `computeSNR` | 分块 RMS → 最安静10%为噪底 → 全频+三段SNR | snrDB, noiseFloorDB, snrLow/Mid/High |
| `computeDistortion` | 自相关基频检测→频谱谐波提取→THD+Asymmetry | thdPct, fundamentalHz, harmonics, asymmetryPct |
| `detectCutoff` | 高频噪底→逆向扫描→带宽利用率 | freq, bw, confidence |

### 15.3 硬性约束

- **不修改** `core/analyzeEngine.js` 和 `worker/analyze.worker.js`
- **FFmpeg 仅兜底**，解码链顺序：AudioElement → Pure JS ALAC → WebCodecs → FFmpeg
- 所有算法**主线程执行**，失败返回 `null` + `D.warn()`

---

## 十四、完整源代码（按模块分类）

> 以下为每个文件的完整源代码。v2.1.0 新增 `utils/audioMath.js`（§14.17）和 processSingleFile 集成代码（§14.18）。

---

### 14.1 main.js — Electron 主进程

```javascript
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Audio Analyzer Pro',
    backgroundColor: '#0d1117',
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

// ── IPC: 读取文件为 ArrayBuffer ──
ipcMain.handle('file:readBuffer', async (_event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch (e) {
    console.error('[main] readBuffer error:', e.message);
    return null;
  }
});

// ── IPC: 获取 FFmpeg 路径 ──
ipcMain.handle('app:getFfmpegPath', () => {
  const possiblePaths = [
    path.join(__dirname, 'assets', 'ffmpeg.exe'),
    path.join(process.resourcesPath || '', 'assets', 'ffmpeg.exe'),
    path.join(app.getPath('exe'), '..', 'assets', 'ffmpeg.exe'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── 全局异常保护（防 EXE 静默崩溃） ──
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
```

---

### 14.2 preload.js — 安全上下文桥接

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFileBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),
  getFfmpegPath: () => ipcRenderer.invoke('app:getFfmpegPath'),
});
```

---

### 14.3 package.json — 项目配置

```json
{
  "name": "audio-analyzer-v2",
  "version": "2.0.0",
  "description": "Audio Analyzer Pro V2 — 专业音频质量分析桌面工具",
  "author": "AudioAnalyzer",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "postinstall": "electron-builder install-app-deps"
  },
  "build": {
    "appId": "audio.analyzer.v2",
    "productName": "Audio Analyzer Pro",
    "directories": {
      "output": "dist"
    },
    "files": [
      "main.js",
      "preload.js",
      "renderer/**/*",
      "worker/**/*",
      "core/**/*",
      "utils/**/*",
      "assets/**/*"
    ],
    "win": {
      "target": "nsis",
      "icon": "build/icon.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true
    }
  },
  "devDependencies": {
    "electron": "latest",
    "electron-builder": "latest"
  }
}
```

---

### 14.4 renderer/index.html — 主页面

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>音频质量分析器 Pro</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>

<div class="app">
  <!-- 侧边栏 -->
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>Audio Analyzer Pro</h1>
      <div class="sub">Professional Audio QC Tool</div>
    </div>
    <nav class="sidebar-nav" id="sidebarNav">
      <div class="nav-item active" data-section="overview">
        <span class="ico">◈</span> 总览
      </div>
      <div class="nav-item" data-section="spectrum">
        <span class="ico">◫</span> 频谱分析
      </div>
      <div class="nav-item" data-section="spectrogram">
        <span class="ico">▦</span> 频谱图
      </div>
      <div class="nav-item" data-section="soundspectrum">
        <span class="ico">▥</span> 声谱
      </div>
      <div class="nav-item" data-section="waveform">
        <span class="ico">▤</span> 波形
      </div>
      <div class="nav-item" data-section="loudness">
        <span class="ico">◉</span> 响度
      </div>
      <div class="nav-item" data-section="narrative">
        <span class="ico">◎</span> 分析报告
      </div>
      <div class="nav-item" data-section="debug">
        <span class="ico">⚙</span> 调试日志
      </div>
    </nav>
    <div class="sidebar-footer">
      <div class="version">v8.0</div>
    </div>
  </aside>

  <!-- 主内容 -->
  <main class="main">
    <!-- 顶部工具栏 -->
    <header class="topbar">
      <div class="topbar-left">
        <button class="btn" id="btnOpen">打开文件</button>
        <button class="btn" id="btnOpenFolder">批量导入</button>
        <span class="worker-status idle" id="workerStatus">Worker 空闲</span>
      </div>
      <div class="topbar-right">
        <span class="status-text" id="statusLeft">就绪</span>
        <span class="status-text dim" id="statusRight"></span>
      </div>
    </header>

    <!-- 内容区 -->
    <div class="content" id="content">
      <section class="section active" id="section-overview">
        <div class="card" id="overviewCard">
          <div class="card-header">文件概览</div>
          <div class="card-body" id="overviewBody">
            <p class="placeholder">请打开一个音频文件开始分析</p>
          </div>
        </div>
        <div class="card">
          <div class="card-header">关键指标</div>
          <div class="card-body" id="metricsBody">
            <p class="placeholder">分析后将显示关键指标</p>
          </div>
        </div>
      </section>
      <section class="section" id="section-spectrum"><div class="chart" id="spectrumChart"></div></section>
      <section class="section" id="section-spectrogram"><canvas id="spectrogramCanvas"></canvas></section>
      <section class="section" id="section-soundspectrum"><div class="chart" id="soundspectrumChart"></div></section>
      <section class="section" id="section-waveform"><canvas id="waveformCanvas"></canvas></section>
      <section class="section" id="section-loudness"><div class="chart" id="loudnessChart"></div></section>
      <section class="section" id="section-narrative">
        <div class="card">
          <div class="card-header">智能分析报告</div>
          <div class="card-body narrative" id="narrativeBody">
            <p class="placeholder">分析完成后自动生成</p>
          </div>
        </div>
      </section>
      <section class="section" id="section-debug">
        <div class="card">
          <div class="card-header">调试日志 <span class="dim" id="debugSummary"></span></div>
          <div class="card-body">
            <div id="debugBody"><div class="debug-empty">等待文件加载...</div></div>
            <div class="debug-console" id="debugConsole"></div>
          </div>
        </div>
      </section>
    </div>

    <!-- 批量结果 -->
    <div class="batch-bar" id="batchBar" style="display:none">
      <div class="batch-header">批量结果</div>
      <div id="results"></div>
    </div>
  </main>
</div>

<!-- 加载遮罩 -->
<div class="loading-overlay" id="loadingOverlay" style="display:none">
  <div class="loading-spinner"></div>
  <div class="loading-text" id="loadingText">正在解码音频...</div>
  <div class="progress-wrap" style="width:240px"><div class="progress-bar" id="progressBar"></div></div>
</div>

<script type="module" src="./app.js"></script>
</body>
</html>
```

---

### 14.5 renderer/styles.css — 完整样式表

```css
:root {
  --bg0: #0d1117;
  --bg1: #161b22;
  --bg2: #21262d;
  --bg3: #30363d;
  --fg0: #e6edf3;
  --fg1: #c9d1d9;
  --fg2: #8b949e;
  --fg3: #6e7681;
  --ac:  #58a6ff;
  --ac2: #79c0ff;
  --gr:  #3fb950;
  --ye:  #d29922;
  --re:  #f85149;
  --pu:  #bc8cff;
  --cy:  #39d2c0;
  --border: #30363d;
  --radius: 8px;
  --shadow: 0 1px 3px rgba(0,0,0,.3);
}
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  background: var(--bg0); color: var(--fg1); line-height: 1.5;
  overflow-x: hidden; min-height: 100vh;
}
.app{display:flex;min-height:100vh}
.sidebar{
  width: 280px; min-width: 280px; background: var(--bg1);
  border-right: 1px solid var(--border); display: flex; flex-direction: column;
  position: sticky; top: 0; height: 100vh; z-index: 10;
}
.sidebar-header{
  padding: 20px 20px 16px; border-bottom: 1px solid var(--border);
}
.sidebar-header h1{font-size:1.1rem;font-weight:700;color:var(--fg0);letter-spacing:-0.3px}
.sidebar-header .sub{font-size:.7rem;color:var(--fg3);margin-top:2px;text-transform:uppercase;letter-spacing:1px}
.sidebar-nav{flex:1;padding:12px 0;overflow-y:auto}
.nav-item{
  display:flex;align-items:center;gap:10px;padding:10px 20px;
  font-size:.82rem;color:var(--fg2);cursor:pointer;transition:.15s;
  border-left: 3px solid transparent; user-select: none;
}
.nav-item:hover{color:var(--fg0);background:rgba(255,255,255,.03)}
.nav-item.active{color:var(--ac);background:rgba(88,166,255,.08);border-left-color:var(--ac);font-weight:600}
.nav-item .ico{font-size:1rem;width:20px;text-align:center;opacity:.7}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--border);font-size:.7rem;color:var(--fg3)}
.main{
  flex:1; display: flex; flex-direction: column; min-width: 0;
}
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:12px 24px;background:var(--bg1);border-bottom:1px solid var(--border);
  position: sticky; top: 0; z-index: 5;
}
.topbar .file-name{font-size:.85rem;color:var(--fg2);font-weight:500;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{
  padding:7px 16px;border:1px solid var(--border);border-radius:6px;
  background:var(--bg2);color:var(--fg1);font-size:.8rem;font-weight:500;
  cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:6px;
}
.btn:hover{background:var(--bg3);border-color:var(--fg3)}
.btn.primary{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:600}
.btn.primary:hover{background:var(--ac2);border-color:var(--ac2)}
.btn-group{display:flex;gap:8px}
.content{padding:20px 24px;flex:1;overflow-y:auto}
.drop-zone{
  border:2px dashed var(--border);border-radius:12px;
  padding:60px 20px;text-align:center;cursor:pointer;transition:.2s;
  background:var(--bg1);margin:80px auto;max-width:560px;
}
.drop-zone:hover,.drop-zone.active{border-color:var(--ac);background:var(--bg2)}
.drop-zone h2{font-size:1.2rem;color:var(--fg0);margin-bottom:8px}
.drop-zone p{font-size:.82rem;color:var(--fg3)}
.drop-zone .icon{font-size:3rem;margin-bottom:16px;opacity:.5}
.drop-zone .formats{margin-top:16px;font-size:.7rem;color:var(--fg3);font-family:'SF Mono',Consolas,monospace}
.drop-zone.compact{
  padding:16px 24px;margin:12px 0 8px;max-width:100%;
  display:flex;align-items:center;justify-content:center;gap:14px;
}
.drop-zone.compact .icon{font-size:1.5rem;margin:0}
.drop-zone.compact h2{font-size:.85rem;margin:0}
.drop-zone.compact p,.drop-zone.compact .formats{display:none}
.card{
  background:var(--bg1);border:1px solid var(--border);border-radius:var(--radius);
  margin-bottom:16px;overflow:hidden;
}
.card-header{
  padding:14px 20px;font-size:.85rem;font-weight:600;color:var(--fg0);
  border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;
  background:var(--bg2);
}
.card-body{padding:18px 20px}
.help-toggle{
  background:none;border:1px solid var(--border);color:var(--fg3);cursor:pointer;
  font-size:.7rem;padding:4px 12px;border-radius:14px;transition:all .2s;
  display:inline-flex;align-items:center;gap:4px;
}
.help-toggle:hover{color:var(--ac);border-color:var(--ac)}
.help-toggle.open{color:var(--ac);border-color:var(--ac);background:rgba(88,166,255,.08)}
.help-body{
  font-size:.74rem;color:var(--fg2);line-height:1.7;
  margin-top:12px;padding:14px 16px;background:var(--bg2);border-radius:8px;
  max-height:0;overflow:hidden;opacity:0;transition:max-height .4s,opacity .3s,margin .3s,padding .3s;
}
.help-body.open{max-height:2000px;opacity:1}
.help-body dt{font-weight:600;color:var(--fg0);margin-top:12px;font-size:.76rem}
.help-body dt:first-child{margin-top:0}
.help-body dd{margin:2px 0 0 0;padding-bottom:10px;border-bottom:1px solid rgba(48,54,61,.4)}
.help-body dd:last-child{border-bottom:none;padding-bottom:0}
.help-body .good{color:var(--gr)}
.help-body .bad{color:var(--re)}
.help-body .warn{color:var(--ye)}
.smart-card{
  font-size:.78rem;color:var(--fg1);line-height:1.7;
  margin:12px 0;padding:14px 16px;background:#0d2233;border-radius:8px;
  border-left:3px solid var(--ac);
}
.smart-card .good{color:var(--gr)}
.smart-card .bad{color:var(--re)}
.smart-card .warn{color:var(--ye)}
.smart-card .hint{color:var(--ac)}
.card-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(48,54,61,.5);font-size:.82rem}
.card-row:last-child{border-bottom:none}
.card-row .lbl{color:var(--fg2)}
.card-row .val{color:var(--fg0);font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.row-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:4px 32px}
.canvas-wrap{position:relative;margin:4px 0}
.canvas-wrap canvas{width:100%;border-radius:4px;display:block}
.canvas-wrap .label{display:flex;justify-content:space-between;font-size:.68rem;color:var(--fg3);margin-bottom:3px}
.badge{
  display:inline-block;font-size:.7rem;font-weight:700;padding:3px 10px;
  border-radius:12px;letter-spacing:.3px;
}
.badge-pass{background:rgba(63,185,80,.15);color:var(--gr)}
.badge-hint{background:rgba(88,166,255,.15);color:var(--ac)}
.badge-warn{background:rgba(210,153,34,.15);color:var(--ye)}
.badge-fail{background:rgba(248,81,73,.15);color:var(--re)}
.progress-wrap{background:var(--bg2);border-radius:4px;height:6px;overflow:hidden;margin:4px 0 8px}
.progress-bar{height:100%;background:var(--ac);border-radius:4px;transition:width .3s;width:0}
.loading-overlay{
  position:fixed;inset:0;background:rgba(13,17,23,.7);z-index:100;
  display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;
}
.spinner{width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--ac);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-text{color:var(--fg2);font-size:.85rem}
.statusbar{
  padding:8px 24px;font-size:.72rem;color:var(--fg3);background:var(--bg1);
  border-top:1px solid var(--border);display:flex;justify-content:space-between;
}
.tooltip{position:relative;cursor:help;border-bottom:1px dotted var(--fg3)}
.tooltip:hover::after{
  content:attr(data-tip);position:absolute;bottom:120%;left:50%;transform:translateX(-50%);
  background:var(--bg0);border:1px solid var(--border);padding:6px 10px;
  border-radius:6px;font-size:.72rem;white-space:nowrap;z-index:20;color:var(--fg1);
}
@media(max-width:768px){
  .app{flex-direction:column}
  .sidebar{width:100%;min-width:auto;height:auto;position:relative;flex-direction:row;overflow-x:auto}
  .sidebar-nav{display:flex;flex-direction:row;padding:0}
  .nav-item{border-left:none;border-bottom:3px solid transparent;padding:12px 16px;white-space:nowrap}
  .nav-item.active{border-left:none;border-bottom-color:var(--ac)}
  .sidebar-header,.sidebar-footer{display:none}
  .topbar{padding:10px 16px}
  .content{padding:12px 16px}
  .drop-zone{margin:40px 16px;padding:40px 16px}
}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg3);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}
.debug-console{
  background:var(--bg0); border-top:2px solid var(--border); position:relative; z-index:15;
  max-height:0; overflow:hidden; transition:max-height .3s;
}
.debug-console.open{max-height:420px;overflow-y:auto}
.debug-header{
  padding:8px 24px;background:var(--bg1);display:flex;justify-content:space-between;align-items:center;cursor:pointer;
  font-size:.78rem;color:var(--fg2);border-bottom:1px solid var(--border);user-select:none;
}
.debug-header:hover{color:var(--fg0)}
.debug-header .count{font-size:.68rem;padding:2px 8px;border-radius:10px;background:var(--bg3)}
.debug-header .count.err{background:rgba(248,81,73,.2);color:var(--re)}
.debug-header .count.ok{background:rgba(63,185,80,.2);color:var(--gr)}
.debug-body{padding:8px 24px;font-family:'SF Mono','Cascadia Code',Consolas,monospace;font-size:.7rem;line-height:1.7}
.debug-entry{display:flex;gap:10px;align-items:baseline;padding:2px 0;border-bottom:1px solid rgba(48,54,61,.3)}
.debug-entry .ts{color:var(--fg3);min-width:70px;flex-shrink:0}
.debug-entry .tag{min-width:44px;flex-shrink:0;font-weight:700;font-size:.65rem;text-align:center;padding:1px 5px;border-radius:3px}
.debug-entry .tag.info{background:rgba(88,166,255,.15);color:var(--ac)}
.debug-entry .tag.ok{background:rgba(63,185,80,.15);color:var(--gr)}
.debug-entry .tag.warn{background:rgba(210,153,34,.15);color:var(--ye)}
.debug-entry .tag.err{background:rgba(248,81,73,.15);color:var(--re)}
.debug-entry .msg{color:var(--fg1);word-break:break-all}
.debug-empty{color:var(--fg3);text-align:center;padding:20px}
.worker-status{display:inline-flex;align-items:center;gap:6px;font-size:.7rem;padding:3px 10px;border-radius:10px}
.worker-status.idle{color:var(--fg3);background:rgba(110,118,129,.1)}
.worker-status.busy{color:var(--ac);background:rgba(88,166,255,.1)}
.worker-status.done{color:var(--gr);background:rgba(63,185,80,.1)}
.worker-status.err{color:var(--re);background:rgba(248,81,73,.1)}
```

---

### 14.6 renderer/app.js — 前端主逻辑 (完整 ~2900 行)

*由于 app.js 过长（~2900 行），已在"第六章"中对其核心函数做了详细拆解（包含完整代码片段），此处不再重复列出全部 2900 行。核心代码涵盖：*

| 行号范围 | 内容 | 详解章节 |
|---------|------|---------|
| 1-300 | 入口/导入/adaptAnalysis/D 日志/drop事件/parseFormatFromBytes | §6.1 |
| 300-500 | parseFormatFromBytes 续（FLAC/OGG/MP3/M4A/AIFF/APE/WavPack/TTA/DSF/DFF/CAF/AC3/WMA） | §6.1 |
| 496-705 | parseMP4BoxTree / extractMP4Info / parseALACConfig / parseSampleTable | §6.2 |
| 786-964 | 三级解码器：WebCodecs / Pure JS ALAC / AudioElement | §6.3-6.4 |
| 1019-1172 | processFiles / processSingleFile / engine.run() | §6.5 |
| 1220-1500 | generateNarrative + 12个 narrate*() 智能报告函数 | §6.8 |
| 1528-1930 | 8个 draw*Canvas() 渲染函数 + magma 色表 | §6.7 |
| 1932-2619 | Navigation / Utility / renderAll / 12个 render*() 函数 / diagnoseRootCause / 补丁 | §6.6-6.9 |

---

### 14.7 core/analyzeEngine.js — 分析引擎入口

```javascript
// ═══════════════════════════════════════════════════════════════
//  analyzeEngine.js — 分析引擎核心（产品级入口）
//  唯一分析入口：切片 → Worker Pool → 汇总
// ═══════════════════════════════════════════════════════════════

import { splitPCM } from "./chunkManager.js";
import { WorkerPool } from "./workerPool.js";
import { reduceResults } from "./reduceResults.js";

export class AnalyzeEngine {
  constructor() {
    this.pool = new WorkerPool("../worker/analyze.worker.js", 4);
  }

  async run(channels, sampleRate, onProgress) {
    const totalSamples = channels[0].length;
    const channelsCount = channels.length;

    const chunks = splitPCM(channels, sampleRate);
    const total = chunks.length;

    const results = [];

    for (let i = 0; i < total; i++) {
      try {
        const raw = await this.pool.run({
          chunk: chunks[i].data,
          index: i,
          sampleRate,
        });

        if (raw && raw.ok === false) {
          console.error(`[Engine] Chunk ${i} failed: ${raw.error}`);
          results.push({ rms: 0, peak: 0, spectrum: [], sampleCount: 0 });
        } else if (raw && raw.ok === true && raw.res) {
          results.push(raw.res);
        } else {
          results.push(raw);
        }

        if (onProgress) {
          onProgress(i / total);
        }
      } catch (err) {
        console.error(`[Engine] Chunk ${i} exception:`, err);
        results.push({ rms: 0, peak: 0, spectrum: [], sampleCount: 0 });
      }
    }

    return reduceResults(results, sampleRate, totalSamples, channelsCount);
  }
}
```

---

### 14.8 core/chunkManager.js — 自适应分片

```javascript
// ═══════════════════════════════════════════════════════════════
//  chunkManager.js — PCM 音频分片管理器（ES Module）
//  根据音频时长自动选择最优 chunk 大小
// ═══════════════════════════════════════════════════════════════

export function splitPCM(channels, sampleRate) {
  const length = channels[0].length;
  const duration = length / sampleRate;

  let chunkSec;
  if (duration < 60) chunkSec = 5;
  else if (duration < 600) chunkSec = 10;
  else chunkSec = 20;

  const chunkSamples = sampleRate * chunkSec;
  const chunks = [];

  for (let i = 0; i < length; i += chunkSamples) {
    const end = Math.min(i + chunkSamples, length);
    chunks.push({
      data: channels.map(ch => ch.slice(i, end)),
      index: chunks.length,
    });
  }

  return chunks;
}
```

---

### 14.9 core/reduceResults.js — 加权汇总

```javascript
// ═══════════════════════════════════════════════════════════════
//  reduceResults.js — 分片分析结果汇总器（ES Module，唯一真源）
// ═══════════════════════════════════════════════════════════════

function reduceResults(results, sampleRate, totalSamples, channelsCount) {
  if (!results || results.length === 0) return {};

  let globalPeak = 0, rmsSumSq = 0, globalClippedSamples = 0, dcOffsetSum = 0, totalWeight = 0;
  let spectrumBins = null, spectrumWeightSum = 0;
  let stereoCorrSum = 0, midSumSq = 0, sideSumSq = 0, stereoWeightSum = 0;

  for (const r of results) {
    if (!r) continue;
    const w = r.sampleCount || 1;
    if (r.peak > globalPeak) globalPeak = r.peak;
    if (typeof r.rms === 'number') { rmsSumSq += (r.rms * r.rms) * w; totalWeight += w; }
    if (typeof r.clippedSamples === 'number') globalClippedSamples += r.clippedSamples;
    if (typeof r.dcOffset === 'number') dcOffsetSum += r.dcOffset * w;
    if (r.spectrum && r.spectrum.length > 0) {
      if (!spectrumBins) spectrumBins = new Float32Array(r.spectrum.length);
      for (let i = 0; i < spectrumBins.length && i < r.spectrum.length; i++) spectrumBins[i] += (r.spectrum[i] || 0) * w;
      spectrumWeightSum += w;
    }
    if (typeof r.stereoCorrelation === 'number') { stereoCorrSum += r.stereoCorrelation * w; stereoWeightSum += w; }
    if (typeof r.midRMS === 'number') midSumSq += (r.midRMS * r.midRMS) * w;
    if (typeof r.sideRMS === 'number') sideSumSq += (r.sideRMS * r.sideRMS) * w;
  }

  const globalRMS = totalWeight > 0 ? Math.sqrt(rmsSumSq / totalWeight) : 0;
  const avgSpectrum = spectrumBins && spectrumWeightSum > 0 ? Array.from(spectrumBins).map(v => v / spectrumWeightSum) : [];
  const maxSpecVal = avgSpectrum.length > 0 ? Math.max(...avgSpectrum) : 1;
  const normSpectrum = avgSpectrum.map(v => v / (maxSpecVal || 1));

  return {
    peak: globalPeak, rms: globalRMS,
    crestFactor: globalRMS > 0 ? 20 * Math.log10(globalPeak / globalRMS) : 0,
    dcOffset: totalWeight > 0 ? dcOffsetSum / totalWeight : 0,
    clippedSamples: globalClippedSamples,
    clipRatio: totalSamples > 0 ? globalClippedSamples / totalSamples : 0,
    spectrum: avgSpectrum, normSpectrum,
    dynamicRangeDB: globalRMS > 0 ? 20 * Math.log10(1.0 / globalRMS) : 0,
    stereoCorrelation: stereoWeightSum > 0 ? stereoCorrSum / stereoWeightSum : null,
    midRMS: totalWeight > 0 ? Math.sqrt(midSumSq / totalWeight) : 0,
    sideRMS: totalWeight > 0 ? Math.sqrt(sideSumSq / totalWeight) : 0,
    stereoWidth: totalWeight > 0 && Math.sqrt(midSumSq / totalWeight) > 0 ? Math.sqrt(sideSumSq / totalWeight) / Math.sqrt(midSumSq / totalWeight) : 0,
    sampleRate, totalSamples, channelsCount,
    _chunked: true, _chunkCount: results.length,
  };
}

export { reduceResults };
```

---

### 14.10 core/workerPool.js — Worker 并行调度池

```javascript
// ═══════════════════════════════════════════════════════════════
//  workerPool.js — Worker 并行调度池（ES Module）
//  4 Worker 并行，背压控制
// ═══════════════════════════════════════════════════════════════

export class WorkerPool {
  constructor(workerUrl, size = 4) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.idle = [];
    this.callbacks = new Map();
    this._activeCount = 0;

    for (let i = 0; i < size; i++) {
      const w = new Worker(workerUrl);
      w.onmessage = (e) => this._done(w, e);
      w.onerror = (err) => this._error(w, err);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      if (this.queue.length > 50) {
        this.queue = this.queue.slice(-50);
      }
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      this.callbacks.set(w, job);
      this._activeCount++;
      w.postMessage(job.task);
    }
  }

  _done(w, e) {
    const job = this.callbacks.get(w);
    this.callbacks.delete(w);
    this.idle.push(w);
    this._activeCount--;
    if (job) job.resolve(e.data);
    this._dispatch();
  }

  _error(w, err) {
    const job = this.callbacks.get(w);
    this.callbacks.delete(w);
    this.idle.push(w);
    this._activeCount--;
    if (job) job.reject(err);
    this._dispatch();
  }

  get activeCount() { return this._activeCount; }

  terminate() {
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.callbacks.clear();
    this._activeCount = 0;
  }
}
```

---

### 14.11 core/safeRunner.js — 安全执行包装器

```javascript
// ═══════════════════════════════════════════════════════════════
//  safeRunner.js — 产品级保护层
//  安全执行异步函数，失败返回 fallback
// ═══════════════════════════════════════════════════════════════

export async function safeRun(fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    console.error("[SAFE ERROR]", e);
    return fallback;
  }
}
```

---

### 14.12 worker/analyze.worker.js — FFT 分析 Worker

```javascript
// ═══════════════════════════════════════════════════════════════
//  analyze.worker.js — 轻量分片音频分析 Worker (V3.1 增强保护)
//  每个 Chunk 独立计算，增强错误隔离
// ═══════════════════════════════════════════════════════════════

const FFT_SIZE = 2048;
const SPECTRUM_BINS = 512;

self.onmessage = async (e) => {
  try {
    const { chunk, sampleRate } = e.data;

    if (!chunk || !chunk[0]) {
      throw new Error('Invalid chunk: empty channel data');
    }

    const res = analyzeChunk(chunk, sampleRate);
    self.postMessage({ ok: true, res });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message || String(err) });
  }
};

function analyzeChunk(channels, sampleRate) {
  const numChannels = channels.length;
  const len = channels[0].length;

  let peak = 0;
  let rmsSumSq = 0;
  let clippedCount = 0;
  let dcSum = 0;

  // Hann 窗
  const window = hannWindow(FFT_SIZE);
  const fftReal = new Float32Array(FFT_SIZE);
  const fftImag = new Float32Array(FFT_SIZE);
  const spectrumAccum = new Float32Array(SPECTRUM_BINS);

  const numFrames = Math.max(1, Math.floor((len - FFT_SIZE) / (FFT_SIZE / 2)) + 1);

  for (let frame = 0; frame < numFrames; frame++) {
    const offset = frame * (FFT_SIZE / 2);
    if (offset + FFT_SIZE > len) break;

    for (let i = 0; i < FFT_SIZE; i++) {
      let val = 0;
      if (numChannels === 1) {
        val = channels[0][offset + i];
      } else if (numChannels >= 2) {
        val = (channels[0][offset + i] + channels[1][offset + i]) / 2;
      }
      fftReal[i] = val * window[i];
      fftImag[i] = 0;

      const abs = Math.abs(val);
      if (abs > peak) peak = abs;
      rmsSumSq += val * val;
      dcSum += val;
      if (abs >= 0.999) clippedCount++;
    }

    fftInPlace(fftReal, fftImag, FFT_SIZE, false);

    for (let b = 0; b < SPECTRUM_BINS; b++) {
      const freqIdx = Math.round((b / SPECTRUM_BINS) * (FFT_SIZE / 2));
      const mag = Math.sqrt(fftReal[freqIdx] * fftReal[freqIdx] + fftImag[freqIdx] * fftImag[freqIdx]);
      spectrumAccum[b] += mag;
    }
  }

  const totalSamples = numFrames * FFT_SIZE;
  const rms = totalSamples > 0 ? Math.sqrt(rmsSumSq / totalSamples) : 0;
  const dcOffset = totalSamples > 0 ? dcSum / totalSamples : 0;
  const spectrum = Array.from(spectrumAccum).map(v => v / Math.max(1, numFrames));

  let stereoCorrelation = null;
  let midRMS = null, sideRMS = null;

  if (numChannels >= 2) {
    let midSumSq = 0, sideSumSq = 0;
    for (let i = 0; i < len; i++) {
      const L = channels[0][i];
      const R = channels[1][i];
      const mid = (L + R) / 2;
      const side = (L - R) / 2;
      midSumSq += mid * mid;
      sideSumSq += side * side;
    }
    midRMS = len > 0 ? Math.sqrt(midSumSq / len) : 0;
    sideRMS = len > 0 ? Math.sqrt(sideSumSq / len) : 0;

    if (midRMS > 0 && sideRMS > 0) {
      const ratio = sideRMS / midRMS;
      stereoCorrelation = 1 - Math.min(ratio, 1);
    }
  }

  return {
    peak,
    rms,
    dcOffset,
    clippedSamples: clippedCount,
    spectrum,
    sampleCount: len,
    stereoCorrelation,
    midRMS,
    sideRMS,
    numFrames,
  };
}

// ── FFT (Cooley-Tukey, in-place) ──
function fftInPlace(real, imag, n, inverse) {
  for (let i = 0, j = 0; i < n; i++) {
    if (j > i) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let m = n >> 1;
    while (m > 0 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    for (let i = 0; i < n; i += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const re = real[i + j + half] * wr - imag[i + j + half] * wi;
        const im = real[i + j + half] * wi + imag[i + j + half] * wr;
        real[i + j + half] = real[i + j] - re;
        imag[i + j + half] = imag[i + j] - im;
        real[i + j] += re;
        imag[i + j] += im;

        const tmp = wr * cosA - wi * sinA;
        wi = wr * sinA + wi * cosA;
        wr = tmp;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

// ── Hann 窗 ──
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
  }
  return w;
}
```

---

### 14.13 utils/dom.js — DOM 快捷工具

```javascript
// ═══════════════════════════════════════════════════════════════
//  utils/dom.js — DOM 快捷工具
//  来源: app.js L6-8
// ═══════════════════════════════════════════════════════════════

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => [...p.querySelectorAll(s)];
```

---

### 14.14 utils/format.js — 格式化工具

```javascript
// ═══════════════════════════════════════════════════════════════
//  utils/format.js — 格式化工具
//  来源: app.js L2443-2445
// ═══════════════════════════════════════════════════════════════

function fmtSize(b) {
  return b < 1024
    ? b + ' B'
    : (b < 1048576
      ? (b / 1024).toFixed(1) + ' KB'
      : (b / 1048576).toFixed(1) + ' MB');
}

function fmtDur(s) {
  const m = Math.floor(s / 60);
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
```

---

### 14.15 utils/logger.js — 调试日志系统

```javascript
// ═══════════════════════════════════════════════════════════════
//  utils/logger.js — 调试日志系统
//  来源: app.js L20-85
// ═══════════════════════════════════════════════════════════════

const D = {
  entries: [],
  _errCount: 0, _okCount: 0,
  _startTime: 0,

  reset() {
    this.entries = [];
    this._errCount = 0; this._okCount = 0;
    this._startTime = Date.now();
    $('#debugBody').innerHTML = '<div class="debug-empty">等待文件加载...</div>';
    $('#debugErrCount').style.display = 'none';
    $('#debugOkCount').style.display = 'none';
    $('#debugConsole').classList.remove('open');
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
    const body = $('#debugBody');
    if (this.entries.length === 1 && this.entries[0].tag === 'INIT') {
      body.innerHTML = '';
    }
    if (this._suppressDOM) return;
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

function toggleDebug() {
  $('#debugConsole').classList.toggle('open');
}
window.toggleDebug = toggleDebug;
```

---

### 14.16 app.js 核心代码精选

> **说明**: app.js 共 ~2900 行，为避免文档过长，此处精选最关键的核心代码段（约占全文件 60%）。完整文件见项目源码 `renderer/app.js`。

#### A. 入口 / 导入 / adaptAnalysis 适配器 (行 1-72)

```javascript
import { AnalyzeEngine } from "../core/analyzeEngine.js";
const engine = new AnalyzeEngine();

function adaptAnalysis(raw, formatInfo) {
  const peakDB = raw.peak > 0 ? 20 * Math.log10(raw.peak) : -Infinity;
  const dcVal = raw.dcOffset || 0;
  return {
    peak: raw.peak, rms: raw.rms, crestFactor: raw.crestFactor,
    dynamicRangeDB: raw.dynamicRangeDB, spectrum: raw.spectrum,
    normSpectrum: raw.normSpectrum, sampleRate: raw.sampleRate,
    totalSamples: raw.totalSamples, channelsCount: raw.channelsCount,
    _chunked: raw._chunked, _chunkCount: raw._chunkCount,
    clip: {
      peakDB, truePeakDB: isFinite(peakDB) ? (peakDB + 0.2).toFixed(2) : '-96.00',
      hasClipping: (raw.clippedSamples || 0) > 0,
      hasTruePeakOver: (raw.clippedSamples || 0) > 100,
      clippedSamples: raw.clippedSamples || 0,
      clippedPct: (raw.clipRatio || 0) * 100,
      maxConsecutiveClip: 0,
    },
    dynamics: { crest: raw.crestFactor || 0 },
    loudness: {
      integratedLoudnessLUFS: -(raw.dynamicRangeDB || 18) - 8,
      shortTermMaxLUFS: -(raw.dynamicRangeDB || 18) - 10,
      lra: 8.0,
    },
    dcOffset: {
      offset: dcVal, isSignificant: Math.abs(dcVal) > 0.001,
      dcDB: Math.abs(dcVal) > 1e-10 ? 20 * Math.log10(Math.abs(dcVal)) : -120,
    },
    stereo: raw.stereoCorrelation !== null ? {
      stereoWidth: (raw.stereoWidth || 0) * 100,
      correlation: raw.stereoCorrelation,
      midRMS: raw.midRMS, sideRMS: raw.sideRMS,
      isOutOfPhase: raw.stereoCorrelation < 0,
      phaseInversionPct: raw.stereoCorrelation < 0 ? Math.abs(raw.stereoCorrelation) * 10 : 0,
      midSideRatio: raw.midRMS && raw.sideRMS ? 20 * Math.log10(raw.midRMS / Math.max(raw.sideRMS, 0.0001)) : 0,
    } : null,
    isCommercialMaster: (raw.clippedSamples || 0) > 0 && (raw.dynamicRangeDB || 99) < 14,
    actualBitDepth: { estimated: formatInfo?.bitDepth || 16, note: formatInfo?.bitDepth ? `基于文件格式 (${formatInfo.bitDepth}-bit)` : '未计算' },
    cutoff: { bw: 100, freq: raw.sampleRate / 2, confidence: 'low' },
    quality: [
      ['削波', (raw.clippedSamples || 0) > 0 ? 'warn' : 'pass'],
      ['动态范围', raw.dynamicRangeDB > 10 ? 'pass' : 'warn'],
      ['响度', 'pass'], ['LRA', 'pass'], ['TP过载', 'pass'],
      ['DC Offset', Math.abs(dcVal) > 0.001 ? 'warn' : 'pass'],
      ['格式', formatInfo?.lossless ? 'pass' : 'warn'],
      ['位深度', (formatInfo?.bitDepth || 16) >= 16 ? 'pass' : 'warn'],
    ],
  };
}
```

#### B. processFiles / processSingleFile 分析管线 (行 1019-1172)

```javascript
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

async function processSingleFile(file) {
  D.info('FILE', `--- ${file.name} (${fmtSize(file.size)}) ---`);
  const rawBytes = new Uint8Array(await file.arrayBuffer());
  STATE.rawBytes = rawBytes;
  const binInfo = parseFormatFromBytes(rawBytes);
  D.info('FORMAT', `binInfo: ${JSON.stringify(binInfo)}`);

  let buffer, channels, sampleRate, decodeMethod = '';

  try {
    await withTimeout((async () => {
      try {
        const r = await PromiseWithTimeout(decodeViaAudioElement(file), 30000);
        buffer = r.buffer; channels = r.channels; sampleRate = r.sampleRate;
        decodeMethod = 'AudioElement'; D.ok('DECODE', `AudioElement 成功: ${channels}ch ${sampleRate}Hz`);
      } catch (e1) {
        D.warn('DECODE', `AudioElement 失败: ${e1.message}`);
        if (binInfo && binInfo.codec === 'ALAC') {
          try {
            D.info('DECODE', '尝试 Pure JS ALAC 解码...');
            const r = await decodeALACWithPureJS(rawBytes);
            buffer = r.buffer; channels = r.channels; sampleRate = r.sampleRate;
            decodeMethod = 'Pure JS ALAC'; D.ok('DECODE', `ALAC 纯JS成功: ${channels}ch ${sampleRate}Hz`);
          } catch (e2) { D.warn('DECODE', `ALAC 纯JS失败: ${e2.message}`); }
        }
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
  } catch (timeoutErr) { D.err('DECODE', `解码超时: ${timeoutErr.message}`); }

  if (!buffer) throw new Error('所有解码方式均失败。请检查调试日志。');

  if (binInfo && binInfo.channels) channels = binInfo.channels;
  if (binInfo && binInfo.sampleRate) sampleRate = binInfo.sampleRate;

  const duration = buffer.duration || (buffer.length / sampleRate);

  const F = {
    container: (binInfo && binInfo.container) || 'Unknown',
    codec: (binInfo && binInfo.codec) || 'Unknown',
    format: (binInfo && binInfo.format) || 'Unknown',
    lossless: binInfo ? !!binInfo.lossless : true,
    channels, sampleRate, duration,
    bitDepth: (binInfo && binInfo.bitDepth) || (buffer.numberOfChannels > 0 && sampleRate > 0 ? null : 16),
    fileSize: file.size, filename: file.name,
    decodeMethod,
    actualBitrate: Math.round(file.size * 8 / (duration || 1)),
  };

  STATE.channels = channels; STATE.sampleRate = sampleRate; STATE.duration = duration;
  STATE.buffer = buffer; STATE.formatInfo = F; STATE.file = file;

  D._suppressDOM = false;
  D.ok('FILE', `解码完成: ${decodeMethod}, ${F.codec}, ${channels}ch, ${(sampleRate/1000).toFixed(1)}kHz, ${duration.toFixed(1)}s`);

  // 1. 提取 PCM 声道数据
  const pcmChannels = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    pcmChannels.push(new Float32Array(buffer.getChannelData(ch)));
  }

  // 2. 通过分析引擎运行（切片 → Worker Pool → 汇总）
  D.info('WORKER', `=] 开始引擎分析, channels=${pcmChannels.length}x${pcmChannels[0]?.length}, sr=${sampleRate}`);
  const t0 = performance.now();
  let rawResult;
  try {
    rawResult = await engine.run(pcmChannels, sampleRate, (ratio) => updateProgress(Math.round(ratio * 100)));
    const t1 = performance.now();
    D.ok('WORKER', `] 引擎完成: ${((t1-t0)/1000).toFixed(2)}s, chunks=${rawResult._chunkCount}, peak=${rawResult.peak?.toFixed(3)}, rms=${rawResult.rms?.toFixed(4)}`);
  } catch (ee) {
    D.err('WORKER', `引擎崩溃: ${ee.message}`);
    console.error('Engine error:', ee);
    return null;
  }

  // 3. 适配为渲染层期望的嵌套结构
  D.info('WORKER', '开始 adaptAnalysis...');
  try {
    STATE.analysis = adaptAnalysis(rawResult, F);
    D.ok('WORKER', `adaptAnalysis 完成, quality=${STATE.analysis.quality?.length}项`);
  } catch (ee) {
    D.err('WORKER', `adaptAnalysis 崩溃: ${ee.message}, rawResult=${JSON.stringify(rawResult||{}).slice(0,200)}`);
    console.error('adaptAnalysis error:', ee);
    return null;
  }

  updateProgress(100);
  D.ok('WORKER', `分析完成, peak=${STATE.analysis.peak?.toFixed(3)}`);
  return { buffer, channels, sampleRate, duration, formatInfo: F, analysis: STATE.analysis };
}
```

#### C. renderAll() 总管 + Canvas 绑图 (行 2029-2068)

```javascript
function renderAll() {
  __TRACE.step('before render');
  const wrap = $('#results');
  wrap.innerHTML = '';
  const sections = [
    ['overview', renderOverview], ['spectrum', renderSpectrum],
    ['spectrogram', renderSpectrogramChart], ['soundspectrum', renderSoundSpectrum],
    ['waveform', renderWaveform], ['dynamics', renderDynamics],
    ['loudnesscurve', renderLoudnessCurve], ['snr', renderSNR],
    ['distortion', renderDistortion], ['stereo', renderStereo],
    ['quality', renderQuality], ['info', renderFileInfo],
  ];
  for (const [id, fn] of sections) {
    const div = document.createElement('div');
    div.className = 'section';
    div.id = 'section-' + id;
    div.innerHTML = fn();
    wrap.appendChild(div);
  }
  $$('.section').forEach(s => s.style.display = (s.id === 'section-overview') ? '' : 'none');
  $('#section-overview').style.display = '';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawSpectrumCanvas(); drawSpectrogramCanvas();
      drawSoundSpectrumCanvas(); drawWaveformCanvas();
      drawPhaseCanvas(); drawLoudnessCurveCanvas();
      drawSNRCanvas(); drawDistortionCanvas();
    });
  });
}
```

#### D. diagnoseRootCause 根因诊断 (行 2338-2388)

```javascript
function diagnoseRootCause(analysis, formatInfo) {
  const A = analysis, F = formatInfo;
  const diag = [];
  const sr = F.sampleRate, crest = A.dynamics.crest;
  const lufs = A.loudness.integratedLoudnessLUFS;
  const lra = A.loudness.lra, cf = A.cutoff, clip = A.clip;
  const loudnessWar = F.lossless && clip.hasClipping && crest < 10 && lufs > -12;

  if (loudnessWar) {
    const era = crest < 6 ? '2000-2010' : crest < 8 ? '2010' : '现代';
    diag.push({ title: '母带风格：硬限幅（Brickwall Limiter）', severity: 'info',
      detail: `此音频符合<b>${era}年代高响度母带处理</b>特征：Crest ${crest.toFixed(1)}dB，${lufs.toFixed(0)} LUFS，${clip.clippedSamples} 削波点。这不是文件损坏——母带工程师刻意牺牲动态以换取持续的感知响度。` });
  }
  if (!clip.hasClipping && crest < 7 && clip.peakDB > -0.3 && !loudnessWar) {
    diag.push({ title: '母带风格：软削波 / 饱和式限幅', severity: 'info',
      detail: `无数字削波但 Crest ${crest.toFixed(1)}dB 且峰值 ${clip.peakDB.toFixed(2)}dBFS——用<b>软削波</b>替代硬限幅器。EDM/Hip-Hop 常见。` });
  }
  if (sr >= 88200 && cf.confidence === 'high' && cf.bw < 85) {
    const realSR = cf.freq * 2.2;
    diag.push({ title: '根因推断：伪高解析度（升频文件）', severity: 'bad',
      detail: `声称 ${(sr/1000).toFixed(0)}kHz 但频谱在 ${(cf.freq/1000).toFixed(1)}kHz 截断，带宽 ${cf.bw.toFixed(0)}%。高概率从 ${realSR < 50000 ? '44.1/48kHz' : (realSR/1000).toFixed(0)+'kHz'} 源升频。文件体积膨胀 ${((sr/(cf.freq*2.2))**2).toFixed(1)} 倍。` });
  }
  if (clip.hasClipping && crest > 10 && lufs < -14 && !loudnessWar) {
    diag.push({ title: '根因推断：录音增益设置过高', severity: 'warn',
      detail: `削波+良好动态：Crest ${crest.toFixed(1)}dB，响度适中，但 ${clip.clippedSamples} 削波点。高概率录音增益过高——瞬态尖峰击穿电平上限。` });
  }
  if (A.stereo && A.stereo.isOutOfPhase) {
    diag.push({ title: '根因推断：立体声极性反转', severity: 'bad',
      detail: `相关性 ${A.stereo.correlation.toFixed(3)}，反相比例 ${A.stereo.phaseInversionPct.toFixed(1)}%。单声道设备上中置元素消失。常见：XLR 焊反、插件极性反转。` });
  }
  // ...更多诊断规则省略，完整版见 app.js 2338-2388 行
  return diag;
}
```

---

> **完整 app.js 源码共 ~2900 行，位于项目 `renderer/app.js`。** 以上精选了最核心的分析管线、Canvas 绑图和诊断引擎代码。其余 render*() 函数（~600 行 HTML 字符串模板）和 narrate*() 函数（~500 行中文解读）因篇幅限制省略。

---

### 14.17 utils/audioMath.js — 高级音频分析算法（v2.1.0 新增）

```javascript
// ═══════════════════════════════════════════════════════════════
//  audioMath.js — 高级音频分析算法（主线程执行）
//  输出精确的响度 / 位深度 / SNR / 失真 / 截止频率
// ═══════════════════════════════════════════════════════════════

const D = {
  warn(tag, msg) { console.warn(`[audioMath:${tag}] ${msg}`); }
};

export function setLogger(logger) {
  Object.assign(D, logger);
}

// ═══ 1. computeLoudness — ITU-R BS.1770-4 K-weighting 响度分析 ═══

export function computeLoudness(data, sampleRate) {
  try {
    if (!data || data.length < sampleRate * 0.4) {
      D.warn('Loudness', '音频太短（<0.4s），无法计算响度');
      return null;
    }

    // ── K-weighting 滤波：预加重 + RLB 高通 + 高架 ──
    const preEmphasis = preEmphasisFilter(data);
    const rlbFiltered = rlbHighPass(preEmphasis, sampleRate);
    const kWeighted = highShelfFilter(rlbFiltered, sampleRate);

    // ── 预计算平方值 ──
    const sq = new Float32Array(kWeighted.length);
    for (let i = 0; i < kWeighted.length; i++) sq[i] = kWeighted[i] * kWeighted[i];

    // ── 400ms block, 75% overlap ──
    const blockSamples = Math.round(0.4 * sampleRate);
    const hopSamples = Math.round(0.1 * sampleRate);

    const meanSquares = [];
    for (let start = 0; start + blockSamples <= kWeighted.length; start += hopSamples) {
      let sumSq = 0;
      for (let i = start; i < start + blockSamples; i++) sumSq += sq[i];
      meanSquares.push(sumSq / blockSamples);
    }

    if (meanSquares.length === 0) {
      D.warn('Loudness', '无有效数据块');
      return null;
    }

    // ── 门控 1: 绝对门控 -70 LUFS ──
    const threshold1 = Math.pow(10, -7);
    const gated1 = meanSquares.filter(v => v >= threshold1);
    if (gated1.length === 0) {
      D.warn('Loudness', '所有块低于-70 LUFS 门限');
      return null;
    }
    const meanLoud1 = gated1.reduce((a, b) => a + b, 0) / gated1.length;

    // ── 门控 2: 相对门控 -10 LU ──
    const threshold2 = meanLoud1 * 0.1;
    const gated2 = gated1.filter(v => v >= threshold2);
    const integratedPower = gated2.length > 0
      ? gated2.reduce((a, b) => a + b, 0) / gated2.length
      : meanLoud1;

    const integratedLoudnessLUFS = -0.691 + 10 * Math.log10(Math.max(integratedPower, 1e-12));

    // ── 短时响度（滑动窗口 O(n)） ──
    const stBlockSamples = Math.round(3.0 * sampleRate);
    const stHopSamples = Math.round(0.1 * sampleRate);
    const stLUFSvalues = [];
    if (kWeighted.length >= stBlockSamples) {
      let windowSum = 0;
      for (let i = 0; i < stBlockSamples; i++) windowSum += sq[i];
      stLUFSvalues.push(windowSum > 1e-12 ? -0.691 + 10 * Math.log10(windowSum / stBlockSamples) : -70);
      for (let i = stBlockSamples; i < kWeighted.length; i++) {
        windowSum += sq[i] - sq[i - stBlockSamples];
        if ((i - stBlockSamples + 1) % stHopSamples === 0) {
          stLUFSvalues.push(windowSum > 1e-12 ? -0.691 + 10 * Math.log10(windowSum / stBlockSamples) : -70);
        }
      }
    }

    const shortTermMaxLUFS = stLUFSvalues.length > 0 ? Math.max(...stLUFSvalues) : integratedLoudnessLUFS;

    // ── LRA（10%-95% 百分位） ──
    const gatedLUFS = gated1.map(v => v > 1e-12 ? -0.691 + 10 * Math.log10(v) : -70);
    gatedLUFS.sort((a, b) => a - b);
    const n = gatedLUFS.length;
    const p10 = gatedLUFS[Math.floor(n * 0.1)];
    const p95 = gatedLUFS[Math.floor(n * 0.95)];
    const lra = p95 - p10;

    return {
      integratedLoudnessLUFS: Math.round(integratedLoudnessLUFS * 10) / 10,
      shortTermMaxLUFS: Math.round(shortTermMaxLUFS * 10) / 10,
      lra: Math.round(lra * 10) / 10,
      stLUFSvalues, stTimeStep: 0.1,
    };
  } catch (e) {
    D.warn('Loudness', `计算失败: ${e.message}`);
    return null;
  }
}

// ── K-weighting 子滤波器 ──

function preEmphasisFilter(data) {
  const out = new Float32Array(data.length);
  let prev = 0;
  const alpha = 0.995;
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] - alpha * prev;
    prev = data[i];
  }
  return out;
}

function rlbHighPass(data, sr) {
  // RLB 二阶 IIR, fc ≈ 38 Hz
  const out = new Float32Array(data.length);
  const w0 = 2 * Math.PI * 38 / sr;
  const alpha = Math.sin(w0) / Math.sqrt(2);
  const cosW0 = Math.cos(w0);
  const b0 = (1 + cosW0) / 2, b1 = -(1 + cosW0), b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosW0, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function highShelfFilter(data, sr) {
  // 高架: +4dB, fc ≈ 1500 Hz, Q = 0.707
  const out = new Float32Array(data.length);
  const fc = 1500, gainDB = 4.0;
  const A = Math.pow(10, gainDB / 40);
  const w0 = 2 * Math.PI * fc / sr;
  const cosW0 = Math.cos(w0), sinW0 = Math.sin(w0);
  const S = 1;
  const alpha = sinW0 / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const sqrtA = Math.sqrt(A);
  const b0 = A * ((A + 1) - (A - 1) * cosW0 + 2 * sqrtA * alpha);
  const b1 = 2 * A * ((A - 1) - (A + 1) * cosW0);
  const b2 = A * ((A + 1) - (A - 1) * cosW0 - 2 * sqrtA * alpha);
  const a0 = (A + 1) + (A - 1) * cosW0 + 2 * sqrtA * alpha;
  const a1 = -2 * ((A - 1) + (A + 1) * cosW0);
  const a2 = (A + 1) + (A - 1) * cosW0 - 2 * sqrtA * alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

// ═══ 2. estimateBitDepth — GCD 量化步长直方图法 ═══

export function estimateBitDepth(data, formatInfo) {
  try {
    if (!data || data.length < 1000) {
      D.warn('BitDepth', '数据不足');
      return null;
    }

    const sampleLen = Math.min(data.length, 30 * 48000);
    const step = Math.max(1, Math.floor(sampleLen / 50000));
    const diffs = [];
    for (let i = 1; i < sampleLen; i += step) {
      const d = Math.abs(data[i] - data[i - 1]);
      if (d > 1e-10 && d < 0.5) diffs.push(d);
    }

    if (diffs.length < 100) {
      const formatBD = formatInfo?.bitDepth || 16;
      return { estimated: formatBD, note: '样本不足，回退到文件声明', detail: `基于格式声明 ${formatBD}-bit` };
    }

    const NUM_BINS = 2000;
    const minDiff = diffs.reduce((a, b) => Math.min(a, b), Infinity);
    const binWidth = minDiff * 0.5;
    const histogram = new Array(NUM_BINS).fill(0);
    for (const d of diffs) {
      const bin = Math.min(NUM_BINS - 1, Math.floor(d / binWidth));
      if (bin >= 0) histogram[bin]++;
    }

    const peaks = [];
    for (let i = 2; i < NUM_BINS - 1; i++) {
      if (histogram[i] > histogram[i - 1] && histogram[i] > histogram[i + 1] && histogram[i] > diffs.length * 0.002) {
        peaks.push(i);
      }
    }

    if (peaks.length < 2) {
      const formatBD = formatInfo?.bitDepth || 16;
      return { estimated: formatBD, note: '无清晰量化特征', detail: `回退到格式声明 ${formatBD}-bit` };
    }

    function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
    const spacings = [];
    for (let i = 1; i < peaks.length; i++) spacings.push(peaks[i] - peaks[i - 1]);
    let commonGcd = spacings[0];
    for (let i = 1; i < spacings.length; i++) {
      commonGcd = gcd(commonGcd, spacings[i]);
      if (commonGcd <= 1) break;
    }

    const rawStep = commonGcd * binWidth;
    if (rawStep <= 0 || rawStep > 0.5) {
      return { estimated: 16, note: '量化步长异常', detail: '无法可靠检测' };
    }

    const estimated = Math.round(-Math.log2(rawStep));
    const clamped = Math.max(8, Math.min(32, estimated));
    const formatBD = formatInfo?.bitDepth || 16;

    if (clamped <= 17 && formatBD >= 24) {
      return {
        estimated: clamped,
        note: `${clamped}-bit 实测（文件声称 ${formatBD}-bit）`,
        detail: `量化步长 ${rawStep.toExponential(2)} → ~${estimated}-bit。差异 ${formatBD - clamped} bit 可能为零填充`,
      };
    }
    return {
      estimated: clamped,
      note: `${clamped}-bit 实测`,
      detail: `量化步长 ${rawStep.toExponential(2)} → ${estimated}-bit`,
    };
  } catch (e) {
    D.warn('BitDepth', `计算失败: ${e.message}`);
    return null;
  }
}

// ═══ 3. computeSNR — 分块噪底估计信噪比 ═══

export function computeSNR(data, sampleRate) {
  try {
    if (!data || data.length < sampleRate * 1) {
      D.warn('SNR', '音频太短（<1s）');
      return null;
    }

    const BLOCK = 4096;
    const totalBlocks = Math.floor(data.length / BLOCK);
    if (totalBlocks < 10) { D.warn('SNR', '分块不足'); return null; }

    const blockRMS = new Float32Array(totalBlocks);
    let globalSumSq = 0;
    for (let b = 0; b < totalBlocks; b++) {
      const off = b * BLOCK;
      let sumSq = 0;
      for (let i = off; i < off + BLOCK; i++) sumSq += data[i] * data[i];
      blockRMS[b] = Math.sqrt(sumSq / BLOCK);
      globalSumSq += sumSq;
    }

    const globalRMS = Math.sqrt(globalSumSq / (totalBlocks * BLOCK));
    const sortedBlocks = Array.from(blockRMS).sort((a, b) => a - b);
    const noiseCount = Math.max(1, Math.floor(totalBlocks * 0.1));
    let noiseSumSq = 0;
    for (let i = 0; i < noiseCount; i++) noiseSumSq += sortedBlocks[i] * sortedBlocks[i];
    const noiseFloorRMS = Math.sqrt(noiseSumSq / noiseCount);
    const noiseFloorDB = noiseFloorRMS > 1e-12 ? 20 * Math.log10(noiseFloorRMS) : -96;
    const snrDB = noiseFloorRMS > 1e-12 ? 20 * Math.log10(globalRMS / noiseFloorRMS) : (globalRMS > 1e-12 ? 96 : 0);

    const bandSNR = (lowCut, highCut) => {
      const filtered = simpleBandFilter(data, sampleRate, lowCut, highCut);
      let bandTotal = 0;
      for (let i = 0; i < filtered.length; i++) bandTotal += filtered[i] * filtered[i];
      const bandRMS = Math.sqrt(bandTotal / filtered.length);
      const quietBlocks = [];
      for (let b = 0; b < totalBlocks; b++) {
        const off = b * BLOCK;
        let sq = 0;
        for (let i = off; i < Math.min(off + BLOCK, filtered.length); i++) sq += filtered[i] * filtered[i];
        quietBlocks.push(Math.sqrt(sq / Math.min(BLOCK, filtered.length - off)));
      }
      quietBlocks.sort((a, b) => a - b);
      const nc = Math.max(1, Math.floor(quietBlocks.length * 0.1));
      let ns = 0;
      for (let i = 0; i < nc; i++) ns += quietBlocks[i] * quietBlocks[i];
      const nRMS = Math.sqrt(ns / nc);
      return nRMS > 1e-12 ? 20 * Math.log10(bandRMS / nRMS) : 60;
    };

    const snrLow = bandSNR(20, 250);
    const snrMid = bandSNR(250, 4000);
    const snrHigh = bandSNR(4000, Math.min(sampleRate / 2 * 0.9, 20000));

    return {
      snrDB: Math.round(snrDB * 10) / 10,
      noiseFloorDB: Math.round(noiseFloorDB * 10) / 10,
      snrLow: Math.round(snrLow * 10) / 10,
      snrMid: Math.round(snrMid * 10) / 10,
      snrHigh: Math.round(snrHigh * 10) / 10,
      isEstimate: false,
    };
  } catch (e) {
    D.warn('SNR', `计算失败: ${e.message}`);
    return null;
  }
}

function simpleBandFilter(data, sr, lowCut, highCut) {
  const targetSR = highCut * 3;
  const decimate = targetSR < sr ? Math.floor(sr / targetSR) : 1;
  const filtered = new Float32Array(Math.floor(data.length / decimate));
  const alpha = Math.exp(-2 * Math.PI * highCut / sr * decimate);
  let y = data[0] || 0;
  for (let i = 0; i < filtered.length; i++) {
    const idx = i * decimate;
    const x = idx < data.length ? data[idx] : 0;
    y = y + alpha * (x - y);
    filtered[i] = y;
  }
  if (lowCut > 20) {
    const beta = Math.exp(-2 * Math.PI * lowCut / sr * decimate);
    let prev = filtered[0] || 0;
    let prevOut = 0;
    for (let i = 1; i < filtered.length; i++) {
      const current = filtered[i];
      filtered[i] = beta * (prevOut + current - prev);
      prevOut = filtered[i];
      prev = current;
    }
  }
  return filtered;
}

// ═══ 4. computeDistortion — 基频检测 + 谐波分析 ═══

export function computeDistortion(data, sampleRate, freqs, spectrum) {
  try {
    if (!data || !freqs || !spectrum || freqs.length < 10) {
      D.warn('Distortion', '数据不足');
      return null;
    }

    // 自相关法检测基频（前 2 秒）
    const autoLen = Math.min(data.length, 2 * sampleRate);
    const corrLen = Math.min(autoLen, 4096);
    const correlation = new Float32Array(corrLen);
    for (let lag = 0; lag < corrLen; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < autoLen; i++) sum += data[i] * data[i + lag];
      correlation[lag] = sum;
    }

    let bestLag = 0, bestVal = -Infinity;
    const minLag = Math.floor(sampleRate / 4000);
    const maxLag = Math.floor(sampleRate / 60);
    for (let lag = minLag; lag < Math.min(maxLag, corrLen); lag++) {
      if (correlation[lag] > correlation[lag - 1] && correlation[lag] > correlation[lag + 1]) {
        if (correlation[lag] > bestVal) { bestVal = correlation[lag]; bestLag = lag; }
      }
    }

    if (bestLag === 0) { D.warn('Distortion', '无法检测基频'); return null; }
    const fundamentalHz = sampleRate / bestLag;
    if (fundamentalHz < 30 || fundamentalHz > 2000) {
      D.warn('Distortion', `基频 ${fundamentalHz.toFixed(0)}Hz 超出合理范围`);
      return null;
    }

    // 提取谐波幅度
    const harmonics = [];
    for (let h = 1; h <= 5; h++) {
      const targetFreq = fundamentalHz * h;
      let bestIdx = 0, bestDist = Infinity;
      for (let i = 0; i < freqs.length; i++) {
        const dist = Math.abs(freqs[i] - targetFreq);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (bestDist < targetFreq * 0.1) {
        harmonics.push(spectrum[bestIdx] !== undefined ? spectrum[bestIdx] : -120);
      } else if (h === 1) {
        return null;
      } else {
        harmonics.push(-120);
      }
    }

    if (harmonics.length < 2) { D.warn('Distortion', '谐波不足'); return null; }

    // THD = sqrt(sum(H2²...H5²)) / H1 × 100%
    const H1_linear = Math.pow(10, harmonics[0] / 20);
    let harmonicSumSq = 0;
    for (let h = 1; h < harmonics.length; h++) {
      const linear = Math.pow(10, harmonics[h] / 20);
      harmonicSumSq += linear * linear;
    }
    const thdPct = H1_linear > 1e-12 ? (Math.sqrt(harmonicSumSq) / H1_linear) * 100 : 0;

    // 波形不对称性
    let posSum = 0, negSum = 0, posCount = 0, negCount = 0;
    const asymLen = Math.min(data.length, 5 * sampleRate);
    for (let i = 0; i < asymLen; i++) {
      if (data[i] > 0) { posSum += data[i]; posCount++; }
      else if (data[i] < 0) { negSum += -data[i]; negCount++; }
    }
    const posAvg = posCount > 0 ? posSum / posCount : 0;
    const negAvg = negCount > 0 ? negSum / negCount : 0;
    const asymmetryPct = (posAvg + negAvg) > 1e-10
      ? Math.abs(posAvg - negAvg) / ((posAvg + negAvg) / 2) * 100 : 0;

    return {
      thdPct: Math.round(thdPct * 1000) / 1000,
      fundamentalHz: Math.round(fundamentalHz * 10) / 10,
      harmonics,
      asymmetryPct: Math.round(asymmetryPct * 10) / 10,
      isEstimate: false,
    };
  } catch (e) {
    D.warn('Distortion', `计算失败: ${e.message}`);
    return null;
  }
}

// ═══ 5. detectCutoff — 截止频率检测 ═══

export function detectCutoff(freqs, spectrum, sampleRate) {
  try {
    if (!freqs || !spectrum || freqs.length < 20) {
      D.warn('Cutoff', '频谱数据不足');
      return null;
    }

    const nyquist = sampleRate / 2;
    const numBins = freqs.length;

    let noiseStartIdx = 0;
    for (let i = 0; i < numBins; i++) {
      if (freqs[i] >= 12000) { noiseStartIdx = i; break; }
    }
    if (noiseStartIdx === 0) noiseStartIdx = Math.floor(numBins * 0.7);

    let ultraSum = 0, ultraCount = 0;
    for (let i = noiseStartIdx; i < numBins; i++) {
      ultraSum += spectrum[i]; ultraCount++;
    }
    const ultraNoiseFloor = ultraCount > 0 ? ultraSum / ultraCount : -80;

    const threshold = 15; // dB above noise floor
    let cutoffIdx = numBins - 1;
    for (let i = numBins - 1; i >= 0; i--) {
      if (spectrum[i] > ultraNoiseFloor + threshold) {
        cutoffIdx = i; break;
      }
    }

    const cutoffFreq = freqs[cutoffIdx] || nyquist;
    const availableBw = cutoffFreq / nyquist * 100;
    let confidence = 'low';
    if (cutoffFreq < nyquist * 0.6) confidence = 'high';
    else if (cutoffFreq < nyquist * 0.85) confidence = 'medium';

    return { freq: Math.round(cutoffFreq), bw: Math.round(availableBw * 10) / 10, confidence };
  } catch (e) {
    D.warn('Cutoff', `计算失败: ${e.message}`);
    return null;
  }
}
```

---

### 14.18 processSingleFile 集成代码（app.js 改动部分）

```javascript
// ▸ 改动1: 导入 audioMath 模块（app.js 第 7 行）
import * as audioMath from "../utils/audioMath.js";

// ▸ 改动2: 注入日志器（app.js D 定义之后）
// audioMath.setLogger({ warn(tag, msg) { D.warn(`audioMath:${tag}`, msg); } });

// ▸ 改动3: processSingleFile 中，analyzeFull() 之后插入高级算法调用
// （原 analyzeFull 返回 rawResult 之后、computeDisplayData 之前）

const ch0 = pcmChannels[0];
const nn = rawResult.normSpectrum;
const ff = rawResult.spectrum ? rawResult.spectrum.map((_, i) =>
  i * rawResult.sampleRate / 2 / (rawResult.spectrum.length - 1)) : null;
const adv = {};
adv.loudness    = audioMath.computeLoudness(ch0, rawResult.sampleRate);
adv.bitDepth    = audioMath.estimateBitDepth(ch0, F);
adv.snr         = audioMath.computeSNR(ch0, rawResult.sampleRate);
if (ff && nn) {
  adv.distortion = audioMath.computeDistortion(ch0, rawResult.sampleRate, ff, nn);
  adv.cutoff     = audioMath.detectCutoff(ff, nn, rawResult.sampleRate);
}

// ▸ 改动4: STATE.analysis 构建中的 5 个字段改为实测值

// loudness: adv.loudness 有值时用实测值，否则回退估算
loudness: adv.loudness ? {
  integratedLoudnessLUFS: adv.loudness.integratedLoudnessLUFS,
  shortTermMaxLUFS: adv.loudness.shortTermMaxLUFS,
  lra: adv.loudness.lra,
  stLUFSvalues: adv.loudness.stLUFSvalues || [],
  stTimeStep: adv.loudness.stTimeStep || 0.1,
} : { /* 原估算逻辑 */ },

// actualBitDepth: GCD 实测
actualBitDepth: adv.bitDepth ? {
  estimated: adv.bitDepth.estimated,
  note: adv.bitDepth.note,
  detail: adv.bitDepth.detail
} : { estimated: F?.bitDepth||16, /* fallback */ },

// cutoff: 高频衰减实测
cutoff: adv.cutoff ? {
  bw: adv.cutoff.bw,
  freq: adv.cutoff.freq,
  confidence: adv.cutoff.confidence
} : { bw:100, freq:sampleRate/2, confidence:'low' },

// snr: 分块噪底实测
snr: adv.snr ? {
  snrDB: adv.snr.snrDB,
  snrLow: adv.snr.snrLow,
  snrMid: adv.snr.snrMid,
  snrHigh: adv.snr.snrHigh,
  noiseFloorDB: adv.snr.noiseFloorDB,
  isEstimate: false
} : (dd.snr || { /* fallback */ }),

// distortion: 自相关+谐波实测
distortion: adv.distortion ? {
  harmonics: adv.distortion.harmonics,
  thdPct: adv.distortion.thdPct,
  fundamentalHz: adv.distortion.fundamentalHz,
  asymmetryPct: adv.distortion.asymmetryPct,
  isEstimate: false
} : (dd.distortion || { harmonics:[], thdPct:0, isEstimate:true }),
```

---

*文档更新于 2026-07-06 — v2.1.0 高级算法补充*
*源项目: AudioAnalyzer_V2 (Electron EXE 版)*
