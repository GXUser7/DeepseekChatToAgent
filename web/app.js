'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const STORE = 'orbit.workspace.v1';
const PREFS = 'orbit.preferences.v1';
const FOLDERS = 'orbit.folders.v1';
const OUTPUT_MODES = ['compact', 'tail', 'full'];
const OUTPUT_PREVIEW_LINES = 5;
const MAX_ATTACHMENT = 200 * 1024;
const MAX_MESSAGE = 60000;
const icon = (name, className = 'icon') => `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
const formatNumber = value => Number(value).toLocaleString('ru-RU');
const timeLabel = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function plural(count, one, few, many) {
  const tens = Math.abs(count) % 100, units = Math.abs(count) % 10;
  if (tens > 10 && tens < 20) return many;
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many;
}
function shortDate(value) {
  const date = new Date(value), now = new Date();
  if (date.toDateString() === now.toDateString()) return timeLabel(value);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'вчера';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }

const validChat = chat => chat && typeof chat.id === 'string' && Array.isArray(chat.messages);
let conversations = (Array.isArray(load(STORE, [])) ? load(STORE, []) : []).filter(validChat);
let preferences = { theme: 'system', deepThink: true, search: false, autoApprove: false, outputMode: 'compact', thinkingOpen: false, systemPrompt: null, ...load(PREFS, {}) };
if (!OUTPUT_MODES.includes(preferences.outputMode)) preferences.outputMode = preferences.fullOutput ? 'full' : 'compact';
delete preferences.fullOutput;
let view = 'chat';
let activeId = null;
let run = null;
let serverStatus = {};
let serverOnline = true;
let defaultPrompt = '';
let stickToBottom = true;
let renderFrame = null;
let attachments = [];
let historyFilter = 'all';
let toastTimer, authTimer, workspaceTimer, promptTimer;
let workspaceWasPicking = false;
const sentText = new Map();
const systemDark = matchMedia('(prefers-color-scheme: dark)');

/* ---------------------------------------------------------------- basics */

function toast(message, { error = false } = {}) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 6000 : 3200);
}
function persist() {
  if (!save(STORE, conversations)) toast('Браузер не дал сохранить историю: память заполнена. Экспортируйте и удалите старые диалоги.', { error: true });
}
function savePreferences() { if (!save(PREFS, preferences)) toast('Браузер не дал сохранить настройки.', { error: true }); }
const currentChat = () => conversations.find(chat => chat.id === activeId);
const chatById = id => conversations.find(chat => chat.id === id);

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.content || `Ошибка сервера (${response.status})`);
    error.output = data.output || '';
    error.status = response.status;
    throw error;
  }
  return data;
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
for (const dialog of $$('dialog')) {
  closeOnBackdrop(dialog);
  for (const button of $$('[data-close]', dialog)) button.addEventListener('click', () => dialog.close());
}
function confirmDialog({ title, text = '', ok = 'Да', danger = false }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').innerHTML = text;
  $('#confirm-text').hidden = !text;
  const button = $('#confirm-ok');
  button.textContent = ok;
  button.className = `button ${danger ? 'danger' : 'primary'}`;
  return new Promise(resolve => {
    let result = false;
    button.onclick = () => { result = true; dialog.close(); };
    dialog.addEventListener('close', () => resolve(result), { once: true });
    dialog.showModal();
    button.focus();
  });
}
function promptDialog({ title, value = '' }) {
  const dialog = $('#prompt-dialog');
  $('#prompt-dialog-title').textContent = title;
  const input = $('#prompt-dialog-input');
  input.value = value;
  return new Promise(resolve => {
    let result = null;
    $('#prompt-dialog-form').onsubmit = event => { event.preventDefault(); result = input.value.trim() || null; dialog.close(); };
    dialog.addEventListener('close', () => resolve(result), { once: true });
    dialog.showModal();
    input.select();
  });
}

/* ---------------------------------------------------------------- theme */

function applyTheme() {
  const dark = preferences.theme === 'dark' || (preferences.theme !== 'light' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-button').innerHTML = icon(dark ? 'sun' : 'moon');
  $('meta[name="theme-color"]').content = dark ? '#161719' : '#f7f6f2';
  for (const button of $$('[data-theme-choice]')) button.setAttribute('aria-checked', String(button.dataset.themeChoice === (preferences.theme || 'system')));
}
systemDark.addEventListener('change', applyTheme);

/* ---------------------------------------------------------------- routing */

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('c/')) return { view: 'chat', id: decodeURIComponent(hash.slice(2)) };
  if (['history', 'settings', 'git'].includes(hash)) return { view: hash };
  return { view: 'chat', id: null };
}
function go(hash) {
  if (location.hash === hash || (hash === '#/' && !location.hash)) applyRoute();
  else location.hash = hash;
}
function applyRoute() {
  const route = parseRoute();
  const previous = view;
  view = route.view;
  if (view === 'chat') {
    const exists = route.id && chatById(route.id);
    if (route.id && !exists) history.replaceState(null, '', '#/');
    if (activeId !== (exists ? route.id : null)) stickToBottom = true;
    activeId = exists ? route.id : null;
  }
  for (const name of ['chat', 'history', 'settings', 'git']) $(`#view-${name}`).hidden = name !== view;
  for (const link of $$('.nav-link')) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (view === 'chat') { renderConversation(); if (matchMedia('(min-width: 761px)').matches) $('#prompt').focus(); }
  if (view === 'history') renderHistoryPage();
  if (view === 'settings') renderSettings();
  if (view === 'git') window.OrbitGit?.show();
  else if (previous === 'git') window.OrbitGit?.hide();
  renderRecent();
  updateTopbar();
  closeSidebar();
}
window.addEventListener('hashchange', applyRoute);

function updateTopbar() {
  const chat = view === 'chat' ? currentChat() : null;
  const titles = { history: 'Диалоги', settings: 'Настройки', git: 'Git' };
  const title = view === 'chat' ? (chat?.title || 'Новый диалог') : titles[view];
  $('#topbar-title').textContent = title;
  $('#topbar-title').title = view === 'chat' && chat ? 'Двойной щелчок — переименовать' : '';
  document.title = view === 'chat' && !chat ? 'Orbit' : `${title} — Orbit`;
  const link = $('#remote-link');
  link.hidden = !remoteLink(chat?.remoteUrl);
  if (!link.hidden) link.href = chat.remoteUrl;
  const usage = $('#context-usage');
  usage.hidden = !Number.isInteger(chat?.tokens);
  if (!usage.hidden) usage.textContent = `${formatNumber(chat.tokens)} ток.`;
}

