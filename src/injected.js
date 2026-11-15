/*
 * FBSoft — сборщик данных Facebook.
 *
 * Скрипт выполняется внутри страницы Facebook (webview). Он перехватывает
 * ответы GraphQL и складывает данные в глобальные массивы:
 *
 *   window.__fbMembers — участники групп
 *   window.__fbPosts   — посты из ленты (профиль пользователя)
 *
 * Экспорт в CSV/XLSX выполняет приложение (main process), скрипт только
 * собирает данные и управляет прокруткой.
 */
(function () {
  'use strict';

  var MEMBER_HEADERS = [
    'Profile Id',
    'Full Name',
    'ProfileLink',
    'Bio',
    'Image Src',
    'Groupe Id',
    'Group Joining Text',
    'Profile Type'
  ];

  var POST_HEADERS = [
    'ID поста',
    'Дата',
    'Автор',
    'Ссылка на автора',
    'Текст поста',
    'Ссылка на пост',
    'Медиа'
  ];

  window.__fbMembers = window.__fbMembers || [MEMBER_HEADERS.slice()];
  window.__fbPosts = window.__fbPosts || [POST_HEADERS.slice()];
  window.__fbMemberIds = window.__fbMemberIds || Object.create(null);
  window.__fbPostIds = window.__fbPostIds || Object.create(null);

  // Скрипт может внедряться повторно — перехватчики ставим только один раз.
  if (window.__fbsoftInstalled) return;
  window.__fbsoftInstalled = true;

  var state = {
    kind: 'members',
    scrolling: false,
    stopped: false,
    box: null,
    countEl: null,
    stopEl: null
  };

  // Идентификатор текущего цикла прокрутки: позволяет гарантированно
  // остановить предыдущий цикл при повторном запуске.
  var scrollRun = 0;

  // ---------------------------------------------------------------------
  // Утилиты
  // ---------------------------------------------------------------------

  function textOf(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value.text === 'string') return value.text;
    return '';
  }

  function absoluteUrl(url) {
    if (!url) return '';
    var value = String(url);
    if (value.charAt(0) === '/') return 'https://www.facebook.com' + value;
    if (/^https?:\/\//i.test(value)) return value;
    return '';
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function formatDate(timestamp) {
    var seconds = Number(timestamp);
    if (!seconds || isNaN(seconds)) return '';
    var d = new Date(seconds * 1000);
    if (isNaN(d.getTime())) return '';
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  function unique(values) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var value = values[i];
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
  }

  function parsePayloads(text) {
    var payloads = [];
    if (!text) return payloads;

    var body = String(text).replace(/^\s*for\s*\(;;\);\s*/, '');

    try {
      payloads.push(JSON.parse(body));
      return payloads;
    } catch (e) {
      // Многократные ответы Facebook приходят построчно.
    }

    var lines = body.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim().replace(/^for\s*\(;;\);\s*/, '');
      if (!line) continue;
      try {
        payloads.push(JSON.parse(line));
      } catch (err) {
        /* пропускаем неполные строки */
      }
    }
    return payloads;
  }

  // ---------------------------------------------------------------------
  // Участники групп
  // ---------------------------------------------------------------------

  function findMemberEdges(data) {
    if (!data) return null;
    var candidates = [data.group, data.node, data.group_members, data];

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate || typeof candidate !== 'object') continue;
      if (candidate.__typename && candidate.__typename !== 'Group') continue;

      var lists = [candidate.new_members, candidate.new_forum_members, candidate.search_results, candidate.members];
      for (var j = 0; j < lists.length; j++) {
        var list = lists[j];
        if (list && list.edges && list.edges.length) return list.edges;
      }
    }
    return null;
  }

  function addMemberEdges(edges) {
    var added = 0;

    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i] || {};
      var node = edge.node || {};
      if (!node || typeof node !== 'object') continue;

      var url = absoluteUrl(node.url || node.profile_url || '');
      var name = node.name || '';
      var id = node.id ? String(node.id) : '';
      var key = id || (url + '|' + name);
      if (!key || window.__fbMemberIds[key]) continue;

      var groupMembership = node.group_membership || {};
      var associatedGroup = groupMembership.associated_group || {};
      var joinStatus = edge.join_status_text || (edge.membership && edge.membership.join_status_text);

      window.__fbMemberIds[key] = true;
      window.__fbMembers.push([
        id,
        name,
        url,
        textOf(node.bio_text),
        node.profile_picture && node.profile_picture.uri ? node.profile_picture.uri : '',
        associatedGroup.id ? String(associatedGroup.id) : '',
        textOf(joinStatus),
        node.__typename || ''
      ]);
      added++;
    }

    return added;
  }

  function parseMembers(text) {
    var payloads = parsePayloads(text);
    for (var i = 0; i < payloads.length; i++) {
      var payload = payloads[i];
      if (!payload || !payload.data) continue;
      var edges = findMemberEdges(payload.data);
      if (edges) addMemberEdges(edges);
    }
  }

  // ---------------------------------------------------------------------
  // Посты
  // ---------------------------------------------------------------------

  function imagesFromAttachments(attachments) {
    var urls = [];
    if (!Array.isArray(attachments)) return urls;

    for (var i = 0; i < attachments.length; i++) {
      var attachment = attachments[i] || {};
      var styles = attachment.styles || {};
      var styled = styles.attachment || {};

      var subNodes = styled.all_subattachments && styled.all_subattachments.nodes;
      if (Array.isArray(subNodes)) {
        for (var j = 0; j < subNodes.length; j++) {
          var subMedia = (subNodes[j] && subNodes[j].media) || {};
          if (subMedia.image && subMedia.image.uri) urls.push(subMedia.image.uri);
          else if (subMedia.viewer_image && subMedia.viewer_image.uri) urls.push(subMedia.viewer_image.uri);
        }
      }

      if (attachment.media && attachment.media.image && attachment.media.image.uri) {
        urls.push(attachment.media.image.uri);
      }
      if (styled.media && styled.media.image && styled.media.image.uri) {
        urls.push(styled.media.image.uri);
      }
      if (styled.image && styled.image.uri) {
        urls.push(styled.image.uri);
      }
    }

    return unique(urls);
  }

  function firstAttachmentLink(attachments) {
    if (!Array.isArray(attachments)) return '';
    for (var i = 0; i < attachments.length; i++) {
      var attachment = attachments[i] || {};
      var styled = (attachment.styles && attachment.styles.attachment) || {};
      var url = absoluteUrl(styled.url);
      if (url) return url;
    }
    return '';
  }

  function collectStoryNodes(value, out, depth) {
    if (!value || typeof value !== 'object' || depth > 30) return;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectStoryNodes(value[i], out, depth + 1);
      return;
    }

    if (value.__typename === 'Story' && (value.comet_sections || value.creation_time || value.attachments)) {
      out.push(value);
    }

    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var child = value[key];
      if (child && typeof child === 'object') collectStoryNodes(child, out, depth + 1);
    }
  }

  function storyToRow(node) {
    if (!node || node.sponsored_data) return null;

    var sections = node.comet_sections || {};
    var contentStory = (sections.content && sections.content.story) || {};
    var contentSections = contentStory.comet_sections || {};

    // Текст и ссылка могут лежать на верхнем уровне секций или внутри
    // content.story.comet_sections — проверяем оба места.
    var messageStory =
      (sections.message && sections.message.story) ||
      (contentSections.message && contentSections.message.story) ||
      {};

    var text = firstNonEmpty(
      messageStory.message && messageStory.message.text,
      contentStory.message && contentStory.message.text,
      node.message && node.message.text
    );

    var link = firstNonEmpty(
      absoluteUrl(messageStory.url),
      absoluteUrl(contentStory.url),
      firstAttachmentLink(node.attachments),
      firstAttachmentLink(contentStory.attachments)
    );

    var owningProfile =
        (node.feedback && node.feedback.owning_profile) ||
        (contentStory.feedback && contentStory.feedback.owning_profile) ||
        (messageStory.feedback && messageStory.feedback.owning_profile) ||
        null;

    var authorName = owningProfile && owningProfile.name ? owningProfile.name : '';
    var authorId = owningProfile && owningProfile.id ? String(owningProfile.id) : '';
    var authorLink = authorId ? 'https://www.facebook.com/profile.php?id=' + authorId : '';

    var attachments = []
      .concat(Array.isArray(node.attachments) ? node.attachments : [])
      .concat(Array.isArray(contentStory.attachments) ? contentStory.attachments : [])
      .concat(Array.isArray(messageStory.attachments) ? messageStory.attachments : []);

    var media = unique(imagesFromAttachments(attachments)).slice(0, 5).join(' | ');

    var id = node.post_id ? String(node.post_id) : String(node.id || link);
    if (!id) return null;
    if (!text && !media && !link) return null;

    return [
      id,
      formatDate(node.creation_time || contentStory.creation_time),
      authorName,
      authorLink,
      text,
      link,
      media
    ];
  }

  function parsePosts(text) {
    var payloads = parsePayloads(text);
    var added = 0;

    for (var i = 0; i < payloads.length; i++) {
      var nodes = [];
      collectStoryNodes(payloads[i], nodes, 0);

      for (var j = 0; j < nodes.length; j++) {
        var row = storyToRow(nodes[j]);
        if (!row) continue;
        if (window.__fbPostIds[row[0]]) continue;
        window.__fbPostIds[row[0]] = true;
        window.__fbPosts.push(row);
        added++;
      }
    }

    return added;
  }

  // ---------------------------------------------------------------------
  // Перехват ответов
  // ---------------------------------------------------------------------

  function isGraphqlUrl(url) {
    return typeof url === 'string' && url.indexOf('/api/graphql') !== -1;
  }

  function handleText(text) {
    if (!text || typeof text !== 'string') return;
    if (text.length < 40) return;

    try {
      if (text.indexOf('"new_members"') !== -1 ||
          text.indexOf('"new_forum_members"') !== -1 ||
          text.indexOf('"search_results"') !== -1) {
        parseMembers(text);
      }
    } catch (e) { /* ошибки разбора не должны ломать страницу */ }

    try {
      if (text.indexOf('"__typename":"Story"') !== -1 ||
          text.indexOf('"__isFeedUnit":"Story"') !== -1 ||
          text.indexOf('"timeline_list_feed_units"') !== -1) {
        parsePosts(text);
      }
    } catch (e) { /* см. выше */ }

    renderOverlay();
  }

  function installInterceptors() {
    var nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4) return;
        try {
          if (!isGraphqlUrl(xhr.responseURL)) return;
          if (xhr.responseType === 'json') {
            handleText(JSON.stringify(xhr.response || ''));
            return;
          }
          if (xhr.responseType && xhr.responseType !== 'text') return;
          handleText(xhr.responseText);
        } catch (e) { /* ответ недоступен */ }
      });
      return nativeSend.apply(this, arguments);
    };

    if (typeof window.fetch === 'function') {
      var nativeFetch = window.fetch;
      window.fetch = function () {
        var requestUrl = '';
        try {
          requestUrl = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
        } catch (e) { /* ignore */ }

        var promise = nativeFetch.apply(this, arguments);
        if (isGraphqlUrl(requestUrl)) {
          promise.then(function (response) {
            try {
              if (!response || !isGraphqlUrl(response.url || requestUrl)) return response;
              response.clone().text().then(handleText).catch(function () {});
            } catch (e) { /* ignore */ }
            return response;
          }).catch(function () {});
        }
        return promise;
      };
    }
  }

  // ---------------------------------------------------------------------
  // Оверлей в странице
  // ---------------------------------------------------------------------

  function activeList() {
    return state.kind === 'posts' ? window.__fbPosts : window.__fbMembers;
  }

  function currentCount() {
    return Math.max(0, activeList().length - 1);
  }

  function ensureOverlay() {
    var existing = document.getElementById('fbsoft-overlay');
    if (existing) {
      state.box = existing;
      state.countEl = document.getElementById('fbsoft-overlay-count');
      state.stopEl = document.getElementById('fbsoft-overlay-stop');
      existing.style.display = 'flex';
      return;
    }
    if (!document.body) return;

    var box = document.createElement('div');
    box.id = 'fbsoft-overlay';
    box.setAttribute(
      'style',
      [
        'position:fixed',
        'top:64px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'gap:10px',
        'background:#ffffff',
        'color:#111827',
        'border:1px solid #d0d5dd',
        'border-radius:8px',
        'padding:7px 10px',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif',
        'box-shadow:0 6px 20px rgba(16,24,40,0.14)',
        'pointer-events:auto'
      ].join(';')
    );

    var label = document.createElement('span');
    label.id = 'fbsoft-overlay-label';
    label.textContent = 'Участники группы:';

    var count = document.createElement('b');
    count.id = 'fbsoft-overlay-count';
    count.textContent = '0';
    count.style.cssText = 'font-weight:650;color:#2456d6;';

    var stop = document.createElement('button');
    stop.id = 'fbsoft-overlay-stop';
    stop.type = 'button';
    stop.textContent = 'Остановить';
    stop.style.cssText = [
      'border:1px solid #f0c2bd',
      'background:#ffffff',
      'color:#b42318',
      'border-radius:6px',
      'padding:3px 9px',
      'font:inherit',
      'cursor:pointer'
    ].join(';');
    stop.addEventListener('click', function () {
      stopScroll();
      renderOverlay();
    });

    var hide = document.createElement('button');
    hide.type = 'button';
    hide.textContent = '\u00d7';
    hide.title = 'Скрыть';
    hide.style.cssText = [
      'border:0',
      'background:transparent',
      'color:#667085',
      'font-size:16px',
      'line-height:1',
      'padding:0 2px',
      'cursor:pointer'
    ].join(';');
    hide.addEventListener('click', function () {
      box.style.display = 'none';
    });

    box.appendChild(label);
    box.appendChild(count);
    box.appendChild(stop);
    box.appendChild(hide);
    document.body.appendChild(box);

    state.box = box;
    state.countEl = count;
    state.stopEl = stop;
  }

  function renderOverlay() {
    if (!state.box || !document.body) return;
    var label = document.getElementById('fbsoft-overlay-label');
    if (label) label.textContent = state.kind === 'posts' ? 'Посты:' : 'Участники группы:';
    if (state.countEl) state.countEl.textContent = String(currentCount());
    if (state.stopEl) state.stopEl.style.display = state.scrolling ? 'inline-block' : 'none';
  }

  // ---------------------------------------------------------------------
  // Прокрутка
  // ---------------------------------------------------------------------

  function pageHeight() {
    return Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
  }

  function waitForGrowth(previousHeight, timeout) {
    return new Promise(function (resolve) {
      var finished = false;
      var observer = null;
      var intervalId = null;
      var timeoutId = null;

      function cleanup() {
        if (intervalId) clearInterval(intervalId);
        if (timeoutId) clearTimeout(timeoutId);
        if (observer) {
          try { observer.disconnect(); } catch (e) { /* ignore */ }
        }
      }

      function finish(result) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      }

      function check() {
        if (pageHeight() !== previousHeight) finish(true);
      }

      intervalId = setInterval(check, 350);
      timeoutId = setTimeout(function () {
        finish(pageHeight() !== previousHeight);
      }, timeout);

      if (typeof ResizeObserver === 'function' && document.body) {
        try {
          observer = new ResizeObserver(check);
          observer.observe(document.body);
        } catch (e) { /* ignore */ }
      }
    });
  }

  async function scrollLoop(run) {
    var idleRounds = 0;
    var previousHeight = pageHeight();

    while (!state.stopped && run === scrollRun) {
      window.scrollTo(0, pageHeight());
      var grew = await waitForGrowth(previousHeight, 1800);
      var height = pageHeight();

      if (!grew || height <= previousHeight + 4) idleRounds++;
      else idleRounds = 0;

      previousHeight = height;
      renderOverlay();

      // Лента больше не подгружается — завершаем.
      if (idleRounds >= 5) break;
    }

    if (run === scrollRun) {
      state.scrolling = false;
      renderOverlay();
    }
  }

  function startAutoScroll() {
    stopScroll(); // инвалидирует предыдущий цикл
    var run = scrollRun;
    state.stopped = false;
    state.scrolling = true;
    renderOverlay();
    scrollLoop(run);
  }

  function stopScroll() {
    scrollRun++;
    state.stopped = true;
    state.scrolling = false;
    renderOverlay();
  }

  // ---------------------------------------------------------------------
  // Публичный API для renderer-процесса
  // ---------------------------------------------------------------------

  window.__fbsoftStart = function (kind, mode) {
    state.kind = kind === 'posts' ? 'posts' : 'members';
    ensureOverlay();
    renderOverlay();

    if (mode === 'auto') {
      startAutoScroll();
    } else {
      stopScroll();
    }

    console.log('[FBSoft] collection started:', state.kind, mode);
  };

  window.__fbsoftStop = function () {
    stopScroll();
  };

  window.__fbsoftStatus = function () {
    return {
      kind: state.kind,
      scrolling: state.scrolling,
      count: currentCount()
    };
  };

  window.__fbsoftReset = function (kind) {
    if (kind === 'posts') {
      window.__fbPosts = [POST_HEADERS.slice()];
      window.__fbPostIds = Object.create(null);
    } else {
      window.__fbMembers = [MEMBER_HEADERS.slice()];
      window.__fbMemberIds = Object.create(null);
    }
    renderOverlay();
    console.log('[FBSoft] list reset:', kind === 'posts' ? 'posts' : 'members');
  };

  installInterceptors();
})();
