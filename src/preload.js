const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveCSV: (data) => ipcRenderer.invoke('save-csv', data),
  getScript: () => ipcRenderer.invoke('get-script'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  scrapeLinks: () => ipcRenderer.invoke('scrape-links'),
  onScriptReady: () => {
    // Уведомляем renderer, что скрипт готов
    window.postMessage({ type: 'SCRIPT_READY' }, '*');
  }
});