/* ---------------------------------------------------------------- sidebar */

function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); $('#menu-button').setAttribute('aria-expanded', 'true'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); $('#menu-button').setAttribute('aria-expanded', 'false'); }
const sortedChats = () => [...conversations].sort((a, b) => (Boolean(b.pinned) - Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
function renderRecent() {
  const list = $('#recent');
  list.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement('p'); empty.className = 'recent-empty'; empty.textContent = 'Диалогов пока нет'; list.append(empty);
    return;
  }
  for (const chat of sortedChats().slice(0, 60)) {
    const link = document.createElement('a');
    link.className = 'recent-link';
    link.href = `#/c/${encodeURIComponent(chat.id)}`;
    link.title = chat.title;
    if (chat.pinned) link.insertAdjacentHTML('beforeend', icon('pin'));
    const title = document.createElement('span'); title.textContent = chat.title; link.append(title);
    if (run?.chatId === chat.id) {
      const waiting = run.message.parts.some(part => part.type === 'terminal' && part.state === 'pending');
      const dot = document.createElement('i'); dot.className = `live-dot${waiting ? ' waiting' : ''}`;
      dot.title = waiting ? 'Команда ждёт разрешения' : 'Отвечает';
      link.append(dot);
    }
    if (view === 'chat' && chat.id === activeId) link.setAttribute('aria-current', 'page');
    list.append(link);
  }
}

/* ---------------------------------------------------------------- markdown */

const DSML_TAG = /<\/?[｜|]{1,2}\s*DSML\s*[｜|]{1,2}[^>]*>/g;
// Until the server turns a <terminal> block into an approval card, show it as code instead of letting the sanitizer drop the tag.
function showTerminalBlocks(value) {
  return value.replace(DSML_TAG, '').replace(/<terminal>([\s\S]*?)(?:<\/terminal>|$)/g, (_, command) => `\n\n\`\`\`\n${command.trim()}\n\`\`\`\n\n`);
}
function markdown(value) {
  value = showTerminalBlocks(value);
  if (!window.marked || !window.DOMPurify) return escapeHtml(value).replace(/\n/g, '<br>');
  return DOMPurify.sanitize(marked.parse(value, { breaks: true }), {
    FORBID_TAGS: ['img', 'style', 'input', 'button', 'form', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });
}
function safeLink(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
const remoteLink = value => typeof value === 'string' && /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[\w-]+$/.test(value);
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

/* ---------------------------------------------------------------- messages */

const shownMessages = new Set();
function renderConversation(keepScroll = false) {
  const scroll = $('#chat-scroll');
  const previousScroll = scroll.scrollTop;
  const chat = currentChat();
  const empty = !chat?.messages.length;
  $('#view-chat').classList.toggle('is-empty', empty);
  $('#messages').replaceChildren(...(chat?.messages || []).map(renderMessage));
  updateComposer();
  if (keepScroll && !stickToBottom) scroll.scrollTop = previousScroll;
  else scrollBottom(true);
}
function fileChip(file, onRemove) {
  const chip = document.createElement('span'); chip.className = 'attachment';
  chip.innerHTML = icon('file');
  const name = document.createElement('span'); name.textContent = file.name; chip.append(name);
  const size = document.createElement('small'); size.textContent = file.size < 1024 ? `${file.size} Б` : `${Math.round(file.size / 1024)} КБ`; chip.append(size);
  if (onRemove) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.innerHTML = icon('close'); remove.setAttribute('aria-label', `Убрать ${file.name}`);
    remove.onclick = onRemove; chip.append(remove);
  }
  return chip;
}
function renderMessage(message) {
  const element = document.createElement('article');
  element.className = `message message-${message.role === 'user' ? 'user' : 'assistant'}${shownMessages.has(message.id) ? '' : ' appear'}`;
  shownMessages.add(message.id);
  element.dataset.messageId = message.id;
  if (message.role === 'user') {
    const bubble = document.createElement('div'); bubble.className = 'user-bubble'; bubble.textContent = message.content;
    element.append(bubble);
    if (message.files?.length) {
      const files = document.createElement('div'); files.className = 'user-files';
      files.append(...message.files.map(file => fileChip(file)));
      element.append(files);
    }
    return element;
  }
  const live = run?.message.id === message.id;
  for (const part of message.parts || []) {
    if (part.type === 'context') continue;
    element.append(renderPart(part, message));
  }
  if (message.stopped) element.append(noticeElement('Остановлено.'));
  if (message.error) {
    const error = document.createElement('div'); error.className = 'message-error';
    const text = document.createElement('span'); text.textContent = message.error; error.append(text);
    const chat = conversations.find(entry => entry.messages.includes(message));
    if (!run && chat && chat.messages.at(-1) === message) {
      const retry = document.createElement('button'); retry.className = 'button small'; retry.type = 'button'; retry.textContent = 'Повторить';
      retry.onclick = () => retryLast(chat);
      error.append(retry);
    }
    if (/авториз/i.test(message.error)) {
      const login = document.createElement('a'); login.className = 'button small'; login.href = '#/settings'; login.textContent = 'Настройки входа';
      error.append(login);
    }
    element.append(error);
  }
  if (live) {
    const last = message.parts.at(-1);
    if (!last || last.type === 'response') { const cursor = document.createElement('span'); cursor.className = 'cursor'; element.append(cursor); }
    return element;
  }
  const foot = document.createElement('div'); foot.className = 'message-foot';
  const responseText = (message.parts || []).filter(part => part.type === 'response').map(part => part.content).join('\n\n');
  if (responseText) {
    const copy = document.createElement('button'); copy.className = 'icon-button'; copy.type = 'button'; copy.innerHTML = icon('copy'); copy.title = 'Скопировать ответ'; copy.setAttribute('aria-label', 'Скопировать ответ');
    copy.onclick = async () => { try { await navigator.clipboard.writeText(responseText); toast('Скопировано'); } catch { toast('Браузер не дал доступ к буферу обмена.', { error: true }); } };
    foot.append(copy);
  }
  const context = (message.parts || []).find(part => part.type === 'context');
  if (context) {
    const show = document.createElement('button'); show.className = 'icon-button'; show.type = 'button'; show.innerHTML = icon('eye'); show.title = 'Что ушло в DeepSeek'; show.setAttribute('aria-label', 'Показать отправленный контекст');
    show.onclick = () => {
      $('#context-text').textContent = context.content + (context.length > context.content.length ? `\n\n… показано ${formatNumber(context.content.length)} из ${formatNumber(context.length)} символов` : '');
      $('#context-dialog').showModal();
    };
    foot.append(show);
  }
  const meta = document.createElement('span'); meta.className = 'meta';
  meta.textContent = [message.duration ? `${message.duration} с` : '', message.createdAt ? timeLabel(message.createdAt) : ''].filter(Boolean).join(' · ');
  foot.append(meta);
  element.append(foot);
  return element;
}
function noticeElement(text) {
  const notice = document.createElement('p'); notice.className = 'notice'; notice.innerHTML = icon('info');
  const span = document.createElement('span'); span.textContent = text; notice.append(span);
  return notice;
}
function foldElement(part, summaryHtml, live) {
  const details = document.createElement('details');
  details.className = `fold${live ? ' live' : ''}`;
  details.open = part.open ?? (part.type === 'think' ? preferences.thinkingOpen : false);
  const summary = document.createElement('summary'); summary.innerHTML = `${summaryHtml}${icon('chevron', 'icon chevron')}`;
  details.append(summary);
  details.addEventListener('toggle', () => { part.open = details.open; });
  return details;
}
function renderPart(part, message) {
  const live = run?.message.id === message.id && part === message.parts.at(-1);
  if (part.type === 'think') {
    const seconds = part.started && part.updated ? Math.round((part.updated - part.started) / 1000) : 0;
    const label = live ? '<span class="spinner"></span>Думает…' : `${icon('brain')}Размышления${seconds ? ` · ${seconds} с` : ''}`;
    const details = foldElement(part, label, live);
    const body = document.createElement('div'); body.className = 'fold-body'; body.textContent = part.content;
    details.append(body);
    return details;
  }
  if (part.type === 'search') {
    const found = (part.results || []).length;
    const label = live && !found ? '<span class="spinner"></span>Ищет в интернете…' : `${icon('globe')}${found ? `${found} ${plural(found, 'источник', 'источника', 'источников')}` : 'Поиск'}`;
    const details = foldElement(part, label, live);
    const body = document.createElement('div'); body.className = 'fold-body sources';
    for (const query of part.queries || []) { const line = document.createElement('div'); line.className = 'query'; line.textContent = `«${query}»`; body.append(line); }
    (part.results || []).slice(0, 20).forEach((result, index) => {
      const href = safeLink(result.url);
      if (!href) return;
      const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = href;
      const number = document.createElement('span'); number.textContent = result.cite_index || index + 1;
      const title = document.createElement('span'); title.textContent = result.title || result.site_name || new URL(href).hostname;
      link.append(number, title); body.append(link);
    });
    details.append(body);
    return details;
  }
  if (part.type === 'terminal') return renderTerminal(part);
  if (part.type === 'notice') return noticeElement(part.content);
  const body = document.createElement('div'); body.className = 'message-body';
  body.innerHTML = markdown(linkCitations(part.content || '', message));
  for (const link of $$('a', body)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return body;
}

/* ---------------------------------------------------------------- terminal cards */

// LRM marks keep a path readable when CSS truncates it from the left with direction: rtl.
const ltr = value => `‎${value}‎`;
const EXIT_CODE = /^\[Код завершения: (-?\d+)\]\n?/;
function formatElapsed(seconds) {
  if (seconds < 0.1) return '< 0,1 с';
  if (seconds < 60) return `${seconds.toLocaleString('ru-RU', { maximumFractionDigits: seconds < 10 ? 1 : 0 })} с`;
  return `${Math.floor(seconds / 60)} мин ${Math.round(seconds % 60)} с`;
}
function terminalState(part, code) {
  if (part.state === 'pending') return ['ждёт разрешения', 'wait'];
  if (part.state === 'running') return ['выполняется', ''];
  if (part.state === 'denied') return ['отклонено', ''];
  if (part.state === 'interrupted') return ['прервано', ''];
  if (code === null) return ['готово', ''];
  return code === 0 ? ['код 0', 'ok'] : [`код ${code}`, 'err'];
}
function terminalBadges(part, [text, className]) {
  const badges = [];
  if (part.auto) { const auto = document.createElement('span'); auto.textContent = 'авто'; auto.title = 'Выполнено без подтверждения'; badges.push(auto); }
  if (Number.isFinite(part.elapsed)) { const time = document.createElement('span'); time.className = 'terminal-time'; time.textContent = formatElapsed(part.elapsed); badges.push(time); }
  const state = document.createElement('span'); state.className = `terminal-state ${className}`;
  if (part.state === 'running' && run) state.innerHTML = '<span class="spinner"></span>';
  state.append(text);
  badges.push(state);
  return badges;
}
// The live message is re-rendered on every streamed chunk, which can replace a button between press and
// release so its click never fires. A mouse acts on the press; touch and keyboard keep the click.
function onPress(element, handler) {
  element.onpointerdown = event => { if (event.pointerType === 'mouse' && event.button === 0) handler(); };
  element.onclick = event => { if (event.pointerType !== 'mouse') handler(); };
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
    toast(error.message, { error: true });
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
function renderTerminal(part) {
  const awaiting = part.state === 'pending' && run;
  const mode = preferences.outputMode;
  const windows = /^[a-z]:\\/i.test(part.cwd || '') || String(serverStatus.platform || '').startsWith('win');
  const promptSign = windows ? 'PS>' : '$';
  const exit = EXIT_CODE.exec(part.output || '');
  const state = terminalState(part, part.state === 'done' && exit ? Number(exit[1]) : null);
  const outputText = exit ? part.output.slice(exit[0].length) : (part.output || '');
  const lines = outputText ? outputText.replace(/\n$/, '').split('\n') : [];
  const lineCount = `${formatNumber(lines.length)} ${plural(lines.length, 'строка', 'строки', 'строк')}`;
  const collapsible = Boolean(outputText) && (mode === 'compact' || (mode === 'tail' && lines.length > OUTPUT_PREVIEW_LINES));
  const card = document.createElement('section'); card.className = 'terminal';
  const toggleOutput = () => { part.expanded = !part.expanded; card.replaceWith(renderTerminal(part)); persist(); };
  if (mode === 'compact' && !awaiting && !part.expanded) {
    card.classList.add('compact');
    const row = document.createElement(outputText ? 'button' : 'div'); row.className = 'terminal-head';
    const line = document.createElement('code'); line.className = 'terminal-line';
    line.innerHTML = `<span class="prompt">${promptSign}</span> `; line.append(part.command);
    line.title = `${part.cwd || ''}\n${part.command}`;
    row.append(line, ...terminalBadges(part, state));
    if (outputText) {
      row.type = 'button';
      row.insertAdjacentHTML('beforeend', icon('chevron', 'icon chevron'));
      row.setAttribute('aria-expanded', 'false');
      row.title = `Показать вывод · ${lineCount}`;
      onPress(row, toggleOutput);
    }
    card.append(row);
    return card;
  }
  const collapsesFromHeader = collapsible && part.expanded;
  const head = document.createElement(collapsesFromHeader ? 'button' : 'div'); head.className = 'terminal-head';
  head.insertAdjacentHTML('beforeend', `<span>${windows ? 'PowerShell' : 'sh'}</span>`);
  const cwd = document.createElement('span'); cwd.className = 'terminal-cwd'; cwd.textContent = ltr(part.cwd || ''); cwd.title = part.cwd || '';
  head.append(cwd, ...terminalBadges(part, state));
  if (collapsesFromHeader) {
    head.type = 'button';
    head.insertAdjacentHTML('beforeend', icon('chevron', 'icon chevron'));
    head.setAttribute('aria-expanded', 'true');
    head.title = 'Свернуть вывод';
    onPress(head, toggleOutput);
  }
  const command = document.createElement('pre'); command.className = 'terminal-command';
  command.innerHTML = `<span class="prompt">${promptSign} </span>`; command.append(part.command);
  card.append(head, command);
  if (awaiting) {
    const ask = document.createElement('div'); ask.className = 'terminal-ask';
    const note = part.checkpoint ? `Уже ${formatNumber(part.checkpoint)} ${plural(part.checkpoint, 'команда', 'команды', 'команд')} подряд. Продолжить?`
      : part.fenced ? 'DeepSeek прислал команду обычным блоком кода, без тега terminal.' : '';
    if (note) { const text = document.createElement('p'); text.textContent = note; ask.append(text); }
    const allow = document.createElement('button'); allow.type = 'button'; allow.className = 'button small primary'; allow.innerHTML = `${icon('check')}Выполнить`;
    const always = document.createElement('button'); always.type = 'button'; always.className = 'button small'; always.textContent = 'Выполнять всегда';
    always.title = 'Выполнить эту и следующие команды без подтверждения';
    const deny = document.createElement('button'); deny.type = 'button'; deny.className = 'button small'; deny.textContent = 'Отклонить';
    allow.onclick = () => decideTerminal(part, true);
    deny.onclick = () => decideTerminal(part, false);
    always.onclick = () => { decideTerminal(part, true); setAutoApprove(true); };
    ask.append(allow, ...(preferences.autoApprove ? [] : [always]), deny);
    card.append(ask);
  }
  if (outputText) {
    const output = document.createElement('pre'); output.className = 'terminal-output';
    output.textContent = mode === 'tail' && collapsible && !part.expanded ? lines.slice(-OUTPUT_PREVIEW_LINES).join('\n') : outputText;
    card.append(output);
    if (collapsible && !part.expanded) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'terminal-more';
      more.textContent = `Показать весь вывод · ${lineCount}`;
      onPress(more, toggleOutput);
      card.append(more);
    }
  }
  return card;
}

/* ---------------------------------------------------------------- streaming */

function updateLiveMessage() {
  if (!run) return;
  renderRecent();
  if (view !== 'chat' || activeId !== run.chatId) return;
  const previous = $$('#messages > .message').find(element => element.dataset.messageId === run.message.id);
  const replacement = renderMessage(run.message);
  if (previous) previous.replaceWith(replacement); else $('#messages').append(replacement);
  scrollBottom();
}
function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => { renderFrame = null; updateLiveMessage(); });
}
function scrollBottom(force = false) {
  const scroll = $('#chat-scroll');
  if (force || stickToBottom) scroll.scrollTop = scroll.scrollHeight;
}
function setRunStatus(text) { if (run) { run.statusText = text; updateComposer(); } }
function addTextPart(type, content) {
  const last = run.message.parts.at(-1);
  if (last?.type === type) { last.content += content; last.updated = Date.now(); }
  else run.message.parts.push({ type, content, started: Date.now(), updated: Date.now() });
}
function handleEvent(event) {
  if (!run || !event || typeof event.type !== 'string') return;
  const content = typeof event.content === 'string' ? event.content : '';
  const chat = chatById(run.chatId);
  switch (event.type) {
    case 'status': setRunStatus(content.replace(/\.\.\.$/, '…')); break;
    case 'think': addTextPart('think', content); setRunStatus('Думает…'); break;
    case 'response': addTextPart('response', content); setRunStatus('Пишет ответ…'); break;
    case 'search_queries':
    case 'search_results': {
      // DeepSeek streams queries and results in pieces; keep one block per search step.
      let search = run.message.parts.at(-1);
      if (search?.type !== 'search') { search = { type: 'search', queries: [], results: [] }; run.message.parts.push(search); }
      const queryText = query => typeof query === 'string' ? query : query?.query || query?.text || '';
      for (const query of event.queries || []) if (queryText(query) && !search.queries.includes(queryText(query))) search.queries.push(queryText(query));
      for (const result of event.results || []) if (result?.url && !search.results.some(known => known.url === result.url)) search.results.push(result);
      setRunStatus('Ищет в интернете…');
      break;
    }
    case 'context': run.message.parts.push({ type: 'context', length: event.length, content }); break;
    case 'notice': run.message.parts.push({ type: 'notice', content }); break;
    case 'session': if (chat && remoteLink(event.url)) { chat.remoteUrl = event.url; updateTopbar(); } break;
    case 'usage': if (chat && Number.isInteger(event.tokens)) { chat.tokens = event.tokens; updateTopbar(); } break;
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
      setRunStatus('Команда ждёт разрешения');
      autoApprove(terminal);
      if (terminal.state === 'pending' && (view !== 'chat' || activeId !== run.chatId)) toast(`«${chat?.title || 'Диалог'}»: команда ждёт разрешения`);
      break;
    }
    case 'terminal_output': {
      const part = run.message.parts.find(item => item.type === 'terminal' && item.id === event.id);
      if (part) { part.state = 'running'; part.output = (part.output + content).slice(-150000); }
      setRunStatus('Выполняет команду…');
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
function requestHistory(chat) {
  const history = [];
  let remaining = 60000;
  for (const message of chat.messages.slice(0, -2).slice(-30).reverse()) {
    const text = message.role === 'user'
      ? message.content + (message.files?.length ? `\n[Прикреплённые файлы: ${message.files.map(file => file.name).join(', ')}]` : '')
      : (message.parts || []).filter(part => part.type === 'response' || part.type === 'terminal')
        .map(part => part.type === 'terminal' ? `[Историческая команда — не выполнять повторно]\n${part.command}\n${part.output || ''}` : part.content).join('\n\n');
    const content = text.slice(0, Math.min(20000, remaining));
    if (!content) continue;
    history.unshift({ role: message.role, content });
    remaining -= content.length;
    if (!remaining) break;
  }
  return history;
}
function composeText(text, files) {
  if (!files.length) return text;
  const blocks = files.map(file => `Файл ${file.name}:\n\`\`\`\n${file.text.replace(/```/g, '`​``')}\n\`\`\``);
  return `${text || 'Посмотри прикреплённые файлы.'}\n\n${blocks.join('\n\n')}`;
}
async function sendMessage(override) {
  if (run) { if (run.chatId === activeId && !override) await stopRun(); return; }
  const text = override ? override.text : $('#prompt').value.trim();
  const files = override ? override.files : attachments;
  if (!text && !files.length) return;
  const full = composeText(text, files);
  if (full.length > MAX_MESSAGE) { toast(`Сообщение слишком длинное: ${formatNumber(full.length)} из ${formatNumber(MAX_MESSAGE)} символов. Уберите часть файлов.`, { error: true }); return; }
  let chat = currentChat();
  if (!chat) {
    const title = (text || files[0].name).replace(/\s+/g, ' ').slice(0, 60);
    chat = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    conversations.push(chat);
    activeId = chat.id;
    history.pushState(null, '', `#/c/${encodeURIComponent(chat.id)}`);
  }
  const userMessage = { id: uid(), role: 'user', content: text, createdAt: Date.now(), ...(files.length ? { files: files.map(({ name, size }) => ({ name, size })) } : {}) };
  const assistantMessage = { id: uid(), role: 'assistant', parts: [], createdAt: Date.now() };
  sentText.set(userMessage.id, { text, files });
  chat.messages.push(userMessage, assistantMessage);
  chat.updatedAt = Date.now();
  run = { chatId: chat.id, message: assistantMessage, start: Date.now(), controller: new AbortController(), receivedDone: false, statusText: 'Подключение…' };
  const thisRun = run;
  if (!override) { $('#prompt').value = ''; attachments = []; renderAttachments(); resizeInput(); }
  stickToBottom = true;
  renderConversation(); renderRecent(); updateTopbar(); persist();
  const timer = setInterval(() => { if (run === thisRun) updateComposer(); }, 1000);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: thisRun.controller.signal,
      body: JSON.stringify({ conversation_id: chat.id, message: full, history: requestHistory(chat), search: Boolean(preferences.search), thinking: preferences.deepThink !== false, ...(preferences.systemPrompt != null ? { system_prompt: preferences.systemPrompt } : {}) }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || error.content || `Ошибка сервера (${response.status})`);
    }
    if (!response.body) throw new Error('Браузер не поддерживает потоковый ответ.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (flush = false) => {
      const lines = buffer.split('\n'); buffer = flush ? '' : lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error('Сервер прислал некорректное событие.'); }
        handleEvent(event);
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) { buffer += decoder.decode(); consume(true); break; }
      buffer += decoder.decode(value, { stream: true }); consume();
    }
    if (!thisRun.receivedDone && !assistantMessage.error && !assistantMessage.stopped) throw new Error('Соединение прервалось до конца ответа.');
  } catch (error) {
    if (error.name === 'AbortError') assistantMessage.stopped = true;
    else assistantMessage.error = error.message || 'Не удалось связаться с локальным сервером.';
  } finally {
    clearInterval(timer);
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = null; }
    assistantMessage.duration = Math.max(1, Math.round((Date.now() - thisRun.start) / 1000));
    for (const part of assistantMessage.parts) if (part.type === 'terminal' && ['pending', 'running'].includes(part.state)) part.state = 'interrupted';
    run = null;
    persist();
    if (view === 'chat') renderConversation(true);
    renderRecent(); updateComposer();
    refreshStatus();
    window.OrbitGit?.runFinished();
  }
}
function retryLast(chat) {
  if (run) return;
  const index = chat.messages.length - 1;
  const user = chat.messages[index - 1];
  if (!user || user.role !== 'user') return;
  const saved = sentText.get(user.id) || { text: user.content, files: [] };
  if (user.files?.length && !sentText.has(user.id)) toast('Файлы из этого сообщения не сохранились — повторяю только текст.');
  chat.messages.splice(index - 1, 2);
  sendMessage(saved);
}
async function stopRun() {
  if (!run || run.stopping) return;
  const current = run;
  current.stopping = true;
  current.message.stopped = true;
  setRunStatus('Останавливаю…');
  try { await api('/api/stop', { conversation_id: current.chatId }); }
  catch { toast('Связь с сервером потеряна. Проверьте фоновые процессы.', { error: true }); }
  finally { current.controller.abort(); }
}

