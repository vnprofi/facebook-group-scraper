const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // требуется для работы webview с Facebook
      webviewTag: true
    },
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

if (process.platform !== 'darwin') {
  Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ---------------------------------------------------------------------------
// Скрипт-сборщик, который внедряется в страницу Facebook
// ---------------------------------------------------------------------------

ipcMain.handle('get-script', (event, payload = {}) => {
  const kind = payload.kind === 'posts' ? 'posts' : 'members';
  const mode = payload.mode === 'auto' ? 'auto' : 'manual';

  const source = fs.readFileSync(path.join(__dirname, 'injected.js'), 'utf8');
  return `${source}\n;window.__fbsoftStart(${JSON.stringify(kind)}, ${JSON.stringify(mode)});\n`;
});

// ---------------------------------------------------------------------------
// Экспорт данных
// ---------------------------------------------------------------------------

function defaultFileName(kind, extension) {
  const date = new Date().toISOString().split('T')[0];
  const base = kind === 'posts' ? 'profile-posts' : 'group-members';
  return `${base}-${date}.${extension}`;
}

ipcMain.handle('save-csv', async (event, payload = {}) => {
  try {
    const content = typeof payload.content === 'string' ? payload.content : '';
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: payload.filename || defaultFileName(payload.kind, 'csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (!filePath) return { success: false, cancelled: true };

    // BOM, чтобы Excel корректно открывал кириллицу.
    fs.writeFileSync(filePath, '\uFEFF' + content, 'utf8');
    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-excel', async (event, payload = {}) => {
  try {
    const table = Array.isArray(payload.rows) ? payload.rows : [];
    const profile = Array.isArray(payload.profile) ? payload.profile : [];
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: payload.filename || defaultFileName(payload.kind, 'xlsx'),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });

    if (!filePath) return { success: false, cancelled: true };

    // Шапка профиля: у каждого профиля свой набор полей, поэтому
    // блок строится из пар «поле — значение», а не из фиксированных колонок.
    const meta = [];
    for (const pair of profile) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const key = pair[0] == null ? '' : String(pair[0]).trim();
      const value = pair[1] == null ? '' : String(pair[1]).trim();
      if (!key || !value) continue;
      meta.push([key, value.replace(/\s*\r?\n+\s*/g, ' · ')]);
    }

    const rows = meta.length
      ? [['Информация о профиле'], ...meta, [], ...table]
      : table;

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);

    // Ширину колонок считаем только по таблице, чтобы шапка её не раздувала.
    sheet['!cols'] = (table[0] || []).map((header, index) => {
      let width = String(header || '').length + 4;
      for (let i = 1; i < Math.min(table.length, 200); i++) {
        const cell = table[i] && table[i][index];
        if (cell != null) width = Math.max(width, String(cell).length + 2);
      }
      return { wch: Math.min(60, Math.max(12, width)) };
    });

    const sheetName = payload.kind === 'posts' ? 'Посты' : 'Участники';
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    XLSX.writeFile(workbook, filePath);

    return { success: true, path: filePath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ---------------------------------------------------------------------------
// Служебные действия
// ---------------------------------------------------------------------------

ipcMain.handle('logout', async () => {
  try {
    const fbSession = session.fromPartition('persist:fb');
    await fbSession.clearStorageData();
    await fbSession.clearCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-external', async (event, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { success: false, error: 'Некорректная ссылка' };
    }
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
