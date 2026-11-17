// Electron main process (Node.js side)
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const devUrl = process.env.VITE_DEV_SERVER_URL;
const APP_ORIGIN = devUrl ? new URL(devUrl).origin : 'app://rmpos';
const DIST = path.join(__dirname, '..', 'dist');

// Pages load from this address rather than file://, so the API can recognise the app and
// the browser treats it as a secure page, which the camera requires.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

function fromApp(url) {
  try {
    // Node gives app:// addresses no origin, so this compares the parts directly.
    const { protocol: scheme, host } = new URL(url);
    return `${scheme}//${host}` === APP_ORIGIN;
  } catch {
    return false;
  }
}

async function serveApp(request) {
  const url = new URL(request.url);
  if (url.host !== 'rmpos') return new Response('Not found', { status: 404 });
  const relative = decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const file = path.normalize(path.join(DIST, relative));
  if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
  try {
    return await net.fetch(pathToFileURL(file).toString());
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// The app only ever needs the camera, for scanning barcodes.
function limitPermissions() {
  const allowed = (permission, origin) => permission === 'media' && fromApp(origin);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed(permission, details.requestingUrl ?? contents.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => allowed(permission, origin));
}

function lockWindow(win) {
  const { webContents } = win;
  webContents.on('will-navigate', (event, url) => {
    if (!fromApp(url)) event.preventDefault();
  });
  webContents.on('will-attach-webview', (event) => event.preventDefault());
  // A scanned PDF can open in its own window. Web links open in the normal browser.
  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('blob:')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true } }
      };
    }
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('did-create-window', lockWindow);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#171717',
    title: 'RM POS',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      plugins: true
    }
  });
  lockWindow(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    dialog.showErrorBox('RM POS could not start', 'The application files could not be loaded. Reinstall RM POS, or contact your administrator.');
    console.error('Load failed:', code, description, url);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('The window stopped:', details.reason);
    if (details.reason !== 'clean-exit') mainWindow?.reload();
  });

  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/`);
  }
}

// Only the app's own page may ask the desktop side to do anything.
function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event.senderFrame?.url ?? '')) throw new Error('Not allowed.');
    return listener(event, ...args);
  });
}

handle('app:version', () => app.getVersion());

// Saves what the print area shows, using the page's own fonts, so Tamil and Sinhala stay intact.
const PDF_SIZES = {
  receipt: { width: 3.15, height: 11 },
  receipt100: { width: 3.94, height: 11 },
  a5: 'A5',
  a4: 'A4'
};
const PRINT_SIZES = {
  receipt: { width: 80000, height: 279400 },
  receipt100: { width: 100000, height: 279400 },
  a5: 'A5',
  a4: 'A4'
};
const size = (table, name) => (Object.hasOwn(table, String(name)) ? table[name] : undefined);

handle('print:save-pdf', async (event, fileName, paperSize) => {
  const name = path.basename(String(fileName)).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.pdf$/i, '') || 'document';
  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    defaultPath: `${name}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return false;
  const pdf = await event.sender.printToPDF({ printBackground: true, pageSize: size(PDF_SIZES, paperSize) ?? PDF_SIZES.a4, margins: { marginType: 'none' } });
  await fs.writeFile(filePath, pdf);
  return true;
});

// Opens the printer's own dialog. A person choosing Cancel isn't an error.
handle('print:document', (event, paperSize) => new Promise((resolve) => {
  // Labels pass no size, so they follow the label printer's own paper.
  const pageSize = size(PRINT_SIZES, paperSize);
  event.sender.print({ printBackground: true, ...(pageSize ? { pageSize } : {}) }, (success, reason) => {
    resolve({ printed: success, cancelled: !success && /cancel/i.test(reason ?? ''), reason: success ? '' : reason });
  });
}));

// A till with two copies open could confuse who is signed in where.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    protocol.handle('app', serveApp);
    limitPermissions();
    if (!devUrl) Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
