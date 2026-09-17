const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
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
