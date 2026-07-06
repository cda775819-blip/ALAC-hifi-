const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFileBuffer: (filePath) => ipcRenderer.invoke('file:readBuffer', filePath),
  getFfmpegPath: () => ipcRenderer.invoke('app:getFfmpegPath'),
});
