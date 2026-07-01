#!/usr/bin/env python3
"""
SoniqTools 同款音频质量分析器 - 桌面版
纯本地运行，无需联网，支持拖放文件分析
"""

import numpy as np
from scipy import signal
from scipy.fft import rfft, rfftfreq
from scipy.ndimage import uniform_filter1d
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.figure import Figure
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import soundfile as sf
import os
import io
import struct
from pathlib import Path

# ──────────────────────────────────────────────────────────
# 核心音频分析引擎
# ──────────────────────────────────────────────────────────

class AudioAnalyzer:
    """音频分析核心类"""

    def __init__(self):
        self.samples = None       # 多声道数据 (samples, channels)
        self.sample_rate = None
        self.duration = 0
        self.filepath = None
        self.file_size = 0
        self.format_info = {}

    def load(self, filepath):
        """加载音频文件，支持 FLAC/WAV/AIFF/OGG/MP3/AAC/M4A/OPUS"""
        self.filepath = filepath
        self.file_size = os.path.getsize(filepath)

        # 先用 soundfile 尝试加载（支持 FLAC/WAV/AIFF/OGG）
        try:
            self.samples, self.sample_rate = sf.read(filepath, dtype='float64')
        except Exception:
            # fallback: 用 pydub + ffmpeg
            try:
                from pydub import AudioSegment
                ext = Path(filepath).suffix.lower()
                audio = AudioSegment.from_file(filepath, format=ext.lstrip('.') or None)
                self.sample_rate = audio.frame_rate
                samples = np.array(audio.get_array_of_samples(), dtype=np.float64)
                if audio.channels == 1:
                    self.samples = samples.reshape(-1, 1) / (2 ** (8 * audio.sample_width - 1))
                else:
                    samples = samples.reshape(-1, audio.channels)
                    self.samples = samples / (2 ** (8 * audio.sample_width - 1))
            except Exception as e:
                raise RuntimeError(f"无法加载音频文件: {e}")

        # 统一转为 2D: (frames, channels)
        if self.samples.ndim == 1:
            self.samples = self.samples.reshape(-1, 1)

        self.duration = len(self.samples) / self.sample_rate
        self._detect_format()

    def _detect_format(self):
        """检测音频格式信息"""
        ext = Path(self.filepath).suffix.lower()
        bit_depth_map = {
            '.flac': '16/24 bit', '.wav': '16/24/32 bit', '.aiff': '16/24 bit',
            '.alac': '16/24 bit', '.mp3': 'lossy', '.aac': 'lossy',
            '.ogg': 'lossy', '.m4a': 'lossy', '.opus': 'lossy'
        }
        codec_map = {
            '.flac': 'FLAC', '.wav': 'PCM', '.aiff': 'PCM', '.alac': 'ALAC',
            '.mp3': 'MP3', '.aac': 'AAC', '.ogg': 'Vorbis', '.m4a': 'AAC', '.opus': 'Opus'
        }
        lossless = {'.flac', '.wav', '.aiff', '.alac'}

        self.format_info = {
            'filename': os.path.basename(self.filepath),
            'filesize': self.file_size,
            'format': ext.lstrip('.').upper(),
            'codec': codec_map.get(ext, 'Unknown'),
            'lossless': ext in lossless,
            'sample_rate': self.sample_rate,
            'channels': self.samples.shape[1],
            'duration': self.duration,
            'bit_depth': bit_depth_map.get(ext, 'Unknown'),
            'bitrate': self._estimate_bitrate(),
        }

    def _estimate_bitrate(self):
        """估算比特率"""
        if self.format_info.get('lossless') and self.sample_rate:
            bits = 16 if self.format_info.get('bit_depth', '').startswith('16') else 24
            return self.sample_rate * bits * self.samples.shape[1]
        return (self.file_size * 8) / self.duration if self.duration > 0 else 0

    def get_mono(self):
        """获取单声道混合信号"""
        if self.samples.shape[1] == 1:
            return self.samples[:, 0]
        return np.mean(self.samples, axis=1)

    def compute_spectrum(self, smoothing=True):
        """计算平均频率频谱 (dB)"""
        mono = self.get_mono()
        n = len(mono)

        # 分段 FFT 取平均
        segment_samples = min(2 ** 16, n)
        n_segments = max(1, n // segment_samples)
        all_spectra = []

        for i in range(n_segments):
            seg = mono[i * segment_samples:(i + 1) * segment_samples]
            if len(seg) < segment_samples:
                seg = np.pad(seg, (0, segment_samples - len(seg)))
            spectrum = np.abs(rfft(seg * np.hanning(len(seg))))
            all_spectra.append(spectrum)

        avg_spectrum = np.mean(all_spectra, axis=0)
        freqs = rfftfreq(segment_samples, 1.0 / self.sample_rate)

        # 转 dB（避免 log(0)）
        avg_spectrum = np.maximum(avg_spectrum, 1e-12)
        avg_spectrum_db = 20 * np.log10(avg_spectrum / np.max(avg_spectrum))

        if smoothing and len(avg_spectrum_db) > 50:
            avg_spectrum_db = uniform_filter1d(avg_spectrum_db, size=min(201, len(avg_spectrum_db) // 10))

        return freqs, avg_spectrum_db

    def compute_spectrogram(self):
        """计算频谱图 STFT"""
        mono = self.get_mono()
        nperseg = min(4096, len(mono) // 4)
        noverlap = nperseg // 2
        f, t, Sxx = signal.spectrogram(
            mono, fs=self.sample_rate, nperseg=nperseg,
            noverlap=noverlap, window='hann', mode='magnitude'
        )
        Sxx_db = 20 * np.log10(np.maximum(Sxx, 1e-12))
        return f, t, Sxx_db

    def detect_frequency_cutoff(self):
        """检测频率截止点（用于过采样检测）"""
        freqs, spectrum_db = self.compute_spectrum(smoothing=True)
        nyquist = self.sample_rate / 2

        # 在 8kHz 以上寻找能量骤降
        mask = freqs > 8000
        if not np.any(mask):
            return nyquist, 100.0

        high_freqs = freqs[mask]
        high_spectrum = spectrum_db[mask]

        # 找能量下降超过 30dB 的频点
        max_val = np.max(high_spectrum)
        threshold = max_val - 30
        below = high_spectrum < threshold
        if np.any(below):
            cutoff_idx = np.argmax(below)
            cutoff_freq = high_freqs[cutoff_idx]
        else:
            cutoff_freq = nyquist

        bandwidth_usage = (cutoff_freq / nyquist * 100) if nyquist > 0 else 100

        return cutoff_freq, bandwidth_usage

    def compute_dynamic_range(self):
        """计算动态范围指标"""
        mono = self.get_mono()
        rms = np.sqrt(np.mean(mono ** 2))
        peak = np.max(np.abs(mono))

        peak_db = 20 * np.log10(peak) if peak > 0 else -120
        rms_db = 20 * np.log10(rms) if rms > 0 else -120
        crest_factor = peak_db - rms_db  # 峰值因数

        return {
            'peak_db': peak_db,
            'rms_db': rms_db,
            'crest_factor': crest_factor,
        }

    def detect_clipping(self):
        """检测削波"""
        mono = self.get_mono()
        peak = np.max(np.abs(mono))
        # 接近 0 dBFS 的采样点
        threshold = 0.999
        clipped = np.sum(np.abs(mono) > threshold)
        clipped_pct = (clipped / len(mono)) * 100

        return {
            'has_clipping': peak >= 0.9999,
            'clipped_samples': int(clipped),
            'clipped_pct': round(clipped_pct, 4),
            'peak_db': 20 * np.log10(peak) if peak > 0 else -120,
        }

    def compute_stereo_correlation(self):
        """计算立体声相关性"""
        if self.samples.shape[1] < 2:
            return {'correlation': 1.0, 'is_stereo': False, 'is_out_of_phase': False}

        left = self.samples[:, 0]
        right = self.samples[:, 1]

        # 皮尔逊相关系数
        corr = np.corrcoef(left, right)[0, 1]
        if np.isnan(corr):
            corr = 1.0

        return {
            'correlation': round(corr, 4),
            'is_stereo': self.samples.shape[1] >= 2,
            'is_out_of_phase': corr < 0,
        }

    def get_quality_assessment(self):
        """综合质量评估"""
        results = []
        info = self.format_info

        # 1. 无损检查
        if info.get('lossless'):
            results.append(('格式', '通过', f"{info['codec']} - 无损格式"))
        else:
            results.append(('格式', '提示', f"{info['codec']} - 有损格式"))

        # 2. 采样率检查
        sr = info.get('sample_rate', 0)
        if sr >= 96000:
            results.append(('采样率', '警告', f"{sr/1000:.1f} kHz - 超高采样率，可能是过采样"))
        elif sr >= 44100:
            results.append(('采样率', '通过', f"{sr/1000:.1f} kHz"))
        else:
            results.append(('采样率', '警告', f"{sr/1000:.1f} kHz - 低于 CD 品质"))

        # 3. 过采样检测
        cutoff, bw_usage = self.detect_frequency_cutoff()
        if bw_usage < 80 and sr > 48000:
            results.append(('过采样', '失败', f"截止于 {cutoff/1000:.1f} kHz，带宽利用率 {bw_usage:.1f}% - 疑似过采样"))
        elif bw_usage >= 100:
            results.append(('过采样', '通过', '未检测到过采样特征'))
        else:
            results.append(('过采样', '提示', f"带宽利用率 {bw_usage:.1f}%"))

        # 4. 削波检测
        clip_info = self.detect_clipping()
        if clip_info['has_clipping']:
            results.append(('削波', '失败', f"检测到削波 ({clip_info['clipped_samples']} 个采样点)"))
        elif clip_info['peak_db'] > -1:
            results.append(('削波', '提示', f"峰值接近 0 dBFS ({clip_info['peak_db']:.1f} dB)"))
        else:
            results.append(('削波', '通过', f"峰值 {clip_info['peak_db']:.1f} dBFS"))

        # 5. 动态范围
        dyn = self.compute_dynamic_range()
        if dyn['crest_factor'] >= 14:
            results.append(('动态范围', '通过', f"Crest Factor {dyn['crest_factor']:.1f} dB - 良好"))
        elif dyn['crest_factor'] >= 8:
            results.append(('动态范围', '提示', f"Crest Factor {dyn['crest_factor']:.1f} dB - 适度压缩"))
        else:
            results.append(('动态范围', '失败', f"Crest Factor {dyn['crest_factor']:.1f} dB - 过度压缩"))

        # 6. 立体声
        stereo = self.compute_stereo_correlation()
        if stereo['is_stereo']:
            if stereo['is_out_of_phase']:
                results.append(('立体声', '失败', f"反相音频 (r={stereo['correlation']})"))
            elif stereo['correlation'] < 0.3:
                results.append(('立体声', '通过', f"良好立体声分离 (r={stereo['correlation']})"))
            else:
                results.append(('立体声', '提示', f"相关性 r={stereo['correlation']} - 接近单声道"))
        else:
            results.append(('立体声', '通过', '单声道'))

        return results


# ──────────────────────────────────────────────────────────
# GUI 界面
# ──────────────────────────────────────────────────────────

class AudioAnalyzerApp:
    """主应用程序"""

    BG = '#1e1e2e'
    FG = '#cdd6f4'
    ACCENT = '#89b4fa'
    CARD_BG = '#313244'
    SUCCESS = '#a6e3a1'
    WARNING = '#f9e2af'
    FAIL = '#f38ba8'
    HINT = '#89b4fa'

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("音频质量分析器 (Audio Quality Analyzer)")
        self.root.geometry("1200x850")
        self.root.configure(bg=self.BG)
        self.root.minsize(900, 600)

        self.analyzer = AudioAnalyzer()
        self.current_file = None

        # 设置 matplotlib 暗色主题
        plt.style.use('dark_background')
        self._build_ui()

        # 拖放支持
        self._setup_drag_drop()

    def _setup_drag_drop(self):
        """设置拖放支持 (Windows)"""
        try:
            from tkinterdnd2 import DND_FILES
            self.root.drop_target_register(DND_FILES)
            self.root.dnd_bind('<<Drop>>', self._on_drop)
        except ImportError:
            pass  # tkinterdnd2 不可用时忽略

    def _on_drop(self, event):
        """处理文件拖放"""
        data = event.data
        # 清理路径
        filepath = data.strip('{}').strip()
        if os.path.isfile(filepath):
            self._load_and_analyze(filepath)

    def _build_ui(self):
        """构建用户界面"""
        # ── 顶部标题栏 ──
        top_frame = tk.Frame(self.root, bg=self.BG)
        top_frame.pack(fill=tk.X, padx=20, pady=(15, 5))

        tk.Label(top_frame, text="音频质量分析器", font=('Microsoft YaHei UI', 20, 'bold'),
                 fg=self.FG, bg=self.BG).pack(side=tk.LEFT)

        # 加载按钮
        btn_frame = tk.Frame(top_frame, bg=self.BG)
        btn_frame.pack(side=tk.RIGHT)

        self.browse_btn = tk.Button(btn_frame, text="选择音频文件", font=('Microsoft YaHei UI', 11),
                                     bg=self.ACCENT, fg='#1e1e2e', padx=20, pady=6,
                                     relief=tk.FLAT, cursor='hand2',
                                     activebackground='#b4d0fb',
                                     command=self._browse_file)
        self.browse_btn.pack(side=tk.RIGHT, padx=(5, 0))

        # ── 拖放区域（未加载时显示） ──
        self.drop_frame = tk.Frame(self.root, bg=self.CARD_BG, relief=tk.GROOVE, bd=2)
        self.drop_frame.place(relx=0.05, rely=0.12, relwidth=0.9, relheight=0.18)

        drop_inner = tk.Frame(self.drop_frame, bg=self.CARD_BG)
        drop_inner.place(relx=0.5, rely=0.5, anchor=tk.CENTER)

        tk.Label(drop_inner, text="将音频文件拖放到此处", font=('Microsoft YaHei UI', 14),
                 fg=self.FG, bg=self.CARD_BG).pack()
        tk.Label(drop_inner, text="或拖放文件夹以进行批量分析", font=('Microsoft YaHei UI', 10),
                 fg='#6c7086', bg=self.CARD_BG).pack(pady=(5, 0))

        # 支持的格式
        formats_text = "FLAC   WAV   AIFF   ALAC   MP3   AAC   OGG   M4A   OPUS"
        tk.Label(drop_inner, text=formats_text,
                 font=('Consolas', 9), fg='#6c7086', bg=self.CARD_BG).pack(pady=(10, 0))

        # ── 主内容区（滚动） ──
        self.main_area = tk.Frame(self.root, bg=self.BG)

        # Canvas + scrollbar
        self.canvas = tk.Canvas(self.main_area, bg=self.BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(self.main_area, orient=tk.VERTICAL, command=self.canvas.yview)
        self.scroll_frame = tk.Frame(self.canvas, bg=self.BG)

        self.scroll_frame.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas_window = self.canvas.create_window((0, 0), window=self.scroll_frame, anchor="nw")

        self.canvas.bind("<Configure>", self._on_canvas_configure)
        self.canvas.configure(yscrollcommand=scrollbar.set)

        # 鼠标滚轮滚动
        def _on_mousewheel(event):
            self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        self.canvas.bind("<Enter>", lambda e: self.canvas.bind_all("<MouseWheel>", _on_mousewheel))
        self.canvas.bind("<Leave>", lambda e: self.canvas.unbind_all("<MouseWheel>"))

        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.main_area.pack_forget()

        # ── 底部状态栏 ──
        self.status_bar = tk.Label(self.root, text="就绪 - 等待加载音频文件",
                                    font=('Microsoft YaHei UI', 9), fg='#6c7086', bg=self.BG,
                                    anchor=tk.W)
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X, padx=20, pady=10)

    def _on_canvas_configure(self, event):
        self.canvas.itemconfig(self.canvas_window, width=event.width)

    def _browse_file(self):
        """浏览选择文件"""
        filetypes = [
            ("音频文件", "*.flac *.wav *.aiff *.aif *.alac *.m4a *.mp3 *.aac *.ogg *.opus"),
            ("所有文件", "*.*"),
        ]
        filepath = filedialog.askopenfilename(title="选择音频文件", filetypes=filetypes)
        if filepath:
            self._load_and_analyze(filepath)

    def _load_and_analyze(self, filepath):
        """加载并分析音频文件"""
        self.status_bar.config(text="正在分析...")
        self.root.update()

        try:
            self.analyzer.load(filepath)
            self.current_file = filepath
            self._show_results()
            self.status_bar.config(text=f"分析完成: {os.path.basename(filepath)}")
        except Exception as e:
            messagebox.showerror("错误", str(e))
            self.status_bar.config(text=f"加载失败: {e}")

    def _show_results(self):
        """显示分析结果"""
        # 隐藏拖放区域
        self.drop_frame.place_forget()
        self.main_area.pack(fill=tk.BOTH, expand=True, padx=15, pady=10)

        # 清空之前的内容
        for widget in self.scroll_frame.winfo_children():
            widget.destroy()

        info = self.analyzer.format_info
        width = max(1000, self.root.winfo_width() - 60)

        # ── 卡片: 文件信息 ──
        self._create_card("📁 文件信息", [
            ("文件名:", info['filename']),
            ("大小:", self._fmt_size(info['filesize'])),
            ("时长:", self._fmt_duration(info['duration'])),
            ("采样率:", f"{info['sample_rate']/1000:.1f} kHz"),
            ("声道:", f"{info['channels']}声道{' (立体声)' if info['channels'] >= 2 else ' (单声道)'}"),
            ("编码:", info['codec']),
            ("格式:", info['format']),
            ("比特率:", f"{info['bitrate']/1000:.1f} kbps" if info['bitrate'] else "N/A"),
        ], width)

        # ── 卡片: 频率频谱 ──
        self._create_spectrum_card(width)

        # ── 卡片: 频谱图 ──
        self._create_spectrogram_card(width)

        # ── 卡片: 过采样检测 ──
        cutoff, bw = self.analyzer.detect_frequency_cutoff()
        nyquist = info['sample_rate'] / 2

        cutoff_color = self.FAIL if (bw < 80 and info['sample_rate'] > 48000) else self.SUCCESS
        self._create_card("🔍 频率截止检测 (过采样检测)", [
            (f"检测到的截止频率:", f"{cutoff/1000:.1f} kHz", cutoff_color),
            (f"奈奎斯特频率:", f"{nyquist/1000:.1f} kHz"),
            (f"带宽利用率:", f"{bw:.1f}%", cutoff_color),
            ("CD 品质参考:", "22.05 kHz"),
            ("", ""),
            ("结论:", self._get_upsampling_conclusion(cutoff, bw, info['sample_rate']), cutoff_color),
        ], width)

        # ── 卡片: 动态范围 ──
        dyn = self.analyzer.compute_dynamic_range()
        cf = dyn['crest_factor']
        cf_color = self.SUCCESS if cf >= 14 else (self.WARNING if cf >= 8 else self.FAIL)

        self._create_card("📊 动态范围", [
            ("Crest Factor (峰值因数):", f"{cf:.1f} dB", cf_color),
            ("峰值电平:", f"{dyn['peak_db']:.2f} dBFS"),
            ("RMS 电平:", f"{dyn['rms_db']:.2f} dBFS"),
            ("", ""),
            ("说明:", self._get_dynamic_desc(cf), cf_color),
        ], width)

        # ── 卡片: 削波检测 ──
        clip = self.analyzer.detect_clipping()
        clip_color = self.FAIL if clip['has_clipping'] else (self.WARNING if clip['peak_db'] > -1 else self.SUCCESS)

        self._create_card("⚡ 削波检测", [
            ("峰值电平:", f"{clip['peak_db']:.2f} dBFS"),
            ("削波采样点数:", f"{clip['clipped_samples']} / {int(info['duration'] * info['sample_rate'])}"),
            ("削波比例:", f"{clip['clipped_pct']:.4f}%"),
            ("状态:", "检测到削波!" if clip['has_clipping'] else "未检测到削波", clip_color),
        ], width)

        # ── 卡片: 立体声分析 ──
        stereo = self.analyzer.compute_stereo_correlation()
        if stereo['is_stereo']:
            r = stereo['correlation']
            st_color = self.FAIL if stereo['is_out_of_phase'] else (self.HINT if r > 0.8 else self.SUCCESS)
            self._create_card("🎧 立体声分析", [
                ("声道:", "立体声 (2 声道)"),
                ("相关性系数:", f"{r:.4f}", st_color),
                ("状态:", "反相音频!" if stereo['is_out_of_phase'] else ("接近单声道" if r > 0.9 else "正常立体声"), st_color),
            ], width)
        else:
            self._create_card("🎧 立体声分析", [
                ("声道:", "单声道 (1 声道)"),
                ("说明:", "此文件为单声道录音"),
            ], width)

        # ── 卡片: 综合质量评估 ──
        self._create_quality_card(width)

    def _create_card(self, title, items, width):
        """创建信息卡片"""
        card = tk.Frame(self.scroll_frame, bg=self.CARD_BG)
        card.pack(fill=tk.X, pady=(0, 10), padx=(0, 10))

        # 标题
        tk.Label(card, text=title, font=('Microsoft YaHei UI', 13, 'bold'),
                 fg=self.ACCENT, bg=self.CARD_BG, anchor=tk.W).pack(fill=tk.X, padx=15, pady=(12, 8))

        # 内容
        content = tk.Frame(card, bg=self.CARD_BG)
        content.pack(fill=tk.X, padx=15, pady=(0, 12))

        cols = 2
        for i in range(0, len(items), cols):
            row_frame = tk.Frame(content, bg=self.CARD_BG)
            row_frame.pack(fill=tk.X, pady=1)

            for j in range(cols):
                if i + j >= len(items):
                    break
                label_text, value_text = items[i + j][:2]
                value_color = items[i + j][2] if len(items[i + j]) > 2 else self.FG

                pair = tk.Frame(row_frame, bg=self.CARD_BG)
                pair.pack(side=tk.LEFT, padx=(0, 30), fill=tk.X, expand=True)

                tk.Label(pair, text=label_text, font=('Microsoft YaHei UI', 10),
                         fg='#a6adc8', bg=self.CARD_BG).pack(side=tk.LEFT)
                tk.Label(pair, text=f" {value_text}", font=('Microsoft YaHei UI', 10, 'bold'),
                         fg=value_color, bg=self.CARD_BG).pack(side=tk.LEFT)

    def _create_spectrum_card(self, width):
        """创建频谱卡片"""
        card = tk.Frame(self.scroll_frame, bg=self.CARD_BG)
        card.pack(fill=tk.X, pady=(0, 10), padx=(0, 10))

        tk.Label(card, text="📈 频率频谱 (平均)", font=('Microsoft YaHei UI', 13, 'bold'),
                 fg=self.ACCENT, bg=self.CARD_BG, anchor=tk.W).pack(fill=tk.X, padx=15, pady=(12, 5))

        fig = Figure(figsize=(10, 3.5), dpi=100, facecolor=self.CARD_BG)
        ax = fig.add_subplot(111, facecolor=self.CARD_BG)

        freqs, spectrum = self.analyzer.compute_spectrum()

        ax.plot(freqs / 1000, spectrum, color=self.ACCENT, linewidth=0.8)
        ax.fill_between(freqs / 1000, -120, spectrum, color=self.ACCENT, alpha=0.15)
        ax.set_xlabel('频率 (kHz)', color='#a6adc8')
        ax.set_ylabel('幅度 (dB)', color='#a6adc8')
        ax.set_xlim(0, self.analyzer.sample_rate / 2000)
        ax.set_ylim(-120, 5)
        ax.grid(True, alpha=0.15, color='#6c7086')
        ax.tick_params(colors='#a6adc8', labelsize=8)
        ax.spines['bottom'].set_color('#45475a')
        ax.spines['left'].set_color('#45475a')
        ax.spines['top'].set_color(self.CARD_BG)
        ax.spines['right'].set_color(self.CARD_BG)

        # 标注区域
        ax.axvspan(0, 8, alpha=0.05, color='#a6e3a1')
        ax.axvspan(8, 16, alpha=0.05, color='#f9e2af')
        ax.axvspan(16, self.analyzer.sample_rate / 2000, alpha=0.05, color='#f38ba8')
        ax.text(3, -115, '低音/中音 (0-8 kHz)', color='#a6e3a1', fontsize=7, ha='center', alpha=0.7)
        ax.text(12, -115, '高音 (8-16 kHz)', color='#f9e2af', fontsize=7, ha='center', alpha=0.7)
        ax.text(self.analyzer.sample_rate / 4000 + 8, -115, '超声波 (16 kHz+)', color='#f38ba8', fontsize=7, ha='center', alpha=0.7)

        fig.tight_layout(pad=2)

        canvas = FigureCanvasTkAgg(fig, card)
        canvas.draw()
        canvas.get_tk_widget().pack(fill=tk.BOTH, padx=10, pady=(0, 10))

        # 存储引用防止被垃圾回收
        card._fig = fig
        card._canvas = canvas

    def _create_spectrogram_card(self, width):
        """创建频谱图卡片"""
        card = tk.Frame(self.scroll_frame, bg=self.CARD_BG)
        card.pack(fill=tk.X, pady=(0, 10), padx=(0, 10))

        tk.Label(card, text="🌊 频谱图 (Spectrogram)", font=('Microsoft YaHei UI', 13, 'bold'),
                 fg=self.ACCENT, bg=self.CARD_BG, anchor=tk.W).pack(fill=tk.X, padx=15, pady=(12, 5))

        fig = Figure(figsize=(10, 3.5), dpi=100, facecolor=self.CARD_BG)
        ax = fig.add_subplot(111, facecolor=self.CARD_BG)

        try:
            f, t, Sxx = self.analyzer.compute_spectrogram()
            pcm = ax.pcolormesh(t, f / 1000, Sxx, shading='gouraud',
                                cmap='magma', vmin=np.percentile(Sxx, 10),
                                vmax=np.percentile(Sxx, 95))
            ax.set_xlabel('时间 (秒)', color='#a6adc8')
            ax.set_ylabel('频率 (kHz)', color='#a6adc8')
            ax.set_ylim(0, min(self.analyzer.sample_rate / 2000, 24))
            ax.tick_params(colors='#a6adc8', labelsize=8)
            ax.spines['bottom'].set_color('#45475a')
            ax.spines['left'].set_color('#45475a')
            ax.spines['top'].set_color(self.CARD_BG)
            ax.spines['right'].set_color(self.CARD_BG)

            cbar = fig.colorbar(pcm, ax=ax, label='幅度 (dB)')
            cbar.ax.yaxis.label.set_color('#a6adc8')
            cbar.ax.tick_params(colors='#a6adc8', labelsize=7)
        except Exception:
            ax.text(0.5, 0.5, '无法生成频谱图', ha='center', va='center', color='#6c7086',
                    transform=ax.transAxes, fontsize=12)
            ax.set_xticks([])
            ax.set_yticks([])

        fig.tight_layout(pad=2)

        canvas = FigureCanvasTkAgg(fig, card)
        canvas.draw()
        canvas.get_tk_widget().pack(fill=tk.BOTH, padx=10, pady=(0, 10))

        card._fig = fig
        card._canvas = canvas

    def _create_quality_card(self, width):
        """创建综合质量评估卡片"""
        card = tk.Frame(self.scroll_frame, bg=self.CARD_BG)
        card.pack(fill=tk.X, pady=(0, 10), padx=(0, 10))

        tk.Label(card, text="🏆 综合质量评估", font=('Microsoft YaHei UI', 13, 'bold'),
                 fg=self.ACCENT, bg=self.CARD_BG, anchor=tk.W).pack(fill=tk.X, padx=15, pady=(12, 8))

        assessments = self.analyzer.get_quality_assessment()

        for dimension, rating, detail in assessments:
            color_map = {
                '通过': self.SUCCESS,
                '提示': self.HINT,
                '警告': self.WARNING,
                '失败': self.FAIL,
            }
            color = color_map.get(rating, self.FG)

            row = tk.Frame(card, bg=self.CARD_BG)
            row.pack(fill=tk.X, padx=15, pady=2)

            # 评级标签
            tag = tk.Label(row, text=rating, font=('Microsoft YaHei UI', 9, 'bold'),
                           fg='#1e1e2e', bg=color, padx=8, pady=1, width=6)
            tag.pack(side=tk.LEFT, padx=(0, 10))

            # 维度名
            tk.Label(row, text=dimension, font=('Microsoft YaHei UI', 10, 'bold'),
                     fg=self.FG, bg=self.CARD_BG, width=10, anchor=tk.W).pack(side=tk.LEFT)

            # 详情
            tk.Label(row, text=detail, font=('Microsoft YaHei UI', 9),
                     fg='#a6adc8', bg=self.CARD_BG, anchor=tk.W).pack(side=tk.LEFT, padx=(5, 0))

    # ── 辅助方法 ──

    @staticmethod
    def _fmt_size(size_bytes):
        if size_bytes < 1024:
            return f"{size_bytes} B"
        elif size_bytes < 1048576:
            return f"{size_bytes/1024:.1f} KB"
        else:
            return f"{size_bytes/1048576:.1f} MB"

    @staticmethod
    def _fmt_duration(seconds):
        m, s = divmod(int(seconds), 60)
        h, m = divmod(m, 60)
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"

    @staticmethod
    def _get_upsampling_conclusion(cutoff, bw, sr):
        if sr <= 48000:
            return "采样率在正常范围内"
        if bw < 60:
            return "严重过采样嫌疑 - 高频内容缺失"
        elif bw < 80:
            return "疑似过采样 - 带宽利用率低"
        return "未检测到明显过采样特征"

    @staticmethod
    def _get_dynamic_desc(cf):
        if cf >= 14:
            return "动态范围优秀，音频自然呼吸"
        elif cf >= 10:
            return "动态范围良好"
        elif cf >= 8:
            return "适度压缩 - 响度战争迹象"
        return "过度压缩 - 响度战争严重"

    def run(self):
        self.root.mainloop()


# ──────────────────────────────────────────────────────────
# 入口
# ──────────────────────────────────────────────────────────

if __name__ == '__main__':
    app = AudioAnalyzerApp()
    app.run()
