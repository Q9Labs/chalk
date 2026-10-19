"""Drive the real GitHub helper through a failing gh executable."""

import io
import os
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
        gh = root / 'gh'
        gh.write_text(f'#!{sys.executable}\n' + '''
import json
import os
from pathlib import Path
import sys

count = Path(os.environ['GH_FAKE_COUNT'])
attempt = int(count.read_text()) + 1 if count.exists() else 1
count.write_text(str(attempt))
if attempt <= int(os.environ['GH_FAKE_FAILURES']):
    print(os.environ['GH_FAKE_ERROR'], file=sys.stderr)
    sys.exit(1)
print(json.dumps([[{'id': 1}], [{'id': 2}]] if '--paginate' in sys.argv else {'id': 1}))
''')
        gh.chmod(0o755)
        environment = patch.dict(os.environ, {
            'PATH': f'{root}{os.pathsep}{os.environ["PATH"]}',
            'GITHUB_REPOSITORY': 'example/repository',
            'GH_FAKE_COUNT': str(self.count),
            'GH_FAKE_FAILURES': '3',
            'GH_FAKE_ERROR': 'gh: Server Error (HTTP 502)',
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.github = GitHub()

    def call(self, method):
        return getattr(self.github, method)('actions/runs/123/jobs?filter=latest')

    def test_reads_recover_on_fourth_attempt(self):
        for method in ('request', 'pages'):
            with self.subTest(method=method), patch('time.sleep') as sleep, patch('sys.stderr', new_callable=io.StringIO) as stderr:
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
                with self.subTest(method=method), patch('time.sleep') as sleep:
                    self.count.unlink(missing_ok=True)
                    with self.assertRaises(subprocess.CalledProcessError) as caught:
                        self.call(method)
                    self.assertEqual(caught.exception.returncode, 1)
                    self.assertEqual(self.count.read_text(), '4')
                    self.assertEqual(sleep.call_count, 3)

    def test_client_errors_are_not_retried(self):
        for error in ('gh: Not Found (HTTP 404)', 'gh: Forbidden (HTTP 403)', 'gh: Too Many Requests (HTTP 429)'):
            for method in ('request', 'pages'):
                with self.subTest(error=error, method=method), patch.dict(os.environ, GH_FAKE_ERROR=error), patch('time.sleep') as sleep:
                    self.count.unlink(missing_ok=True)
                    with self.assertRaises(subprocess.CalledProcessError):
                        self.call(method)
                    self.assertEqual(self.count.read_text(), '1')
                    sleep.assert_not_called()

    def test_connection_and_timeout_errors_recover(self):
        for error in ('error connecting to api.github.com', 'dial tcp: connection reset by peer',
                      'net/http: TLS handshake timeout', 'context deadline exceeded', 'unexpected EOF'):
            for method in ('request', 'pages'):
                with self.subTest(error=error, method=method), patch.dict(os.environ, GH_FAKE_ERROR=error), patch('time.sleep'):
                    self.count.unlink(missing_ok=True)
                    self.call(method)
                    self.assertEqual(self.count.read_text(), '4')

    def test_deployment_posts_are_not_retried(self):
        with patch('time.sleep') as sleep:
            with self.assertRaises(subprocess.CalledProcessError):
                self.github.reserve_cut('a' * 40)
            self.assertEqual(self.count.read_text(), '1')
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
