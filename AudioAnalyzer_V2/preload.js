const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用版本：从主进程的 package.json 取，避免界面里写死的版本号与实际脱节
  // （历史上界面/导出报告里的 v9.0.x 就是手写的，版本一升就会不一致）
  appVersion: () => ipcRenderer.invoke('app:getVersion'),

  // 文件对话框与读取
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFileBuffer: (filePath, opts) => ipcRenderer.invoke('file:readBuffer', filePath, opts),
  getFileSize: (filePath) => ipcRenderer.invoke('file:size', filePath),

  // FFmpeg
  getFfmpegPath: () => ipcRenderer.invoke('app:getFfmpegPath'),
  probeAudio: (filePath) => ipcRenderer.invoke('audio:probe', filePath),
  // 注意：必须透传 opts（sampleRate/channels/maxSeconds/rateCap），
  // 否则主进程拿不到解码参数，大文件的时长与采样率控制会静默失效
  decodeWithFFmpeg: (filePath, opts) => ipcRenderer.invoke('ffmpeg:decode', filePath, opts),

  // 音乐库（只读：仅 readdir + stat）
  scanLibrary: (dirPath, opts) => ipcRenderer.invoke('lib:scan', dirPath, opts),
  chooseLibraryRoot: () => ipcRenderer.invoke('lib:chooseRoot'),
});
