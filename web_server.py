"""Loopback-only web interface for the DeepSeek terminal harness.

Run: python web_server.py [--port 8765]
Chat responses are newline-delimited JSON; all other API responses are JSON.
"""

import argparse
import json
import mimetypes
import os
from pathlib import Path
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import uuid

import deepseek_client as client
import git_tools

MAX_BODY = 768 * 1024
MAX_CONVERSATIONS = 256
# Instead of a hard command limit, every CHECKPOINT_COMMANDS-th command in a row needs the user's
# click even with auto-approve on, so a runaway loop stops but long tasks can go on.
CHECKPOINT_COMMANDS = 25
# How many times DeepSeek is asked to resend a broken terminal block before the turn ends.
MAX_REPAIRS = 2
MAX_CONTEXT_EVENT = 20000
BROKEN_BLOCK_PROMPT = ('Оболочка: terminal-блок в твоём ответе был пустым или незакрытым, поэтому команда не '
                       'выполнялась. Если команда нужна, повтори её целиком одним блоком <terminal>команда</terminal> '
                       'в конце ответа. Если не нужна, ответь без terminal-тегов.')
# Told to DeepSeek with the user's next message, so it knows why its last command has no result.
BROKEN_BLOCK_NOTE = 'Оболочка: terminal-блок в твоём прошлом ответе был пустым или незакрытым, команда не выполнялась.\n'
DECLINED_NOTE = 'Оболочка: пользователь отклонил команду из твоего прошлого ответа, она не выполнялась.\n'
STOPPED_NOTE = 'Оболочка: пользователь остановил запрос, результат команды из твоего прошлого ответа не получен.\n'
WEB_ROOT = Path(__file__).resolve().parent / 'web'


class APIError(Exception):
    def __init__(self, status, message, output=''):
        self.status = status
        self.message = message
        self.output = output


# Git endpoints: path -> (handler taking (cwd, body), changes the repository).
GIT_ROUTES = {
    '/api/git/diff': (lambda cwd, body: git_tools.diff(cwd, body.get('path')), False),
    '/api/git/show': (lambda cwd, body: git_tools.show(cwd, body.get('hash')), False),
    '/api/git/commit': (lambda cwd, body: git_tools.commit(cwd, body.get('paths'), body.get('subject'),
                                                           body.get('body', '')), True),
    '/api/git/discard': (lambda cwd, body: git_tools.discard(cwd, body.get('paths')), True),
    '/api/git/undo': (lambda cwd, body: git_tools.undo_commit(cwd), True),
    '/api/git/ignore': (lambda cwd, body: git_tools.ignore(cwd, body.get('path')), True),
    '/api/git/revert': (lambda cwd, body: git_tools.revert(cwd, body.get('hash')), True),
    '/api/git/abort': (lambda cwd, body: git_tools.abort(cwd), True),
    '/api/git/stash': (lambda cwd, body: git_tools.stash(cwd), True),
    '/api/git/unstash': (lambda cwd, body: git_tools.unstash(cwd), True),
    '/api/git/pull': (lambda cwd, body: git_tools.pull(cwd), True),
    '/api/git/push': (lambda cwd, body: git_tools.push(cwd), True),
    '/api/git/fetch': (lambda cwd, body: git_tools.fetch(cwd, quiet=body.get('quiet') is True), True),
    '/api/git/switch': (lambda cwd, body: git_tools.switch(cwd, body.get('branch'), body.get('create') is True), True),
    '/api/git/merge': (lambda cwd, body: git_tools.merge(cwd, body.get('branch')), True),
    '/api/git/delete-branch': (lambda cwd, body: git_tools.delete_branch(cwd, body.get('branch')), True),
    '/api/git/init': (lambda cwd, body: git_tools.init(cwd), True),
    '/api/git/remote': (lambda cwd, body: git_tools.set_remote(cwd, body.get('url')), True),
}
GIT_MESSAGE_RUN = 'git-message'


class PendingApproval:
    def __init__(self, run):
        self.run = run
        self.event = threading.Event()
        self.approved = False
        self.decided = False


class Run:
    def __init__(self, conversation_id):
        self.conversation_id = conversation_id
        self.stop = threading.Event()


