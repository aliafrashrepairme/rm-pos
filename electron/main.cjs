// Electron main process (Node.js side)
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#171717',
    title: 'RM POS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('app:version', () => app.getVersion());

// Saves what the print area shows, using the page's own fonts, so Tamil and Sinhala stay intact.
const PDF_SIZES = {
  receipt: { width: 3.15, height: 11 },
  receipt100: { width: 3.94, height: 11 },
  a5: 'A5',
  a4: 'A4'
};

ipcMain.handle('print:save-pdf', async (event, fileName, size) => {
  const name = path.basename(String(fileName)).replace(/[^A-Za-z0-9._-]/g, '_');
  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    defaultPath: name,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return false;
  const pdf = await event.sender.printToPDF({ printBackground: true, pageSize: PDF_SIZES[size] ?? PDF_SIZES.receipt, margins: { marginType: 'none' } });
  await fs.writeFile(filePath, pdf);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
