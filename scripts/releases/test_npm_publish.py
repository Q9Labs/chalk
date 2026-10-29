"""Publish only the production commit, even when master has advanced."""

import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

from npm_publish import PRODUCTION_RELEASE_URL, verify_publish_ref

ROOT = Path(__file__).resolve().parents[2]


class NpmPublishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        cls.source = Path(cls.directory.name) / 'origin'
        cls.source.mkdir()
        cls.git(cls.source, 'init', '-b', 'master')
        cls.git(cls.source, 'config', 'user.name', 'Release contract')
        cls.git(cls.source, 'config', 'user.email', 'release@example.invalid')
        cls.base = cls.commit('previous production')
        cls.production = cls.commit('promoted production')
        cls.master = cls.commit('unrelated master change')
        cls.git(cls.source, 'checkout', '-b', 'side', cls.base)
        cls.side = cls.commit('unrelated branch')
        cls.git(cls.source, 'checkout', 'master')

        class Marker(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.last_headers = self.headers
                self.send_response(cls.http_status)
                self.end_headers()
                self.wfile.write(cls.body)

            def log_message(self, *_):
                pass

        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Marker)
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server.shutdown)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/release.json'

    @staticmethod
    def git(cwd, *args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args],
                                       cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()

    @classmethod
    def commit(cls, message):
        cls.git(cls.source, 'commit', '--allow-empty', '-m', message)
        return cls.git(cls.source, 'rev-parse', 'HEAD')

    def setUp(self):
        self.checkout_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.checkout_dir.cleanup)
        self.checkout = Path(self.checkout_dir.name) / 'checkout'
        self.git(self.source, 'clone', '--depth=1', self.source.as_uri(), str(self.checkout))
        type(self).http_status = 200
        self.marker({'environment': 'production', 'commit': self.production})

    def marker(self, marker):
        type(self).body = json.dumps(marker).encode()

    def verify(self, sha):
        with contextlib.chdir(self.checkout):
            verify_publish_ref(sha, self.url)

    def test_production_commit_behind_master_is_accepted_from_shallow_checkout(self):
        self.assertEqual(self.git(self.checkout, 'rev-parse', '--is-shallow-repository'), 'true')
        self.verify(self.production)
        self.assertEqual(self.git(self.checkout, 'rev-parse', '--is-shallow-repository'), 'false')
        self.assertEqual(self.last_headers['User-Agent'], 'chalk-release/1.0')
        self.assertEqual(self.last_headers['Cache-Control'], 'no-cache')

    def test_production_commit_at_master_is_accepted(self):
        self.marker({'environment': 'production', 'commit': self.master})
        self.verify(self.master)

    def test_master_only_commit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Production identity check failed:.*does not match live production'):
            self.verify(self.master)

    def test_non_ancestor_is_rejected_even_if_production_reports_it(self):
        self.git(self.checkout, 'fetch', 'origin', self.side)
        self.marker({'environment': 'production', 'commit': self.side})
        with self.assertRaisesRegex(ValueError, 'Ancestry check failed:.*not an ancestor'):
            self.verify(self.side)

    def test_production_identity_mismatch_is_rejected(self):
        self.marker({'environment': 'production', 'commit': self.base})
        with self.assertRaisesRegex(ValueError, 'Production identity check failed:.*does not match live production'):
            self.verify(self.production)

    def test_unreachable_identity_is_rejected(self):
        type(self).http_status = 503
        with self.assertRaisesRegex(ValueError, 'Production identity check failed:.*unreachable'):
            self.verify(self.production)

    def test_malformed_identity_is_rejected(self):
        for marker in (None, [], {}, {'environment': 'nightly', 'commit': self.production},
                       {'environment': 'production', 'commit': self.production[:8]},
                       {'environment': 'production', 'commit': 123}):
            with self.subTest(marker=marker):
                self.marker(marker)
                with self.assertRaisesRegex(ValueError, 'Production identity check failed:.*must report production'):
                    self.verify(self.production)
        type(self).body = b'not json'
        with self.assertRaisesRegex(ValueError, 'Production identity check failed:.*malformed'):
            self.verify(self.production)

    def test_empty_or_non_sha_release_ref_is_rejected(self):
        for sha in ('', 'master', self.production[:8], '0' * 39, self.production.upper()):
            with self.subTest(sha=sha), self.assertRaisesRegex(ValueError, 'explicit full lowercase commit SHA'):
                self.verify(sha)

    def test_unreachable_master_is_rejected(self):
        self.git(self.checkout, 'remote', 'set-url', 'origin', str(self.source / 'missing'))
        with self.assertRaisesRegex(ValueError, 'Ancestry check failed:.*could not fetch'):
            self.verify(self.production)

    def test_workflow_uses_its_own_guard_before_checking_out_the_release(self):
        workflow = (ROOT / '.github/workflows/npm-publish.yml').read_text()
        guard_checkout = workflow.index('      - name: Checkout publish guard\n')
        guard = workflow.index('      - name: Verify publish ref\n')
        checkout = workflow.index('      - name: Checkout\n')
        self.assertLess(guard_checkout, guard)
        self.assertLess(guard, checkout)
        self.assertIn('ref: ${{ github.sha }}', workflow[guard_checkout:guard])
        self.assertIn('if: ${{ !inputs.dry_run }}', workflow[guard:checkout])
        self.assertIn('RELEASE_SHA: ${{ inputs.release_sha }}', workflow[guard:checkout])
        self.assertIn('run: python3 scripts/releases/npm_publish.py "$RELEASE_SHA"', workflow[guard:checkout])
        self.assertIn('ref: ${{ inputs.release_sha || github.sha }}', workflow[checkout:])
        self.assertEqual(PRODUCTION_RELEASE_URL, 'https://chalkmeet.com/release.json')
        contracts = (ROOT / '.github/workflows/release-contracts.yml').read_text()
        self.assertIn('      - .github/workflows/npm-publish.yml\n', contracts)
