// Safe bridge between Electron (Node) and React (browser).
// Only expose what the UI needs — never expose the whole ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rmpos', {
  getVersion: () => ipcRenderer.invoke('app:version')
});
