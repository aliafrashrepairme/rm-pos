// Safe bridge between Electron (Node) and React (browser).
// Only expose what the UI needs — never expose the whole ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rmpos', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  savePdf: (fileName, size) => ipcRenderer.invoke('print:save-pdf', fileName, size),
  print: (size, role) => ipcRenderer.invoke('print:document', size, role),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  getPrinterSettings: () => ipcRenderer.invoke('printers:get'),
  savePrinterSettings: (settings) => ipcRenderer.invoke('printers:save', settings),
  getComputerName: () => ipcRenderer.invoke('app:computer-name')
});
