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
  return 'ffmpeg'; // fallback to PATH
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
