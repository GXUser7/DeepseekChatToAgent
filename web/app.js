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
let preferences = { theme: systemTheme, expert: false, search: false, thinkingOpen: false, systemPrompt: null, ...load(PREFS, {}) };
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
  $('#expert-button').setAttribute('aria-pressed', String(Boolean(preferences.expert)));
  $('#search-button').setAttribute('aria-pressed', String(Boolean(preferences.search)));
  $('#thinking-switch').setAttribute('aria-checked', String(Boolean(preferences.thinkingOpen)));
  $('#new-session-switch').setAttribute('aria-checked', String(preferences.newSession !== false));
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
// Until the server turns a <terminal> block into an approval card, show it as code instead of letting the sanitizer drop the tag.
function showTerminalBlocks(value) {
  return value.replace(/<terminal>([\s\S]*?)(?:<\/terminal>|$)/g, (_, command) => `\n\n\`\`\`\n${command.trim()}\n\`\`\`\n\n`);
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
  for (const part of message.parts || []) element.append(renderPart(part, message));
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
    const label = part.step ? 'Отправлено DeepSeek после команды' : 'Контекст запроса';
    summary.innerHTML = `${icon('code')}<span class="context-label">${label}</span><span class="context-size">${formatNumber(part.length || part.content.length)} симв.</span>${icon('chevron', 'icon thinking-chevron')}`;
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
  return code === 0 ? ['Код 0', 'ok'] : [`Код ${code}`, 'err'];
}
function renderTerminal(part) {
  const awaiting = part.state === 'pending' && run;
  const card = document.createElement('section'); card.className = `terminal-card${awaiting ? ' pending' : ''}`;
  const windows = /^[a-z]:\\/i.test(part.cwd || '') || String(serverStatus.platform || '').startsWith('win');
  const exit = EXIT_CODE.exec(part.output || '');
  const [stateText, stateClass] = terminalState(part, part.state === 'done' && exit ? Number(exit[1]) : null);
  const header = document.createElement('div'); header.className = 'terminal-header';
  header.innerHTML = `${icon('terminal')}<span class="terminal-shell">${windows ? 'PowerShell' : 'sh'}</span>`;
  const cwd = document.createElement('span'); cwd.className = 'terminal-cwd'; cwd.textContent = ltr(part.cwd || ''); cwd.title = part.cwd || '';
  const label = document.createElement('span'); label.className = `terminal-state ${stateClass}`;
  if (part.state === 'running' && run) label.innerHTML = '<span class="activity-indicator"></span>';
  label.append(stateText);
  header.append(cwd, label);
  const command = document.createElement('pre'); command.className = 'terminal-command';
  const prompt = document.createElement('span'); prompt.className = 'terminal-prompt'; prompt.textContent = windows ? 'PS> ' : '$ ';
  command.append(prompt, part.command);
  card.append(header, command);
  if (awaiting) {
    const approval = document.createElement('div'); approval.className = 'terminal-approval';
    const explanation = document.createElement('p'); explanation.textContent = 'Выполнить эту команду?';
    const buttons = document.createElement('div'); buttons.className = 'terminal-buttons';
    const allow = document.createElement('button'); allow.className = 'primary-button'; allow.innerHTML = `${icon('check')}Выполнить`;
    const deny = document.createElement('button'); deny.className = 'tonal-button'; deny.textContent = 'Отклонить';
    const decide = async approved => {
      part.state = approved ? 'running' : 'denied';
      updateLiveMessage();
      try {
        await api('/api/approve', { id: part.id, approved });
        persist();
      } catch (error) {
        if (run && part.state !== 'done') part.state = 'pending';
        updateLiveMessage();
        toast(error.message);
      }
    };
    allow.onclick = () => decide(true); deny.onclick = () => decide(false);
    buttons.append(allow, deny); approval.append(explanation, buttons); card.append(approval);
  }
  const outputText = exit ? part.output.slice(exit[0].length) : part.output;
  if (outputText) { const output = document.createElement('pre'); output.className = 'terminal-output'; output.textContent = outputText; card.append(output); }
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
  $('#expert-button').disabled = busy;
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
    case 'context': run.message.parts.push({ type: 'context', step: event.step, length: event.length, content }); break;
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
      for (const part of run.message.parts) {
        if (part.type === 'response') part.content = part.content.replace(/<terminal>[\s\S]*?<\/terminal>/g, '').trim();
      }
      run.message.parts = run.message.parts.filter(part => part.type !== 'response' || part.content);
      run.message.parts.push({ type: 'terminal', id: event.id, command: event.command, cwd: event.cwd, state: 'pending', output: '' });
      $('#run-status-text').textContent = 'Команда ждёт вашего разрешения';
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
      body: JSON.stringify({ conversation_id: chat.id, message: content, history: requestHistory(chat), search: Boolean(preferences.search), expert: Boolean(preferences.expert), new_session: preferences.newSession !== false, ...(preferences.systemPrompt != null ? { system_prompt: preferences.systemPrompt } : {}) }),
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
$('#expert-button').onclick = () => { preferences.expert = !preferences.expert; updateOptions(); savePreferences(); };
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
$('#new-session-switch').onclick = () => { preferences.newSession = preferences.newSession === false; updateOptions(); savePreferences(); };
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
