const { BrowserWindow } = require('electron');

// Простая задержка
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to wait for a selector to appear (in the page context)
function waitForSelector(webContents, selector, timeout = 10000) {
  const expr = `new Promise((res) => {
    const check = () => {
      if (document.querySelector('${selector.replace(/'/g,"\\'")}')) res(true);
      else if (Date.now() - start > ${timeout}) res(false);
      else setTimeout(check, 300);
    };
    const start = Date.now();
    check();
  })`;
  return webContents.executeJavaScript(expr, true);
}

// JS-код, который выполняется в контексте страницы профиля Facebook и возвращает необходимые данные.
const extractionScript = `(() => {
  function cleanFacebookUrl(url) {
    try {
      if (url.includes('l.facebook.com/l.php')) {
        const urlObj = new URL(url);
        const realUrl = urlObj.searchParams.get('u');
        if (realUrl) {
          return realUrl.split('?fbclid=')[0].split('&fbclid=')[0];
        }
      }
      return url.replace(/\?fbclid=[^&]+/, '').replace(/&fbclid=[^&]+/, '');
    } catch { return url; }
  }

  function isSocialLink(url) {
    const domains = ['instagram.com','tiktok.com','vk.com','ok.ru','telegram.org','t.me','youtube.com','twitter.com','linkedin.com','whatsapp.com','viber.com'];
    return domains.some(d => url.toLowerCase().includes(d));
  }

  // Сбор ссылок
  const linkSelectors = [
    'a[href*="l.facebook.com/l.php"]',
    'a[href*="instagram.com"]',
    'a[href*="tiktok.com"]',
    'a[href*="vk.com"]',
    'a[href*="ok.ru"]',
    'a[href*="t.me"]',
    'a[href*="telegram"]',
    'a[href*="youtube.com"]',
    'a[href*="twitter.com"]',
    'a[href*="linkedin.com"]',
    'a.x1i10hfl.xjbqb8w.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.xt0psk2.xe8uvvx.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x16tdsg8.x1hl2dhg.xggy1nq.x1a2a7pz.xkrqix3.x1sur9pj.x1qq9wsj.x1s688f'
  ];

  const allElements = linkSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
  const uniqueElements = [];
  const seenHrefs = new Set();

  allElements.forEach(el => {
    const href = el.getAttribute('href');
    if (href && !seenHrefs.has(href)) {
      seenHrefs.add(href);
      uniqueElements.push(el);
    }
  });

  const linksData = [];
  uniqueElements.forEach(el => {
    try {
      let text = el.textContent.trim();
      const hrefRaw = el.getAttribute('href');
      const href = cleanFacebookUrl(hrefRaw);

      if (!href) return;
      const lower = href.toLowerCase();
      if (['recover','password','login','signup','facebook.com/privacy','facebook.com/help'].some(tok => lower.includes(tok))) return;

      if (isSocialLink(href) || (!href.includes('facebook.com') && href.startsWith('http'))) {
        if (!text || text.length < 3) {
          try { text = new URL(href).hostname.replace('www.', ''); } catch {}
        }
        // Используем обычную конкатенацию, чтобы избежать вложенных template-literals
        linksData.push(text + ' | ' + href);
      }
    } catch {}
  });

  const uniqueLinks = [];
  const seenUrls = new Set();
  linksData.forEach(ld => {
    const url = ld.split(' | ').pop();
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      uniqueLinks.push(ld);
    }
  });

  const allLinks = uniqueLinks.join(' --- ') || 'Ссылки не найдены';

  // Извлечение основной информации профиля
  const targetDiv = document.querySelector('div.xieb3on') || document.querySelector('div[data-pagelet^="ProfileTilesFeed_"]');
  let formattedProfile = 'Не найдено';
  if (targetDiv) {
    const lines = targetDiv.innerText.replace(/\u200b/g, '').split('\n').map(l => l.trim()).filter(Boolean);
    const idx = lines.findIndex(l => l.includes('Актуальное'));
    const profileInfo = idx !== -1 ? lines.slice(0, idx) : lines;
    formattedProfile = profileInfo.join('\n');
  }

  const nameEl = document.querySelector('h1') || document.querySelector('[data-testid="profile_header_name"]');
  const name = nameEl ? nameEl.textContent.trim().replace('\u00a0', ' ') : 'Не найдено';

  return { formattedProfile: formattedProfile || 'Не найдено', name, links: allLinks };
})();`;

/**
 * Парсит список ссылок профилей Facebook, возвращая массив строк:
 *  [url, name, full_profile, links]
 */
async function scrapeProfiles(links, onProgress = () => {}) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      partition: 'persist:fb'
    }
  });

  const results = [];
  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    try {
      await win.loadURL(url);
      await win.webContents.executeJavaScript('document.readyState === "complete" ? true : new Promise(res=>window.addEventListener("load",()=>res(true)))', true);
      // Небольшая дополнительная задержка, чтобы Facebook дорендерил DOM
      await delay(2500);

      // Проверяем, не перекинуло ли нас на страницу логина
      const currentUrl = win.webContents.getURL();
      if (/facebook\.com\/(login|checkpoint)/i.test(currentUrl)) {
        throw new Error('Не авторизовано в Facebook для ' + url);
      }

      // Ждем появления хотя бы заголовка профиля – максимум 10 сек
      const hasH1 = await waitForSelector(win.webContents, 'h1', 10000);
      if (!hasH1) {
        throw new Error('Контент профиля не загрузился');
      }

      const data = await win.webContents.executeJavaScript(extractionScript, true);
      results.push([url, data.name, data.formattedProfile, data.links]);
    } catch (err) {
      console.error('Scrape error for', url, err);
      results.push([url, 'Ошибка', 'Ошибка', 'Ошибка при сборе ссылок']);
    }
    onProgress(i + 1, links.length);
  }

  win.destroy();
  return results;
}

module.exports = { scrapeProfiles };