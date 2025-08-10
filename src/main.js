const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process'); // Добавляем для запуска Python-скрипта

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // Нужно для работы с Facebook
      webviewTag: true // Включаем поддержку webview
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Открываем DevTools в режиме разработки
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
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

// Обработка сообщений от renderer процесса
ipcMain.handle('save-csv', async (event, data) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `group-members-${new Date().toISOString().split('T')[0]}.csv`,
      filters: [
        { name: 'CSV файлы', extensions: ['csv'] }
      ]
    });

    if (filePath) {
      fs.writeFileSync(filePath, data);
      return { success: true, path: filePath };
    }
    
    return { success: false, cancelled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error('Ошибка открытия ссылки:', error);
    return { success: false, error: error.message };
  }
});

// Запуск Python-скрипта для парсинга профилей по ссылкам
ipcMain.handle('scrape-links', async () => {
  try {
    // Путь к скрипту с парсером (файл link.txt в корне проекта)
    const scriptPath = path.join(__dirname, '..', 'link.txt');

    return await new Promise((resolve) => {
      // Запускаем скрипт в отдельном процессе, пробрасывая stdio в текущий терминал
      const child = spawn('python', [scriptPath], {
        stdio: 'inherit'
      });

      child.on('close', (code) => {
        resolve({ success: code === 0, code });
      });
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-script', () => {
  // Возвращаем скрипт с исправленным позиционированием кнопки
  return `
function exportToCsv(e,t){for(var n="",o=0;o<t.length;o++)n+=function(e){for(var t="",n=0;n<e.length;n++){var o=null===e[n]||void 0===e[n]?"":e[n].toString(),o=(o=e[n]instanceof Date?e[n].toLocaleString():o).replace(/"/g,'""');0<n&&(t+=","),t+=o=0<=o.search(/("|,|\\n)/g)?'"'+o+'"':o}return t+"\\n"}(t[o]);var r=new Blob([n],{type:"text/csv;charset=utf-8;"}),i=document.createElement("a");void 0!==i.download&&(r=URL.createObjectURL(r),i.setAttribute("href",r),i.setAttribute("download",e),document.body.appendChild(i),i.click(),document.body.removeChild(i))}

function buildCTABtn(){
  var e=document.createElement("div"),t=(e.setAttribute("style",[
    "position: fixed;",
    "top: 80px;",
    "left: 50%;", 
    "transform: translateX(-50%);",
    "z-index: 99999;",
    "width: 100%;",
    "height: 100%;",
    "pointer-events: none;"
  ].join("")),document.createElement("div"));
  
  t.setAttribute("style",[
    "position: absolute;",
    "top: 0;",
    "left: 50%;",
    "transform: translateX(-50%);",
    "color: white;",
    "min-width: 200px;",
    "background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);",
    "border-radius: 12px;",
    "padding: 15px 25px;",
    "cursor: pointer;",
    "font-weight: 600;",
    "font-size: 16px;",
    "display: inline-flex;",
    "pointer-events: auto;",
    "height: auto;",
    "align-items: center;",
    "justify-content: center;",
    "box-shadow: 0 8px 32px rgba(0,0,0,0.3);",
    "border: 2px solid rgba(255,255,255,0.2);",
    "backdrop-filter: blur(10px);"
  ].join(""));
  
  var n=document.createTextNode("📥 Скачать "),o=document.createElement("span"),r=(o.setAttribute("id","fb-group-scraper-number-tracker"),o.setAttribute("style","font-weight:700;color:#FFD700;margin:0 5px;"),o.textContent="0",document.createTextNode(" участников"));
  
  return t.appendChild(n),t.appendChild(o),t.appendChild(r),t.addEventListener("click",function(){var e=(new Date).toISOString();exportToCsv("groupMemberExport-".concat(e,".csv"),window.members_list)}),e.appendChild(t),document.body.appendChild(e),e
}

function processResponse(e){var t,n;if(null!==(t=null==e?void 0:e.data)&&void 0!==t&&t.group)o=e.data.group;else{if("Group"!==(null===(t=null===(t=null==e?void 0:e.data)||void 0===t?void 0:t.node)||void 0===t?void 0:t.__typename))return;o=e.data.node}if(null!==(t=null==o?void 0:o.new_members)&&void 0!==t&&t.edges)n=o.new_members.edges;else if(null!==(e=null==o?void 0:o.new_forum_members)&&void 0!==e&&e.edges)n=o.new_forum_members.edges;else{if(null===(t=null==o?void 0:o.search_results)||void 0===t||!t.edges)return;n=o.search_results.edges}var e=n.map(function(e){var t=e.node,n=t.id,o=t.name,r=t.bio_text,i=t.url,s=t.profile_picture,t=t.__isProfile,d=(null===(d=null==e?void 0:e.join_status_text)||void 0===d?void 0:d.text)||(null===(d=null===(d=null==e?void 0:e.membership)||void 0===d?void 0:d.join_status_text)||void 0===d?void 0:d.text),e=null===(e=e.node.group_membership)||void 0===e?void 0:e.associated_group.id;return[n,o,i,(null==r?void 0:r.text)||"",(null==s?void 0:s.uri)||"",e,d||"",t]}),o=((t=window.members_list).push.apply(t,e),document.getElementById("fb-group-scraper-number-tracker"));o&&(o.textContent=window.members_list.length.toString())}

function parseResponse(e){var n=[];try{n.push(JSON.parse(e))}catch(t){var o=e.split("\\n");if(o.length<=1)return void console.error("Fail to parse API response",t);for(var r=0;r<o.length;r++){var i=o[r];try{n.push(JSON.parse(i))}catch(e){console.error("Fail to parse API response",t)}}}for(var t=0;t<n.length;t++)processResponse(n[t])}

function main(){buildCTABtn();var e=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){this.addEventListener("readystatechange",function(){this.responseURL.includes("/api/graphql/")&&4===this.readyState&&parseResponse(this.responseText)},!1),e.apply(this,arguments)}}

window.members_list=window.members_list||[["Profile Id","Full Name","ProfileLink","Bio","Image Src","Groupe Id","Group Joining Text","Profile Type"]],main();

/* Auto-scroll to load more members */
(function(){
  try {
    var maxIdleIterations = 8;
    var idleIterations = 0;
    var lastScrollHeight = 0;
    var totalScrollSteps = 0;
    var scrollStep = Math.max(400, Math.floor(window.innerHeight * 0.8));
    var scrollIntervalMs = 900;
    var maxScrollSteps = 2000;

    if (window.__fbAutoScrollTimer) clearInterval(window.__fbAutoScrollTimer);
    window.__fbAutoScrollTimer = setInterval(function(){
      var currentHeight = document.body.scrollHeight;
      if (currentHeight === lastScrollHeight) idleIterations++; else idleIterations = 0;
      lastScrollHeight = currentHeight;

      window.scrollBy({ top: scrollStep, left: 0, behavior: 'smooth' });
      totalScrollSteps++;

      if (idleIterations >= maxIdleIterations || totalScrollSteps >= maxScrollSteps) {
        clearInterval(window.__fbAutoScrollTimer);
        console.log('[FB Scraper] Auto-scroll complete');
      }
    }, scrollIntervalMs);
  } catch (e) {
    console.log('[FB Scraper] Auto-scroll error', e);
  }
})();

// Добавляем интеграцию с Electron
window.electronAPI && window.electronAPI.onScriptReady && window.electronAPI.onScriptReady();
`;
});
