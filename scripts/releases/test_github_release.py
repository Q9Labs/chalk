"""Drive the real GitHub helper through a failing gh executable."""

import io
import os
import signal
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from github_release import GitHub


class GitHubRetry(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.count = root / 'calls'
        self.pids = root / 'pids'
        gh = root / 'gh'
        gh.write_text(f'#!{sys.executable}\n' + r'''
import json
import os
from pathlib import Path
import sys
import time
import signal

count = Path(os.environ['GH_FAKE_COUNT'])
attempt = int(count.read_text()) + 1 if count.exists() else 1
count.write_text(str(attempt))
with open(os.environ['GH_FAKE_PIDS'], 'a') as pids:
    pids.write(f'{os.getpid()}\n')
if os.environ.get('GH_FAKE_HANG') == '1':
    child = os.fork()
    if child == 0:
        if os.environ.get('GH_FAKE_IGNORE_TERM') == '1':
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.alarm(5)
        with open(os.environ['GH_FAKE_PIDS'], 'a') as pids:
            pids.write(f'{os.getpid()}\n')
        print('partial response', flush=True)
        time.sleep(5)
        os._exit(0)
    signal.alarm(5)
    time.sleep(5)
if attempt <= int(os.environ['GH_FAKE_FAILURES']):
    if os.environ.get('GH_FAKE_PARTIAL') == '1':
        print(json.dumps([{'jobs': [{'id': 99}]}]))
    print(os.environ['GH_FAKE_ERROR'], file=sys.stderr)
    sys.exit(1)
pages = [[{'id': 1}], [{'id': 2}]]
if os.environ.get('GH_FAKE_PARTIAL') == '1':
    pages = [{'jobs': page} for page in pages]
print(json.dumps(pages if '--paginate' in sys.argv else {'id': 1}))
''')
        gh.chmod(0o755)
        environment = patch.dict(os.environ, {
            'PATH': f'{root}{os.pathsep}{os.environ["PATH"]}',
            'GITHUB_REPOSITORY': 'example/repository',
            'GH_FAKE_COUNT': str(self.count),
            'GH_FAKE_PIDS': str(self.pids),
            'GH_FAKE_FAILURES': '3',
            'GH_FAKE_ERROR': 'gh: Server Error (HTTP 502)',
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.github = GitHub()

    def test_hanging_calls_terminate_the_process_tree(self):
        self.github = GitHub(timeout=0.3)
        for method, attempts, ignore_term in ((method, attempts, ignore_term)
                for method, attempts in (('request', 4), ('pages', 4), ('post', 1))
                for ignore_term in ('0', '1')):
            with self.subTest(method=method, ignore_term=ignore_term), patch.dict(
                    os.environ, GH_FAKE_HANG='1', GH_FAKE_IGNORE_TERM=ignore_term), patch('github_release.backoff_sleep') as sleep:
                self.count.unlink(missing_ok=True)
                self.pids.unlink(missing_ok=True)
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    if method == 'post':
                        self.github.reserve_cut('a' * 40)
                    else:
                        self.call(method)
                self.assertEqual(caught.exception.returncode, 124)
                self.assertIn(b'timed out', caught.exception.stderr)
                self.assertEqual(caught.exception.output, b'partial response\n')
                self.assertEqual(self.count.read_text(), str(attempts))
                self.assertEqual(sleep.call_count, attempts - 1)
                pids = self.pids.read_text().splitlines()
                self.assertEqual(len(pids), attempts * 2)
                for pid in pids:
                    # An orphan zombie has exited; only its init-owned bookkeeping remains.
                    state = subprocess.run(['ps', '-o', 'stat=', '-p', pid],
                                           capture_output=True, text=True, timeout=1).stdout.strip()
                    self.assertTrue(not state or state.startswith('Z'), (pid, state))

    def test_interrupt_terminates_the_process_tree(self):
        with patch.dict(os.environ, GH_FAKE_HANG='1', GH_FAKE_IGNORE_TERM='1'):
            owner = subprocess.Popen([sys.executable, '-B', '-c',
                "import signal; signal.alarm(5); from github_release import GitHub; "
                "GitHub().request('actions/runs/123/jobs')"],
                cwd=Path(__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if self.pids.exists() and len(self.pids.read_text().splitlines()) == 2:
                        break
                    time.sleep(0.01)
                self.assertTrue(self.pids.exists())
                pids = self.pids.read_text().splitlines()
                self.assertEqual(len(pids), 2)
                owner.send_signal(signal.SIGINT)
                _, stderr = owner.communicate(timeout=2)
                self.assertNotEqual(owner.returncode, 0)
                self.assertIn(b'KeyboardInterrupt', stderr)
                for pid in pids:
                    state = subprocess.run(['ps', '-o', 'stat=', '-p', pid],
                                           capture_output=True, text=True, timeout=1).stdout.strip()
                    self.assertTrue(not state or state.startswith('Z'), (pid, state))
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=1)
                owner.stdout.close()
                owner.stderr.close()

    def test_partial_pagination_output_is_discarded_on_retry(self):
        with patch.dict(os.environ, GH_FAKE_PARTIAL='1', GH_FAKE_FAILURES='1'), patch('github_release.backoff_sleep'):
            self.assertEqual(self.github.pages('actions/runs/123/jobs', 'jobs'), [{'id': 1}, {'id': 2}])
            self.assertEqual(self.count.read_text(), '2')

    def call(self, method):
        return getattr(self.github, method)('actions/runs/123/jobs?filter=latest')

    def test_reads_recover_on_fourth_attempt(self):
        for method in ('request', 'pages'):
            with self.subTest(method=method), patch('github_release.backoff_sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO) as stderr:
                self.count.unlink(missing_ok=True)
                self.assertEqual(self.call(method), {'id': 1} if method == 'request' else [{'id': 1}, {'id': 2}])
                self.assertEqual(self.count.read_text(), '4')
                self.assertEqual(sleep.call_count, 3)
                self.assertLessEqual(sum(call.args[0] for call in sleep.call_args_list), 21)
                self.assertIn('actions/runs/123/jobs?filter=latest', stderr.getvalue())
                self.assertIn('attempt 4/4', stderr.getvalue())

    def test_reads_give_up_after_four_attempts(self):
        with patch.dict(os.environ, GH_FAKE_FAILURES='10'):
            for method in ('request', 'pages'):
                with self.subTest(method=method), patch('github_release.backoff_sleep') as sleep:
                    self.count.unlink(missing_ok=True)
                    with self.assertRaises(subprocess.CalledProcessError) as caught:
                        self.call(method)
                    self.assertEqual(caught.exception.returncode, 1)
                    self.assertEqual(self.count.read_text(), '4')
                    self.assertEqual(sleep.call_count, 3)

    def test_client_errors_are_not_retried(self):
        for error in ('gh: Not Found (HTTP 404)', 'gh: Forbidden (HTTP 403)', 'gh: Too Many Requests (HTTP 429)'):
            for method in ('request', 'pages'):
                with self.subTest(error=error, method=method), patch.dict(os.environ, GH_FAKE_ERROR=error), patch('github_release.backoff_sleep') as sleep:
                    self.count.unlink(missing_ok=True)
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.call(method)
                    self.assertEqual(self.count.read_text(), '1')
                    sleep.assert_not_called()

    def test_connection_and_timeout_errors_recover(self):
        for error in ('error connecting to api.github.com', 'dial tcp: connection reset by peer',
                      'net/http: TLS handshake timeout', 'context deadline exceeded', 'unexpected EOF'):
            for method in ('request', 'pages'):
                with self.subTest(error=error, method=method), patch.dict(os.environ, GH_FAKE_ERROR=error), patch('github_release.backoff_sleep'):
                    self.count.unlink(missing_ok=True)
                    self.call(method)
                    self.assertEqual(self.count.read_text(), '4')

    def test_deployment_posts_are_not_retried(self):
        with patch('github_release.backoff_sleep') as sleep:
            with self.assertRaises(subprocess.CalledProcessError):
                self.github.reserve_cut('a' * 40)
            self.assertEqual(self.count.read_text(), '1')
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