def pick_workspace_directory():
    import tkinter
    from tkinter import filedialog

    root = None
    try:
        root = tkinter.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        return filedialog.askdirectory(parent=root, title='Выберите рабочую папку',
                                       initialdir=os.getcwd(), mustexist=True)
    finally:
        if root is not None:
            root.destroy()


class AppState:
    def __init__(self, web_root=WEB_ROOT):
        self.web_root = Path(web_root).resolve()
        self.lock = threading.Lock()
        self.conversations = {}
        self.active = None
        self.pending = {}
        self.authenticating = False
        self.auth_error = ''
        self.selecting_workspace = False
        self.workspace_error = ''
        self.git_busy = False

    def _blocked(self):
        return self.active is not None or self.authenticating or self.selecting_workspace or self.git_busy

    def status(self):
        try:
            client.load_config(auto_auth=False)
            configured = True
        except client.AuthenticationError:
            configured = False
        branch = git_tools.current_branch(os.getcwd())
        with self.lock:
            return {
                'configured': configured, 'cwd': os.getcwd(), 'platform': sys.platform, 'branch': branch,
                'system_prompt': client.SYSTEM_INIT_PROMPT, 'busy': self.active is not None,
                'authenticating': self.authenticating, 'auth_error': self.auth_error,
                'selecting_workspace': self.selecting_workspace, 'workspace_error': self.workspace_error,
            }

    def start_run(self, conversation_id, register=True):
        with self.lock:
            if self._blocked():
                raise APIError(409, 'Запрос, авторизация, выбор папки или операция Git уже выполняется.')
            if register and conversation_id not in self.conversations:
                if len(self.conversations) >= MAX_CONVERSATIONS:
                    raise APIError(409, 'Достигнут предел диалогов. Перезапустите сервер.')
                self.conversations[conversation_id] = {'parent': None, 'started': False, 'session': None, 'note': ''}
            run = Run(conversation_id)
            self.active = run
            return run

    def finish_run(self, run):
        with self.lock:
            for request_id, approval in list(self.pending.items()):
                if approval.run is run:
                    approval.event.set()
                    del self.pending[request_id]
            if self.active is run:
                self.active = None

    def stop_run(self, conversation_id):
        with self.lock:
            run = self.active
            if run is None or run.conversation_id != conversation_id:
                return False
            run.stop.set()
            for approval in self.pending.values():
                if approval.run is run:
                    approval.event.set()
            return True

    def approve(self, request_id, approved):
        with self.lock:
            approval = self.pending.get(request_id)
            if approval is None or approval.run.stop.is_set():
                raise APIError(404, 'Запрос разрешения не найден или уже отменён.')
            if approval.decided:
                raise APIError(409, 'Ответ на этот запрос разрешения уже получен.')
            approval.decided = True
            approval.approved = approved
            approval.event.set()

    def authenticate(self):
        with self.lock:
            if self._blocked():
                raise APIError(409, 'Дождитесь завершения запроса, авторизации, выбора папки или операции Git.')
            self.authenticating = True
            self.auth_error = ''

        def worker():
            error = ''
            try:
                import auth_fetcher
                if not auth_fetcher.fetch_tokens_and_save():
                    error = 'Авторизация не завершена. Попробуйте ещё раз.'
                else:
                    client.load_config(auto_auth=False)
            except Exception:
                error = 'Не удалось выполнить авторизацию. Проверьте браузер и повторите попытку.'
            finally:
                with self.lock:
                    self.auth_error = error
                    self.authenticating = False
                    if not error:
                        # A new remote session cannot reuse the old session's message IDs.
                        self.conversations.clear()

        threading.Thread(target=worker, name='deepseek-auth', daemon=True).start()

    @staticmethod
    def _change_workspace(path):
        if not isinstance(path, str) or not path.strip() or len(path) > 32767 or '\x00' in path:
            raise APIError(400, 'Укажите корректный путь к существующей папке.')
        try:
            if not os.path.isdir(path):
                raise APIError(400, 'Рабочая папка не найдена или недоступна.')
            os.chdir(path)
            return os.getcwd()
        except (OSError, ValueError, UnicodeError):
            raise APIError(400, 'Не удалось открыть рабочую папку. Проверьте путь и права доступа.') from None

    def set_workspace(self, path):
        with self.lock:
            if self._blocked():
                raise APIError(409, 'Дождитесь завершения запроса, авторизации, выбора папки или операции Git.')
            try:
                cwd = self._change_workspace(path)
            except APIError as exc:
                self.workspace_error = exc.message
                raise
            self.workspace_error = ''
            return cwd

    def pick_workspace(self):
        with self.lock:
            if self._blocked():
                raise APIError(409, 'Дождитесь завершения запроса, авторизации, выбора папки или операции Git.')
            self.selecting_workspace = True
            self.workspace_error = ''

        def worker():
            error = ''
            try:
                path = pick_workspace_directory()
                if path:
                    with self.lock:
                        self._change_workspace(path)
            except APIError as exc:
                error = exc.message
            except ImportError:
                error = 'Окно выбора папки недоступно: установите Tkinter или введите путь вручную.'
            except Exception:
                error = 'Не удалось выбрать рабочую папку. Повторите попытку или введите путь вручную.'
            finally:
                with self.lock:
                    self.workspace_error = error
                    self.selecting_workspace = False

        try:
            threading.Thread(target=worker, name='deepseek-workspace', daemon=True).start()
        except Exception:
            with self.lock:
                self.selecting_workspace = False
                self.workspace_error = 'Не удалось открыть окно выбора папки. Введите путь вручную.'
                raise APIError(503, self.workspace_error) from None

    def git(self, path, body):
        handler, writes = GIT_ROUTES[path]
        if writes:
            with self.lock:
                if self.active is not None:
                    raise APIError(409, 'Дождитесь, пока DeepSeek закончит ответ: он может работать с этой папкой.')
                if self.git_busy or self.authenticating or self.selecting_workspace:
                    raise APIError(409, 'Дождитесь завершения текущей операции.')
                self.git_busy = True
        try:
            return handler(os.getcwd(), body)
        except git_tools.GitError as exc:
            raise APIError(400, exc.message, exc.output[-20000:]) from None
        finally:
            if writes:
                with self.lock:
                    self.git_busy = False

    def git_read(self, kind):
        try:
            return git_tools.status(os.getcwd()) if kind == 'status' else git_tools.log(os.getcwd())
        except git_tools.GitError as exc:
            raise APIError(400, exc.message, exc.output[-20000:]) from None

    def git_message(self, run, body):
        try:
            context = git_tools.message_context(os.getcwd(), body.get('paths'))
        except git_tools.GitError as exc:
            raise APIError(400, exc.message) from None
        config = client.load_config(auto_auth=False)
        # A separate chat on the site, so commit messages do not mix with the user's dialogs.
        session = client.create_chat_session(config, stop_event=run.stop)
        result = client.send_chat_completion(
            dict(config, chat_session_id=session), git_tools.commit_message_prompt(context, body.get('draft', '')),
            None, search_enabled=False, thinking_enabled=False, sse_callback=lambda event: None, stop_event=run.stop,
        )
        if not isinstance(result, tuple) or len(result) != 2:
            raise client.ChatError('DeepSeek не вернул ответ.')
        try:
            subject, message_body = git_tools.parse_commit_message(result[1])
        except git_tools.GitError as exc:
            raise client.ChatError(exc.message) from None
        return {'subject': subject, 'body': message_body}

    def chat(self, run, body, emit):
        config = client.load_config(auto_auth=False)
        conversation = self.conversations[run.conversation_id]
        prompt = body['message']
        if not conversation['started']:
            prompt = client.initial_prompt(prompt, body.get('system_prompt', client.SYSTEM_INIT_PROMPT),
                                           history=body.get('history'))
        else:
            prompt = f"{conversation['note']}{client.turn_context()}\n\nЗапрос пользователя:\n{prompt}"
        if conversation['session'] is None:
            # Every dialog gets its own chat on the site. Writing into config.json's chat with no parent
            # would replace that chat's first message and keep its settings, so a failure is an error.
            emit({'type': 'status', 'content': 'Создание чата на сайте DeepSeek...'})
            conversation['session'] = client.create_chat_session(config, stop_event=run.stop)
            emit({'type': 'session', 'url': f"https://chat.deepseek.com/a/chat/s/{conversation['session']}"})
        session_config = dict(config, chat_session_id=conversation['session'])
        emit({'type': 'context', 'length': len(prompt), 'content': prompt[:MAX_CONTEXT_EVENT]})
        executed = repairs = 0
        while True:
            client.check_cancelled(run.stop)
            result = client.send_chat_completion(
                session_config, prompt, conversation['parent'], search_enabled=body.get('search', False),
                thinking_enabled=body.get('thinking', True), sse_callback=emit, stop_event=run.stop,
            )
            client.check_cancelled(run.stop)
            if not isinstance(result, tuple) or len(result) != 2:
                raise client.ChatError('DeepSeek не вернул ответ. Проверьте авторизацию и повторите запрос.')
            conversation['parent'], response = result
            conversation['started'] = True
            conversation['note'] = ''
            commands = client.terminal_blocks(response)
            # DeepSeek sometimes forgets the tags; a shell fence that ends the reply counts as the command.
            fenced = not commands and client.fenced_command(response)
            if fenced:
                commands = [fenced]
            if not commands:
                if '<terminal>' not in response:
                    return
                if repairs == MAX_REPAIRS:
                    conversation['note'] = BROKEN_BLOCK_NOTE
                    emit({'type': 'notice', 'content': 'Пустой или незакрытый terminal-блок: команда не выполнялась.'})
                    return
                repairs += 1
                emit({'type': 'notice', 'content': 'Пустой или незакрытый terminal-блок — DeepSeek попросили повторить команду.'})
                prompt = f'{BROKEN_BLOCK_PROMPT}\n\n{client.turn_context()}'
                continue
            repairs = 0
            command = commands[0]
            request_id = uuid.uuid4().hex
            approval = PendingApproval(run)
            with self.lock:
                self.pending[request_id] = approval
            conversation['note'] = STOPPED_NOTE
            try:
                emit({'type': 'terminal_request', 'id': request_id, 'command': command, 'cwd': os.getcwd(),
                      'fenced': bool(fenced),
                      'checkpoint': executed if executed and executed % CHECKPOINT_COMMANDS == 0 else 0})
                while not approval.event.wait(0.2):
                    client.check_cancelled(run.stop)
                client.check_cancelled(run.stop)
                if not approval.approved:
                    conversation['note'] = DECLINED_NOTE
                    emit({'type': 'terminal_done', 'id': request_id, 'approved': False,
                          'content': 'Выполнение команды отклонено.'})
                    return
                started = time.monotonic()
                output = client.execute_terminal_command_with_callback(
                    command,
                    callback=lambda content: emit({'type': 'terminal_output', 'id': request_id, 'content': content}),
                    stop_event=run.stop,
                )
                client.check_cancelled(run.stop)
                executed += 1
                emit({'type': 'terminal_done', 'id': request_id, 'approved': True, 'content': output,
                      'elapsed': round(time.monotonic() - started, 2)})
                skipped = ''
                if len(commands) > 1:
                    skipped = f'Выполнена только первая команда, остальные ({len(commands) - 1}) пропущены.\n'
                prompt = f'{skipped}Результат разрешённой команды:\n{output}\n\n{client.turn_context()}'
            finally:
                with self.lock:
                    self.pending.pop(request_id, None)


class LocalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server bind a port the first still listens on, and
    # requests then reach either one at random. Take the port exclusively there instead.
    allow_reuse_address = not sys.platform.startswith('win')

    def __init__(self, address=('127.0.0.1', 8765), state=None):
        if address[0] != '127.0.0.1':
            raise ValueError('The server must bind to 127.0.0.1.')
        self.state = state if state is not None else AppState()
        super().__init__(address, Handler)

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def server_close(self):
        with self.state.lock:
            if self.state.active is not None:
                self.state.active.stop.set()
            for approval in self.state.pending.values():
                approval.event.set()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'DeepSeekLocal/1.0'
    sys_version = ''

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args):
        # Do not log query strings, messages, commands, or auth details.
        pass

    def _guard(self):
        port = self.server.server_port
        allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if port == 80:
            allowed_hosts.update(('127.0.0.1', 'localhost'))
        hosts = self.headers.get_all('Host', [])
        if len(hosts) != 1 or hosts[0].lower() not in allowed_hosts:
            raise APIError(403, 'Invalid Host. Open this service using its local URL.')
        origins = self.headers.get_all('Origin', [])
        if origins and (len(origins) != 1 or origins[0].lower() != 'http://' + hosts[0].lower()):
            raise APIError(403, 'Cross-origin requests are not allowed.')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError(403, 'Cross-site requests are not allowed.')

    def _headers(self, status, content_type, length=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header('Connection', 'close')
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.end_headers()
        self.close_connection = True

    def _json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self._headers(status, 'application/json; charset=utf-8', len(payload))
        self.wfile.write(payload)

    def _body(self, allow_empty=False):
        if self.headers.get('Transfer-Encoding'):
            raise APIError(400, 'Transfer-Encoding is not supported.')
        lengths = self.headers.get_all('Content-Length', [])
        if allow_empty and (not lengths or lengths == ['0']):
            return {}
        if len(lengths) != 1 or not lengths[0].isdigit():
            raise APIError(411, 'A single Content-Length is required.')
        if len(lengths[0]) > 10:
            raise APIError(413, 'Request body is too large.')
        length = int(lengths[0])
        if length > MAX_BODY:
            raise APIError(413, 'Request body is too large.')
        if self.headers.get_content_type() != 'application/json':
            raise APIError(415, 'Use application/json.')
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            body = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError, RecursionError):
            raise APIError(400, 'Invalid JSON body.') from None
        if not isinstance(body, dict):
            raise APIError(400, 'JSON body must be an object.')
        return body

    @staticmethod
    def _string(body, field, limit=128):
        value = body.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > limit or '\x00' in value:
            raise APIError(400, f'Invalid {field}.')
        return value

    @staticmethod
    def _history(body):
        history = body.get('history', [])
        if not isinstance(history, list) or len(history) > 30:
            raise APIError(400, 'history must be an array of at most 30 messages.')
        total = 0
        for entry in history:
            if not isinstance(entry, dict) or entry.get('role') not in ('user', 'assistant'):
                raise APIError(400, 'Each history entry must have role user or assistant.')
            content = entry.get('content')
            if not isinstance(content, str) or len(content) > 24000 or '\x00' in content:
                raise APIError(400, 'Each history content must be a string of at most 24000 characters.')
            total += len(content)
        if total > 64000:
            raise APIError(400, 'history content must total at most 64000 characters.')

    def _path(self):
        parsed = urlsplit(self.path)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise APIError(400, 'Invalid request path.')
        return parsed.path

    def do_GET(self):
        try:
            self._guard()
            path = self._path()
            if path == '/api/status':
                self._json(200, self.server.state.status())
            elif path in ('/api/git/status', '/api/git/log'):
                self._json(200, self.server.state.git_read(path.rsplit('/', 1)[1]))
            elif path.startswith('/api/'):
                raise APIError(404, 'Unknown API endpoint.')
            else:
                self._static(path)
        except APIError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionError, TimeoutError):
            pass

    def _error(self, exc):
        self._json(exc.status, {'error': exc.message, **({'output': exc.output} if exc.output else {})})

    def _static(self, path):
        path = unquote(path)
        if '\\' in path or '\x00' in path or any(part.startswith('.') for part in path.split('/') if part):
            raise APIError(404, 'Not found.')
        root = self.server.state.web_root
        target = (root / ('index.html' if path == '/' else path.lstrip('/'))).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise APIError(404, 'Not found.')
        try:
            content = target.read_bytes()
        except OSError:
            raise APIError(404, 'Not found.') from None
        mime = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        self._headers(200, mime, len(content))
        self.wfile.write(content)

    def do_POST(self):
        try:
            self._guard()
            path = self._path()
            if path not in ('/api/chat', '/api/approve', '/api/stop', '/api/auth', '/api/workspace',
                            '/api/workspace/pick', '/api/git/message') and path not in GIT_ROUTES:
                raise APIError(404, 'Unknown API endpoint.')
            body = self._body(allow_empty=path == '/api/auth' or path in GIT_ROUTES)
            state = self.server.state
            if path in GIT_ROUTES:
                self._git_body(body)
                self._json(200, {'ok': True, **state.git(path, body)})
            elif path == '/api/git/message':
                self._git_body(body)
                if 'draft' in body and (not isinstance(body['draft'], str) or len(body['draft']) > 8000):
                    raise APIError(400, 'Invalid draft.')
                run = state.start_run(GIT_MESSAGE_RUN, register=False)
                try:
                    self._json(200, {'ok': True, **state.git_message(run, body)})
                except client.ChatCancelled:
                    raise APIError(409, 'Подготовка сообщения остановлена.') from None
                except client.ChatError as exc:
                    raise APIError(502, str(exc)) from None
                finally:
                    state.finish_run(run)
            elif path == '/api/chat':
                conversation_id = self._string(body, 'conversation_id')
                self._string(body, 'message', 64000)
                self._history(body)
                for flag in ('search', 'thinking'):
                    if flag in body and type(body[flag]) is not bool:
                        raise APIError(400, f'{flag} must be a boolean.')
                if 'system_prompt' in body:
                    if not isinstance(body['system_prompt'], str) or len(body['system_prompt']) > 32000:
                        raise APIError(400, 'Invalid system_prompt.')
                run = state.start_run(conversation_id)
                self._stream_chat(run, body)
            elif path == '/api/approve':
                request_id = self._string(body, 'id')
                if type(body.get('approved')) is not bool:
                    raise APIError(400, 'approved must be a boolean.')
                state.approve(request_id, body['approved'])
                self._json(200, {'ok': True})
            elif path == '/api/stop':
                stopped = state.stop_run(self._string(body, 'conversation_id'))
                self._json(200, {'ok': True, 'stopped': stopped})
            elif path == '/api/workspace':
                cwd = state.set_workspace(body.get('path'))
                self._json(200, {'ok': True, 'cwd': cwd})
            elif path == '/api/workspace/pick':
                state.pick_workspace()
                self._json(202, {'ok': True, 'selecting_workspace': True})
            else:
                state.authenticate()
                self._json(202, {'ok': True, 'authenticating': True})
        except APIError as exc:
            self._error(exc)
        except (BrokenPipeError, ConnectionError, TimeoutError):
            pass

    @staticmethod
    def _git_body(body):
        paths = body.get('paths')
        if paths is not None and (not isinstance(paths, list) or len(paths) > git_tools.MAX_FILES or not all(
                isinstance(path, str) and 0 < len(path) <= 4096 and '\x00' not in path for path in paths)):
            raise APIError(400, 'paths must be a list of file paths.')
        for field, limit in (('path', 4096), ('hash', 64), ('branch', 250), ('url', 1000),
                             ('subject', 500), ('body', 8000)):
            value = body.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > limit or '\x00' in value):
                raise APIError(400, f'Invalid {field}.')

    def _stream_chat(self, run, body):
        state = self.server.state

        def emit(event):
            client.check_cancelled(run.stop)
            self.wfile.write((json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8'))
            self.wfile.flush()

        def final_event(event):
            self.wfile.write((json.dumps(event, ensure_ascii=False) + '\n').encode('utf-8'))
            self.wfile.flush()

        try:
            self._headers(200, 'application/x-ndjson; charset=utf-8')
            try:
                state.chat(run, body, emit)
            except client.ChatCancelled:
                final_event({'type': 'status', 'content': 'Запрос остановлен.'})
            except client.ChatError as exc:
                final_event({'type': 'error', 'content': str(exc)})
            except (BrokenPipeError, ConnectionError, TimeoutError):
                run.stop.set()
                return
            except Exception:
                final_event({'type': 'error', 'content': 'Внутренняя ошибка запроса. Повторите попытку.'})
            final_event({'type': 'done'})
        except (BrokenPipeError, ConnectionError, TimeoutError):
            run.stop.set()
        finally:
            state.finish_run(run)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    try:
        server = LocalHTTPServer(('127.0.0.1', args.port))
    except OSError:
        print(f'Порт {args.port} уже занят — вероятно, сервер Orbit уже запущен. '
              f'Закройте его окно или укажите другой порт: --port.')
        sys.exit(1)
    with server:
        print(f'DeepSeek: http://127.0.0.1:{server.server_port}')
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