/* ---------------------------------------------------------------- composer */

function updateComposer() {
  const here = run && run.chatId === activeId;
  const send = $('#send-button');
  send.classList.toggle('stop', Boolean(here));
  send.innerHTML = icon(here ? 'stop' : 'arrow-up');
  send.setAttribute('aria-label', here ? 'Остановить' : 'Отправить');
  send.title = here ? 'Остановить ответ' : run ? 'DeepSeek отвечает в другом диалоге' : 'Отправить (Enter)';
  send.disabled = here ? false : Boolean(run) || (!$('#prompt').value.trim() && !attachments.length);
  $('#think-toggle').disabled = Boolean(here);
  $('#search-toggle').disabled = Boolean(here);
  const status = $('#run-status');
  status.hidden = !here;
  if (here) {
    $('#run-status-text').textContent = run.statusText || '';
    $('#run-timer').textContent = `${Math.floor((Date.now() - run.start) / 1000)} с`;
    $('#jump-bottom').hidden = stickToBottom;
  }
}
function resizeInput() {
  const input = $('#prompt');
  input.style.height = 'auto';
  input.style.height = `${Math.min(240, Math.max(48, input.scrollHeight))}px`;
  updateComposer();
}
function updateOptions() {
  $('#think-toggle').setAttribute('aria-pressed', String(preferences.deepThink !== false));
  $('#search-toggle').setAttribute('aria-pressed', String(Boolean(preferences.search)));
  $('#auto-approve-switch').setAttribute('aria-checked', String(Boolean(preferences.autoApprove)));
  $('#thinking-switch').setAttribute('aria-checked', String(Boolean(preferences.thinkingOpen)));
  for (const option of $$('#output-mode [data-mode]')) option.setAttribute('aria-checked', String(option.dataset.mode === preferences.outputMode));
}
function renderAttachments() {
  const box = $('#attachments');
  box.replaceChildren(...attachments.map(file => fileChip(file, () => { attachments = attachments.filter(item => item !== file); renderAttachments(); updateComposer(); })));
  box.hidden = !attachments.length;
}
async function addFiles(fileList) {
  for (const file of fileList) {
    if (attachments.length >= 5) { toast('Не больше пяти файлов за раз.'); break; }
    if (file.size > MAX_ATTACHMENT) { toast(`${file.name}: больше 200 КБ, такой файл не поместится в сообщение.`, { error: true }); continue; }
    let text;
    try { text = await file.text(); } catch { toast(`Не удалось прочитать ${file.name}.`, { error: true }); continue; }
    if (text.includes('\u0000')) { toast(`${file.name} не похож на текстовый файл.`, { error: true }); continue; }
    attachments.push({ name: file.name, size: file.size, text });
  }
  renderAttachments(); updateComposer();
  $('#prompt').focus();
}

