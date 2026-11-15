const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getScript: (kind, mode) => ipcRenderer.invoke('get-script', { kind, mode }),
  saveCsv: (content, kind) => ipcRenderer.invoke('save-csv', { content, kind }),
  saveExcel: (rows, kind) => ipcRenderer.invoke('save-excel', { rows, kind }),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  logout: () => ipcRenderer.invoke('logout')
});
