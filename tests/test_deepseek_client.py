import io
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deepseek_client as client


class ClientTests(unittest.TestCase):
    def test_initial_think_response_and_batch_content(self):
        events = []
        parser = client.StreamParser(events.append)
        parser.parse({'v': {'response': {'message_id': 5, 'fragments': [{'type': 'THINK', 'content': 'initial'}]}}})
        parser.parse({'p': 'response/fragments/-1/content', 'v': ' delta'})
        parser.parse({'p': 'response', 'o': 'BATCH', 'v': [
            {'p': 'fragments', 'o': 'APPEND', 'v': [{'type': 'RESPONSE', 'content': 'Hello'}]},
            {'p': 'fragments/-1/content', 'o': 'APPEND', 'v': ' world'},
            {'p': 'status', 'v': 'FINISHED'},
        ]})
        self.assertEqual(parser.parent_id, 5)
        self.assertEqual(parser.text, 'Hello world')
        self.assertEqual(events[:2], [{'type': 'think', 'content': 'initial'}, {'type': 'think', 'content': ' delta'}])
        self.assertTrue(parser.finished)

    def test_search_events_and_implicit_path(self):
        events = []
        parser = client.StreamParser(events.append)
        parser.parse({'p': 'response', 'o': 'BATCH', 'v': [
            {'p': 'fragments', 'o': 'APPEND', 'v': [{'type': 'TOOL_SEARCH', 'queries': [{'query': 'q'}]}]},
            {'p': 'fragments/-1/results', 'v': [{'title': 'result'}]},
            {'p': 'fragments', 'o': 'APPEND', 'v': [{'type': 'RESPONSE', 'content': 'A'}]},
        ]})
        parser.parse({'p': 'response/fragments/-1/content', 'v': 'B'})
        parser.parse({'v': 'C'})
        self.assertEqual(parser.text, 'ABC')
        self.assertEqual(events[0]['type'], 'search_queries')
        self.assertEqual(events[1]['type'], 'search_results')

    def test_token_usage_and_legacy_search_paths(self):
        events = []
        parser = client.StreamParser(events.append)
        parser.parse({'v': {'response': {'message_id': 4, 'accumulated_token_usage': 75, 'fragments': []}}})
        parser.parse({'p': 'response/search_status', 'v': 'SEARCHING'})
        parser.parse({'p': 'response/search_results', 'v': [{'url': 'https://a.example', 'cite_index': 1}]})
        parser.parse({'p': 'response', 'o': 'BATCH', 'v': [
            {'p': 'accumulated_token_usage', 'v': 562}, {'p': 'quasi_status', 'v': 'FINISHED'}]})
        self.assertEqual([event['tokens'] for event in events if event['type'] == 'usage'], [75, 562])
        self.assertIn({'type': 'search_results', 'results': [{'url': 'https://a.example', 'cite_index': 1}]}, events)
        self.assertIn({'type': 'status', 'content': 'Ищет в интернете...'}, events)
        self.assertTrue(parser.finished)

    def test_create_chat_session(self):
        for body, expected in (({'code': 0, 'data': {'biz_code': 0, 'biz_data': {'id': 'abc-1'}}}, 'abc-1'),
                               ({'code': 0, 'data': {'biz_code': 0, 'biz_data': {'chat_session': {'id': 'abc-2'}}}}, 'abc-2')):
            response = self.response()
            response.json.return_value = body
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            with patch.object(client.requests, 'post', return_value=response) as post:
                self.assertEqual(client.create_chat_session({'authorization': 'x'}), expected)
            self.assertEqual(post.call_args.kwargs['json'], {})
            self.assertTrue(post.call_args.args[0].endswith('/api/v0/chat_session/create'))
        response = self.response()
        response.json.return_value = {'code': 0, 'data': {'biz_code': 0, 'biz_data': {'id': '../evil'}}}
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(client.requests, 'post', return_value=response), self.assertRaises(client.ChatError):
            client.create_chat_session({})

    def response(self, lines=(), status=200):
        response = Mock(status_code=status)
        response.iter_lines.return_value = iter(lines)
        return response

    def test_http_202_has_actionable_error(self):
        with self.assertRaisesRegex(client.ChatError, 'HTTP 202.*авторизацию'):
            client._check_http(self.response(status=202))

    def test_completion_payload_and_closure(self):
        response = self.response([b'data: {"response_message_id": 9}', b'data: {"p":"response/content","v":"answer"}', b'data: [DONE]'])
        events = []
        with patch.object(client, 'solve_pow_challenge', return_value='POW'), patch.object(client.requests, 'post', return_value=response) as post:
            self.assertEqual(client.send_chat_completion({'chat_session_id': 's'}, 'hello', None,
                                                        thinking_enabled=False,
                                                        sse_callback=events.append), (9, 'answer'))
        # The site sends "default" as a string, not null.
        self.assertEqual(post.call_args.kwargs['json']['model_type'], 'default')
        self.assertFalse(post.call_args.kwargs['json']['thinking_enabled'])
        headers = post.call_args.kwargs['headers']
        self.assertIn('Chrome/148.0.0.0 Safari/537.36', headers['user-agent'])
        for key, value in {'x-client-version': '2.0.0', 'x-client-timezone-offset': '18000',
                           'x-client-platform': 'web', 'x-client-locale': 'en_US',
                           'sec-fetch-site': 'same-origin', 'sec-ch-ua-platform': '"Windows"',
                           'priority': 'u=1, i'}.items():
            self.assertEqual(headers[key], value)
        self.assertIn('sec-ch-ua', headers)
        self.assertIn('accept-language', headers)
        response.close.assert_called_once()

    def test_empty_or_think_only_truncated_stream_is_actionable_error(self):
        streams = [[], [b'data: {"response_message_id": 9}'],
                   ['data: ' + json.dumps({'v': {'response': {'message_id': 9, 'status': 'WIP',
                                         'fragments': [{'type': 'THINK', 'content': 'thinking'}]}}})]]
        for lines in streams:
            with self.subTest(lines=lines):
                response = self.response(lines)
                with patch.object(client, 'solve_pow_challenge', return_value='POW'), patch.object(client.requests, 'post', return_value=response):
                    with self.assertRaisesRegex(client.ChatError, 'Повторите запрос'):
                        client.send_chat_completion({}, 'hello', None, sse_callback=lambda event: None)
                response.close.assert_called_once()

    def test_explicit_stream_end_is_not_silent_truncation(self):
        for lines in ([b'data: [DONE]'], [b'data: {"p":"response/status","v":"FINISHED"}']):
            response = self.response(lines)
            with patch.object(client, 'solve_pow_challenge', return_value='POW'), patch.object(client.requests, 'post', return_value=response):
                self.assertEqual(client.send_chat_completion({}, 'hello', None, sse_callback=lambda event: None),
                                 (None, ''))
            response.close.assert_called_once()

    def test_windows_terminal_sets_utf8_output_encoding(self):
        process = Mock(stdout=io.StringIO('Привет, мир!\n'), returncode=0)
        process.poll.return_value = 0
        command = "$text = @'\nс \"кавычками\" и C:\\путь\\\n'@\nWrite-Output $text"
        with patch.object(client.sys, 'platform', 'win32'), patch.object(client.subprocess, 'Popen', return_value=process) as popen:
            output = client.execute_subprocess_only_with_callback(command, stop_event=threading.Event())
        # The command goes to stdin untouched; only the fixed runner is on the command line.
        self.assertEqual(popen.call_args.args[0], ['powershell', '-NoProfile', '-NonInteractive', '-Command',
                                                   client.POWERSHELL_STDIN_RUNNER])
        self.assertTrue(client.POWERSHELL_STDIN_RUNNER.startswith('[Console]::OutputEncoding = $OutputEncoding = '))
        process.stdin.write.assert_called_once_with(command)
        process.stdin.close.assert_called_once()
        self.assertEqual(popen.call_args.kwargs['stdin'], client.subprocess.PIPE)
        self.assertEqual(popen.call_args.kwargs['encoding'], 'utf-8')
        self.assertIn('Привет, мир!', output)

    @unittest.skipUnless(sys.platform.startswith('win'), 'runs Windows PowerShell')
    def test_windows_powershell_exit_codes_and_readable_errors(self):
        run = client.execute_subprocess_only_with_callback
        self.assertTrue(run("$t = @'\nЁж \"x\" C:\\a\\\n'@\nWrite-Output $t").startswith('[Код завершения: 0]\nЁж "x" C:\\a\\'))
        self.assertTrue(run('Write-Output a; exit 3').startswith('[Код завершения: 3]'))
        self.assertTrue(run('cmd /c exit 5').startswith('[Код завершения: 5]'))
        self.assertTrue(run('Get-Item C:\\definitely\\missing\\path').startswith('[Код завершения: 1]'))
        self.assertTrue(run('Get-Item C:\\definitely\\missing\\path; Write-Output ok').startswith('[Код завершения: 0]'))
        parse_error = run('Write-Output (')
        self.assertTrue(parse_error.startswith('[Код завершения: 1]'))
        # The error points at the model's line, not at the runner.
        self.assertIn('Write-Output (', parse_error)
        self.assertNotIn('LASTEXITCODE', parse_error)

    def test_callback_exception_propagates_and_response_closes(self):
        response = self.response([b'data: {"p":"response/content","v":"answer"}'])

        def callback(event):
            if event['type'] == 'response':
                raise client.ChatCancelled('cancel')

        with patch.object(client, 'solve_pow_challenge', return_value='POW'), patch.object(client.requests, 'post', return_value=response):
            with self.assertRaises(client.ChatCancelled):
                client.send_chat_completion({}, 'hello', None, sse_callback=callback)
        response.close.assert_called_once()

    def test_auth_failure_closes_without_exposing_body(self):
        response = self.response(status=403)
        response.text = 'SECRET COOKIE'
        with patch.object(client, 'solve_pow_challenge', return_value='POW'), patch.object(client.requests, 'post', return_value=response):
            with self.assertRaises(client.AuthenticationError) as raised:
                client.send_chat_completion({}, 'hello', None, sse_callback=lambda event: None)
        self.assertNotIn('SECRET', str(raised.exception))
        response.close.assert_called_once()

    def test_cancelled_event_does_not_make_request(self):
        stop = threading.Event()
        stop.set()
        with patch.object(client.requests, 'post') as post:
            with self.assertRaises(client.ChatCancelled):
                client.send_chat_completion({}, 'hello', None, stop_event=stop)
            post.assert_not_called()

    def test_stop_closes_blocked_stream(self):
        stop, entered, closed = threading.Event(), threading.Event(), threading.Event()
        response = Mock(status_code=200)
        response.close.side_effect = closed.set

        def lines():
            entered.set()
            closed.wait(2)
            return
            yield b''

        response.iter_lines.side_effect = lines
        errors = []

        def run():
            try:
                client.send_chat_completion({}, 'hello', None, stop_event=stop, sse_callback=lambda event: None)
            except client.ChatCancelled:
                errors.append('cancelled')

        with patch.object(client, 'solve_pow_challenge', return_value='POW'), patch.object(client.requests, 'post', return_value=response):
            worker = threading.Thread(target=run)
            worker.start()
            self.assertTrue(entered.wait(1))
            stop.set()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, ['cancelled'])
            self.assertTrue(closed.is_set())

    def test_terminal_callback_cancellation_propagates(self):
        def cancel(line):
            raise client.ChatCancelled('cancel')

        with self.assertRaises(client.ChatCancelled):
            client.execute_subprocess_only_with_callback('echo hello', cancel, threading.Event())

    def test_no_automatic_auth_or_raw_logs(self):
        with patch('builtins.open', side_effect=FileNotFoundError):
            with self.assertRaises(client.AuthenticationError):
                client.load_config(auto_auth=False)
        self.assertEqual(client.extract_terminal_command('<terminal>echo x</terminal>'), 'echo x')

    def test_terminal_block_with_surrounding_text(self):
        # Real DeepSeek output: an explanation sentence before the block.
        response = ('Изучу структуру проекта, чтобы рассказать о нём.\n\n'
                    '<terminal>Get-ChildItem -Force | Select-Object Mode, Length, Name</terminal>')
        self.assertEqual(client.extract_terminal_command(response),
                         'Get-ChildItem -Force | Select-Object Mode, Length, Name')
        self.assertEqual(client.extract_terminal_command('prefix <terminal>echo x</terminal> suffix'), 'echo x')
        self.assertEqual(client.extract_terminal_command('<terminal>a</terminal><terminal>b</terminal>'), 'a')
        self.assertEqual(client.terminal_blocks('<terminal>a</terminal> и <terminal>b</terminal>'), ['a', 'b'])
        self.assertEqual(client.extract_terminal_command('<terminal>\n```powershell\ndir\n```\n</terminal>'), 'dir')
        self.assertEqual(client.extract_terminal_command('<terminal><terminal>dir</terminal>'), 'dir')
        self.assertEqual(client.extract_terminal_command('<terminal>dir</terminal></terminal>'), 'dir')
        for text in ('no block', '<terminal>   </terminal>', '<terminal>unclosed'):
            self.assertIsNone(client.extract_terminal_command(text))

    def test_terminal_block_keeps_tag_text_inside_command(self):
        # Real DeepSeek output: a README here-string that itself describes the <terminal> format.
        command = ("$readme = @'\nКоманды пишутся так: <terminal>команда</terminal>.\n"
                   "'@\n[IO.File]::WriteAllText('README.md', $readme)")
        self.assertEqual(client.terminal_blocks(f'Обновлю README.\n\n<terminal>{command}</terminal>'), [command])
        command = "$readme = @'\nБлок начинается с <terminal>.\n'@\nWrite-Output $readme"
        self.assertEqual(client.terminal_blocks(f'<terminal>{command}</terminal>'), [command])
        # DeepSeek sometimes closes a long block with its own tool-call tag.
        self.assertEqual(client.terminal_blocks('<terminal>echo hi</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜invoke>'), ['echo hi'])
        self.assertEqual(client.terminal_blocks('<terminal>a</terminal> текст <terminal>b</terminal>'), ['a', 'b'])

    def test_fenced_command_only_from_trailing_shell_fence(self):
        self.assertEqual(client.fenced_command('Проверю.\n\n```\ngit remote -v; git status\n```'), 'git remote -v; git status')
        self.assertEqual(client.fenced_command('```powershell\nGet-ChildItem\n```\n\n'), 'Get-ChildItem')
        self.assertEqual(client.fenced_command('```js\nx()\n```\nТеперь:\n```Bash\nls\n```'), 'ls')
        for text in ('```python\nprint(1)\n```', '```sh\nls\n```\nПотом посмотрим.', '```\n\n```', 'git status', '', None):
            self.assertIsNone(client.fenced_command(text))


if __name__ == '__main__':
    unittest.main()
