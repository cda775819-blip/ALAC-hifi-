# legacy/ — 历史版本（只读归档）

这里的文件是项目的历史形态，**不再维护、不再修改**。保留原因仅为参考与追溯。

| 文件 | 说明 |
|------|------|
| `音频质量分析器.html` | v7/v8 单文件浏览器版。双击即可在浏览器中使用，纯主线程、无 Worker、无 Electron。是当前 Electron 版（`AudioAnalyzer_V2/`）的前身。 |
| `audio_analyzer.py` | Python 命令行分析版。与上面两者互不依赖，同样已停止维护。 |

## 为什么归档

项目原本是一条演进线：

```
音频质量分析器.html  ──迁移──▶  AudioAnalyzer_V2/（Electron 桌面版）
（单文件 / 浏览器）              （打包为 Audio Analyzer Pro Setup *.exe）
```

迁移后两份代码各自继续改动、逐渐分叉，导致同一个算法存在两份实现，修一处 bug 需要改两遍。
`AudioAnalyzer_V2/` 已完整覆盖 HTML 版的全部能力（LUFS / True Peak / 位深度 / THD / 截止频率 /
智能诊断 / 全部图表），并额外具备桌面端能力，因此**以 `AudioAnalyzer_V2/` 为唯一主线**。

## 需要注意的历史遗留

归档版本中存在一些已知问题，**未修复也不会修复**。若日后需要参考其算法实现，请注意：

- `computeBandSpectrum()` 的 `freqs` 使用频段**下边界**。当前主线改为使用**几何中心频率**，
  但 `labels` 仍是下边界标签，导致标签与数据错位一格（已记录，待修）。
- 该版本的让步策略是 `await sleep(0)`（每 10 帧让出一次），主线版曾丢失该逻辑导致界面冻结，
  现已通过 `makeAutoYield()` 恢复。

## 使用建议

只读参考即可。**不要在归档版本上继续开发** —— 任何修复都应落到 `AudioAnalyzer_V2/`。

---

## 追加归档（2026）

| 文件 | 说明 |
|------|------|
| `V2-旧版单页残留.html` | 原 `AudioAnalyzer_V2/index.html`。V2 早期目录布局的残留：引用 `./app.js`（根级无此文件），从未被 `main.js` 加载。真正的入口是 `AudioAnalyzer_V2/renderer/index.html`。 |
