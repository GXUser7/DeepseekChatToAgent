'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const STORE = 'orbit.workspace.v1';
const PREFS = 'orbit.preferences.v1';
const icon = (name, className = 'icon') => `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uid = () => crypto.randomUUID();
const timeLabel = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
const savedChats = load(STORE, []);
let conversations = Array.isArray(savedChats) ? savedChats.filter(chat => chat && typeof chat.id === 'string' && Array.isArray(chat.messages)) : [];
const systemTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
let preferences = { theme: systemTheme, deepThink: true, search: false, autoApprove: false, outputMode: 'compact', thinkingOpen: false, systemPrompt: null, ...load(PREFS, {}) };
const OUTPUT_MODES = ['compact', 'tail', 'full'];
if (!OUTPUT_MODES.includes(preferences.outputMode)) preferences.outputMode = preferences.fullOutput ? 'full' : 'compact';
delete preferences.fullOutput;
let activeId = null;
let run = null;
let serverStatus = {};
let defaultPrompt = '';
let stickToBottom = true;
let renderFrame = null;
let toastTimer;
let authTimer;
let workspaceTimer;
let workspaceWasPicking = false;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3700);
}
function persist() {
  try { localStorage.setItem(STORE, JSON.stringify(conversations)); }
  catch { toast('Не удалось сохранить историю: память браузера заполнена. Экспортируйте диалоги в настройках.'); }
}
function savePreferences() {
  try { localStorage.setItem(PREFS, JSON.stringify(preferences)); }
  catch { toast('Браузер не разрешил сохранить настройки.'); }
}
function currentChat() { return conversations.find(chat => chat.id === activeId); }
function applyTheme() {
  document.documentElement.dataset.theme = preferences.theme === 'dark' ? 'dark' : 'light';
  $('#theme-button').innerHTML = icon(preferences.theme === 'dark' ? 'sun' : 'moon');
  $('meta[name="theme-color"]').content = preferences.theme === 'dark' ? '#111318' : '#eff0f4';
}
function updateOptions() {
  $('#deepthink-button').setAttribute('aria-pressed', String(preferences.deepThink !== false));
  $('#search-button').setAttribute('aria-pressed', String(Boolean(preferences.search)));
  $('#auto-approve-switch').setAttribute('aria-checked', String(Boolean(preferences.autoApprove)));
  $('#thinking-switch').setAttribute('aria-checked', String(Boolean(preferences.thinkingOpen)));
  for (const option of document.querySelectorAll('#output-mode [data-mode]')) option.setAttribute('aria-checked', String(option.dataset.mode === preferences.outputMode));
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-scrim').classList.remove('open');
}
function newChat() {
  if (run) { toast('Сначала остановите текущий ответ.'); return; }
  activeId = null;
  $('#prompt').value = '';
  resizeInput();
  renderConversation();
  renderHistory();
  closeSidebar();
  $('#prompt').focus();
}
function renderHistory() {
  const history = $('#history');
  history.replaceChildren();
  $('#history-count').textContent = conversations.length;
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'Нет диалогов';
    history.append(empty);
    return;
  }
  let lastGroup;
  for (const chat of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const group = new Date(chat.updatedAt).toDateString() === new Date().toDateString() ? 'Сегодня' : 'Ранее';
    if (group !== lastGroup) {
      const label = document.createElement('div');
      label.className = 'history-group';
      label.textContent = group;
      history.append(label);
      lastGroup = group;
    }
    const item = document.createElement('div');
    item.className = `history-item${chat.id === activeId ? ' active' : ''}`;
    const button = document.createElement('button');
    button.className = 'history-link';
    const title = document.createElement('span');
    title.textContent = chat.title;
    button.append(title);
    button.title = chat.title;
    if (chat.id === activeId) button.setAttribute('aria-current', 'page');
    button.onclick = () => {
      if (run && activeId !== chat.id) { toast('Сначала остановите текущий ответ.'); return; }
      activeId = chat.id;
      stickToBottom = true;
      renderConversation();
      renderHistory();
      closeSidebar();
      scrollBottom(true);
    };
    const remove = document.createElement('button');
    remove.className = 'history-delete';
    remove.innerHTML = icon('trash');
    remove.setAttribute('aria-label', `Удалить диалог «${chat.title}»`);
    remove.onclick = () => {
      if (run) { toast('Дождитесь завершения ответа.'); return; }
      if (!confirm(`Удалить диалог «${chat.title}» из этого браузера?`)) return;
      conversations = conversations.filter(entry => entry.id !== chat.id);
      if (activeId === chat.id) activeId = null;
      persist(); renderHistory(); renderConversation();
    };
    item.append(button, remove);
    history.append(item);
  }
}
// DeepSeek sometimes ends a terminal block with its own tool-call tags (</｜｜DSML｜｜ parameter>); they are never text.
const DSML_TAG = /<\/?[｜|]{1,2}\s*DSML\s*[｜|]{1,2}[^>]*>/g;
// Until the server turns a <terminal> block into an approval card, show it as code instead of letting the sanitizer drop the tag.
function showTerminalBlocks(value) {
  return value.replace(DSML_TAG, '').replace(/<terminal>([\s\S]*?)(?:<\/terminal>|$)/g, (_, command) => `\n\n\`\`\`\n${command.trim()}\n\`\`\`\n\n`);
}
function markdown(value) {
  value = showTerminalBlocks(value);
  if (!window.marked || !window.DOMPurify) {
    const text = document.createElement('div');
    text.textContent = value;
    return text.innerHTML.replace(/\n/g, '<br>');
  }
  return DOMPurify.sanitize(marked.parse(value, { breaks: true }), {
    FORBID_TAGS: ['img', 'style', 'input', 'button', 'form', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
}
function renderConversation(keepScroll = false) {
  const previousScroll = $('#conversation-scroll').scrollTop;
  const chat = currentChat();
  $('#welcome').hidden = Boolean(chat?.messages.length);
  $('#messages').replaceChildren();
  $('#chat-title').textContent = chat?.title || 'Новый диалог';
  document.title = chat ? `${chat.title} — Orbit` : 'Orbit — DeepSeek workspace';
  updateChatInfo();
  if (!chat) return;
  for (const message of chat.messages) $('#messages').append(renderMessage(message));
  if (keepScroll && !stickToBottom) $('#conversation-scroll').scrollTop = previousScroll;
  else scrollBottom(true);
}
// Messages are re-rendered on every streamed chunk; only the first render may play the entry animation.
const shownMessages = new Set();
function renderMessage(message) {
  const element = document.createElement('article');
  element.className = `message message-${message.role}${shownMessages.has(message.id) ? '' : ' appear'}`;
  shownMessages.add(message.id);
  element.dataset.messageId = message.id;
  if (message.role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = message.content;
    element.append(bubble);
    return element;
  }
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.innerHTML = `${icon('flower', 'message-avatar')}<strong>DeepSeek</strong>`;
  const time = document.createElement('time');
  time.dateTime = new Date(message.createdAt).toISOString();
  time.textContent = timeLabel(message.createdAt);
  meta.append(time);
  element.append(meta);
  for (const part of message.parts || []) {
    // Older chats kept a card for every prompt sent after a command; only the first prompt is shown.
    if (part.type !== 'context' || !part.step) element.append(renderPart(part, message));
  }
  if (message.error) {
    const error = document.createElement('div');
    error.className = 'message-error'; error.textContent = message.error; element.append(error);
  }
  if (message.stopped) {
    const notice = document.createElement('p'); notice.className = 'message-notice'; notice.textContent = 'Ответ остановлен вами.'; element.append(notice);
  }
  if (run?.message.id === message.id) {
    const cursor = document.createElement('span'); cursor.className = 'streaming-cursor'; element.append(cursor);
  } else {
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const copy = document.createElement('button'); copy.className = 'icon-button'; copy.innerHTML = icon('copy'); copy.title = 'Скопировать ответ'; copy.setAttribute('aria-label', 'Скопировать ответ');
    copy.onclick = async () => {
      const text = (message.parts || []).filter(part => part.type === 'response').map(part => part.content).join('\n\n');
      try { await navigator.clipboard.writeText(text); toast('Ответ скопирован'); } catch { toast('Не удалось скопировать ответ.'); }
    };
    actions.append(copy);
    if (message.duration) { const duration = document.createElement('span'); duration.className = 'message-duration'; duration.textContent = `${message.duration} с`; actions.append(duration); }
    element.append(actions);
  }
  return element;
}
const formatNumber = value => Number(value).toLocaleString('ru-RU');
function plural(count, one, few, many) {
  const tens = count % 100, units = count % 10;
  if (tens > 10 && tens < 20) return many;
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many;
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
// DeepSeek marks sources in search answers as [citation:N]; turn them into links to the found pages.
function linkCitations(text, message) {
  const results = (message.parts || []).filter(part => part.type === 'search').flatMap(part => part.results || []);
  return text.replace(/\[citation:(\d+)\]/g, (_, number) => {
    const index = Number(number);
    const result = results.find(item => item.cite_index === index) || results[index - 1];
    const href = result && safeLink(result.url);
    return href ? `<sup class="cite"><a href="${escapeHtml(href)}" title="${escapeHtml(result.title || href)}">${index}</a></sup>` : `<sup class="cite">${index}</sup>`;
  });
}
const remoteLink = value => typeof value === 'string' && /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[\w-]+$/.test(value);
function updateChatInfo() {
  const chat = currentChat();
  const link = $('#remote-link');
  link.hidden = !remoteLink(chat?.remoteUrl);
  if (!link.hidden) link.href = chat.remoteUrl;
  const usage = $('#context-usage');
  usage.hidden = !Number.isInteger(chat?.tokens);
  if (!usage.hidden) usage.textContent = `Контекст: ${formatNumber(chat.tokens)} ток.`;
}
function safeLink(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
function renderPart(part, message) {
  if (part.type === 'think') {
    const thinking = run?.message.id === message.id && part === message.parts.at(-1);
    const details = document.createElement('details');
    details.className = `thinking-card${thinking ? ' active' : ''}`;
    details.open = part.open ?? preferences.thinkingOpen;
    const summary = document.createElement('summary');
    summary.innerHTML = `${icon('brain')}<span class="thinking-label">Ход размышлений</span><span class="thinking-state">${thinking ? 'Думает…' : 'Завершено'}</span>${icon('chevron', 'icon thinking-chevron')}`;
    const content = document.createElement('div'); content.className = 'thinking-content'; content.textContent = part.content;
    details.append(summary, content);
    details.addEventListener('toggle', () => { part.open = details.open; });
    return details;
  }
  if (part.type === 'terminal') return renderTerminal(part);
  if (part.type === 'context') {
    const details = document.createElement('details'); details.className = 'context-card';
    details.open = Boolean(part.open);
    const summary = document.createElement('summary');
    summary.innerHTML = `${icon('code')}<span class="context-label">Контекст запроса</span><span class="context-size">${formatNumber(part.length || part.content.length)} симв.</span>${icon('chevron', 'icon thinking-chevron')}`;
    const content = document.createElement('pre'); content.className = 'context-content';
    content.textContent = part.content + (part.length > part.content.length ? `\n… обрезано для показа, всего ${formatNumber(part.length)} симв.` : '');
    details.append(summary, content);
    details.addEventListener('toggle', () => { part.open = details.open; });
    return details;
  }
  if (part.type === 'notice') {
    const notice = document.createElement('p'); notice.className = 'message-notice'; notice.innerHTML = icon('info');
    const text = document.createElement('span'); text.textContent = part.content; notice.append(text);
    return notice;
  }
  if (part.type === 'search') {
    const card = document.createElement('div'); card.className = 'search-card';
    const title = document.createElement('div'); title.className = 'search-card-title';
    const found = (part.results || []).length;
    title.innerHTML = `${icon('globe')}<span>Искал в сети${found ? ` · ${found} ${plural(found, 'источник', 'источника', 'источников')}` : ''}</span>`;
    card.append(title);
    for (const query of part.queries || []) {
      const text = document.createElement('div'); text.className = 'search-query'; text.textContent = typeof query === 'string' ? query : query.query; card.append(text);
    }
    const results = document.createElement('div'); results.className = 'search-results';
    for (const result of (part.results || []).slice(0, 12)) {
      const href = safeLink(result.url);
      if (!href) continue;
      const link = document.createElement('a'); link.className = 'search-result'; link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = result.site_name || new URL(href).hostname; link.title = result.title || href; results.append(link);
    }
    if (results.children.length) card.append(results);
    return card;
  }
  const body = document.createElement('div'); body.className = 'message-body';
  body.innerHTML = markdown(linkCitations(part.content || '', message));
  for (const link of body.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return body;
}
// LRM marks keep a path readable when CSS truncates it from the left with direction: rtl.
const ltr = value => `‎${value}‎`;
const EXIT_CODE = /^\[Код завершения: (-?\d+)\]\n?/;
function terminalState(part, code) {
  if (part.state === 'pending') return ['Ждёт разрешения', 'pending'];
  if (part.state === 'running') return ['Выполняется', 'muted'];
  if (part.state === 'denied') return ['Отклонено', 'muted'];
  if (part.state === 'interrupted') return ['Прервано', 'muted'];
  if (code === null) return ['Готово', 'muted'];
  return code === 0 ? ['Успешно', 'ok', 'Код завершения 0'] : [`Ошибка · код ${code}`, 'err', `Команда завершилась с кодом ${code}`];
}
async function decideTerminal(part, approved) {
  if (part.state !== 'pending') return;
  part.state = approved ? 'running' : 'denied';
  updateLiveMessage();
  try {
    await api('/api/approve', { id: part.id, approved });
    persist();
  } catch (error) {
    if (run && part.state !== 'done') { part.state = 'pending'; part.auto = false; }
    updateLiveMessage();
    toast(error.message);
  }
}
function autoApprove(part) {
  // A checkpoint after many commands in a row always waits for the user.
  if (!preferences.autoApprove || part.state !== 'pending' || part.checkpoint) return;
  part.auto = true;
  decideTerminal(part, true);
}
function setAutoApprove(enabled) {
  preferences.autoApprove = enabled; updateOptions(); savePreferences();
  if (!enabled) return;
  toast('Команды будут выполняться без подтверждения');
  for (const part of run?.message.parts || []) if (part.type === 'terminal') autoApprove(part);
}
const OUTPUT_PREVIEW_LINES = 5;
// The live message is re-rendered on every streamed chunk, which can replace a button between press and
// release so its click never fires. A mouse acts on the press; touch and keyboard keep the click.
function onPress(element, handler) {
  element.onpointerdown = event => { if (event.pointerType === 'mouse' && event.button === 0) handler(); };
  element.onclick = event => { if (event.pointerType !== 'mouse') handler(); };
}
function formatElapsed(seconds) {
  if (seconds < 0.1) return '< 0,1 с';
  if (seconds < 60) return `${seconds.toLocaleString('ru-RU', { maximumFractionDigits: seconds < 10 ? 1 : 0 })} с`;
  return `${Math.floor(seconds / 60)} мин ${Math.round(seconds % 60)} с`;
}
// Auto mark, run time and state, shared by the full header and the compact row.
function terminalBadges(part, [stateText, stateClass, stateTitle]) {
  const badges = [];
  if (part.auto) { const auto = document.createElement('span'); auto.className = 'terminal-auto'; auto.textContent = 'авто'; auto.title = 'Выполнено без подтверждения'; badges.push(auto); }
  if (Number.isFinite(part.elapsed)) { const time = document.createElement('span'); time.className = 'terminal-time'; time.textContent = formatElapsed(part.elapsed); time.title = 'Время выполнения'; badges.push(time); }
  const label = document.createElement('span'); label.className = `terminal-state ${stateClass}`;
  if (stateTitle) label.title = stateTitle;
  if (part.state === 'running' && run) label.innerHTML = '<span class="activity-indicator"></span>';
  label.append(stateText);
  badges.push(label);
  return badges;
}
function renderTerminal(part) {
  const awaiting = part.state === 'pending' && run;
  const mode = preferences.outputMode;
  const card = document.createElement('section'); card.className = `terminal-card${awaiting ? ' pending' : ''}`;
  const windows = /^[a-z]:\\/i.test(part.cwd || '') || String(serverStatus.platform || '').startsWith('win');
  const exit = EXIT_CODE.exec(part.output || '');
  const state = terminalState(part, part.state === 'done' && exit ? Number(exit[1]) : null);
  const outputText = exit ? part.output.slice(exit[0].length) : part.output;
  const lines = outputText ? outputText.replace(/\n$/, '').split('\n') : [];
  const lineCount = `${formatNumber(lines.length)} ${plural(lines.length, 'строка', 'строки', 'строк')}`;
  const collapsible = Boolean(outputText) && (mode === 'compact' || (mode === 'tail' && lines.length > OUTPUT_PREVIEW_LINES));
  const toggleOutput = () => { part.expanded = !part.expanded; card.replaceWith(renderTerminal(part)); persist(); };
  if (mode === 'compact' && !awaiting && !part.expanded) {
    // One line: the command, run time and result; the output opens on click.
    card.classList.add('compact');
    const row = document.createElement(outputText ? 'button' : 'div'); row.className = 'terminal-row';
    row.innerHTML = icon('terminal');
    const command = document.createElement('code'); command.className = 'terminal-row-command';
    command.textContent = `${windows ? 'PS>' : '$'} ${part.command}`; command.title = `${part.cwd || ''}\n${part.command}`;
    row.append(command, ...terminalBadges(part, state));
    if (outputText) {
      row.insertAdjacentHTML('beforeend', icon('chevron', 'icon terminal-row-chevron'));
      row.setAttribute('aria-expanded', 'false');
      row.title = `Показать вывод · ${lineCount}`;
      onPress(row, toggleOutput);
    }
    card.append(row);
    return card;
  }
  // An expanded card collapses from its header, which stays in view above long output.
  const collapsesFromHeader = collapsible && part.expanded;
  const header = document.createElement(collapsesFromHeader ? 'button' : 'div'); header.className = 'terminal-header';
  header.innerHTML = `${icon('terminal')}<span class="terminal-shell">${windows ? 'PowerShell' : 'sh'}</span>`;
  const cwd = document.createElement('span'); cwd.className = 'terminal-cwd'; cwd.textContent = ltr(part.cwd || ''); cwd.title = part.cwd || '';
  header.append(cwd, ...terminalBadges(part, state));
  if (collapsesFromHeader) {
    header.insertAdjacentHTML('beforeend', icon('chevron', 'icon terminal-header-chevron'));
    header.setAttribute('aria-expanded', 'true');
    header.title = 'Свернуть вывод';
    onPress(header, toggleOutput);
  }
  const command = document.createElement('pre'); command.className = 'terminal-command';
  const prompt = document.createElement('span'); prompt.className = 'terminal-prompt'; prompt.textContent = windows ? 'PS> ' : '$ ';
  command.append(prompt, part.command);
  card.append(header, command);
  if (awaiting) {
    const approval = document.createElement('div'); approval.className = 'terminal-approval';
    const explanation = document.createElement('p');
    explanation.textContent = part.checkpoint ? `DeepSeek выполнил уже ${formatNumber(part.checkpoint)} ${plural(part.checkpoint, 'команду', 'команды', 'команд')} подряд. Продолжить?`
      : part.fenced ? 'DeepSeek прислал команду обычным блоком кода. Выполнить её?' : 'Выполнить эту команду?';
    const buttons = document.createElement('div'); buttons.className = 'terminal-buttons';
    const allow = document.createElement('button'); allow.className = 'primary-button'; allow.innerHTML = `${icon('check')}Выполнить`;
    const always = document.createElement('button'); always.className = 'tonal-button'; always.innerHTML = `${icon('bolt')}Всегда`;
    always.title = 'Выполнить и дальше запускать команды без подтверждения';
    const deny = document.createElement('button'); deny.className = 'tonal-button'; deny.textContent = 'Отклонить';
    allow.onclick = () => decideTerminal(part, true); deny.onclick = () => decideTerminal(part, false);
    always.onclick = () => { decideTerminal(part, true); setAutoApprove(true); };
    buttons.append(allow, ...(preferences.autoApprove ? [] : [always]), deny); approval.append(explanation, buttons); card.append(approval);
  }
  if (outputText) {
    const output = document.createElement('pre'); output.className = 'terminal-output';
    output.textContent = mode === 'tail' && collapsible && !part.expanded ? lines.slice(-OUTPUT_PREVIEW_LINES).join('\n') : outputText;
    card.append(output);
    if (collapsible && !part.expanded) {
      const toggle = document.createElement('button'); toggle.className = 'terminal-toggle';
      toggle.innerHTML = icon('chevron', 'icon terminal-toggle-chevron');
      toggle.append(`Показать весь вывод · ${lineCount}`);
      onPress(toggle, toggleOutput);
      card.append(toggle);
    }
  }
  return card;
}
function updateLiveMessage() {
  if (!run) return;
  const previous = [...$('#messages').children].find(element => element.dataset.messageId === run.message.id);
  const oldDetails = previous?.querySelectorAll('.thinking-card') || [];
  const thinks = run.message.parts.filter(part => part.type === 'think');
  oldDetails.forEach((details, index) => { if (thinks[index]) thinks[index].open = details.open; });
  const replacement = renderMessage(run.message);
  if (previous) previous.replaceWith(replacement); else $('#messages').append(replacement);
  scrollBottom();
}
function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = null; updateLiveMessage(); });
}
function scrollBottom(force = false) {
  if (force || stickToBottom) $('#conversation-scroll').scrollTop = $('#conversation-scroll').scrollHeight;
}
function setBusy(busy) {
  $('#run-status').hidden = !busy;
  const send = $('#send-button');
  send.classList.toggle('stopping', busy);
  send.innerHTML = icon(busy ? 'stop' : 'arrow');
  send.setAttribute('aria-label', busy ? 'Остановить ответ' : 'Отправить сообщение');
  send.title = busy ? 'Остановить ответ' : 'Отправить сообщение';
  send.disabled = !busy && !$('#prompt').value.trim();
  $('#search-button').disabled = busy;
  $('#deepthink-button').disabled = busy;
}
function addTextPart(type, content) {
  const last = run.message.parts.at(-1);
  if (last?.type === type) last.content += content;
  else run.message.parts.push({ type, content });
}
function handleEvent(event) {
  if (!run || !event || typeof event.type !== 'string') return;
  const content = typeof event.content === 'string' ? event.content : '';
  switch (event.type) {
    case 'status': $('#run-status-text').textContent = content; break;
    case 'think': addTextPart('think', content); $('#run-status-text').textContent = 'Обдумывает задачу…'; break;
    case 'response': addTextPart('response', content); $('#run-status-text').textContent = 'Пишет ответ…'; break;
    case 'search_queries':
    case 'search_results': {
      // DeepSeek streams queries and results in pieces; keep one card per search step.
      let search = run.message.parts.at(-1);
      if (search?.type !== 'search') { search = { type: 'search', queries: [], results: [] }; run.message.parts.push(search); }
      const queryText = query => typeof query === 'string' ? query : query?.query || query?.text || '';
      for (const query of event.queries || []) if (queryText(query) && !search.queries.some(known => queryText(known) === queryText(query))) search.queries.push(queryText(query));
      for (const result of event.results || []) if (result?.url && !search.results.some(known => known.url === result.url)) search.results.push(result);
      $('#run-status-text').textContent = 'Ищет в интернете…';
      break;
    }
    case 'context': run.message.parts.push({ type: 'context', length: event.length, content }); break;
    case 'notice': run.message.parts.push({ type: 'notice', content }); break;
    case 'session': {
      const chat = conversations.find(entry => entry.id === run.chatId);
      if (chat && remoteLink(event.url)) { chat.remoteUrl = event.url; updateChatInfo(); }
      break;
    }
    case 'usage': {
      const chat = conversations.find(entry => entry.id === run.chatId);
      if (chat && Number.isInteger(event.tokens)) { chat.tokens = event.tokens; updateChatInfo(); }
      break;
    }
    case 'terminal_request': {
      // The card shows the command, so drop the block it came from: the reply ends with it, and its
      // command can itself contain the tag text or end with DeepSeek's tool-call tags.
      const reply = run.message.parts.findLast(part => part.type === 'response');
      if (reply && reply.content.includes('<terminal>')) reply.content = reply.content.slice(0, reply.content.indexOf('<terminal>'));
      for (const part of run.message.parts) {
        if (part.type === 'response') part.content = part.content.replace(/<terminal>[\s\S]*?<\/terminal>/g, '').replace(DSML_TAG, '').trim();
      }
      if (event.fenced && reply) reply.content = reply.content.replace(/(^|\n)[ \t]*```[^\n]*\n(?:(?!```)[\s\S])*```\s*$/, '').trim();
      run.message.parts = run.message.parts.filter(part => part.type !== 'response' || part.content);
      const terminal = { type: 'terminal', id: event.id, command: event.command, cwd: event.cwd, state: 'pending', output: '', fenced: event.fenced === true,
        checkpoint: Number.isInteger(event.checkpoint) && event.checkpoint > 0 ? event.checkpoint : 0 };
      run.message.parts.push(terminal);
      $('#run-status-text').textContent = 'Команда ждёт вашего разрешения';
      autoApprove(terminal);
      break;
    }
    case 'terminal_output': {
      const part = run.message.parts.find(item => item.type === 'terminal' && item.id === event.id);
      if (part) { part.state = 'running'; part.output = (part.output + content).slice(-150000); }
      $('#run-status-text').textContent = 'Выполняет команду…';
      break;
    }
    case 'terminal_done': {
      const part = run.message.parts.find(item => item.type === 'terminal' && item.id === event.id);
      if (part) {
        if (part.state !== 'denied') part.state = event.approved === false ? 'denied' : 'done';
        if (content) part.output = content.slice(-150000);
        if (typeof event.elapsed === 'number' && event.elapsed >= 0) part.elapsed = event.elapsed;
      }
      break;
    }
    case 'error': run.message.error = content || 'Не удалось получить ответ.'; break;
    case 'done': run.receivedDone = true; break;
  }
  scheduleRender();
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.content || `Ошибка сервера (${response.status})`);
  return data;
}
function requestHistory(chat) {
  const history = [];
  let remaining = 60000;
  for (const message of chat.messages.slice(0, -2).slice(-30).reverse()) {
    const content = (message.role === 'user' ? message.content : (message.parts || [])
      .filter(part => part.type === 'response' || part.type === 'terminal')
      .map(part => part.type === 'terminal' ? `[Историческая команда — не выполнять повторно]\n${part.command}\n${part.output || ''}` : part.content).join('\n\n')).slice(0, Math.min(20000, remaining));
    if (!content) continue;
    history.unshift({ role: message.role, content });
    remaining -= content.length;
    if (!remaining) break;
  }
  return history;
}
async function sendMessage() {
  if (run) { await stopRun(); return; }
  const content = $('#prompt').value.trim();
  if (!content) return;
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: content.replace(/\s+/g, ' ').slice(0, 45), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    conversations.push(chat); activeId = chat.id;
  }
  const userMessage = { id: uid(), role: 'user', content, createdAt: Date.now() };
  const assistantMessage = { id: uid(), role: 'assistant', parts: [], createdAt: Date.now() };
  chat.messages.push(userMessage, assistantMessage); chat.updatedAt = Date.now();
  run = { chatId: chat.id, message: assistantMessage, start: Date.now(), controller: new AbortController(), receivedDone: false };
  const thisRun = run;
  $('#prompt').value = ''; resizeInput(); stickToBottom = true;
  renderHistory(); renderConversation(); setBusy(true); persist();
  $('#run-status-text').textContent = 'Подключаюсь к DeepSeek…';
  $('#run-timer').textContent = '0 с';
  const timer = setInterval(() => { $('#run-timer').textContent = `${Math.floor((Date.now() - thisRun.start) / 1000)} с`; }, 1000);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: thisRun.controller.signal,
      body: JSON.stringify({ conversation_id: chat.id, message: content, history: requestHistory(chat), search: Boolean(preferences.search), thinking: preferences.deepThink !== false, ...(preferences.systemPrompt != null ? { system_prompt: preferences.systemPrompt } : {}) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || error.content || `Ошибка сервера (${response.status})`);
    }
    if (!response.body) throw new Error('Браузер не поддерживает потоковый ответ.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    function consumeLines(flush = false) {
      const lines = buffer.split('\n'); buffer = flush ? '' : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('Сервер вернул некорректное потоковое событие.'); }
        handleEvent(event);
      }
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) { buffer += decoder.decode(); consumeLines(true); break; }
      buffer += decoder.decode(value, { stream: true }); consumeLines();
    }
    if (!thisRun.receivedDone && !assistantMessage.error && !assistantMessage.stopped) throw new Error('Соединение прервалось до завершения ответа.');
  } catch (error) {
    if (error.name === 'AbortError') assistantMessage.stopped = true;
    else assistantMessage.error = error.message || 'Не удалось связаться с локальным сервером.';
  } finally {
    clearInterval(timer);
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = null; }
    assistantMessage.duration = Math.max(1, Math.round((Date.now() - thisRun.start) / 1000));
    for (const part of assistantMessage.parts) if (part.type === 'terminal' && ['pending', 'running'].includes(part.state)) part.state = 'interrupted';
    run = null; setBusy(false); persist(); renderConversation(true); renderHistory();
    refreshStatus();
  }
}
async function stopRun() {
  if (!run || run.stopping) return;
  const current = run;
  current.stopping = true;
  current.message.stopped = true;
  $('#run-status-text').textContent = 'Останавливаю…';
  try { await api('/api/stop', { conversation_id: current.chatId }); }
  catch { toast('Связь с сервером потеряна. Проверьте фоновые процессы.'); }
  finally { current.controller.abort(); }
}
function resizeInput() {
  const input = $('#prompt'); input.style.height = 'auto'; input.style.height = `${Math.min(220, Math.max(26, input.scrollHeight))}px`;
  if (!run) $('#send-button').disabled = !input.value.trim();
}
async function refreshStatus() {
  try {
    serverStatus = await api('/api/status');
    const connection = $('#connection');
    const authenticating = serverStatus.authenticating;
    $('#connection-text').textContent = authenticating ? 'Вход…' : serverStatus.busy && !run ? 'Сервер занят' : serverStatus.configured ? 'Локально · готов' : 'Нужен вход';
    connection.className = `connection${serverStatus.configured && !authenticating ? '' : ' warning'}`;
    connection.title = `${$('#connection-text').textContent} — открыть настройки`;
    $('.auth-status').className = `auth-status${serverStatus.configured && !authenticating && !serverStatus.auth_error ? '' : ' warning'}`;
    $('#auth-description').textContent = authenticating ? 'Ожидаем вход в открытом браузере…' : serverStatus.auth_error || (serverStatus.configured ? 'Сессия сохранена. Проверяется при отправке.' : 'Авторизация ещё не настроена.');
    $('#auth-button').disabled = Boolean(authenticating);
    $('#auth-button span').textContent = authenticating ? 'Ожидаем авторизацию…' : 'Обновить авторизацию';
    if (serverStatus.cwd) {
      const folder = serverStatus.cwd.split(/[\\/]/).filter(Boolean).at(-1) || serverStatus.cwd;
      $('#workspace-name').textContent = folder;
      $('#workspace-path-label').textContent = ltr(serverStatus.cwd);
      $('#workspace-button').title = `${serverStatus.cwd} — сменить рабочую папку`;
      $('#welcome-path').textContent = serverStatus.cwd;
    }
    if (serverStatus.system_prompt) defaultPrompt = serverStatus.system_prompt;
    const picking = Boolean(serverStatus.selecting_workspace);
    $('#pick-workspace').disabled = picking;
    $('#apply-workspace').disabled = picking;
    $('#pick-workspace').innerHTML = `${icon('folder')}${picking ? 'Выбор папки…' : 'Обзор…'}`;
    if (workspaceWasPicking && !picking) {
      $('#workspace-path').value = serverStatus.cwd || '';
      $('#workspace-error').textContent = serverStatus.workspace_error || '';
      $('#workspace-error').hidden = !serverStatus.workspace_error;
      if (!serverStatus.workspace_error) $('#workspace-dialog').close();
    }
    workspaceWasPicking = picking;
    if (picking) { clearTimeout(workspaceTimer); workspaceTimer = setTimeout(refreshStatus, 1000); }
    if (authenticating) { clearTimeout(authTimer); authTimer = setTimeout(refreshStatus, 2000); }
    else if (authTimer) { clearTimeout(authTimer); authTimer = null; }
  } catch {
    $('#connection-text').textContent = 'Сервер недоступен'; $('#connection').className = 'connection offline';
    $('.auth-status').className = 'auth-status offline';
    $('#auth-description').textContent = 'Локальный сервер недоступен. Запустите python web_server.py.';
  }
}

$('#composer').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
$('#prompt').addEventListener('input', resizeInput);
window.addEventListener('resize', resizeInput);
$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!run) sendMessage(); }
});
$('#workspace-button').onclick = () => {
  if (run) { toast('Сначала остановите текущий ответ.'); return; }
  $('#workspace-path').value = serverStatus.cwd || '';
  $('#workspace-error').hidden = true;
  $('#workspace-dialog').showModal();
};
$('#close-workspace').onclick = () => $('#workspace-dialog').close();
$('#workspace-form').onsubmit = async event => {
  event.preventDefault();
  $('#apply-workspace').disabled = true;
  try {
    await api('/api/workspace', { path: $('#workspace-path').value.trim() });
    await refreshStatus();
    $('#workspace-dialog').close();
  } catch (error) {
    $('#workspace-error').textContent = error.message;
    $('#workspace-error').hidden = false;
  } finally { $('#apply-workspace').disabled = false; }
};
$('#pick-workspace').onclick = async () => {
  $('#pick-workspace').disabled = true;
  $('#workspace-error').hidden = true;
  try {
    await api('/api/workspace/pick', {});
    workspaceWasPicking = true;
    await refreshStatus();
  } catch (error) {
    $('#workspace-error').textContent = error.message;
    $('#workspace-error').hidden = false;
    $('#pick-workspace').disabled = false;
  }
};
$('#new-chat').onclick = newChat;
$('#theme-button').onclick = () => { preferences.theme = preferences.theme === 'dark' ? 'light' : 'dark'; applyTheme(); savePreferences(); };
$('#deepthink-button').onclick = () => { preferences.deepThink = preferences.deepThink === false; updateOptions(); savePreferences(); };
$('#search-button').onclick = () => { preferences.search = !preferences.search; updateOptions(); savePreferences(); };
$('#menu-button').onclick = () => { $('#sidebar').classList.add('open'); $('#sidebar-scrim').classList.add('open'); };
$('#sidebar-scrim').onclick = closeSidebar;
$('#jump-bottom').onclick = () => { stickToBottom = true; scrollBottom(true); };
$('#conversation-scroll').addEventListener('scroll', () => {
  const scroll = $('#conversation-scroll'); stickToBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
});
for (const suggestion of document.querySelectorAll('[data-prompt]')) suggestion.onclick = () => {
  $('#prompt').value = suggestion.dataset.prompt; resizeInput(); $('#prompt').focus();
};
$('#settings-button').onclick = () => {
  $('#system-prompt').value = preferences.systemPrompt ?? defaultPrompt;
  updateOptions(); $('#settings-dialog').showModal(); refreshStatus();
};
$('#close-settings').onclick = () => $('#settings-dialog').close();
$('#settings-dialog').addEventListener('click', event => {
  if (event.target !== $('#settings-dialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
$('#save-settings').onclick = () => {
  const prompt = $('#system-prompt').value.trim();
  preferences.systemPrompt = prompt && prompt !== defaultPrompt ? prompt : null;
  savePreferences(); $('#settings-dialog').close(); toast('Настройки сохранены');
};
$('#reset-prompt').onclick = () => { $('#system-prompt').value = defaultPrompt; };
$('#thinking-switch').onclick = () => { preferences.thinkingOpen = !preferences.thinkingOpen; updateOptions(); savePreferences(); };
$('#auto-approve-switch').onclick = () => setAutoApprove(!preferences.autoApprove);
for (const option of document.querySelectorAll('#output-mode [data-mode]')) option.onclick = () => {
  preferences.outputMode = option.dataset.mode; updateOptions(); savePreferences(); renderConversation(true);
};
$('#connection').onclick = () => $('#settings-button').click();
$('#auth-button').onclick = async () => {
  if (run) { toast('Остановите ответ перед обновлением авторизации.'); return; }
  $('#auth-button').disabled = true;
  try { await api('/api/auth', {}); toast('Войдите в DeepSeek в открывшемся Chrome и отправьте одно сообщение.'); await refreshStatus(); }
  catch (error) { toast(error.message); $('#auth-button').disabled = false; }
};
$('#export-button').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'Orbit', version: 1, exportedAt: new Date().toISOString(), conversations }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `orbit-dialogues-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('#clear-history').onclick = () => {
  if (run) { toast('Сначала остановите текущий ответ.'); return; }
  if (!conversations.length) { toast('История уже пуста'); return; }
  if (!confirm('Удалить все диалоги из этого браузера? Это действие нельзя отменить.')) return;
  conversations = []; activeId = null; persist(); renderHistory(); renderConversation(); toast('История очищена');
};
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!$('#settings-dialog').open) newChat(); }
  if (event.key === 'Escape') closeSidebar();
});
window.addEventListener('beforeunload', event => {
  if (!run) return;
  navigator.sendBeacon('/api/stop', new Blob([JSON.stringify({ conversation_id: run.chatId })], { type: 'application/json' }));
  event.preventDefault(); event.returnValue = '';
});

for (const chat of conversations) for (const message of chat.messages) for (const part of message.parts || []) {
  if (part.type === 'terminal' && ['pending', 'running'].includes(part.state)) part.state = 'interrupted';
}
applyTheme(); updateOptions(); renderHistory(); renderConversation(); resizeInput(); refreshStatus();
