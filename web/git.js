'use strict';

// Git view. Three places — working folder, local history, server — and the actions that move work between them.
// Hovering or focusing any action lights up the places it touches and explains the result in one line.
(() => {
  const { api, toast, confirmDialog, promptDialog, icon, escapeHtml: esc, plural, formatNumber } = window.Orbit;
  const root = document.querySelector('#view-git');
  const $ = selector => root.querySelector(selector);
  const DRAFTS = 'orbit.git.drafts.v1';
  const MAX_DIFF_LINES = 4000;

  let visible = false;
  let mode = '';
  let st = null;
  let commits = [];
  let selected = new Set();
  let known = new Set();
  let active = null; // { type: 'file', path } | { type: 'commit', hash }
  let diffData = null;
  let busy = '';
  let generating = false;
  let fetchingQuietly = false;
  let lastFetch = 0;
  let lastError = '';
  let lastOutput = null;
  let hover = null;
  let pointerHover = null;
  let focusHover = null;
  let loadToken = 0;
  let plainCwd = '';

  const count = (n, one, few, many) => `${formatNumber(n)} ${plural(n, one, few, many)}`;
  const files = () => st?.files || [];
  const selectedFiles = () => files().filter(file => selected.has(file.path));
  const trackedChanges = () => files().some(file => !file.untracked);
  const latest = () => commits[0];
  const canUndo = () => Boolean(latest()) && latest().pushed !== true && !latest().merge;
  function relative(seconds) {
    const diff = Date.now() / 1000 - seconds;
    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
    return window.Orbit.shortDate(seconds * 1000);
  }
  const loadDrafts = () => { try { return JSON.parse(localStorage.getItem(DRAFTS)) || {}; } catch { return {}; } };
  function saveDraft() {
    if (!st?.root || !$('#git-subject')) return;
    const drafts = loadDrafts();
    drafts[st.root] = { subject: $('#git-subject').value, body: $('#git-body').value };
    try { localStorage.setItem(DRAFTS, JSON.stringify(drafts)); } catch {}
  }

  /* ------------------------------------------------------------ explanations */

  // Each action: which places it touches, the badge shown on each, and the sentence under the diagram.
  function describe(action, target = {}) {
    const n = selectedFiles().length, all = files().length;
    const ahead = st?.ahead || 0, behind = st?.behind || 0;
    const remote = Boolean(st?.remotes?.length);
    switch (action) {
      case 'commit': return {
        lit: ['work', 'local'], arrow: 'commit', delta: n ? { work: `−${n}`, local: '+1' } : {},
        text: n ? `Коммит сохранит ${count(n, 'отмеченный файл', 'отмеченных файла', 'отмеченных файлов')} как новую точку в истории на этом компьютере. На сервер ничего не уйдёт — для этого потом нажмите Push.`
          : all ? 'Коммит сохраняет отмеченные файлы как новую точку в истории. Отметьте файлы галочками.' : 'Сохранять нечего: в папке нет изменений.',
        blocked: !n,
      };
      case 'undo': return {
        lit: ['local', 'work'], arrow: 'undo', delta: canUndo() ? { local: '−1', work: '+файлы' } : {},
        text: canUndo() ? `Отменит последний коммит «${latest().subject}». Его изменения вернутся в список — ничего не потеряется.`
          : !latest() ? 'Отменять нечего: коммитов ещё нет.' : latest().merge ? 'Последний коммит — слияние, его так не отменить. Используйте «Откатить» в истории.'
            : 'Последний коммит уже на сервере. Чтобы убрать его изменения, нажмите «Откатить» в истории — появится новый коммит.',
        blocked: !canUndo(),
      };
      case 'push': {
        let text, blocked = true;
        if (!remote) text = 'Сервер не подключён. Вставьте адрес репозитория в поле ниже.';
        else if (!st.has_head) text = 'Отправлять нечего: коммитов ещё нет.';
        else if (behind) text = `На сервере ${count(behind, 'коммит', 'коммита', 'коммитов')}, которых у вас нет. Сначала Pull, потом Push.`;
        else if (!st.upstream) { text = `Push создаст ветку ${st.branch} на сервере и отправит туда ${count(ahead, 'коммит', 'коммита', 'коммитов')}.`; blocked = false; }
        else if (!ahead) text = 'Отправлять нечего: все коммиты уже на сервере.';
        else { text = `Push отправит ${count(ahead, 'коммит', 'коммита', 'коммитов')} с этого компьютера на сервер. Файлы в папке не изменятся.`; blocked = false; }
        return { lit: ['local', 'remote'], arrow: 'push', delta: blocked ? {} : { local: `${ahead} →`, remote: `+${ahead}` }, text, blocked };
      }
      case 'pull': {
        let text, blocked = true;
        if (!remote) text = 'Сервер не подключён — получать не откуда.';
        else if (!st.upstream) text = 'Этой ветки ещё нет на сервере. Сначала отправьте её (Push).';
        else if (st.state) text = 'Сначала закончите или отмените слияние.';
        else if (trackedChanges()) text = 'Pull работает, когда все правки сохранены в коммит или отложены. Иначе Git может их перезаписать.';
        else if (!behind) text = 'На сервере нет новых коммитов. «Проверить сервер» узнает наверняка.';
        else { text = `Pull скачает ${count(behind, 'новый коммит', 'новых коммита', 'новых коммитов')} с сервера и обновит файлы в папке.`; blocked = false; }
        return { lit: ['remote', 'local', 'work'], arrow: 'pull', delta: blocked ? {} : { remote: `${behind} →`, local: `+${behind}`, work: 'обновятся' }, text, blocked };
      }
      case 'fetch': return {
        lit: ['remote'], delta: { remote: '?' }, blocked: !remote,
        text: remote ? 'Узнает, появилось ли что-то новое на сервере. Ваши файлы и коммиты не меняются.' : 'Сервер не подключён.',
      };
      case 'stash': return {
        lit: ['work'], delta: all ? { work: `−${all}` } : {}, blocked: !all || !st?.has_head,
        text: !st?.has_head ? 'Отложить можно после первого коммита.' : all ? `Уберёт все изменения (${all}) в «отложенное». Папка станет как после последнего коммита — удобно перед Pull или сменой ветки.` : 'Откладывать нечего.',
      };
      case 'unstash': return { lit: ['work'], delta: { work: '+отложенное' }, text: 'Вернёт отложенные изменения обратно в папку.' };
      case 'discard': {
        const file = files().find(item => item.path === target.path);
        return {
          lit: ['work'], delta: { work: '−1' },
          text: file?.untracked ? `Удалит новый файл ${target.path}. Вернуть его будет нельзя.` : `Вернёт ${target.path} к последнему коммиту. Ваши правки в этом файле пропадут.`,
        };
      }
      case 'ignore': {
        const file = files().find(item => item.path === target.path);
        const pattern = file?.ignore || '';
        const what = pattern.endsWith('/') ? `все папки ${pattern}` : pattern.startsWith('*') ? `все файлы ${pattern}` : 'этот файл';
        return { lit: ['work'], delta: { work: '−1' }, text: `Добавит строку ${pattern} в .gitignore: Git перестанет показывать ${what}. Сам файл на диске останется.` };
      }
      case 'generate': return {
        lit: ['work'], blocked: !n,
        text: n ? 'DeepSeek прочитает изменения отмеченных файлов и предложит название и описание. Текст, который вы уже написали, он учтёт как подсказку.' : 'Отметьте файлы — DeepSeek опишет их изменения.',
      };
      case 'revert': return {
        lit: ['local', 'work'], delta: { local: '+1', work: 'изменятся' },
        text: 'Откат создаст новый коммит, который убирает изменения выбранного. История не переписывается, поэтому так можно отменить и уже отправленный коммит.',
        blocked: trackedChanges() || Boolean(st?.state),
      };
      case 'switch': return {
        lit: ['work', 'local'], delta: { work: 'сменятся', local: target.branch }, text: `Перейдёт на ветку ${target.branch}: файлы в папке станут такими, как в ней. Несохранённые правки Git не даст потерять.`,
      };
      case 'merge': return {
        lit: ['local', 'work'], delta: { local: `+ ${target.branch}` }, blocked: trackedChanges() || Boolean(st?.state),
        text: trackedChanges() ? 'Перед слиянием сохраните или отложите правки.' : `Добавит в ${st?.branch} все коммиты из ${target.branch}. Если они правят одни и те же строки, Orbit всё отменит и скажет, где конфликт.`,
      };
      case 'delete-branch': return { lit: ['local'], text: `Удалит ветку ${target.branch} на этом компьютере. Если в ней есть коммиты, которых нет в других ветках, Git её не удалит.` };
      case 'create-branch': return { lit: ['local', 'work'], delta: { local: 'новая ветка' }, text: 'Создаст ветку от текущего состояния и перейдёт на неё. Удобно, чтобы пробовать что-то, не трогая основную ветку.' };
      case 'abort': return { lit: ['work', 'local'], text: 'Отменит незаконченное слияние: всё вернётся как было до него.' };
      case 'init': return { lit: [], text: 'Создаст в папке скрытую папку .git. Ваши файлы не изменятся, Git начнёт следить за их версиями.' };
      case 'remote': return { lit: ['remote'], text: 'Свяжет папку с репозиторием на сервере, чтобы работали Push и Pull.' };
      default: return null;
    }
  }
  function nextStep() {
    if (!st) return '';
    if (st.state) return 'Git ждёт завершения слияния. Нажмите «Отменить слияние», чтобы вернуть всё как было.';
    const all = files().length, remote = st.remotes.length;
    if (all) return `Есть несохранённые изменения: ${count(all, 'файл', 'файла', 'файлов')}. Отметьте нужные, напишите название и нажмите «Коммит».`;
    if (!remote) return st.has_head ? 'Всё сохранено. Сервер не подключён — история есть только на этом компьютере.' : 'Изменений нет. Создайте или поменяйте файлы — они появятся здесь.';
    if (st.behind) return `На сервере ${count(st.behind, 'новый коммит', 'новых коммита', 'новых коммитов')}. Нажмите Pull, чтобы получить их.`;
    if (st.ahead || (!st.upstream && st.has_head)) return `${st.upstream ? count(st.ahead, 'коммит пока', 'коммита пока', 'коммитов пока') + ' только на этом компьютере' : 'Ветки ещё нет на сервере'}. Нажмите Push, чтобы отправить.`;
    return 'Всё сохранено и отправлено на сервер.';
  }
  function recommended() {
    if (!st || st.state) return '';
    if (files().length) return 'commit';
    if (st.remotes.length && st.behind) return 'pull';
    if (st.remotes.length && st.has_head && (st.ahead || !st.upstream)) return 'push';
    return '';
  }

  /* ------------------------------------------------------------ skeleton */

  const arrow = (action, label, back = false) =>
    `<button class="flow-arrow${back ? ' back' : ''}" type="button" data-git="${action}" data-explain="${action}"><span class="arrow"><i></i></span><span class="flow-label">${label}</span></button>`;
  function skeleton(next) {
    if (mode === next) return;
    mode = next;
    if (next === 'loading') { root.innerHTML = '<p class="git-loading"><span class="spinner"></span>Читаю репозиторий…</p>'; return; }
    if (next === 'missing') { root.innerHTML = '<div class="git-intro"><h3>Git не найден</h3><p>Установите Git с сайта git-scm.com и перезапустите сервер Orbit.</p></div>'; return; }
    if (next === 'norepo') {
      root.innerHTML = `
        <div class="git-intro">
          <h3>В этой папке ещё нет Git</h3>
          <p class="mono" id="git-cwd"></p>
          <p>Git запоминает версии файлов: видно, что поменялось, и можно вернуться назад или отправить работу на GitHub.</p>
          <div class="button-row"><button class="button primary" type="button" data-git="init" data-explain="init">Включить Git в этой папке</button><button class="button" type="button" data-git="workspace">Выбрать другую папку</button></div>
          <p class="flow-explain" id="git-explain"></p>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="page-head">
        <span class="branch-badge" id="git-branch-badge" title="Текущая ветка">${icon('branch')}<span></span></span>
        <div class="page-actions"><button class="button" type="button" data-git="fetch" data-explain="fetch" id="git-fetch">${icon('refresh')}<span>Проверить сервер</span></button></div>
      </div>
      <section class="flow" id="git-flow" aria-label="Где сейчас ваша работа">
        <div class="flow-box" data-box="work"><div class="flow-box-head">${icon('folder')}Папка проекта</div><div class="flow-count" data-count="work"></div><div class="flow-caption" data-caption="work"></div><span class="flow-delta" data-delta="work"></span></div>
        <div class="flow-links">${arrow('commit', 'Коммит')}${arrow('undo', 'Отменить коммит', true)}</div>
        <div class="flow-box" data-box="local"><div class="flow-box-head">${icon('laptop')}История на компьютере</div><div class="flow-count" data-count="local"></div><div class="flow-caption" data-caption="local"></div><span class="flow-delta" data-delta="local"></span></div>
        <div class="flow-links">${arrow('push', 'Push · отправить')}${arrow('pull', 'Pull · получить', true)}</div>
        <div class="flow-box" data-box="remote"><div class="flow-box-head">${icon('cloud')}Сервер</div><div class="flow-count" data-count="remote"></div><div class="flow-caption" data-caption="remote"></div><button class="flow-sub" type="button" data-git="edit-remote" data-explain="remote" id="git-remote-url"></button><span class="flow-delta" data-delta="remote"></span></div>
      </section>
      <p class="flow-explain" id="git-explain" aria-live="polite"></p>
      <div class="git-banner" id="git-banner" hidden></div>
      <form class="git-remote" id="git-remote-form" hidden>
        <label for="git-remote-input">Адрес репозитория на GitHub, GitLab или другом сервере</label>
        <div class="inline"><input class="field mono" id="git-remote-input" type="text" placeholder="https://github.com/имя/проект.git" autocomplete="off" spellcheck="false"><button class="button primary" type="submit" data-explain="remote">Подключить</button></div>
        <p class="row-hint">Создайте на сайте пустой репозиторий без README и скопируйте его адрес.</p>
      </form>
      <details class="git-output" id="git-output" hidden><summary></summary><pre></pre></details>
      <div class="git-grid">
        <section class="panel">
          <header class="panel-head wrap"><h3>Изменения <span class="count" id="git-files-count"></span></h3><div class="panel-tools" id="git-files-tools"></div></header>
          <div class="file-list" id="git-files"></div>
          <form class="commit-form" id="git-commit-form">
            <label class="sr-only" for="git-subject">Название коммита</label>
            <input class="field" id="git-subject" type="text" maxlength="200" placeholder="Название: что сделано, коротко" autocomplete="off">
            <label class="sr-only" for="git-body">Описание</label>
            <textarea class="field" id="git-body" rows="3" maxlength="8000" placeholder="Подробности — по желанию"></textarea>
            <div class="commit-actions">
              <button class="button" type="button" data-git="generate" data-explain="generate" id="git-generate">Написать с DeepSeek</button>
              <span class="spacer"></span>
              <button class="button primary" type="submit" data-explain="commit" id="git-commit">Коммит</button>
            </div>
          </form>
        </section>
        <section class="panel diff-panel">
          <header class="panel-head" id="git-diff-head"></header>
          <div class="diff" id="git-diff" tabindex="0"></div>
        </section>
      </div>
      <div class="git-grid lower">
        <section class="panel">
          <header class="panel-head"><h3>История</h3><span class="legend"><i class="dot"></i>на сервере <i class="dot local"></i>только здесь</span></header>
          <div class="log-list" id="git-log"></div>
        </section>
        <section class="panel">
          <header class="panel-head"><h3>Ветки</h3></header>
          <div class="branch-list" id="git-branches"></div>
          <form class="branch-new" id="git-branch-form">
            <label class="sr-only" for="git-branch-input">Имя новой ветки</label>
            <input class="field mono" id="git-branch-input" type="text" placeholder="имя-новой-ветки" maxlength="200" autocomplete="off" spellcheck="false">
            <button class="button" type="submit" data-explain="create-branch">Создать</button>
          </form>
        </section>
      </div>`;
    const draft = loadDrafts()[st?.root] || {};
    $('#git-subject').value = draft.subject || '';
    $('#git-body').value = draft.body || '';
    $('#git-subject').addEventListener('input', () => { saveDraft(); updateCommitButton(); });
    $('#git-body').addEventListener('input', saveDraft);
    $('#git-commit-form').addEventListener('submit', event => { event.preventDefault(); commit(); });
    $('#git-branch-form').addEventListener('submit', event => { event.preventDefault(); createBranch(); });
    $('#git-remote-form').addEventListener('submit', event => { event.preventDefault(); connectRemote($('#git-remote-input').value); });
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    if (!visible || mode !== 'repo') { if (mode === 'norepo') { $('#git-cwd').textContent = plainCwd; renderExplain(); } return; }
    $('#git-branch-badge span').textContent = st.detached ? `без ветки (${st.branch})` : st.branch;
    renderFlow(); renderFiles(); renderLog(); renderBranches(); renderBanner(); renderOutput(); renderExplain(); updateCommitButton();
  }
  function setBox(name, number, caption) {
    const box = $(`[data-count="${name}"]`);
    if (number === '✓') box.innerHTML = icon('check', 'icon done');
    else box.textContent = number;
    $(`[data-caption="${name}"]`).textContent = caption;
  }
  function renderFlow() {
    const all = files().length;
    setBox('work', all || '✓', all ? `${plural(all, 'файл изменён', 'файла изменено', 'файлов изменено')}${st.stash ? ` · отложено: ${st.stash}` : ''}` : `всё сохранено${st.stash ? ` · отложено: ${st.stash}` : ''}`);
    const unpushed = st.ahead;
    if (!st.has_head) setBox('local', '0', 'коммитов пока нет');
    else if (!st.remotes.length) setBox('local', commits.length >= 50 ? '50+' : commits.length, plural(commits.length, 'коммит', 'коммита', 'коммитов'));
    else if (!st.upstream) setBox('local', formatNumber(unpushed), `${plural(unpushed, 'коммит', 'коммита', 'коммитов')} · ветки нет на сервере`);
    else setBox('local', unpushed || '✓', unpushed ? `${plural(unpushed, 'коммит не отправлен', 'коммита не отправлены', 'коммитов не отправлены')}` : 'всё отправлено');
    const url = $('#git-remote-url');
    if (!st.remotes.length) { setBox('remote', '—', 'не подключён'); url.hidden = true; }
    else {
      setBox('remote', st.upstream ? (st.behind || '✓') : '·', !st.upstream ? `ветки ${st.branch} там нет` : st.behind ? plural(st.behind, 'новый коммит', 'новых коммита', 'новых коммитов') : fetchingQuietly ? 'проверяю…' : 'новых нет');
      url.hidden = false;
      url.textContent = st.remote_url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
      url.title = `${st.remote_url}\nНажмите, чтобы изменить адрес`;
    }
    $('#git-remote-form').hidden = Boolean(st.remotes.length);
    const best = recommended();
    for (const button of root.querySelectorAll('.flow-arrow')) {
      const info = describe(button.dataset.git);
      button.classList.toggle('primary', button.dataset.git === best);
      button.setAttribute('aria-disabled', String(Boolean(busy) || Boolean(info?.blocked)));
    }
    const fetchButton = $('#git-fetch');
    fetchButton.setAttribute('aria-disabled', String(Boolean(busy) || !st.remotes.length));
    fetchButton.querySelector('span').textContent = busy === 'fetch' || fetchingQuietly ? 'Проверяю…' : 'Проверить сервер';
  }
  const STATUS_WORDS = { M: ['изменён', 'mod'], A: ['новый', 'add'], D: ['удалён', 'del'], R: ['переименован', 'ren'], U: ['конфликт', 'conflict'] };
  function renderFiles() {
    const list = files();
    $('#git-files-count').textContent = list.length ? list.length : '';
    const tools = $('#git-files-tools');
    tools.innerHTML = (list.length ? `<button class="text-button" type="button" data-git="select-all">${selected.size === list.length ? 'Снять все' : 'Отметить все'}</button>` : '')
      + (list.length && st.has_head ? `<button class="button small" type="button" data-git="stash" data-explain="stash">${icon('box')}Отложить</button>` : '')
      + (st.stash ? `<button class="button small" type="button" data-git="unstash" data-explain="unstash">Вернуть отложенное</button>` : '');
    const box = $('#git-files');
    if (!list.length) { box.innerHTML = '<p class="panel-empty">Изменений нет.</p>'; return; }
    box.innerHTML = list.map(file => {
      const slash = file.path.lastIndexOf('/');
      const name = file.path.slice(slash + 1), dir = slash > 0 ? file.path.slice(0, slash) : '';
      const [word, tone] = file.junk ? ['служебный', ''] : STATUS_WORDS[file.status] || STATUS_WORDS.M;
      const stat = file.binary ? '<span class="muted">бинарный</span>' : file.added == null ? '' : `<span class="add">+${file.added}</span><span class="del">−${file.removed}</span>`;
      const isActive = active?.type === 'file' && active.path === file.path;
      return `<div class="file-row${isActive ? ' active' : ''}">
        <input type="checkbox" data-check="${esc(file.path)}" ${selected.has(file.path) ? 'checked' : ''} aria-label="Включить ${esc(file.path)} в коммит">
        <button class="file-open" type="button" data-open-file="${esc(file.path)}" title="${esc(file.original ? `${file.original} → ${file.path}` : file.path)}"><span class="file-name">${esc(name)}</span>${dir ? `<span class="file-dir">${esc(dir)}</span>` : ''}</button>
        <span class="file-tag ${tone}">${word}</span>
        <span class="file-stat">${stat}</span>
        <span class="file-actions">${file.untracked ? `<button class="icon-button" type="button" data-git="ignore" data-explain="ignore" data-path="${esc(file.path)}" title="Не отслеживать (.gitignore)" aria-label="Не отслеживать: ${esc(file.path)}">${icon('hide')}</button>` : ''}<button class="icon-button" type="button" data-git="discard" data-explain="discard" data-path="${esc(file.path)}" title="${file.untracked ? 'Удалить новый файл' : 'Отменить изменения в файле'}" aria-label="Отменить изменения: ${esc(file.path)}">${icon(file.untracked ? 'trash' : 'undo')}</button></span>
      </div>`;
    }).join('') + (st.truncated ? '<p class="panel-empty">Показаны первые 1000 файлов.</p>' : '');
  }
  function updateCommitButton() {
    if (mode !== 'repo') return;
    const n = selectedFiles().length;
    const button = $('#git-commit');
    button.textContent = n ? `Коммит · ${count(n, 'файл', 'файла', 'файлов')}` : 'Коммит';
    button.setAttribute('aria-disabled', String(Boolean(busy) || !n));
    const generate = $('#git-generate');
    generate.textContent = generating ? 'Остановить' : 'Написать с DeepSeek';
    generate.setAttribute('aria-disabled', String(!generating && (Boolean(busy) || !n)));
  }
  function renderLog() {
    const box = $('#git-log');
    if (!commits.length) { box.innerHTML = '<p class="panel-empty">Коммитов пока нет. Первый появится после кнопки «Коммит».</p>'; return; }
    box.innerHTML = commits.map((entry, index) => {
      const local = entry.pushed !== true;
      const isActive = active?.type === 'commit' && active.hash === entry.hash;
      const actions = [];
      if (index === 0 && canUndo()) actions.push(`<button class="button small" type="button" data-git="undo" data-explain="undo">Отменить</button>`);
      actions.push(`<button class="button small" type="button" data-git="revert" data-explain="revert" data-hash="${entry.hash}">Откатить</button>`);
      return `<div class="log-row${isActive ? ' active' : ''}">
        <i class="dot${local ? ' local' : ''}" title="${entry.pushed == null ? '' : local ? 'Только на этом компьютере' : 'На сервере'}"></i>
        <button class="log-main" type="button" data-open-commit="${entry.hash}"><span class="log-subject">${esc(entry.subject)}</span><span class="log-meta">${esc(entry.short)} · ${esc(entry.author)} · ${relative(entry.time)}</span></button>
        <div class="row-actions">${actions.join('')}</div>
      </div>`;
    }).join('');
  }
  function renderBranches() {
    $('#git-branches').innerHTML = st.branches.map(name => {
      const current = name === st.branch && !st.detached;
      return `<div class="branch-row${current ? ' current' : ''}">
        <span class="branch-name">${esc(name)}</span>${current ? '<span class="branch-here">вы здесь</span>' : ''}
        ${current ? '' : `<div class="row-actions">
          <button class="button small" type="button" data-git="switch" data-explain="switch" data-branch="${esc(name)}">Перейти</button>
          <button class="button small" type="button" data-git="merge" data-explain="merge" data-branch="${esc(name)}">Слить сюда</button>
          <button class="icon-button" type="button" data-git="delete-branch" data-explain="delete-branch" data-branch="${esc(name)}" aria-label="Удалить ветку ${esc(name)}" title="Удалить ветку">${icon('trash')}</button>
        </div>`}
      </div>`;
    }).join('') || '<p class="panel-empty">Ветка появится после первого коммита.</p>';
  }
  function renderBanner() {
    const banner = $('#git-banner');
    banner.hidden = !st.state;
    if (st.state) {
      const conflicts = files().filter(file => file.status === 'U').map(file => file.path);
      banner.innerHTML = `<span>Незаконченное ${st.state === 'rebase' ? 'перебазирование' : st.state === 'revert' ? 'откатывание' : 'слияние'}${conflicts.length ? `: конфликт в ${esc(conflicts.slice(0, 3).join(', '))}${conflicts.length > 3 ? ' …' : ''}` : ''}.</span><button class="button small" type="button" data-git="abort" data-explain="abort">Отменить слияние</button>`;
    }
  }
  function renderOutput() {
    const box = $('#git-output');
    box.hidden = !lastOutput?.text;
    if (lastOutput?.text) {
      box.querySelector('summary').textContent = `Ответ Git на «${lastOutput.title}»`;
      box.querySelector('pre').textContent = lastOutput.text;
    }
  }
  function renderExplain() {
    const line = $('#git-explain');
    if (!line) return;
    const info = hover ? describe(hover.action, hover) : null;
    const flow = $('#git-flow');
    if (flow) {
      for (const box of flow.querySelectorAll('.flow-box')) box.classList.toggle('lit', Boolean(info?.lit?.includes(box.dataset.box)));
      for (const button of flow.querySelectorAll('.flow-arrow')) button.classList.toggle('lit', info?.arrow === button.dataset.git);
      for (const badge of flow.querySelectorAll('.flow-delta')) {
        const text = info?.delta?.[badge.dataset.delta];
        badge.textContent = text || '';
        badge.classList.toggle('show', Boolean(text));
      }
    }
    line.className = 'flow-explain';
    if (busy) { line.innerHTML = `<span class="spinner"></span>${esc(busyText())}`; return; }
    if (info) { line.textContent = info.text; line.classList.add(info.blocked ? 'muted' : 'lit'); return; }
    if (lastError) {
      line.textContent = lastError;
      line.classList.add('error');
      if (/конфликт/i.test(lastError)) line.insertAdjacentHTML('beforeend', '<button class="button small" type="button" data-git="ask">Разобрать с DeepSeek</button>');
      return;
    }
    line.textContent = mode === 'norepo' ? '' : nextStep();
  }
  const BUSY_TEXT = { commit: 'Сохраняю коммит…', push: 'Отправляю на сервер…', pull: 'Получаю с сервера…', fetch: 'Проверяю сервер…', undo: 'Отменяю коммит…',
    stash: 'Откладываю изменения…', ignore: 'Обновляю .gitignore…', unstash: 'Возвращаю отложенное…', discard: 'Отменяю изменения…', revert: 'Создаю откатывающий коммит…', switch: 'Переключаю ветку…',
    merge: 'Сливаю ветки…', 'delete-branch': 'Удаляю ветку…', 'create-branch': 'Создаю ветку…', abort: 'Отменяю слияние…', init: 'Включаю Git…', remote: 'Подключаю сервер…' };
  const busyText = () => BUSY_TEXT[busy] || 'Git работает…';

  /* ------------------------------------------------------------ diff */

  function parseDiff(text) {
    const rows = [];
    let oldLine = 0, newLine = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) { const match = / b\/(.*)$/.exec(line); rows.push({ kind: 'file', text: match ? match[1] : line }); continue; }
      if (/^(index |--- |\+\+\+ |old mode|new mode|similarity index|dissimilarity index)/.test(line)) continue;
      if (/^new file mode/.test(line)) { rows.push({ kind: 'meta', text: 'Новый файл' }); continue; }
      if (/^deleted file mode/.test(line)) { rows.push({ kind: 'meta', text: 'Файл удалён' }); continue; }
      if (line.startsWith('rename from ')) { rows.push({ kind: 'meta', text: `Переименован из ${line.slice(12)}` }); continue; }
      if (line.startsWith('rename to ')) continue;
      if (/^Binary files/.test(line)) { rows.push({ kind: 'meta', text: 'Бинарный файл — содержимое не показывается' }); continue; }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); rows.push({ kind: 'hunk', text: hunk[3].trim() ? `…${hunk[3]}` : '…' }); continue; }
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) rows.push({ kind: 'add', old: '', next: newLine++, text: line.slice(1) });
      else if (line.startsWith('-')) rows.push({ kind: 'del', old: oldLine++, next: '', text: line.slice(1) });
      else if (line.startsWith(' ')) rows.push({ kind: 'ctx', old: oldLine++, next: newLine++, text: line.slice(1) });
    }
    return rows;
  }
  function renderDiffBody(text, truncated, showFiles) {
    const rows = parseDiff(text).filter(row => showFiles || row.kind !== 'file');
    if (!rows.length) return '<p class="panel-empty">Содержимое не изменилось (поменялись только права или имя).</p>';
    const shown = rows.slice(0, MAX_DIFF_LINES);
    const html = shown.map(row => {
      if (row.kind === 'file') return `<div class="dl file">${icon('file')}${esc(row.text)}</div>`;
      if (row.kind === 'meta') return `<div class="dl meta">${esc(row.text)}</div>`;
      if (row.kind === 'hunk') return `<div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="code">${esc(row.text)}</span></div>`;
      const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
      return `<div class="dl ${row.kind}"><span class="ln">${row.old}</span><span class="ln">${row.next}</span><span class="code"><span class="sign">${sign}</span>${esc(row.text) || ' '}</span></div>`;
    }).join('');
    const more = rows.length > MAX_DIFF_LINES || truncated ? '<p class="panel-empty">Изменения слишком большие — показано начало.</p>' : '';
    return `<div class="diff-lines">${html}</div>${more}`;
  }
  function renderDiff() {
    if (mode !== 'repo') return;
    const head = $('#git-diff-head'), body = $('#git-diff');
    if (!active || !diffData) {
      head.innerHTML = '<h3>Что изменилось</h3><span class="legend"><span class="add">зелёное</span> — добавлено, <span class="del">красное</span> — удалено</span>';
      body.innerHTML = `<p class="panel-empty">${active ? '<span class="spinner"></span>' : files().length ? 'Нажмите на файл слева.' : commits.length ? 'Нажмите на коммит в истории, чтобы увидеть его изменения.' : ''}</p>`;
      return;
    }
    if (active.type === 'file') {
      const file = files().find(item => item.path === active.path);
      head.innerHTML = `<h3 class="mono" title="${esc(active.path)}">${esc(active.path)}</h3>${file && file.added != null ? `<span class="legend"><span class="add">+${file.added}</span> <span class="del">−${file.removed}</span></span>` : ''}`;
      body.innerHTML = diffData.binary ? '<p class="panel-empty">Бинарный файл — содержимое не показывается.</p>' : renderDiffBody(diffData.diff, diffData.truncated, false);
    } else {
      head.innerHTML = `<h3 title="${esc(diffData.subject)}">${esc(diffData.subject)}</h3><span class="legend mono">${esc(diffData.short)} · ${esc(diffData.author)}</span>`;
      body.innerHTML = (diffData.body ? `<p class="commit-body">${esc(diffData.body)}</p>` : '') + renderDiffBody(diffData.diff, diffData.truncated, true);
    }
  }
  async function openFile(path) {
    active = { type: 'file', path };
    diffData = null;
    renderFiles(); renderLog(); renderDiff();
    const token = ++loadToken;
    try {
      const data = await api('/api/git/diff', { path });
      if (token === loadToken) { diffData = data; renderDiff(); }
    } catch (error) {
      if (token === loadToken) { active = null; renderDiff(); toast(error.message, { error: true }); }
    }
  }
  async function openCommit(hash) {
    active = { type: 'commit', hash };
    diffData = null;
    renderFiles(); renderLog(); renderDiff();
    const token = ++loadToken;
    try {
      const data = await api('/api/git/show', { hash });
      if (token === loadToken) { diffData = data; renderDiff(); }
    } catch (error) {
      if (token === loadToken) { active = null; renderDiff(); toast(error.message, { error: true }); }
    }
  }

  /* ------------------------------------------------------------ data */

  async function refresh({ quiet = false } = {}) {
    if (!visible) return;
    if (!st && !quiet) skeleton('loading');
    let status, log;
    try {
      [status, log] = await Promise.all([api('/api/git/status'), api('/api/git/log')]);
    } catch (error) {
      if (/Git не найден/.test(error.message)) { skeleton('missing'); return; }
      lastError = error.message;
      if (mode === 'repo') renderExplain(); else toast(error.message, { error: true });
      return;
    }
    if (!status.repo) { st = null; commits = []; plainCwd = status.cwd || ''; skeleton('norepo'); render(); return; }
    const rootChanged = st?.root !== status.root;
    st = status;
    commits = log.commits || [];
    const paths = new Set(st.files.map(file => file.path));
    // New changes start checked, like a fresh “commit all”; unchecking is remembered while the file stays changed.
    for (const file of st.files) if (!known.has(file.path) && !file.junk) selected.add(file.path);
    for (const path of [...selected]) if (!paths.has(path)) selected.delete(path);
    known = paths;
    if (rootChanged) { mode = ''; active = null; diffData = null; lastOutput = null; lastError = ''; }
    skeleton('repo');
    if (active?.type === 'file' && !paths.has(active.path)) { active = null; diffData = null; }
    if (active?.type === 'commit' && !commits.some(entry => entry.hash === active.hash)) { active = null; diffData = null; }
    if (!active && st.files.length) { openFile(st.files[0].path); }
    else if (active?.type === 'file') openFile(active.path);
    render(); renderDiff();
    if (!quiet && st.remotes.length && Date.now() - lastFetch > 5 * 60 * 1000) quietFetch();
  }
  async function quietFetch() {
    if (fetchingQuietly || busy) return;
    lastFetch = Date.now();
    fetchingQuietly = true;
    if (mode === 'repo') renderFlow();
    try { await api('/api/git/fetch', { quiet: true }); } catch { /* offline or needs a login: the button still works */ }
    fetchingQuietly = false;
    await refresh({ quiet: true });
  }
  async function op(name, path, body = {}, success = '') {
    if (busy) return null;
    busy = name; lastError = '';
    render();
    let result = null;
    try {
      result = await api(path, body);
      lastOutput = result.output ? { title: BUSY_LABEL[name] || name, text: result.output } : null;
      if (success) toast(typeof success === 'function' ? success(result) : success);
    } catch (error) {
      lastError = error.message;
      lastOutput = error.output ? { title: BUSY_LABEL[name] || name, text: error.output } : null;
      toast(error.message, { error: true });
    } finally {
      busy = '';
      focusHover = null;
      await refresh({ quiet: true });
      window.Orbit.refreshStatus();
    }
    return result;
  }
  const BUSY_LABEL = { commit: 'Коммит', push: 'Push', pull: 'Pull', fetch: 'Проверить сервер', undo: 'Отменить коммит', stash: 'Отложить', unstash: 'Вернуть отложенное',
    discard: 'Отменить изменения', ignore: 'Не отслеживать', revert: 'Откатить', switch: 'Перейти на ветку', merge: 'Слить ветку', 'delete-branch': 'Удалить ветку', 'create-branch': 'Создать ветку',
    abort: 'Отменить слияние', init: 'Включить Git', remote: 'Подключить сервер' };

  /* ------------------------------------------------------------ actions */

  async function commit() {
    if (busy) return;
    const paths = selectedFiles().map(file => file.path);
    if (!paths.length) { setHoverAction('commit'); toast('Отметьте галочками файлы для коммита.'); return; }
    const subject = $('#git-subject').value.trim();
    if (!subject) { $('#git-subject').focus(); toast('Напишите название — или нажмите «Написать с DeepSeek».'); return; }
    const result = await op('commit', '/api/git/commit', { paths, subject, body: $('#git-body').value.trim() },
      data => `Коммит ${data.hash} сохранён. ${st?.remotes?.length ? 'Чтобы отправить его на сервер, нажмите Push.' : ''}`);
    if (result) { $('#git-subject').value = ''; $('#git-body').value = ''; saveDraft(); }
  }
  async function generate() {
    if (generating) { try { await api('/api/stop', { conversation_id: 'git-message' }); } catch {} return; }
    if (busy) return;
    const paths = selectedFiles().map(file => file.path);
    if (!paths.length) { toast('Отметьте файлы — DeepSeek опишет их изменения.'); return; }
    generating = true; lastError = '';
    updateCommitButton();
    $('#git-explain').innerHTML = '<span class="spinner"></span>DeepSeek читает изменения…';
    try {
      const draft = [$('#git-subject').value.trim(), $('#git-body').value.trim()].filter(Boolean).join('\n');
      const result = await api('/api/git/message', { paths, draft });
      $('#git-subject').value = result.subject;
      $('#git-body').value = result.body;
      saveDraft();
      toast('Проверьте текст и нажмите «Коммит».');
    } catch (error) {
      if (error.status !== 409 || !/остановлена/.test(error.message)) { lastError = error.message; toast(error.message, { error: true }); }
    } finally {
      generating = false;
      updateCommitButton(); renderExplain();
    }
  }
  async function createBranch() {
    const name = $('#git-branch-input').value.trim();
    if (!name) { $('#git-branch-input').focus(); return; }
    const result = await op('create-branch', '/api/git/switch', { branch: name, create: true }, `Вы на новой ветке ${name}`);
    if (result) $('#git-branch-input').value = '';
  }
  async function connectRemote(url) {
    url = (url || '').trim();
    if (!url) { $('#git-remote-input')?.focus(); return; }
    const result = await op('remote', '/api/git/remote', { url }, 'Сервер подключён. Теперь можно нажать Push.');
    if (result && $('#git-remote-input')) $('#git-remote-input').value = '';
  }
  async function act(name, element) {
    const info = describe(name, element.dataset);
    if (element.getAttribute('aria-disabled') === 'true' || (info?.blocked && name !== 'commit' && name !== 'generate')) {
      setHover(element);
      if (info?.blocked) toast(info.text);
      return;
    }
    const branch = element.dataset.branch, path = element.dataset.path, hash = element.dataset.hash;
    switch (name) {
      case 'commit': return commit();
      case 'generate': return generate();
      case 'select-all': {
        const all = selected.size === files().length;
        selected = all ? new Set() : new Set(files().map(file => file.path));
        renderFiles(); renderFlow(); updateCommitButton(); return renderExplain();
      }
      case 'undo': return op('undo', '/api/git/undo', {}, data => `Коммит «${data.subject}» отменён, его изменения снова в списке.`);
      case 'push': return op('push', '/api/git/push', {}, 'Отправлено на сервер.');
      case 'pull': return op('pull', '/api/git/pull', {}, 'Получено с сервера.');
      case 'fetch': {
        lastFetch = Date.now();
        if (await op('fetch', '/api/git/fetch', {})) toast(st?.behind ? `На сервере ${count(st.behind, 'новый коммит', 'новых коммита', 'новых коммитов')}.` : 'На сервере ничего нового.');
        return;
      }
      case 'stash': return op('stash', '/api/git/stash', {}, 'Изменения отложены. Вернуть их можно кнопкой «Вернуть отложенное».');
      case 'unstash': return op('unstash', '/api/git/unstash', {}, 'Отложенные изменения вернулись.');
      case 'ignore': return op('ignore', '/api/git/ignore', { path }, data => `В .gitignore добавлено: ${data.pattern}`);
      case 'discard': {
        const file = files().find(item => item.path === path);
        if (!await confirmDialog({ title: file?.untracked ? 'Удалить новый файл?' : 'Отменить изменения в файле?', text: esc(describe('discard', { path }).text), ok: file?.untracked ? 'Удалить' : 'Отменить изменения', danger: true })) return;
        return op('discard', '/api/git/discard', { paths: [path] }, 'Готово.');
      }
      case 'revert': {
        const entry = commits.find(item => item.hash === hash);
        if (!await confirmDialog({ title: 'Откатить коммит?', text: `«${esc(entry?.subject || hash)}»\n\n${esc(describe('revert').text)}`, ok: 'Откатить' })) return;
        return op('revert', '/api/git/revert', { hash }, 'Создан откатывающий коммит.');
      }
      case 'switch': return op('switch', '/api/git/switch', { branch }, `Вы на ветке ${branch}`);
      case 'merge':
        if (!await confirmDialog({ title: `Слить ${esc(branch)} в ${esc(st.branch)}?`, text: esc(describe('merge', { branch }).text), ok: 'Слить' })) return;
        return op('merge', '/api/git/merge', { branch }, 'Ветки слиты.');
      case 'delete-branch':
        if (!await confirmDialog({ title: `Удалить ветку ${esc(branch)}?`, text: esc(describe('delete-branch', { branch }).text), ok: 'Удалить', danger: true })) return;
        return op('delete-branch', '/api/git/delete-branch', { branch }, `Ветка ${branch} удалена.`);
      case 'abort': return op('abort', '/api/git/abort', {}, 'Слияние отменено.');
      case 'init': return op('init', '/api/git/init', {}, 'Git включён. Теперь здесь видны все файлы как новые — сделайте первый коммит.');
      case 'workspace': return window.Orbit.openWorkspace();
      case 'ask': return window.Orbit.startChat(`Git сообщил: «${lastError}». Помоги разобраться с конфликтом: посмотри git status и diff, объясни, что пересекается, и предложи, как объединить изменения.`);
      case 'edit-remote': {
        const url = await promptDialog({ title: 'Адрес сервера', value: st?.remote_url || '' });
        if (url) connectRemote(url);
        return;
      }
    }
  }

  /* ------------------------------------------------------------ events */

  const hoverOf = element => element ? { action: element.dataset.explain, path: element.dataset.path, hash: element.dataset.hash, branch: element.dataset.branch } : null;
  function updateHover() {
    const next = pointerHover || focusHover;
    if (JSON.stringify(next) === JSON.stringify(hover)) return;
    hover = next;
    renderExplain();
  }
  function setHover(element) { pointerHover = hoverOf(element); updateHover(); }
  function setHoverAction(action) { pointerHover = { action }; updateHover(); }
  root.addEventListener('pointerover', event => setHover(event.target.closest('[data-explain]')));
  root.addEventListener('pointerleave', () => setHover(null));
  // Only keyboard focus explains an action; focus left on a clicked button would pin an outdated sentence.
  root.addEventListener('focusin', event => { const target = event.target.closest('[data-explain]'); focusHover = target?.matches(':focus-visible') ? hoverOf(target) : null; updateHover(); });
  root.addEventListener('focusout', () => { focusHover = null; updateHover(); });
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-git]');
    if (action) { event.preventDefault(); act(action.dataset.git, action); return; }
    const file = event.target.closest('[data-open-file]');
    if (file) { openFile(file.dataset.openFile); return; }
    const entry = event.target.closest('[data-open-commit]');
    if (entry) openCommit(entry.dataset.openCommit);
  });
  root.addEventListener('submit', event => {
    // A disabled-looking submit button must not run the action.
    const button = event.submitter;
    if (button?.getAttribute('aria-disabled') === 'true') { event.preventDefault(); event.stopImmediatePropagation(); setHover(button); toast(describe(button.dataset.explain)?.text || ''); }
  }, true);
  root.addEventListener('change', event => {
    const box = event.target.closest('[data-check]');
    if (!box) return;
    if (box.checked) selected.add(box.dataset.check); else selected.delete(box.dataset.check);
    renderFlow(); updateCommitButton(); renderExplain();
    const toggle = root.querySelector('[data-git="select-all"]');
    if (toggle) toggle.textContent = selected.size === files().length ? 'Снять все' : 'Отметить все';
  });
  document.addEventListener('visibilitychange', () => { if (visible && !document.hidden && !busy) refresh({ quiet: true }); });

  window.OrbitGit = {
    show() { visible = true; refresh(); },
    hide() { visible = false; hover = pointerHover = focusHover = null; },
    busy: () => Boolean(busy) || generating,
    workspaceChanged() { st = null; mode = ''; selected = new Set(); known = new Set(); active = null; diffData = null; lastFetch = 0; lastOutput = null; lastError = ''; if (visible) refresh(); },
    runFinished() { if (visible) refresh({ quiet: true }); },
  };
})();
