import importlib.util
from pathlib import Path
import tempfile
import unittest
import hashlib
import http.server
import json
import threading
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / 'apps/api/internal/adapters/digitalocean/recorder_install.py'
spec = importlib.util.spec_from_file_location('recorder_install', SOURCE)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstalledReleaseContract(unittest.TestCase):
    def test_archive_download_recovers_from_transient_http_and_truncated_body(self):
        payload = b'verified recorder archive' * 100
        calls = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                self.send_response(503 if len(calls) == 1 else 200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                if len(calls) == 2:
                    self.wfile.write(payload[:10])
                elif len(calls) == 3:
                    self.wfile.write(payload)
                self.close_connection = True

            def log_message(self, *args):
                pass

        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                with tempfile.TemporaryDirectory() as directory:
                    config = dict(release_id='test', sha256=hashlib.sha256(payload).hexdigest(),
                                  url=f'http://127.0.0.1:{server.server_port}/archive')
                    with self.assertRaisesRegex(installer.ArchiveInstallError, '^archive_extraction_failed$'):
                        installer.install(config, Path(directory))
                    self.assertEqual(len(calls), 3)
            finally:
                server.shutdown()
                thread.join()

    def test_download_failure_is_bounded_and_does_not_log_bearer_url(self):
        import contextlib
        import io
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(output), \
                patch.object(installer.urllib.request, 'urlopen', side_effect=TimeoutError('SECRET')), \
                patch.object(installer.time, 'sleep'), self.assertRaisesRegex(installer.ArchiveInstallError, '^archive_download_failed$'):
            installer.install(dict(release_id='test', sha256='a' * 64,
                                   url='https://example.test/?token=SECRET'), Path(directory))
        self.assertNotIn('SECRET', output.getvalue())
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([event['attempt'] for event in events], [1, 2, 3])
        self.assertEqual(events[-1]['reason_code'], 'timeout')

    def test_verified_archive_replaces_receiptless_baked_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'selected'
            target.mkdir()
            (target / 'binary').write_bytes(b'baked bytes')
            stage = root / '.stage'
            stage.mkdir()
            release = stage / 'release'
            release.mkdir()
            (release / 'binary').write_bytes(b'verified archive bytes')
            (release / '.archive-sha256').write_text('a' * 64)
            installer.select_release(release, target, 'a' * 64)
            self.assertEqual((target / 'binary').read_bytes(), b'verified archive bytes')
            self.assertEqual((stage / 'previous/binary').read_bytes(), b'baked bytes')
            installer.select_release(release, target, 'a' * 64)
            with self.assertRaisesRegex(ValueError, 'different bytes'):
                installer.select_release(release, target, 'b' * 64)

    def test_failed_selection_restores_baked_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'selected'
            target.mkdir()
            (target / 'binary').write_bytes(b'baked bytes')
            with self.assertRaises(FileNotFoundError):
                installer.select_release(root / 'missing', target, 'a' * 64)
            self.assertEqual((target / 'binary').read_bytes(), b'baked bytes')

    def test_download_checksum_and_extraction_failures_have_bounded_reasons(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / 'invalid.tar.gz'
            bundle.write_bytes(b'not an archive')
            config = dict(release_id='test', sha256='a' * 64, manifest_digest='sha256:'+'a'*64)
            for url, sha, reason in (
                ((root / 'absent').as_uri(), 'a'*64, 'archive_download_failed'),
                (bundle.as_uri(), 'a'*64, 'archive_verification_failed'),
                (bundle.as_uri(), hashlib.sha256(bundle.read_bytes()).hexdigest(), 'archive_extraction_failed'),
            ):
                with self.subTest(reason=reason):
                    config.update(url=url, sha256=sha)
                    with self.assertRaisesRegex(installer.ArchiveInstallError, '^'+reason+'$'):
                        installer.install(config, root)
                    self.assertFalse((root / 'releases/test').exists())
