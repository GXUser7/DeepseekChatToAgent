import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import deepseek_client as client
import git_tools
import web_server as web


def git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def make_repo(path, remote=None):
    git(path.parent, 'init', '-q', '-b', 'main', str(path))
    git(path, 'config', 'user.email', 'test@example.com')
    git(path, 'config', 'user.name', 'Test')
    git(path, 'config', 'commit.gpgsign', 'false')
    if remote:
        git(path, 'remote', 'add', 'origin', str(remote))


@unittest.skipUnless(shutil.which('git'), 'git is not installed')
class GitToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.remote = self.base / 'remote.git'
        git(self.base, 'init', '-q', '--bare', '-b', 'main', str(self.remote))
        self.repo = self.base / 'work'
        make_repo(self.repo, self.remote)
        for name, text in (('keep.txt', 'a\nb\n'), ('gone.txt', 'x\n'), ('old.txt', 'r\n'), ('staged_gone.txt', 's\n')):
            (self.repo / name).write_text(text)
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'init')

    def tearDown(self):
        self.temp.cleanup()

    def paths(self):
        return sorted((file['path'], file['status']) for file in git_tools.status(str(self.repo))['files'])

    def test_commit_takes_only_selected_files(self):
        (self.repo / 'keep.txt').write_text('a\nb\nc\n')
        (self.repo / 'gone.txt').unlink()
        (self.repo / 'new file.txt').write_text('hello\n')
        (self.repo / '*.md').write_text('literal star\n')
        git(self.repo, 'mv', 'old.txt', 'renamed.txt')
        git(self.repo, 'rm', '-q', 'staged_gone.txt')
        self.assertEqual(self.paths(), [('*.md', 'A'), ('gone.txt', 'D'), ('keep.txt', 'M'), ('new file.txt', 'A'),
                                        ('renamed.txt', 'R'), ('staged_gone.txt', 'D')])
        git_tools.commit(str(self.repo), ['gone.txt', 'new file.txt', 'renamed.txt', 'staged_gone.txt'], 'partial', 'body')
        self.assertEqual(self.paths(), [('*.md', 'A'), ('keep.txt', 'M')])
        shown = git(self.repo, 'show', '--name-status', '--format=%s%n%b', 'HEAD')
        self.assertIn('partial', shown)
        self.assertIn('body', shown)
        for line in ('D\tgone.txt', 'A\tnew file.txt', 'D\tstaged_gone.txt'):
            self.assertIn(line, shown)
        self.assertRegex(shown, r'R\d+\told.txt\trenamed.txt')

    def test_paths_must_come_from_status(self):
        for paths in ([], ['../outside.txt'], ['keep.txt'], 'keep.txt'):
            with self.subTest(paths=paths), self.assertRaises(git_tools.GitError):
                git_tools.commit(str(self.repo), paths, 'x')
        with self.assertRaises(git_tools.GitError):
            git_tools.diff(str(self.repo), '../outside.txt')
        with self.assertRaises(git_tools.GitError):
            git_tools.discard(str(self.repo), ['keep.txt'])

    def test_diff_discard_and_ignore(self):
        (self.repo / 'keep.txt').write_text('a\nB\n')
        (self.repo / 'note.md').write_text('one\ntwo\n')
        (self.repo / '__pycache__').mkdir()
        (self.repo / '__pycache__' / 'm.pyc').write_bytes(b'\0\1')
        diff = git_tools.diff(str(self.repo), 'keep.txt')['diff']
        self.assertIn('-b', diff)
        self.assertIn('+B', diff)
        self.assertIn('+two', git_tools.diff(str(self.repo), 'note.md')['diff'])
        self.assertTrue(git_tools.diff(str(self.repo), '__pycache__/m.pyc')['binary'])
        junk = next(file for file in git_tools.status(str(self.repo))['files'] if file['path'] == '__pycache__/m.pyc')
        self.assertEqual((junk['ignore'], junk['junk']), ('__pycache__/', True))
        self.assertEqual(git_tools.ignore(str(self.repo), '__pycache__/m.pyc')['pattern'], '__pycache__/')
        self.assertEqual((self.repo / '.gitignore').read_text(), '__pycache__/\n')
        git_tools.discard(str(self.repo), ['keep.txt', 'note.md'])
        self.assertEqual((self.repo / 'keep.txt').read_text(), 'a\nb\n')
        self.assertFalse((self.repo / 'note.md').exists())
        self.assertEqual(self.paths(), [('.gitignore', 'A')])

    def test_push_pull_conflict_and_undo(self):
        git_tools.push(str(self.repo))
        status = git_tools.status(str(self.repo))
        self.assertEqual((status['upstream'], status['ahead'], status['behind']), ('origin/main', 0, 0))
        other = self.base / 'other'
        git(self.base, 'clone', '-q', '-b', 'main', str(self.remote), str(other))
        git(other, 'config', 'user.email', 'o@example.com')
        git(other, 'config', 'user.name', 'Other')
        (other / 'keep.txt').write_text('remote\n')
        git(other, 'commit', '-qam', 'remote edit')
        git(other, 'push', '-q')
        (self.repo / 'keep.txt').write_text('local\n')
        git_tools.commit(str(self.repo), ['keep.txt'], 'local edit')
        git_tools.fetch(str(self.repo), quiet=True)
        status = git_tools.status(str(self.repo))
        self.assertEqual((status['ahead'], status['behind']), (1, 1))
        with self.assertRaisesRegex(git_tools.GitError, 'Сначала получите'):
            git_tools.push(str(self.repo))
        before = git(self.repo, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(git_tools.GitError, 'конфликт в keep.txt') as raised:
            git_tools.pull(str(self.repo))
        self.assertIn('CONFLICT', raised.exception.output)
        self.assertEqual(git(self.repo, 'rev-parse', 'HEAD'), before)
        self.assertEqual(git_tools.status(str(self.repo))['state'], '')
        self.assertEqual(git_tools.undo_commit(str(self.repo))['subject'], 'local edit')
        self.assertEqual(self.paths(), [('keep.txt', 'M')])
        with self.assertRaisesRegex(git_tools.GitError, 'уже на сервере'):
            git_tools.undo_commit(str(self.repo))
        git_tools.stash(str(self.repo))
        git_tools.pull(str(self.repo))
        self.assertEqual((self.repo / 'keep.txt').read_text(), 'remote\n')
        log = git_tools.log(str(self.repo))['commits']
        self.assertEqual([entry['pushed'] for entry in log[:2]], [True, True])

    def test_branches_revert_and_remote(self):
        git_tools.switch(str(self.repo), 'feature/x', create=True)
        (self.repo / 'f.txt').write_text('feature\n')
        git_tools.commit(str(self.repo), ['f.txt'], 'feature file')
        git_tools.switch(str(self.repo), 'main')
        with self.assertRaisesRegex(git_tools.GitError, 'Сначала слейте'):
            git_tools.delete_branch(str(self.repo), 'feature/x')
        git_tools.merge(str(self.repo), 'feature/x')
        git_tools.delete_branch(str(self.repo), 'feature/x')
        self.assertEqual(git_tools.status(str(self.repo))['branches'], ['main'])
        for name in ('-x', 'a b', 'main'):
            with self.subTest(name=name), self.assertRaises(git_tools.GitError):
                git_tools.switch(str(self.repo), name, create=True)
        head = git_tools.log(str(self.repo))['commits'][0]['hash']
        git_tools.revert(str(self.repo), head)
        self.assertFalse((self.repo / 'f.txt').exists())
        self.assertIn('feature file', git_tools.show(str(self.repo), head[:7])['subject'])
        for bad in ('HEAD', 'abc; rm', '../x'):
            with self.subTest(bad=bad), self.assertRaises(git_tools.GitError):
                git_tools.show(str(self.repo), bad)
        for url in ('--upload-pack=touch x', 'ext::sh -c x', 'not a url'):
            with self.subTest(url=url), self.assertRaises(git_tools.GitError):
                git_tools.set_remote(str(self.repo), url)
        git_tools.set_remote(str(self.repo), 'https://user:token@example.com/a/b.git')
        self.assertEqual(git_tools.status(str(self.repo))['remote_url'], 'https://example.com/a/b.git')

    def test_plain_folder_and_first_commit(self):
        plain = self.base / 'plain'
        plain.mkdir()
        self.assertEqual(git_tools.status(str(plain)), {'repo': False, 'cwd': str(plain)})
        self.assertIsNone(git_tools.current_branch(str(plain)))
        git_tools.init(str(plain))
        git(plain, 'config', 'user.email', 'p@example.com')
        git(plain, 'config', 'user.name', 'P')
        (plain / 'a.txt').write_text('1\n')
        status = git_tools.status(str(plain))
        self.assertFalse(status['has_head'])
        self.assertEqual([file['added'] for file in status['files']], [1])
        git_tools.commit(str(plain), ['a.txt'], 'first')
        self.assertEqual(git_tools.undo_commit(str(plain))['subject'], 'first')
        self.assertFalse(git_tools.status(str(plain))['has_head'])

    def test_commit_message_parsing(self):
        self.assertEqual(git_tools.parse_commit_message('```json\n{"subject": "fix: x", "body": ["a", "b"]}\n```'),
                         ('fix: x', 'a\nb'))
        self.assertEqual(git_tools.parse_commit_message('Вот: {"subject": "feat: y", "body": ""}'), ('feat: y', ''))
        self.assertEqual(git_tools.parse_commit_message('fix: plain\n\nmore'), ('fix: plain', 'more'))
        with self.assertRaises(git_tools.GitError):
            git_tools.parse_commit_message('   ')


@unittest.skipUnless(shutil.which('git'), 'git is not installed')
class GitEndpointTests(unittest.TestCase):
    def setUp(self):
        self.original_cwd = os.getcwd()
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name, 'repo')
        make_repo(self.repo)
        (self.repo / 'a.txt').write_text('1\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'init')
        (self.repo / 'a.txt').write_text('2\n')
        os.chdir(self.repo)
        self.state = web.AppState(self.temp.name)
        self.server = web.LocalHTTPServer(('127.0.0.1', 0), self.state)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        os.chdir(self.original_cwd)
        self.temp.cleanup()

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, payload, {'Content-Type': 'application/json'} if payload is not None else {})
        response = connection.getresponse()
        data = json.loads(response.read() or b'{}')
        connection.close()
        return response.status, data

    def test_status_diff_and_commit(self):
        with patch.object(client, 'load_config', return_value={'authorization': 'a', 'chat_session_id': 's'}):
            self.assertEqual(self.request('GET', '/api/status')[1]['branch'], 'main')
        status, data = self.request('GET', '/api/git/status')
        self.assertEqual((status, [file['path'] for file in data['files']]), (200, ['a.txt']))
        status, data = self.request('POST', '/api/git/diff', {'path': 'a.txt'})
        self.assertIn('+2', data['diff'])
        self.assertEqual(self.request('POST', '/api/git/diff', {'path': '/etc/passwd'})[0], 400)
        for body in ({'paths': 'a.txt', 'subject': 'x'}, {'paths': [1], 'subject': 'x'}, {'paths': ['a.txt'], 'subject': 5}):
            with self.subTest(body=body):
                self.assertEqual(self.request('POST', '/api/git/commit', body)[0], 400)
        status, data = self.request('POST', '/api/git/commit', {'paths': ['a.txt'], 'subject': 'update a'})
        self.assertEqual(status, 200)
        self.assertEqual(self.request('GET', '/api/git/log')[1]['commits'][0]['subject'], 'update a')
        self.assertEqual(self.request('POST', '/api/git/nope', {})[0], 404)

    def test_errors_carry_git_output(self):
        status, data = self.request('POST', '/api/git/push', {})
        self.assertEqual(status, 400)
        self.assertIn('Сервер не подключён', data['error'])

    def test_writes_wait_for_a_running_answer(self):
        run = self.state.start_run('chat')
        try:
            status, data = self.request('POST', '/api/git/commit', {'paths': ['a.txt'], 'subject': 'x'})
            self.assertEqual(status, 409)
            self.assertEqual(self.request('GET', '/api/git/status')[0], 200)
        finally:
            self.state.finish_run(run)
        self.state.git_busy = True
        self.assertEqual(self.request('POST', '/api/chat', {'conversation_id': 'c', 'message': 'hi'})[0], 409)
        self.state.git_busy = False

    def test_commit_message_from_deepseek(self):
        prompts = []

        def fake_send(config, prompt, parent, **kwargs):
            prompts.append((config['chat_session_id'], prompt, kwargs.get('thinking_enabled')))
            return 'id', '{"subject": "feat: bump a", "body": "Меняет 1 на 2."}'

        with patch.object(client, 'load_config', return_value={'authorization': 'a', 'chat_session_id': 'main-chat'}), \
                patch.object(client, 'create_chat_session', return_value='commit-chat'), \
                patch.object(client, 'send_chat_completion', side_effect=fake_send):
            status, data = self.request('POST', '/api/git/message', {'paths': ['a.txt'], 'draft': 'поднял версию'})
        self.assertEqual((status, data['subject'], data['body']), (200, 'feat: bump a', 'Меняет 1 на 2.'))
        session, prompt, thinking = prompts[0]
        self.assertEqual((session, thinking), ('commit-chat', False))
        self.assertIn('+2', prompt)
        self.assertIn('поднял версию', prompt)
        self.assertIsNone(self.state.active)


if __name__ == '__main__':
    unittest.main()
