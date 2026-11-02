import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deepseek_client as client
import web_server as web


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.original_cwd = os.getcwd()
        self.temp = tempfile.TemporaryDirectory()
        Path(self.temp.name, 'index.html').write_text('<h1>Hello</h1>', encoding='utf-8')
        self.state = web.AppState(self.temp.name)
        self.server = web.LocalHTTPServer(('127.0.0.1', 0), self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config_patch = patch.object(client, 'load_config', return_value={'authorization': 'SECRET', 'chat_session_id': 's'})
        self.config_patch.start()
        self.create_patch = patch.object(client, 'create_chat_session', return_value='fresh')
        self.create_session = self.create_patch.start()

    def tearDown(self):
        if self.state.active:
            self.state.stop_run(self.state.active.conversation_id)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.config_patch.stop()
        self.create_patch.stop()
        os.chdir(self.original_cwd)
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        hdrs = {'Content-Type': 'application/json'}
        hdrs.update(headers or {})
        payload = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        connection.request(method, path, payload, hdrs)
        response = connection.getresponse()
        data = response.read()
        status, content_type = response.status, response.getheader('Content-Type')
        connection.close()
        return status, content_type, data

    def chat(self, conversation='one', message='Hello', **extra):
        status, content_type, data = self.request('POST', '/api/chat', dict(conversation_id=conversation, message=message, **extra))
        self.assertEqual(status, 200)
        self.assertTrue(content_type.startswith('application/x-ndjson'))
        return [json.loads(line) for line in data.splitlines()]

    def wait_pending(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with self.state.lock:
                if self.state.pending:
                    return next(iter(self.state.pending))
            time.sleep(0.01)
        self.fail('No terminal approval request')

    def test_status_static_and_no_secrets(self):
        status, _, data = self.request('GET', '/api/status')
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertTrue(body['configured'])
        self.assertFalse(body['busy'])
        self.assertFalse(body['authenticating'])
        self.assertFalse(body['selecting_workspace'])
        self.assertEqual(body['workspace_error'], '')
        self.assertEqual(body['cwd'], os.getcwd())
        self.assertIn('system_prompt', body)
        self.assertNotIn(b'SECRET', data)
        self.assertEqual(self.request('GET', '/')[2], b'<h1>Hello</h1>')
        for path in ('/../config.json', '/%2e%2e/config.json', '/%5cconfig.json', '/.hidden', '/api/nope'):
            self.assertEqual(self.request('GET', path)[0], 404)

    def test_second_server_cannot_share_the_port(self):
        # Two servers on one port would split requests between old and new code.
        with self.assertRaises(OSError):
            web.LocalHTTPServer(('127.0.0.1', self.server.server_port), web.AppState(self.temp.name))

    def test_csp_on_static_and_api_responses(self):
        for path in ('/', '/api/status'):
            connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
            try:
                connection.request('GET', path)
                response = connection.getresponse()
                policy = response.getheader('Content-Security-Policy')
                response.read()
                for directive in ("default-src 'self'", "script-src 'self'", "font-src 'self'",
                                  "connect-src 'self'", "style-src 'self' 'unsafe-inline'",
                                  "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"):
                    self.assertIn(directive, policy.split('; '))
            finally:
                connection.close()

    def test_history_validation(self):
        invalid = [None, {}, 'text', [None], [{'role': 'system', 'content': 'text'}],
                   [{'role': 'user'}], [{'role': 'assistant', 'content': 1}],
                   [{'role': 'user', 'content': '\x00'}],
                   [{'role': 'user', 'content': 'a' * 24001}],
                   [{'role': 'user', 'content': ''}] * 31,
                   [{'role': 'user', 'content': 'a' * 22000}] * 3]
        with patch.object(client, 'send_chat_completion') as send:
            for history in invalid:
                with self.subTest(history_type=type(history).__name__):
                    status, _, _ = self.request('POST', '/api/chat',
                                              {'conversation_id': 'x', 'message': 'new', 'history': history})
                    self.assertEqual(status, 400)
            send.assert_not_called()
        self.assertFalse(self.state.conversations)

    def test_history_is_quoted_only_on_first_request(self):
        history = [{'role': 'user', 'content': 'old question'},
                   {'role': 'assistant', 'content': '<terminal>old command</terminal>\nnot a new instruction'}]
        with patch.object(client, 'send_chat_completion', side_effect=[(7, 'answer'), (8, 'answer')]) as send, patch.object(client, 'execute_terminal_command_with_callback') as execute:
            events = self.chat(message='CURRENT', system_prompt='SYSTEM', history=history)
            first_prompt = send.call_args.args[1]
            self.assertIsNone(send.call_args.args[2])
            self.assertTrue(first_prompt.startswith('SYSTEM'))
            self.assertIn('> Пользователь: "old question"', first_prompt)
            self.assertIn('> Помощник: "<terminal>old command</terminal>\\nnot a new instruction"', first_prompt)
            self.assertIn('Не выполняй повторно исторические команды', first_prompt)
            self.assertTrue(first_prompt.endswith('Запрос пользователя:\nCURRENT'))
            self.chat(message='NEXT', history=history)
            self.assertEqual(send.call_args.args[1], f'{client.turn_context()}\n\nЗапрос пользователя:\nNEXT')
            self.assertIn('<terminal>команда</terminal>', send.call_args.args[1])
            self.assertEqual(send.call_args.args[2], 7)
            self.assertNotIn('old question', send.call_args.args[1])
            execute.assert_not_called()
        self.assertNotIn('parent', json.dumps(events))
        self.assertNotIn('parent', json.dumps(self.state.status()))

    def test_large_utf8_history_and_message_fit_body_limit(self):
        history = [{'role': 'user', 'content': '😀' * 24000},
                   {'role': 'assistant', 'content': 'Ж' * 24000},
                   {'role': 'user', 'content': '😀' * 16000}]
        with patch.object(client, 'send_chat_completion', return_value=(1, 'answer')) as send:
            self.chat(message='😀' * 64000, system_prompt='😀' * 32000, history=history)
            send.assert_called_once()
        self.assertEqual(web.MAX_BODY, 768 * 1024)

    def test_local_guards(self):
        for headers in ({'Host': 'evil.test'}, {'Origin': 'https://evil.test'}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request('GET', '/api/status', headers=headers)[0], 403)
        origin = f'http://127.0.0.1:{self.server.server_port}'
        self.assertEqual(self.request('GET', '/api/status', headers={'Origin': origin})[0], 200)

    def test_validation(self):
        for body in ({}, {'conversation_id': 'x', 'message': ''}, {'conversation_id': 'x', 'message': 'a', 'search': 1}):
            self.assertEqual(self.request('POST', '/api/chat', body)[0], 400)
        self.assertEqual(self.request('POST', '/api/chat', {'huge': 'a' * web.MAX_BODY})[0], 413)
        self.assertEqual(self.request('POST', '/api/approve', {'id': 'x', 'approved': 'yes'})[0], 400)
        self.assertEqual(self.request('POST', '/api/approve', {'id': 'x', 'approved': True})[0], 404)

    def test_conversation_parents_and_initial_prompt(self):
        calls = []

        def completion(config, prompt, parent, **kwargs):
            calls.append((prompt, parent, kwargs))
            kwargs['sse_callback']({'type': 'think', 'content': 'thinking'})
            kwargs['sse_callback']({'type': 'response', 'content': 'answer'})
            return len(calls), 'answer'

        with patch.object(client, 'send_chat_completion', side_effect=completion):
            events = self.chat(system_prompt='CUSTOM', search=True, thinking=False)
            self.chat(message='second')
            self.chat(conversation='two')
        self.assertEqual([call[1] for call in calls], [None, 1, None])
        self.assertIn('CUSTOM', calls[0][0])
        self.assertIn('Hello', calls[0][0])
        self.assertIn('Оболочка:', calls[0][0])
        self.assertEqual(calls[1][0], f'{client.turn_context()}\n\nЗапрос пользователя:\nsecond')
        self.assertTrue(calls[0][2]['search_enabled'])
        self.assertIs(calls[0][2]['thinking_enabled'], False)
        self.assertIs(calls[1][2]['thinking_enabled'], True)
        self.assertEqual(events[-1], {'type': 'done'})
        self.assertIn({'type': 'think', 'content': 'thinking'}, events)

    def test_missing_auth_is_stream_error_without_browser(self):
        with patch.object(client, 'load_config', side_effect=client.AuthenticationError('Please authenticate')), patch.object(client, 'send_chat_completion') as send:
            events = self.chat()
        send.assert_not_called()
        self.assertEqual(events[0], {'type': 'error', 'content': 'Please authenticate'})
        self.assertEqual(events[-1]['type'], 'done')
        self.assertIsNone(self.state.active)

    def test_terminal_requires_approval_and_follows_up(self):
        results = []
        with patch.object(client, 'send_chat_completion', side_effect=[(10, '<terminal>echo hello</terminal>'), (11, 'Finished')]) as send, patch.object(client, 'execute_terminal_command_with_callback', return_value='hello\n') as execute:
            worker = threading.Thread(target=lambda: results.extend(self.chat()))
            worker.start()
            request_id = self.wait_pending()
            execute.assert_not_called()
            self.assertEqual(self.request('POST', '/api/chat', {'conversation_id': 'two', 'message': 'x'})[0], 409)
            self.assertEqual(self.request('POST', '/api/approve', {'id': request_id, 'approved': True})[0], 200)
            worker.join(4)
            self.assertFalse(worker.is_alive())
            execute.assert_called_once()
            self.assertEqual(send.call_args_list[1].args[2], 10)
            self.assertIn('hello', send.call_args_list[1].args[1])
            self.assertTrue(send.call_args_list[1].args[1].endswith(client.COMMAND_REMINDER))
        request = next(event for event in results if event['type'] == 'terminal_request')
        self.assertIs(request['fenced'], False)
        self.assertEqual(request['checkpoint'], 0)
        # Only the user's prompt is shown as context, not every prompt sent after a command.
        self.assertEqual(len([event for event in results if event['type'] == 'context']), 1)
        terminal_done = next(event for event in results if event['type'] == 'terminal_done')
        self.assertIs(terminal_done['approved'], True)
        self.assertIsInstance(terminal_done['elapsed'], float)
        self.assertGreaterEqual(terminal_done['elapsed'], 0)
        self.assertEqual(results[-1]['type'], 'done')

    def test_terminal_after_explanation_runs_first_command_only(self):
        results = []
        reply = 'Посмотрю файлы.\n\n<terminal>dir</terminal>\n<terminal>del x</terminal>'
        with patch.object(client, 'send_chat_completion', side_effect=[(10, reply), (11, 'Finished')]) as send, patch.object(client, 'execute_terminal_command_with_callback', return_value='ok\n') as execute:
            worker = threading.Thread(target=lambda: results.extend(self.chat()))
            worker.start()
            request_id = self.wait_pending()
            self.assertEqual(self.request('POST', '/api/approve', {'id': request_id, 'approved': True})[0], 200)
            worker.join(4)
            self.assertFalse(worker.is_alive())
            execute.assert_called_once()
            self.assertEqual(execute.call_args.args[0], 'dir')
            self.assertIn('остальные (1) пропущены', send.call_args_list[1].args[1])
        request = next(event for event in results if event['type'] == 'terminal_request')
        self.assertEqual(request['command'], 'dir')

    def test_trailing_shell_fence_asks_for_approval(self):
        # DeepSeek's real follow-up after a command: the next command as Markdown instead of <terminal>.
        reply = 'Сейчас изучу git remote и README.\n\n```powershell\ngit remote -v\n```\n'
        results = []
        with patch.object(client, 'send_chat_completion', side_effect=[(10, reply), (11, 'Finished')]) as send, patch.object(client, 'execute_terminal_command_with_callback', return_value='origin\n') as execute:
            worker = threading.Thread(target=lambda: results.extend(self.chat()))
            worker.start()
            request_id = self.wait_pending()
            execute.assert_not_called()
            self.assertEqual(self.request('POST', '/api/approve', {'id': request_id, 'approved': True})[0], 200)
            worker.join(4)
            self.assertFalse(worker.is_alive())
            self.assertEqual(execute.call_args.args[0], 'git remote -v')
            self.assertIn('origin', send.call_args_list[1].args[1])
        request = next(event for event in results if event['type'] == 'terminal_request')
        self.assertEqual(request['command'], 'git remote -v')
        self.assertIs(request['fenced'], True)

        for reply in ('Пример:\n```python\nprint(1)\n```', '```bash\nls\n```\nи потом посмотрим', 'Только текст'):
            with self.subTest(reply=reply), patch.object(client, 'send_chat_completion', return_value=(1, reply)), patch.object(client, 'execute_terminal_command_with_callback') as execute:
                events = self.chat(conversation='other')
                execute.assert_not_called()
                self.assertFalse(any(event['type'] == 'terminal_request' for event in events))

    def test_each_dialog_gets_its_own_site_chat(self):
        with patch.object(client, 'send_chat_completion', return_value=(3, 'answer')) as send:
            events = self.chat(conversation='site', message='first')
            self.chat(conversation='site', message='second')
            self.chat(conversation='other', message='third', new_session=False)
        self.assertEqual(self.create_session.call_count, 2)
        self.assertTrue(all(call.args[0]['chat_session_id'] == 'fresh' for call in send.call_args_list))
        self.assertEqual([call.args[2] for call in send.call_args_list], [None, 3, None])
        session = next(event for event in events if event['type'] == 'session')
        self.assertEqual(session['url'], 'https://chat.deepseek.com/a/chat/s/fresh')
        context = next(event for event in events if event['type'] == 'context')
        self.assertTrue(context['content'].endswith('Запрос пользователя:\nfirst'))
        self.assertNotIn('SECRET', json.dumps(events))
        self.assertEqual(self.request('POST', '/api/chat', {'conversation_id': 'x', 'message': 'y', 'thinking': 'yes'})[0], 400)

    def test_failed_site_chat_is_an_error_not_the_shared_chat(self):
        # Sending into config.json's chat with no parent would replace that chat's first message.
        self.create_session.side_effect = client.ChatError('Не удалось создать чат на сайте DeepSeek.')
        with patch.object(client, 'send_chat_completion') as send:
            events = self.chat(conversation='failed')
        send.assert_not_called()
        self.assertIn({'type': 'error', 'content': 'Не удалось создать чат на сайте DeepSeek.'}, events)
        self.assertFalse(any(event['type'] == 'session' for event in events))
        self.create_session.side_effect = None
        with patch.object(client, 'send_chat_completion', return_value=(3, 'answer')) as send:
            self.chat(conversation='failed')
        self.assertEqual(send.call_args.args[0]['chat_session_id'], 'fresh')

    def test_denial_and_stop_never_execute(self):
        for approve, note in ((False, web.DECLINED_NOTE), (None, web.STOPPED_NOTE)):
            results = []
            conversation = f'denial-{approve}'
            with patch.object(client, 'send_chat_completion', return_value=(1, '<terminal>echo hello</terminal>')), patch.object(client, 'execute_terminal_command_with_callback') as execute:
                worker = threading.Thread(target=lambda: results.extend(self.chat(conversation)))
                worker.start()
                request_id = self.wait_pending()
                if approve is False:
                    self.request('POST', '/api/approve', {'id': request_id, 'approved': False})
                else:
                    response = self.request('POST', '/api/stop', {'conversation_id': conversation})
                    self.assertTrue(json.loads(response[2])['stopped'])
                worker.join(4)
                self.assertFalse(worker.is_alive())
                execute.assert_not_called()
                self.assertEqual(results[-1]['type'], 'done')
                if approve is False:
                    terminal_done = next(event for event in results if event['type'] == 'terminal_done')
                    self.assertIs(terminal_done['approved'], False)
                else:
                    self.assertTrue(any(event['type'] == 'status' and 'остановлен' in event['content']
                                        for event in results))
                self.assertFalse(self.state.pending)
            # DeepSeek learns with the next message why its command has no result, and only once.
            with patch.object(client, 'send_chat_completion', return_value=(2, 'ok')) as send:
                self.chat(conversation, message='next')
                self.assertEqual(send.call_args.args[1], f'{note}{client.turn_context()}\n\nЗапрос пользователя:\nnext')
                self.chat(conversation, message='again')
                self.assertNotIn('Оболочка: пользователь', send.call_args.args[1])

    def test_auth_explicit_background_and_sanitized_error(self):
        entered, release = threading.Event(), threading.Event()

        def authenticate():
            entered.set()
            release.wait(3)
            raise RuntimeError('SECRET TOKEN')

        fake = types.SimpleNamespace(fetch_tokens_and_save=authenticate)
        with patch.dict(sys.modules, {'auth_fetcher': fake}):
            status, _, _ = self.request('POST', '/api/auth', {})
            self.assertEqual(status, 202)
            self.assertTrue(entered.wait(1))
            self.assertTrue(json.loads(self.request('GET', '/api/status')[2])['authenticating'])
            self.assertEqual(self.request('POST', '/api/auth', {})[0], 409)
            release.set()
            deadline = time.monotonic() + 2
            while self.state.authenticating and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(self.state.auth_error)
            self.assertNotIn('SECRET', self.state.auth_error)

    def wait_workspace(self):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with self.state.lock:
                if not self.state.selecting_workspace:
                    return
            time.sleep(0.01)
        self.fail('Workspace picker did not finish')

    def test_workspace_validation_and_success(self):
        invalid = [None, 1, [], '', '  ', '\x00', 'a' * 32768,
                   str(Path(self.temp.name, 'missing')), str(Path(self.temp.name, 'index.html'))]
        for path in invalid:
            with self.subTest(path_type=type(path).__name__):
                status, _, data = self.request('POST', '/api/workspace', {'path': path})
                self.assertEqual(status, 400)
                self.assertIn('error', json.loads(data))
                self.assertEqual(os.getcwd(), self.original_cwd)
        self.assertEqual(self.request('POST', '/api/workspace', {})[0], 400)
        status, _, data = self.request('POST', '/api/workspace', {'path': self.temp.name})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data), {'ok': True, 'cwd': os.getcwd()})
        self.assertEqual(Path.cwd(), Path(self.temp.name).resolve())
        self.assertTrue(Path('index.html').is_file())
        body = json.loads(self.request('GET', '/api/status')[2])
        self.assertEqual(body['cwd'], os.getcwd())
        self.assertEqual(body['workspace_error'], '')

    def test_workspace_change_errors_are_sanitized(self):
        with patch.object(web.os, 'chdir', side_effect=PermissionError('SECRET TOKEN')):
            status, _, data = self.request('POST', '/api/workspace', {'path': self.temp.name})
        self.assertEqual(status, 400)
        self.assertNotIn(b'SECRET', data)
        self.assertTrue(self.state.workspace_error)
        self.assertNotIn('SECRET', self.state.workspace_error)
        self.assertEqual(os.getcwd(), self.original_cwd)

    def test_workspace_rejected_while_busy_or_authenticating(self):
        with patch.object(web, 'pick_workspace_directory') as pick:
            for busy in ('run', 'auth'):
                with self.subTest(busy=busy):
                    run = self.state.start_run('one') if busy == 'run' else None
                    if busy == 'auth':
                        self.state.authenticating = True
                    try:
                        self.assertEqual(self.request('POST', '/api/workspace', {'path': self.temp.name})[0], 409)
                        self.assertEqual(self.request('POST', '/api/workspace/pick', {})[0], 409)
                    finally:
                        if run:
                            self.state.finish_run(run)
                        self.state.authenticating = False
            pick.assert_not_called()
        self.assertEqual(os.getcwd(), self.original_cwd)

    def test_workspace_picker_is_background_and_blocks_mutations(self):
        entered, release = threading.Event(), threading.Event()
        threads = []

        def choose():
            threads.append(threading.current_thread().name)
            entered.set()
            release.wait(3)
            return self.temp.name

        with patch.object(web, 'pick_workspace_directory', side_effect=choose):
            try:
                status, _, data = self.request('POST', '/api/workspace/pick', {})
                self.assertEqual(status, 202)
                self.assertEqual(json.loads(data), {'ok': True, 'selecting_workspace': True})
                self.assertTrue(entered.wait(1))
                body = json.loads(self.request('GET', '/api/status')[2])
                self.assertTrue(body['selecting_workspace'])
                self.assertEqual(body['workspace_error'], '')
                self.assertEqual(body['cwd'], self.original_cwd)
                for path, payload in (
                    ('/api/chat', {'conversation_id': 'one', 'message': 'hello'}),
                    ('/api/auth', {}), ('/api/workspace/pick', {}),
                    ('/api/workspace', {'path': self.temp.name}),
                ):
                    self.assertEqual(self.request('POST', path, payload)[0], 409)
            finally:
                release.set()
                self.wait_workspace()
        self.assertEqual(threads, ['deepseek-workspace'])
        self.assertEqual(Path.cwd(), Path(self.temp.name).resolve())
        self.assertEqual(self.state.workspace_error, '')
        self.assertFalse(self.state.conversations)

    def test_workspace_picker_cancel_and_errors(self):
        self.state.workspace_error = 'previous error'
        with patch.object(web, 'pick_workspace_directory', return_value=''):
            self.assertEqual(self.request('POST', '/api/workspace/pick', {})[0], 202)
            self.wait_workspace()
        self.assertEqual(os.getcwd(), self.original_cwd)
        self.assertEqual(self.state.workspace_error, '')
        for error in (ImportError('SECRET TOKEN'), RuntimeError('SECRET TOKEN')):
            with patch.object(web, 'pick_workspace_directory', side_effect=error):
                self.assertEqual(self.request('POST', '/api/workspace/pick', {})[0], 202)
                self.wait_workspace()
            body = json.loads(self.request('GET', '/api/status')[2])
            self.assertFalse(body['selecting_workspace'])
            self.assertTrue(body['workspace_error'])
            self.assertIn('вручную', body['workspace_error'])
            self.assertNotIn('SECRET', body['workspace_error'])
            self.assertEqual(os.getcwd(), self.original_cwd)
        with patch.object(web, 'pick_workspace_directory', return_value=str(Path(self.temp.name, 'missing'))):
            self.assertEqual(self.request('POST', '/api/workspace/pick', {})[0], 202)
            self.wait_workspace()
        self.assertTrue(self.state.workspace_error)
        self.assertEqual(os.getcwd(), self.original_cwd)

    def test_workspace_picker_tk_lifecycle_on_worker(self):
        root = Mock()
        tk = types.SimpleNamespace(Tk=Mock(return_value=root), filedialog=types.SimpleNamespace(askdirectory=Mock()))
        called_threads = []

        def choose(**kwargs):
            called_threads.append(threading.current_thread().name)
            self.assertEqual(kwargs['parent'], root)
            self.assertTrue(kwargs['mustexist'])
            root.withdraw.assert_called_once_with()
            root.attributes.assert_called_once_with('-topmost', True)
            return ''

        tk.filedialog.askdirectory.side_effect = choose
        with patch.dict(sys.modules, {'tkinter': tk}):
            self.assertEqual(self.request('POST', '/api/workspace/pick', {})[0], 202)
            self.wait_workspace()
        self.assertEqual(called_threads, ['deepseek-workspace'])
        root.destroy.assert_called_once_with()
        root.reset_mock()
        tk.filedialog.askdirectory.side_effect = RuntimeError('SECRET TOKEN')
        with patch.dict(sys.modules, {'tkinter': tk}):
            self.assertEqual(self.request('POST', '/api/workspace/pick', {})[0], 202)
            self.wait_workspace()
        root.destroy.assert_called_once_with()
        self.assertTrue(self.state.workspace_error)
        self.assertNotIn('SECRET', self.state.workspace_error)

    def test_continuation_refreshes_workspace_context(self):
        with patch.object(client, 'send_chat_completion', side_effect=[(7, 'answer'), (8, 'answer')]) as send:
            self.chat(message='first')
            initial = send.call_args.args[1]
            self.assertIn(self.original_cwd, initial)
            self.assertEqual(self.request('POST', '/api/workspace', {'path': self.temp.name})[0], 200)
            self.chat(message='second')
            prompt, parent = send.call_args.args[1:3]
            self.assertEqual(parent, 7)
            self.assertIn(os.getcwd(), prompt)
            self.assertTrue(prompt.endswith('Запрос пользователя:\nsecond'))
        self.assertEqual(len(self.state.conversations), 1)

    def test_broken_block_is_sent_back_to_deepseek(self):
        # An empty or unclosed block goes back to DeepSeek instead of waiting for the user to retype it.
        replies = [(1, 'text <terminal>   </terminal>'), (2, 'Повторю: <terminal>dir'), (3, '<terminal></terminal>')]
        with patch.object(client, 'send_chat_completion', side_effect=replies) as send, patch.object(client, 'execute_terminal_command_with_callback') as execute:
            events = self.chat()
            execute.assert_not_called()
        self.assertEqual(send.call_count, web.MAX_REPAIRS + 1)
        for call in send.call_args_list[1:]:
            self.assertEqual(call.args[1], f'{web.BROKEN_BLOCK_PROMPT}\n\n{client.turn_context()}')
        self.assertEqual([call.args[2] for call in send.call_args_list], [None, 1, 2])
        notices = [event['content'] for event in events if event['type'] == 'notice']
        self.assertEqual(len(notices), web.MAX_REPAIRS + 1)
        self.assertIn('не выполнялась', notices[-1])
        self.assertEqual(events[-1]['type'], 'done')
        with patch.object(client, 'send_chat_completion', return_value=(4, 'ok')) as send:
            self.chat(message='next')
        self.assertTrue(send.call_args.args[1].startswith(web.BROKEN_BLOCK_NOTE))

        results = []
        with patch.object(client, 'send_chat_completion', side_effect=[(1, '<terminal>dir'), (2, '<terminal>dir</terminal>'), (3, 'Готово')]) as send, patch.object(client, 'execute_terminal_command_with_callback', return_value='ok\n') as execute:
            worker = threading.Thread(target=lambda: results.extend(self.chat('repaired')))
            worker.start()
            self.request('POST', '/api/approve', {'id': self.wait_pending(), 'approved': True})
            worker.join(4)
            self.assertFalse(worker.is_alive())
            self.assertEqual(execute.call_args.args[0], 'dir')
        self.assertEqual(send.call_count, 3)

    def test_long_runs_pause_at_checkpoints_instead_of_failing(self):
        results = []
        replies = [(index, f'<terminal>echo {index}</terminal>') for index in range(5)] + [(5, 'Готово')]
        with patch.object(web, 'CHECKPOINT_COMMANDS', 2), patch.object(client, 'send_chat_completion', side_effect=replies), patch.object(client, 'execute_terminal_command_with_callback', return_value='ok\n') as execute:
            worker = threading.Thread(target=lambda: results.extend(self.chat()))
            worker.start()
            for _ in range(5):
                request_id = self.wait_pending()
                self.assertEqual(self.request('POST', '/api/approve', {'id': request_id, 'approved': True})[0], 200)
                deadline = time.monotonic() + 3
                while request_id in self.state.pending and time.monotonic() < deadline:
                    time.sleep(0.01)
            worker.join(4)
            self.assertFalse(worker.is_alive())
            self.assertEqual(execute.call_count, 5)
        checkpoints = [event['checkpoint'] for event in results if event['type'] == 'terminal_request']
        self.assertEqual(checkpoints, [0, 0, 2, 0, 4])
        self.assertFalse(any(event['type'] == 'error' for event in results))


if __name__ == '__main__':
    unittest.main()
