# 音频质量分析器 · Audio Analyzer Pro

**Windows 桌面应用 · 完全离线 · 支持音乐库批量分析 · 20+ 音频格式**

不用上传、不用联网、不收集任何数据。拖入文件或扫描本地音乐库，输出广播级的客观指标 + 中文大白话解读。

---

## 下载

### 方式一：安装版（推荐）

👉 **[下载 Audio Analyzer Pro v9.0.1 安装程序](https://github.com/cda775819-blip/ALAC-hifi-/releases/latest/download/Audio.Analyzer.Pro.Setup.9.0.1.exe)**

文件名：`Audio Analyzer Pro Setup 9.0.1.exe`（211.8 MB）

- 双击安装，可自选安装目录，自动创建桌面快捷方式
- **已内置 ffmpeg / ffprobe**，无需另行安装任何依赖
- 卸载通过「设置 → 应用」，或安装目录下的 `Uninstall`

> 全部版本与更新说明见 👉 **[Releases 页面](https://github.com/cda775819-blip/ALAC-hifi-/releases)**
>
> 注：上面的直链指向最新版。GitHub 会把附件名里的空格转成点号，
> 因此直链文件名使用 `Audio.Analyzer.Pro.Setup.*.exe` 形式。

### 方式二：从源码运行

```bash
git clone https://github.com/cda775819-blip/ALAC-hifi-.git
cd ALAC-hifi-/AudioAnalyzer_V2
npm install
npm start
```

### 方式三：自行打包

```bash
cd AudioAnalyzer_V2
npm install
npm run build     # 产物在 dist/
```

---

## ⚠️ 关于 FFmpeg / FFprobe（打包前必读）

本工具**内置的纯 JS ALAC 解码器可独立处理绝大部分文件**，但有一条兜底解码路径依赖外部二进制：

| 二进制 | 用途 | 缺失后果 |
|--------|------|---------|
| `ffmpeg.exe` | 浏览器原生解码失败时的兜底（DSD、APE、WavPack 等） | 这些格式无法分析 |
| `ffprobe.exe` | 探测文件的**真实采样率**（大文件分段解码时使用） | 全库按 48kHz 分析，**采样率相关指标失真** |

放置位置（按优先级）：

```
AudioAnalyzer_V2/assets/ffmpeg.exe
AudioAnalyzer_V2/assets/ffprobe.exe
```

或直接安装到系统 `PATH`。

> **打包分发时务必把这两个文件放进 `assets/`** —— 否则用户机器上若没装 FFmpeg，
> 高采样率文件（96kHz / 192kHz / DSD）会被静默按 48kHz 分析，
> 「检测升采样假无损」这项能力会失效，而且不会报错。

下载：https://www.gyan.dev/ffmpeg/builds/ （选 `full` 版即可）

---

## 这是什么

一个面向**音频质量核查（QC）**的桌面工具。适合这些场景：

- 收到一批音乐文件，想知道哪些是**真无损**、哪些是从有损格式转出来的
- 想确认某张专辑有没有**响度战争**式的过度压缩
- 想知道一个「24bit/96kHz 高解析」文件是不是**低采样率升频**来的
- 想批量检查一个音乐库里有没有削波、DC 偏移、相位反转等问题

## 功能

### 分析指标

| 指标 | 说明 |
|------|------|
| **Integrated LUFS** | ITU-R BS.1770-4 标准 K-weighting + 双门限积分响度 |
| **LRA / Short-term LUFS** | 响度范围与短时响度曲线 |
| **True Peak** | 采样间过载检测 |
| **Crest Factor / 动态范围** | 峰值与 RMS 之比 |
| **削波检测** | 采样级削波计数与占比 |
| **DC 偏移** | 直流偏移检测 |
| **有效位深度** | 实测比特深度（识别 16bit 装进 24bit 容器的伪高解析） |
| **截止频率 / 带宽利用率** | 频谱边缘检测（识别升频假无损、有损转无损） |
| **SNR / 噪底** | 分频段信噪比 |
| **THD 谐波失真** | 单音素材可用；复音素材会自动判定为「无法测量」 |
| **立体声相关度 / 相位** | 归一化互相关系数，可识别反相 |
| **频谱图 / 声谱 / 波形 / 相位示波器** | 全部支持 HiDPI |

### 智能解读

- **中文大白话**：每个指标都配通俗解释，不需要声学背景也能看懂
- **根因推断**：不只报数字，还会推断成因（母带处理风格、录音增益不当、录音硬件故障、音频接口耦合电容老化等）
- **自动识别「测不了」**：对复音素材的 THD、极短素材的 LUFS 等会明确说明不可用，而不是给出误导性数值

### 音乐库浏览器

- 扫描本地音乐目录（**只读**：仅做 `readdir` + `stat`，绝不修改、移动、删除任何文件）
- 虚拟化列表：数万条曲目仍流畅（实测 3294 条仅渲染 26 个 DOM 节点）
- 搜索、按格式筛选、键盘操作（`↑↓` 选择 / `Enter` 分析）
- 批量分析队列

## 支持的格式

| 类别 | 格式 |
|------|------|
| 无损 | WAV, FLAC, AIFF, ALAC (M4A/MP4), APE, WavPack, TTA, CAF |
| 有损 | MP3, AAC, OGG Vorbis, Opus, WMA, AC3, EAC3 |
| DSD | DSF, DFF |
| 容器 | M4A, MP4, MKA, WEBM |

**Apple Lossless（ALAC）已内置纯 JavaScript 解码器**，零网络依赖、无需外部工具。

## 使用方法

1. 打开应用
2. 三种方式任选：
   - **拖放**音频文件到窗口
   - 点「打开文件」选择
   - 点左侧「扫描」浏览音乐库，双击条目分析
3. 等待分析完成，用左侧导航查看各项指标

### 快捷键

| 按键 | 功能 |
|------|------|
| `Ctrl` + `O` | 打开文件 |
| `Ctrl` + `B` | 显示/隐藏音乐库面板 |
| `↑` / `↓` | 在音乐库中移动选择 |
| `Enter` | 分析选中条目 |

### 大文件处理策略

为避免内存爆炸，超过 32MB 的文件走**分段采样**：在**开头 / 中间 / 结尾**各取一段解码分析（而非只看前几秒），
确保长曲目的响度与动态范围具有代表性。实测 1.5GB 文件峰值内存约 **296MB**，
且内存占用不随文件大小增长。

## 技术实现

### 解码链（四级兜底）

```
① 浏览器原生解码（AudioElement + OfflineAudioContext，不重采样）
   ↓ 失败
② 纯 JS ALAC 解码器（Rice/Golomb 熵编码 + 自适应线性预测）
   ↓ 失败
③ WebCodecs（AudioDecoder）
   ↓ 失败
④ FFmpeg 外部二进制（DSD / APE / WavPack 等，支持分段采样）
```

> 关键设计：用 `OfflineAudioContext` 而非 `AudioContext` 解码 ——
> 后者会把音频**重采样到系统采样率**（Windows 上通常是 48kHz），
> 96kHz 母带会在解码阶段就被降采样，导致频率轴失真、「升采样检测」失效。

### 分析引擎

- **Web Worker 池**（4 线程并行）承担标量指标与频谱计算
- 主线程只做渲染所需数据的计算，并通过分片让步（`makeAutoYield`）保持界面可响应
- 长循环每 16ms 让出一次主线程，大文件分析期间界面不冻结

### 数值正确性

K-weighting 滤波器对照 **ITU-R BS.1770-4 官方公布的 48kHz 数字系数**逐项校验：

| 频率 | 官方 | 本实现 | 偏差 |
|------|------|--------|------|
| 20 Hz | -13.275 dB | -13.594 dB | -0.32 |
| 50 Hz | -3.934 dB | -4.111 dB | -0.18 |
| 1 kHz | +0.698 dB | +0.656 dB | -0.04 |
| 10 kHz | +4.042 dB | +3.999 dB | -0.04 |

LUFS 端到端最大偏差 **0.215 dB**（40Hz 极低音素材）。

## 修复记录

### v9.0.1

| 问题 | 影响 |
|------|------|
| **M4A/ALAC 采样率报成 `1`** | 字段偏移差 2 字节，且读了容器里**恒为 0** 的 channelcount/samplesize。真值只存在 ALAC magic cookie 里 —— 现优先解析 cookie |
| **DSF 声道数报成 `486850652`** | 把 64 位 ID3 元数据偏移当成了声道数、其高 32 位当成采样率。现按 `fmt` chunk 正确解析 |
| **空/截断文件让分析链崩溃** | `parseFormatFromBytes` 抛 `RangeError`，现改为干净返回「无法识别」 |
| **THD 对复音素材给出误导数值** | 该指标仅对单一基频素材有效。现增加方法适用性门槛，不满足时明确返回「无法测量」并说明判据，而非报出 100% |

### v9.0

修掉了一批**数值错误** —— 它们不报错、不崩溃，只是安静地给出错误结果：

| 问题 | 影响 |
|------|------|
| K-weighting 高架滤波器用了「低架」系数形式 | 滤波器方向完全相反，LUFS 长期偏高 3.3dB；叠加多余的一级预加重后，100Hz 偏低 **27.6dB** |
| 粗频谱把格号当 FFT bin 用 | 频标**错 2 倍**：440Hz 被标成 887Hz |
| THD 计算传入线性谱（应为 dB 谱） | 纯正弦报 **178%**，且数值与实际信号无关 |
| 截止频率判据在 dB/线性混用下永不成立 | 「升采样假无损检测」**从未真正生效**，恒返回奈奎斯特 |
| Worker 逐采样统计写在 50% 重叠的 FFT 帧循环里 | 削波计数**翻倍** |
| Worker 立体声相关度用宽度启发式代替互相关系数 | 恒为非负，**反相音频漏判** |
| 频段标签与中心频率错位一格 | 声谱柱状图与三频解读**全部偏移一格** |
| 采样率被容器标称值覆盖 | 96kHz 文件被错标为 44.1kHz，频率轴全错 |
| `preload.js` 未透传 IPC 参数 | FFmpeg 的时长/采样率/定位参数**静默失效** |
| 数字静音文件 | 产生 -109.8 LUFS 这类越界值 |
| FFmpeg 二进制被打进 `app.asar` | 外部进程无法执行 asar 内文件，打包版兜底解码与 ffprobe 探测**静默失效** |

同时修复了：`engine.run()` 从未被调用（4 个 Worker 长期空转、实际跑的是主线程重复实现）、
4 个重复拖放监听器、累积的「补丁1/2/3」死代码块。

## 测试

```bash
cd AudioAnalyzer_V2
npm test          # 8 组回归测试
```

| 测试 | 守护内容 |
|------|---------|
| `spectrum.test.mjs` | 频标正确性、标签错位、结构完整性 |
| `worker.test.mjs` | 削波计数、相关度符号、bin↔Hz 不变式 |
| `cutoff.test.mjs` | THD / 截止频率的数据类型 |
| `audiomath-guard.test.mjs` | 静音早退、THD 钳制、LUFS 线性度 |
| `kweighting.test.mjs` | K-weighting 频响精度（对照官方 BS.1770-4 系数） |
| `parse-format.test.mjs` | 文件头解析（M4A/ALAC/DSF/FLAC/WAV 对照真实文件期望值，并断言旧 bug 特征值不再出现） |
| `distortion-method.test.mjs` | THD 方法适用性门槛（纯音应有值、复音须判不可测） |
| `alac-decode.test.mjs` | ALAC 解码逐样本对拍（655,360 样本零差异） |

其他验证脚本：

```bash
npm run smoke            # 端到端冒烟（真实解码→Worker→渲染）
npm run test:ui          # UI 冒烟 + 虚拟化验证
npm run test:layout      # 布局几何断言
npm run verify:paths     # 两条解码路径的指标一致性
npm run stress:mem       # 内存分段测量
npm run stress:a         # 全库格式探测
```

## 项目结构

```
├── AudioAnalyzer_V2/              # Electron 桌面应用（主项目）
│   ├── main.js                    # 主进程：窗口 + IPC + 文件系统 + FFmpeg/ffprobe
│   ├── preload.js                 # 上下文桥接
│   ├── core/                      # 分析引擎（分片 / Worker 池 / 汇总）
│   ├── worker/                    # FFT 分析 Worker
│   ├── utils/audioMath.js         # LUFS / 位深度 / SNR / THD / 截止频率
│   ├── renderer/                  # UI：app.js / library.js / styles.css
│   └── test/                      # 回归测试与验证脚本
├── AudioAnalyzer-V2-完整源码详解.md   # 源码级详解文档（4572 行）
└── legacy/                        # 历史归档（只读，不再维护）
    ├── 音频质量分析器.html           # v7/v8 单文件浏览器版
    ├── audio_analyzer.py           # Python CLI 版
    └── V2-旧版单页残留.html          # 早期目录布局残留
```

## 系统要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11 (x64) |
| 内存 | 建议 4GB 以上（大文件分析峰值约 300MB） |
| 磁盘 | 约 300MB（含 Electron 运行时） |
| 网络 | **不需要** |

## 许可证

MIT License — 随便用，随便改，随便分发。

## 声明

本工具仅供音频爱好者交流学习使用。分析结果仅供参考，不构成任何音频品质认证。

THD 指标基于「自相关估基频 + 频谱取谐波」的方法，**仅对单一基频素材（纯音、单件乐器独奏）有效**；
对复音音乐本工具会明确标注「无法给出可靠 THD」，不会给出误导性数值。

---

## 常见问题

**Q：为什么某些文件分析不出结果？**

A：检查是否安装了 FFmpeg（见上方「关于 FFmpeg」）。APE / WavPack / DSD 等格式依赖它解码。

**Q：为什么 THD 显示「无法给出可靠 THD 数值」？**

A：这个方法只对单一基频素材有效。流行/摇滚/古典等复音素材的频谱是多个乐器叠加，
不存在「基频 + 谐波」结构，比值没有物理意义。工具会明确说明而不是给个假数字。

**Q：为什么高解析文件的采样率显示不对？**

A：多半是缺 `ffprobe.exe`。缺少它时会按 48kHz 兜底分析，采样率相关指标会失真。

**Q：分析大文件为什么只取部分片段？**

A：超过 32MB 的文件会在开头/中间/结尾各取一段（而非整首解码），
既保证代表性又避免内存爆炸。需要全量分析可调大 `renderer/app.js` 里的 `LARGE_PCM_BUDGET`。

**Q：会修改我的音乐文件吗？**

A：不会。音乐库扫描只做 `readdir` + `stat`，分析时文件只被读取，从不写入、移动或删除。