/* ---------------------------------------------------------------- history page */

function chatText(chat) {
  return chat.messages.map(message => message.role === 'user' ? message.content : (message.parts || []).filter(part => part.type === 'response').map(part => part.content).join(' ')).join(' ');
}
function renderHistoryPage() {
  const query = $('#history-search').value.trim().toLocaleLowerCase('ru');
  const list = $('#history-list');
  list.replaceChildren();
  const chats = sortedChats().filter(chat => (historyFilter !== 'pinned' || chat.pinned) && (!query || `${chat.title} ${chatText(chat)}`.toLocaleLowerCase('ru').includes(query)));
  if (!chats.length) {
    const empty = document.createElement('p'); empty.className = 'empty-line';
    empty.textContent = !conversations.length ? 'Диалогов пока нет.' : query ? 'Ничего не найдено.' : 'Закреплённых диалогов нет.';
    list.append(empty);
    return;
  }
  for (const chat of chats) {
    const row = document.createElement('div'); row.className = 'history-row';
    const main = document.createElement('a'); main.className = 'history-main'; main.href = `#/c/${encodeURIComponent(chat.id)}`;
    const title = document.createElement('span'); title.className = 'history-title';
    if (chat.pinned) title.innerHTML = icon('pin');
    const titleText = document.createElement('span'); titleText.textContent = chat.title; title.append(titleText);
    const lastUser = chat.messages.findLast(message => message.role === 'user');
    const snippet = document.createElement('span'); snippet.className = 'history-snippet';
    snippet.textContent = `${chat.messages.length} ${plural(chat.messages.length, 'сообщение', 'сообщения', 'сообщений')}${lastUser && lastUser.content !== chat.title ? ` · ${lastUser.content.replace(/\s+/g, ' ')}` : ''}`;
    main.append(title, snippet);
    const date = document.createElement('span'); date.className = 'history-date'; date.textContent = shortDate(chat.updatedAt);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'icon-button'; pin.innerHTML = icon('pin');
    pin.title = chat.pinned ? 'Открепить' : 'Закрепить'; pin.setAttribute('aria-pressed', String(Boolean(chat.pinned))); pin.setAttribute('aria-label', `${pin.title}: ${chat.title}`);
    pin.onclick = () => { chat.pinned = !chat.pinned; persist(); renderHistoryPage(); renderRecent(); };
    const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'icon-button'; rename.innerHTML = icon('edit');
    rename.title = 'Переименовать'; rename.setAttribute('aria-label', `Переименовать: ${chat.title}`);
    rename.onclick = () => renameChat(chat);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.innerHTML = icon('trash');
    remove.title = 'Удалить'; remove.setAttribute('aria-label', `Удалить: ${chat.title}`);
    remove.onclick = () => deleteChat(chat);
    actions.append(pin, rename, remove);
    row.append(main, date, actions);
    list.append(row);
  }
}
async function renameChat(chat) {
  const title = await promptDialog({ title: 'Название диалога', value: chat.title });
  if (!title) return;
  chat.title = title.slice(0, 120);
  persist(); renderRecent(); updateTopbar();
  if (view === 'history') renderHistoryPage();
}
async function deleteChat(chat) {
  if (run?.chatId === chat.id) { toast('Сначала остановите ответ в этом диалоге.'); return; }
  if (!await confirmDialog({ title: 'Удалить диалог?', text: `«${escapeHtml(chat.title)}» исчезнет из этого браузера. На сайте DeepSeek он останется.`, ok: 'Удалить', danger: true })) return;
  conversations = conversations.filter(entry => entry.id !== chat.id);
  persist();
  if (activeId === chat.id) { activeId = null; if (view === 'chat') go('#/'); }
  renderRecent();
  if (view === 'history') renderHistoryPage();
}
function exportChats() {
  const blob = new Blob([JSON.stringify({ app: 'Orbit', version: 1, exportedAt: new Date().toISOString(), conversations }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `orbit-dialogues-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importChats(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Это не JSON-файл экспорта Orbit.', { error: true }); return; }
  const incoming = (Array.isArray(data) ? data : data?.conversations || []).filter(chat => validChat(chat) && typeof chat.title === 'string');
  const known = new Set(conversations.map(chat => chat.id));
  const added = incoming.filter(chat => !known.has(chat.id)).map(chat => ({ ...chat, createdAt: Number(chat.createdAt) || Date.now(), updatedAt: Number(chat.updatedAt) || Date.now() }));
  for (const chat of added) for (const message of chat.messages) for (const part of message.parts || []) if (part.type === 'terminal' && ['pending', 'running'].includes(part.state)) part.state = 'interrupted';
  conversations.push(...added);
  persist(); renderRecent();
  if (view === 'history') renderHistoryPage();
  toast(added.length ? `Добавлено: ${added.length} ${plural(added.length, 'диалог', 'диалога', 'диалогов')}` : 'Новых диалогов в файле нет');
}

/* ---------------------------------------------------------------- settings */

function renderSettings() {
  const textarea = $('#system-prompt');
  if (document.activeElement !== textarea) textarea.value = preferences.systemPrompt ?? defaultPrompt;
  $('#reset-prompt').hidden = preferences.systemPrompt == null;
  updateOptions(); applyTheme(); renderAuth();
  refreshStatus();
}
function renderAuth() {
  const authenticating = serverStatus.authenticating;
  $('#auth-title').textContent = !serverOnline ? 'Сервер недоступен' : authenticating ? 'Ждём вход в Chrome…' : serverStatus.configured ? 'Сессия сохранена' : 'Вход не выполнен';
  const hint = $('#auth-hint');
  hint.textContent = !serverOnline ? 'Запустите python web_server.py.'
    : serverStatus.auth_error || (authenticating ? 'Войдите на сайт DeepSeek и отправьте там одно сообщение.'
      : serverStatus.configured ? 'Проверяется при отправке сообщения.' : 'Откроется Chrome: войдите в DeepSeek и отправьте там одно сообщение.');
  hint.classList.toggle('error', Boolean(serverStatus.auth_error) || !serverOnline);
  $('#auth-button').textContent = authenticating ? 'Ждём…' : serverStatus.configured ? 'Войти заново' : 'Войти';
  $('#auth-button').disabled = Boolean(authenticating) || !serverOnline;
}

/* ---------------------------------------------------------------- status and workspace */

function rememberFolder(path) {
  const folders = load(FOLDERS, []).filter(item => typeof item === 'string' && item !== path);
  folders.unshift(path);
  save(FOLDERS, folders.slice(0, 6));
}
async function refreshStatus() {
  const previousCwd = serverStatus.cwd;
  try {
    serverStatus = await api('/api/status');
    serverOnline = true;
  } catch {
    serverOnline = false;
  }
  const connection = $('#connection');
  const authenticating = serverStatus.authenticating;
  const problem = !serverOnline ? 'Сервер недоступен' : authenticating ? 'Вход…' : serverStatus.busy && !run && !window.OrbitGit?.busy() ? 'Сервер занят' : !serverStatus.configured ? 'Нужен вход' : '';
  connection.hidden = !problem;
  connection.textContent = problem;
  connection.className = `status-link${serverOnline ? '' : ' offline'}`;
  renderAuth();
  if (serverOnline && serverStatus.cwd) {
    const cwd = serverStatus.cwd;
    $('#workspace-name').textContent = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
    $('#workspace-path-label').textContent = ltr(cwd);
    $('#workspace-button').title = `${cwd}\nСменить рабочую папку`;
    $('#dock-path').textContent = ltr(`${cwd}${serverStatus.branch ? `  ·  ${serverStatus.branch}` : ''}`);
    $('#nav-branch').textContent = serverStatus.branch || '';
    rememberFolder(cwd);
    if (previousCwd && previousCwd !== cwd) window.OrbitGit?.workspaceChanged();
  }
  if (serverStatus.system_prompt) {
    defaultPrompt = serverStatus.system_prompt;
    if (view === 'settings' && preferences.systemPrompt == null && document.activeElement !== $('#system-prompt')) $('#system-prompt').value = defaultPrompt;
  }
  const picking = Boolean(serverStatus.selecting_workspace);
  $('#pick-workspace').disabled = picking;
  $('#apply-workspace').disabled = picking;
  $('#pick-workspace').innerHTML = `${icon('folder')}${picking ? 'Выбор папки…' : 'Обзор…'}`;
  if (workspaceWasPicking && !picking) {
    $('#workspace-path').value = serverStatus.cwd || '';
    showWorkspaceError(serverStatus.workspace_error || '');
    if (!serverStatus.workspace_error) $('#workspace-dialog').close();
  }
  workspaceWasPicking = picking;
  if (picking) { clearTimeout(workspaceTimer); workspaceTimer = setTimeout(refreshStatus, 1000); }
  if (authenticating) { clearTimeout(authTimer); authTimer = setTimeout(refreshStatus, 2000); }
  return serverStatus;
}
function showWorkspaceError(message) { $('#workspace-error').textContent = message; $('#workspace-error').hidden = !message; }
function openWorkspace() {
  if (run) { toast('Папку можно сменить, когда DeepSeek закончит ответ.'); return; }
  $('#workspace-path').value = serverStatus.cwd || '';
  showWorkspaceError('');
  const folders = load(FOLDERS, []).filter(path => typeof path === 'string' && path !== serverStatus.cwd);
  const box = $('#recent-folders');
  box.replaceChildren(...folders.map(path => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = path; button.title = path;
    button.onclick = () => { $('#workspace-path').value = path; $('#workspace-form').requestSubmit(); };
    return button;
  }));
  $('#workspace-dialog').showModal();
  $('#workspace-path').select();
}

/* ---------------------------------------------------------------- events */

$('#composer').addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
$('#prompt').addEventListener('input', resizeInput);
$('#prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!run) sendMessage(); }
});
$('#prompt').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); addFiles(files); }
});
$('.dock').addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
$('.dock').addEventListener('drop', event => { if (event.dataTransfer?.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
$('#attach-button').onclick = () => $('#file-input').click();
$('#file-input').onchange = event => { addFiles(event.target.files); event.target.value = ''; };
$('#think-toggle').onclick = () => { preferences.deepThink = preferences.deepThink === false; updateOptions(); savePreferences(); };
$('#search-toggle').onclick = () => { preferences.search = !preferences.search; updateOptions(); savePreferences(); };
for (const suggestion of $$('[data-prompt]')) suggestion.onclick = () => { $('#prompt').value = suggestion.dataset.prompt; resizeInput(); $('#prompt').focus(); };
$('#jump-bottom').onclick = () => { stickToBottom = true; scrollBottom(true); updateComposer(); };
$('#chat-scroll').addEventListener('scroll', () => {
  const scroll = $('#chat-scroll');
  const stick = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  if (stick !== stickToBottom) { stickToBottom = stick; updateComposer(); }
});

$('#new-chat').onclick = () => { if (location.hash.replace(/^#\/?/, '') === '' && view === 'chat') { activeId = null; applyRoute(); } else go('#/'); };
$('#menu-button').onclick = openSidebar;
$('#scrim').onclick = closeSidebar;
$('#theme-button').onclick = () => {
  preferences.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(); savePreferences();
};
$('#topbar-title').addEventListener('dblclick', () => { const chat = view === 'chat' && currentChat(); if (chat) renameChat(chat); });
$('#workspace-button').onclick = openWorkspace;
$('#dock-path').onclick = openWorkspace;
$('#workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#apply-workspace').disabled = true;
  try {
    await api('/api/workspace', { path: $('#workspace-path').value.trim() });
    await refreshStatus();
    $('#workspace-dialog').close();
    window.OrbitGit?.workspaceChanged();
  } catch (error) { showWorkspaceError(error.message); }
  finally { $('#apply-workspace').disabled = false; }
});
$('#pick-workspace').onclick = async () => {
  $('#pick-workspace').disabled = true;
  showWorkspaceError('');
  try { await api('/api/workspace/pick', {}); workspaceWasPicking = true; await refreshStatus(); }
  catch (error) { showWorkspaceError(error.message); $('#pick-workspace').disabled = false; }
};

$('#history-search').addEventListener('input', renderHistoryPage);
for (const option of $$('#history-filter [data-filter]')) option.onclick = () => {
  historyFilter = option.dataset.filter;
  for (const item of $$('#history-filter [data-filter]')) item.setAttribute('aria-checked', String(item === option));
  renderHistoryPage();
};
for (const id of ['#export-button', '#settings-export']) $(id).onclick = () => { if (!conversations.length) { toast('Экспортировать нечего.'); return; } exportChats(); };
for (const id of ['#import-button', '#settings-import']) $(id).onclick = () => $('#import-input').click();
$('#import-input').onchange = event => { const file = event.target.files[0]; if (file) importChats(file); event.target.value = ''; };

$('#system-prompt').addEventListener('input', () => {
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => {
    const value = $('#system-prompt').value;
    preferences.systemPrompt = value.trim() && value.trim() !== defaultPrompt.trim() ? value : null;
    savePreferences();
    $('#reset-prompt').hidden = preferences.systemPrompt == null;
  }, 300);
});
$('#reset-prompt').onclick = () => { preferences.systemPrompt = null; savePreferences(); $('#system-prompt').value = defaultPrompt; $('#reset-prompt').hidden = true; };
$('#auto-approve-switch').onclick = () => setAutoApprove(!preferences.autoApprove);
$('#thinking-switch').onclick = () => { preferences.thinkingOpen = !preferences.thinkingOpen; updateOptions(); savePreferences(); };
for (const option of $$('#output-mode [data-mode]')) option.onclick = () => { preferences.outputMode = option.dataset.mode; updateOptions(); savePreferences(); };
for (const option of $$('[data-theme-choice]')) option.onclick = () => { preferences.theme = option.dataset.themeChoice; applyTheme(); savePreferences(); };
$('#auth-button').onclick = async () => {
  if (run) { toast('Остановите ответ перед входом.'); return; }
  $('#auth-button').disabled = true;
  try { await api('/api/auth', {}); toast('Войдите в DeepSeek в открывшемся Chrome и отправьте одно сообщение.'); await refreshStatus(); }
  catch (error) { toast(error.message, { error: true }); $('#auth-button').disabled = false; }
};
$('#clear-history').onclick = async () => {
  if (run) { toast('Сначала остановите ответ.'); return; }
  if (!conversations.length) { toast('История уже пуста.'); return; }
  if (!await confirmDialog({ title: 'Удалить все диалоги?', text: `${conversations.length} ${plural(conversations.length, 'диалог', 'диалога', 'диалогов')} исчезнут из этого браузера. Это нельзя отменить — сначала можно сделать экспорт.`, ok: 'Удалить все', danger: true })) return;
  conversations = []; activeId = null; persist(); renderRecent(); toast('История удалена');
};

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!$('dialog[open]')) go('#/'); }
  if (event.key === 'Escape') closeSidebar();
  if (event.key === '/' && view === 'history' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$('dialog[open]')) { event.preventDefault(); $('#history-search').focus(); }
});
window.addEventListener('beforeunload', event => {
  if (!run) return;
  navigator.sendBeacon('/api/stop', new Blob([JSON.stringify({ conversation_id: run.chatId })], { type: 'application/json' }));
  event.preventDefault(); event.returnValue = '';
});
window.addEventListener('focus', () => { if (!run) refreshStatus(); });

window.Orbit = {
  api, toast, confirmDialog, promptDialog, icon, escapeHtml, plural, formatNumber, shortDate, onPress,
  status: () => serverStatus, isRunning: () => Boolean(run), refreshStatus, openWorkspace,
  startChat(text) { go('#/'); $('#prompt').value = text; resizeInput(); $('#prompt').focus(); },
};

for (const chat of conversations) for (const message of chat.messages) for (const part of message.parts || []) {
  if (part.type === 'terminal' && ['pending', 'running'].includes(part.state)) part.state = 'interrupted';
}
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(); updateOptions(); applyRoute(); resizeInput(); refreshStatus();
});
