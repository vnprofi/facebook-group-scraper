/*
 * FBSoft — сборщик данных Facebook.
 *
 * Скрипт выполняется внутри страницы Facebook (webview). Он перехватывает
 * ответы GraphQL и складывает данные в глобальные массивы:
 *
 *   window.__fbMembers  — участники групп
 *   window.__fbPosts    — посты из ленты (профиль пользователя)
 *   window.__fbComments — комментарии, загруженные при раскрытии постов
 *   window.__fbProfile  — шапка профиля (пары «поле — значение»)
 *
 * Реакции собираются из ответов подсказки (CometUFI*ReactionIconTooltip*).
 * У каждого поста и комментария есть feedback.id — по нему реакции
 * привязываются к нужной строке.
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
    'Медиа',
    'Реакции',
    'Реакции (по типам)',
    'Комментарии',
    'Репосты',
    'Кто отреагировал'
  ];

  var COMMENT_HEADERS = [
    'ID комментария',
    'Пост ID',
    'Текст поста',
    'Ссылка на пост',
    'Автор поста',
    'Ссылка на автора поста',
    'Автор',
    'Ссылка на автора',
    'Текст комментария',
    'Дата',
    'Реакции',
    'Ссылка на комментарий',
    'Кто отреагировал'
  ];

  // Индексы служебных колонок в строках таблиц.
  var POST_REACTION_COUNT_COLUMN = 7;
  var POST_REACTION_TYPES_COLUMN = 8;
  var POST_COMMENT_COUNT_COLUMN = 9;
  var POST_REACTORS_COLUMN = POST_HEADERS.length - 1;
  var COMMENT_REACTION_COUNT_COLUMN = 10;
  var COMMENT_REACTORS_COLUMN = COMMENT_HEADERS.length - 1;

  var REACTION_NAMES = {
    '1635855486666999': 'Нравится',
    '1678524932434102': 'Супер',
    '613557422527858': 'Поддерживаю',
    '115940658764963': 'Ха-ха',
    '478547315650144': 'Удивление',
    '908563459236466': 'Печаль',
    '444813342392137': 'Злость'
  };

  window.__fbMembers = window.__fbMembers || [MEMBER_HEADERS.slice()];
  window.__fbPosts = window.__fbPosts || [POST_HEADERS.slice()];
  window.__fbComments = window.__fbComments || [COMMENT_HEADERS.slice()];
  window.__fbMemberIds = window.__fbMemberIds || Object.create(null);
  window.__fbPostIds = window.__fbPostIds || Object.create(null);
  window.__fbCommentIds = window.__fbCommentIds || Object.create(null);
  window.__fbProfile = window.__fbProfile || [];

  // feedback.id → строка поста или комментария.
  window.__fbFeedbackTargets = window.__fbFeedbackTargets || Object.create(null);
  // feedback.id → { seen, names[], total } — те, кто поставил реакцию.
  window.__fbReactions = window.__fbReactions || Object.create(null);

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
  // Шапка профиля
  //
  // Набор полей у каждого профиля свой, поэтому собираем только то, что
  // реально отрисовано на странице, и отдаём список пар «поле — значение».
  // ---------------------------------------------------------------------

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanLines(value) {
    return String(value == null ? '' : value)
      .replace(/\u00a0/g, ' ')
      .split(/\n+/)
      .map(function (line) { return line.replace(/\s+/g, ' ').trim(); })
      .filter(function (line) { return !!line; });
  }

  function metaContent(name) {
    var el =
      document.querySelector('meta[property="' + name + '"]') ||
      document.querySelector('meta[name="' + name + '"]');
    return el ? cleanText(el.getAttribute('content')) : '';
  }

  function profileUrl() {
    var canonical = document.querySelector('link[rel="canonical"]');
    var raw = (canonical && canonical.href) || metaContent('og:url') || location.href;

    try {
      var url = new URL(raw, location.origin);
      var id = url.searchParams.get('id');
      if (url.pathname === '/profile.php' && id) {
        return 'https://www.facebook.com/profile.php?id=' + id;
      }
      return url.origin + url.pathname.replace(/\/+$/, '');
    } catch (e) {
      return location.href.split('?')[0];
    }
  }

  function profileIdFromUrl(url) {
    try {
      var parsed = new URL(url, location.origin);
      var id = parsed.searchParams.get('id');
      if (id) return id;
      var people = parsed.pathname.match(/\/people\/[^/]+\/(\d+)/);
      if (people) return people[1];
    } catch (e) { /* ignore */ }
    return '';
  }

  function headerActions() {
    return document.querySelector('[data-pagelet="ProfileActions"]');
  }

  // Блок действий, имя, счётчики, биография и «Актуальная информация»
  // лежат в разных ветках одной шапки. Общий контейнер ищем от блока
  // действий: сначала по блоку «Актуальная информация» (он есть у
  // большинства профилей), затем по ссылке на подписчиков.
  function headerWrapper() {
    var actions = headerActions();
    if (!actions) return null;

    var details = document.querySelector(
      '[aria-label="Актуальная информация"], [aria-label="Details"], [aria-label="Intro"]'
    );

    if (details) {
      var node = actions;
      for (var i = 0; i < 10 && node.parentElement; i++) {
        node = node.parentElement;
        if (node.contains(details)) return node;
      }
    }

    var fallback = actions;
    for (var j = 0; j < 8 && fallback.parentElement; j++) {
      fallback = fallback.parentElement;
      if (fallback.querySelector('a[href*="/followers"], a[href*="sk=followers"]')) {
        return fallback;
      }
    }
    return actions.parentElement;
  }

  function cleanCount(value) {
    var text = cleanText(value);
    // «5,4 тыс. — подписчики» / «5.4K followers» → «5,4 тыс.» / «5.4K»
    text = text.replace(/\s*[—–-]\s*.*$/, '');
    text = text.replace(/\s*(подписчики|подписчиков|подписки|подписок|друзей|друзья|friends|followers|following)\s*$/i, '');
    text = text.trim();
    return /\d/.test(text) ? text : '';
  }

  function findAnchorByParam(param) {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var text = cleanText(links[i].innerText || links[i].textContent);
      if (!/\d/.test(text)) continue; // аватарки друзей тоже ведут на sk=followers
      try {
        var url = new URL(links[i].href, location.origin);
        if (param === 'followers') {
          if (url.searchParams.get('sk') === 'followers') return links[i];
          if (/\/followers\/?$/i.test(url.pathname)) return links[i];
        } else if (param === 'following') {
          if (url.searchParams.get('sk') === 'following') return links[i];
          if (/\/following\/?$/i.test(url.pathname)) return links[i];
        } else if (url.searchParams.get('sk') === param) {
          return links[i];
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function friendsCount() {
    var links = document.querySelectorAll('a[href*="/friends"], a[href*="sk=friends"]');
    for (var i = 0; i < links.length; i++) {
      var text = cleanCount(links[i].innerText || links[i].textContent);
      if (text) return text;
    }
    return '';
  }

  function nameFromHeader(wrapper, actions) {
    if (!wrapper) return '';
    var skip = /^(друзья|сообщение|поиск|смотреть рекомендации|добавить в друзья|подписаться|отписаться|написать|ещё|friends|message|search|follow|following|add friend)\b/i;
    var buttons = wrapper.querySelectorAll('[role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      if (actions && actions.contains(buttons[i])) continue;
      if (buttons[i].closest('[aria-label="Актуальная информация"], [aria-label="Details"], [aria-label="Intro"]')) continue;
      var text = cleanText(buttons[i].innerText || buttons[i].textContent);
      if (!text || text.length > 80) continue;
      if (skip.test(text)) continue;
      return text;
    }
    return '';
  }

  function bioFromHeader(wrapper, actions, name) {
    if (!wrapper) return '';
    var spans = wrapper.querySelectorAll('span[dir="auto"]');
    var fallback = '';

    for (var i = 0; i < spans.length; i++) {
      var el = spans[i];
      if (actions && actions.contains(el)) continue;
      if (el.closest('[role="button"]')) continue;
      if (el.closest('a')) continue;
      if (el.querySelector('[role="button"]')) continue;
      if (el.querySelector('a[href*="/followers"], a[href*="sk=followers"], a[href*="/following"], a[href*="sk=following"]')) continue;
      if (el.closest('[aria-label="Актуальная информация"], [aria-label="Details"], [aria-label="Intro"]')) continue;

      var text = cleanLines(el.innerText || el.textContent).join(' · ').trim();
      if (!text || text === name) continue;
      if (/^(друзья|сообщение|поиск|смотреть рекомендации|подписчики|подписки|friends|message|search)$/i.test(text)) continue;
      if (!/[A-Za-zА-Яа-яЁё0-9]/.test(text)) continue;

      // Приоритет — биография с переносами строк или ссылками,
      // иначе берём первый осмысленный текст под именем.
      if (el.querySelector('br') || el.querySelector('a')) return text;
      if (!fallback && /\s/.test(text)) fallback = text;
    }

    return fallback;
  }

  function detailsFromHeader(wrapper) {
    if (!wrapper) return '';

    var labels = ['Актуальная информация', 'Details', 'Intro'];
    var node = null;
    for (var i = 0; i < labels.length; i++) {
      node = wrapper.querySelector('[aria-label="' + labels[i] + '"]');
      if (node) break;
    }
    if (!node) return '';

    var items = node.querySelectorAll('[role="listitem"]');
    var out = [];
    for (var j = 0; j < items.length; j++) {
      var text = cleanText(items[j].innerText || items[j].textContent);
      if (!text || text === '·') continue;
      if (out.indexOf(text) === -1) out.push(text);
    }

    if (!out.length) {
      var all = cleanText(node.innerText || node.textContent);
      return all === '·' ? '' : all;
    }
    return out.join(' · ');
  }

  function isGenericName(value) {
    var text = cleanText(value);
    if (!text) return true;
    return /^(\(\d+\+?\)\s*)?facebook$/i.test(text) || /^(facebook|log\s*in|войти|регистрация)$/i.test(text);
  }

  // У коротких адресов (facebook.com/username) числового id в URL нет,
  // поэтому берём его из уже собранных постов — самые частые авторы.
  function idFromCollectedPosts() {
    var rows = window.__fbPosts || [];
    var counts = Object.create(null);
    var best = '';
    var bestCount = 0;

    for (var i = 1; i < rows.length; i++) {
      var link = rows[i] && rows[i][3] ? String(rows[i][3]) : '';
      var match = link.match(/[?&]id=(\d+)/);
      if (!match) continue;
      var id = match[1];
      counts[id] = (counts[id] || 0) + 1;
      if (counts[id] > bestCount) {
        bestCount = counts[id];
        best = id;
      }
    }

    return best;
  }

  function collectProfileHeader() {
    var fields = [];
    var seen = Object.create(null);

    function add(key, value) {
      var text = cleanText(value);
      if (!text || seen[key]) return;
      seen[key] = true;
      fields.push([key, text]);
    }

    var actions = headerActions();
    var wrapper = headerWrapper();

    var name = nameFromHeader(wrapper, actions);
    if (isGenericName(name)) {
      var ogTitle = metaContent('og:title');
      name = isGenericName(ogTitle) ? '' : ogTitle;
    }
    if (isGenericName(name)) {
      var docTitle = cleanText(document.title || '').replace(/^\(\d+\+?\)\s*/, '');
      var firstPart = docTitle.split('|')[0].split(' - ')[0].trim();
      name = isGenericName(firstPart) ? '' : firstPart;
    }
    name = cleanText(name).replace(/\s*[|\-–]\s*Facebook\s*$/i, '').trim();
    add('Имя', name);

    var url = profileUrl();
    add('Ссылка', url);
    add('ID', profileIdFromUrl(url) || idFromCollectedPosts());

    var followers = findAnchorByParam('followers');
    if (followers) add('Подписчики', cleanCount(followers.innerText || followers.textContent));

    var following = findAnchorByParam('following');
    if (following) add('Подписки', cleanCount(following.innerText || following.textContent));

    add('Друзья', friendsCount());
    add('О себе', bioFromHeader(wrapper, actions, name));
    add('Актуальная информация', detailsFromHeader(wrapper));

    window.__fbProfile = fields;
    return fields;
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

  // ---------------------------------------------------------------------
  // Счётчики реакций, комментариев и репостов
  // ---------------------------------------------------------------------

  function countText(value) {
    if (value == null) return '';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value.trim();
    if (typeof value !== 'object') return '';

    // count_reduced — уже готовая строка («12», «1,2 тыс.»).
    if (value.count_reduced != null && value.count_reduced !== '') {
      return String(value.count_reduced).trim();
    }
    if (typeof value.count === 'number') return String(value.count);
    if (typeof value.count === 'string' && value.count.trim()) return value.count.trim();
    if (typeof value.total_count === 'number') return String(value.total_count);
    if (typeof value.reaction_count === 'number') return String(value.reaction_count);
    return '';
  }

  function reactionBreakdown(feedback) {
    var top = feedback && feedback.top_reactions;
    if (!top || typeof top !== 'object') return '';

    var items = [];
    if (Array.isArray(top.edges)) items = top.edges;
    else if (Array.isArray(top.summary)) items = top.summary;

    var parts = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var node = item.node || item.reaction || {};
      var id = node.id ? String(node.id) : '';
      var count = countText(item);
      if (!count) continue;
      var name = REACTION_NAMES[id] || id || 'Реакция';
      parts.push(name + ' ' + count);
    }

    return parts.join(' · ');
  }

  function postStats(feedbacks) {
    var reactions = '';
    var breakdown = '';
    var comments = '';
    var shares = '';

    for (var i = 0; i < feedbacks.length; i++) {
      var feedback = feedbacks[i];
      if (!feedback || typeof feedback !== 'object') continue;

      if (!reactions) {
        reactions =
          countText(feedback.unified_reactors) ||
          countText(feedback.reactors) ||
          countText(feedback.reaction_count);
      }
      if (!breakdown) breakdown = reactionBreakdown(feedback);

      if (!comments) {
        var rendering = feedback.comment_rendering_instance_for_feed_location;
        comments = countText(rendering && rendering.comments);
        if (!comments) comments = countText(feedback.total_comment_count);
        if (!comments) comments = countText(feedback.comment_count);
      }

      if (!shares) {
        shares =
          countText(feedback.share_count) ||
          countText(feedback.reshares) ||
          countText(feedback.reshare_count);
      }

      if (reactions && breakdown && comments && shares) break;
    }

    return [reactions, breakdown, comments, shares];
  }

  // ---------------------------------------------------------------------
  // Реакции
  //
  // Подсказка при наведении на реакции (CometUFIReactionIconTooltipContentQuery)
  // возвращает feedback.id и список User. Тот же feedback.id есть у поста
  // и у комментария, поэтому реакции попадают в нужную строку таблицы.
  // ---------------------------------------------------------------------

  function looksLikeFeedbackId(value) {
    if (typeof value !== 'string' || !value) return false;
    return value.indexOf('feedback:') === 0 || value.indexOf('ZmVlZGJhY2s6') === 0;
  }

  // Facebook отдаёт id то в base64, то в открытом виде — приводим к одному.
  function feedbackKey(value) {
    var raw = String(value || '');
    if (raw.indexOf('feedback:') === 0) return raw;
    if (raw.indexOf('ZmVlZGJhY2s6') === 0) {
      try {
        var b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var decoded = atob(b64);
        if (decoded.indexOf('feedback:') === 0) return decoded;
      } catch (e) { /* не base64 */ }
    }
    return raw;
  }

  // У feedback-узла есть хоть какие-то счётчики реакций. Подсказка при
  // наведении присылает только top_reactions.summary, без reactors.nodes,
  // поэтому проверяем все варианты, а не только полный список.
  function hasReactionStats(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.reactors && typeof value.reactors === 'object') return true;
    if (value.unified_reactors && typeof value.unified_reactors === 'object') return true;
    if (value.total_reaction_count && typeof value.total_reaction_count === 'object') return true;
    if (value.top_reactions && typeof value.top_reactions === 'object') return true;
    if (value.comment_rendering_instance_for_feed_location) return true;
    return false;
  }

  function collectFeedbackNodes(value, out, depth) {
    if (!value || typeof value !== 'object' || depth > 40) return;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectFeedbackNodes(value[i], out, depth + 1);
      return;
    }

    if (looksLikeFeedbackId(value.id) && hasReactionStats(value)) out.push(value);

    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var child = value[key];
      if (child && typeof child === 'object') collectFeedbackNodes(child, out, depth + 1);
    }
  }

  function registerFeedbackTarget(feedback, type, row) {
    if (!feedback || !feedback.id || !row) return;
    var key = feedbackKey(feedback.id);
    window.__fbFeedbackTargets[key] = { type: type, row: row };
    applyReactionTarget(key);
  }

  function applyReactionTarget(key) {
    var target = window.__fbFeedbackTargets[key];
    var entry = window.__fbReactions[key];
    if (!target || !target.row || !entry) return;

    if (target.type === 'comment') {
      target.row[COMMENT_REACTORS_COLUMN] = entry.names.join(', ');
      if (!target.row[COMMENT_REACTION_COUNT_COLUMN] && entry.total) {
        target.row[COMMENT_REACTION_COUNT_COLUMN] = entry.total;
      }
    } else {
      target.row[POST_REACTORS_COLUMN] = entry.names.join(', ');
      if (!target.row[POST_REACTION_COUNT_COLUMN] && entry.total) {
        target.row[POST_REACTION_COUNT_COLUMN] = entry.total;
      }
      if (!target.row[POST_REACTION_TYPES_COLUMN] && entry.breakdown) {
        target.row[POST_REACTION_TYPES_COLUMN] = entry.breakdown;
      }
      if (!target.row[POST_COMMENT_COUNT_COLUMN] && entry.comments) {
        target.row[POST_COMMENT_COUNT_COLUMN] = entry.comments;
      }
    }
  }

  function addUserNode(entry, node) {
    if (!node || node.__typename !== 'User') return;

    var id = node.id ? String(node.id) : '';
    var name = cleanText(node.name);
    if (!id && !name) return;

    var dedupe = id || name;
    if (entry.seen[dedupe]) return;
    entry.seen[dedupe] = true;
    entry.names.push(name ? (id ? name + ' (' + id + ')' : name) : id);
  }

  function addReactionUsers(feedback) {
    if (!feedback || !feedback.id) return;

    var key = feedbackKey(feedback.id);
    var entry = window.__fbReactions[key];
    if (!entry) {
      entry = window.__fbReactions[key] = {
        seen: Object.create(null),
        names: [],
        total: '',
        breakdown: '',
        comments: ''
      };
    }

    var nodes = (feedback.reactors && Array.isArray(feedback.reactors.nodes)) ? feedback.reactors.nodes : [];
    for (var i = 0; i < nodes.length; i++) addUserNode(entry, nodes[i]);

    // Подсказка при наведении: в каждом summary-элементе лежат несколько
    // первых «интересных» реакторов, по ним и набирается список.
    var top = feedback.top_reactions;
    var items = top && Array.isArray(top.summary) ? top.summary
      : top && Array.isArray(top.edges) ? top.edges
        : [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j] || {};
      if (Array.isArray(item.interesting_reactors)) {
        for (var k = 0; k < item.interesting_reactors.length; k++) addUserNode(entry, item.interesting_reactors[k]);
      }
      if (Array.isArray(item.reactors)) {
        for (var m = 0; m < item.reactors.length; m++) addUserNode(entry, item.reactors[m]);
      }
    }

    entry.total =
      countText(feedback.total_reaction_count) ||
      countText(feedback.reactors) ||
      countText(feedback.unified_reactors) ||
      countText(feedback.reaction_count) ||
      entry.total;

    if (!entry.breakdown) entry.breakdown = reactionBreakdown(feedback);

    if (!entry.comments) {
      var rendering = feedback.comment_rendering_instance_for_feed_location;
      entry.comments = countText(rendering && rendering.comments);
    }

    applyReactionTarget(key);
  }

  function parseReactions(text) {
    var payloads = parsePayloads(text);
    for (var i = 0; i < payloads.length; i++) {
      var nodes = [];
      collectFeedbackNodes(payloads[i], nodes, 0);
      for (var j = 0; j < nodes.length; j++) addReactionUsers(nodes[j]);
    }
  }

  function clearReactions(type) {
    var keys = Object.keys(window.__fbFeedbackTargets);
    for (var i = 0; i < keys.length; i++) {
      var target = window.__fbFeedbackTargets[keys[i]];
      if (!target || target.type !== type) continue;
      delete window.__fbFeedbackTargets[keys[i]];
      delete window.__fbReactions[keys[i]];
    }
  }

  function storyFeedbacks(node) {
    var out = [];
    if (!node) return out;

    var sections = node.comet_sections || {};
    var contentStory = (sections.content && sections.content.story) || {};
    var contentSections = contentStory.comet_sections || {};
    var messageStory =
      (sections.message && sections.message.story) ||
      (contentSections.message && contentSections.message.story) ||
      {};

    if (node.feedback) out.push(node.feedback);
    if (contentStory.feedback) out.push(contentStory.feedback);
    if (messageStory.feedback) out.push(messageStory.feedback);
    return out;
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

    var feedbacks = storyFeedbacks(node);
    var stats = postStats(feedbacks);

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
      media,
      stats[0],
      stats[1],
      stats[2],
      stats[3],
      ''
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

        var feedbacks = storyFeedbacks(nodes[j]);
        for (var k = 0; k < feedbacks.length; k++) {
          registerFeedbackTarget(feedbacks[k], 'post', row);
        }

        added++;
      }
    }

    return added;
  }

  // ---------------------------------------------------------------------
  // Комментарии
  //
  // Комментарии приходят отдельными GraphQL-ответами при раскрытии поста.
  // Узел комментария содержит id в base64 («comment:POSTID_COMMENTID»),
  // автора, текст, время и счётчик реакций.
  // ---------------------------------------------------------------------

  var COMMENT_RE = /^comment:(\d+)_(\d+)$/;

  function decodeCommentId(value) {
    var raw = String(value || '');
    if (!raw) return null;

    var direct = raw.match(COMMENT_RE);
    if (direct) return { postId: direct[1], commentId: direct[2] };

    var plain = raw.match(/^(\d+)_(\d+)$/);
    if (plain) return { postId: plain[1], commentId: plain[2] };

    if (/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
      try {
        var decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
        var match = decoded.match(COMMENT_RE);
        if (match) return { postId: match[1], commentId: match[2] };
      } catch (e) { /* не base64 — пропускаем */ }
    }

    return null;
  }

  function findPostRow(postId) {
    if (!postId) return null;
    var rows = window.__fbPosts || [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i] && String(rows[i][0]) === String(postId)) return rows[i];
    }
    return null;
  }

  function isCommentNode(value) {
    if (!value || typeof value !== 'object') return false;
    if (!value.body || typeof value.body !== 'object') return false;
    if (!value.author || typeof value.author !== 'object') return false;
    return value.__typename === 'Comment' || !!value.legacy_fbid;
  }

  function collectCommentNodes(value, out, depth) {
    if (!value || typeof value !== 'object' || depth > 40) return;

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectCommentNodes(value[i], out, depth + 1);
      return;
    }

    if (isCommentNode(value)) out.push(value);

    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var child = value[key];
      if (child && typeof child === 'object') collectCommentNodes(child, out, depth + 1);
    }
  }

  function commentToRow(comment) {
    var author = comment.author || {};
    var authorId = author.id ? String(author.id) : '';
    var authorName = author.name ? String(author.name) : '';
    var authorLink = absoluteUrl(author.url);
    if (!authorLink && authorId) authorLink = 'https://www.facebook.com/profile.php?id=' + authorId;

    var text = comment.body && typeof comment.body.text === 'string' ? comment.body.text : '';
    if (!text) return null;

    var feedback = comment.feedback || {};
    var ids = decodeCommentId(comment.id) || {};
    var commentId = comment.legacy_fbid ? String(comment.legacy_fbid) : (ids.commentId || '');
    var postId = ids.postId || '';

    var permalink = absoluteUrl(feedback.url);
    if (feedback.url) {
      try {
        var fbUrl = new URL(feedback.url, location.origin);
        if (!postId) postId = fbUrl.searchParams.get('story_fbid') || '';
      } catch (e) { /* ignore */ }
    }
    if (!permalink && postId && commentId) {
      permalink = 'https://www.facebook.com/' + postId + '?comment_id=' + commentId;
    }

    var key = commentId || String(comment.id || '') || (postId + '|' + authorName + '|' + text);
    if (!key || window.__fbCommentIds[key]) return null;

    var reactions =
      countText(comment.reactors) ||
      countText(feedback.reactors) ||
      countText(feedback.reaction_count) ||
      countText(feedback.unified_reactors);

    window.__fbCommentIds[key] = true;
    return [
      commentId,
      postId,
      '',
      '',
      '',
      '',
      authorName,
      authorLink,
      text,
      formatDate(comment.created_time),
      reactions,
      permalink,
      ''
    ];
  }

  function parseComments(text) {
    var payloads = parsePayloads(text);
    var added = 0;

    for (var i = 0; i < payloads.length; i++) {
      var nodes = [];
      collectCommentNodes(payloads[i], nodes, 0);

      for (var j = 0; j < nodes.length; j++) {
        var row = commentToRow(nodes[j]);
        if (!row) continue;
        window.__fbComments.push(row);
        registerFeedbackTarget(nodes[j].feedback, 'comment', row);
        added++;
      }
    }

    return added;
  }

  // Текст и ссылку поста могли собрать позже самого комментария,
  // поэтому подставляем их при экспорте.
  function refreshCommentRows() {
    var rows = window.__fbComments || [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row) continue;
      var post = findPostRow(row[1]);
      if (!post) continue;
      if (!row[2]) row[2] = post[4] || '';
      if (!row[3]) row[3] = post[5] || '';
      if (!row[4]) row[4] = post[2] || '';
      if (!row[5]) row[5] = post[3] || '';
    }
    return rows;
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

    try {
      if (text.indexOf('"__typename":"Comment"') !== -1 ||
          text.indexOf('"legacy_fbid"') !== -1 ||
          text.indexOf('CommentsListComponentsPaginationQuery') !== -1) {
        parseComments(text);
      }
    } catch (e) { /* см. выше */ }

    try {
      if (text.indexOf('"top_reactions"') !== -1 ||
          text.indexOf('"reactors"') !== -1 ||
          text.indexOf('"unified_reactors"') !== -1 ||
          text.indexOf('"comment_rendering_instance_for_feed_location"') !== -1) {
        parseReactions(text);
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
    if (state.kind === 'posts') return window.__fbPosts;
    if (state.kind === 'comments') return window.__fbComments;
    return window.__fbMembers;
  }

  function overlayLabel() {
    if (state.kind === 'posts') return 'Посты:';
    if (state.kind === 'comments') return 'Комментарии:';
    return 'Участники группы:';
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
    label.textContent = overlayLabel();

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
    if (label) label.textContent = overlayLabel();
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
    // Посты и комментарии собираются только при ручной прокрутке.
    if (state.kind === 'posts' || state.kind === 'comments') {
      stopScroll();
      return;
    }

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
    if (kind === 'posts') state.kind = 'posts';
    else if (kind === 'comments') state.kind = 'comments';
    else state.kind = 'members';

    ensureOverlay();
    renderOverlay();

    if (state.kind === 'posts') {
      collectProfileHeader();
    }

    if (mode === 'auto' && state.kind === 'members') {
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
      count: currentCount(),
      comments: Math.max(0, (window.__fbComments || []).length - 1)
    };
  };

  window.__fbsoftCollectProfile = function () {
    return collectProfileHeader();
  };

  window.__fbsoftCollectComments = function () {
    return refreshCommentRows();
  };

  window.__fbsoftHideOverlay = function () {
    if (state.box) state.box.style.display = 'none';
  };

  window.__fbsoftReset = function (kind) {
    if (kind === 'posts') {
      window.__fbPosts = [POST_HEADERS.slice()];
      window.__fbPostIds = Object.create(null);
      window.__fbProfile = [];
      clearReactions('post');
    } else if (kind === 'comments') {
      window.__fbComments = [COMMENT_HEADERS.slice()];
      window.__fbCommentIds = Object.create(null);
      clearReactions('comment');
    } else {
      window.__fbMembers = [MEMBER_HEADERS.slice()];
      window.__fbMemberIds = Object.create(null);
    }
    renderOverlay();
    console.log('[FBSoft] list reset:', kind);
  };

  installInterceptors();
})();
