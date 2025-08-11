const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveCSV: (data) => ipcRenderer.invoke('save-csv', data),
  saveExcel: (rows) => ipcRenderer.invoke('save-excel', rows),
  getScript: () => ipcRenderer.invoke('get-script'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  scrapeLinks: () => ipcRenderer.invoke('scrape-links'),
  logout: () => ipcRenderer.invoke('logout'),
  onScriptReady: () => {
    // Уведомляем renderer, что скрипт готов
    window.postMessage({ type: 'SCRIPT_READY' }, '*');
  }
});
