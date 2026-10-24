"""Exercise Pages rollback through real HTTP requests and release outputs."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import web


class PagesRollback(unittest.TestCase):
    def test_rollback_over_http(self):
        for case in ('restore', 'already-live', 'stale', 'http-error', 'invalid-json',
                     'api-error', 'preview', 'failed', 'missing'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                requests = []
                live = 'saved' if case == 'already-live' else 'old'

                class PagesAPI(BaseHTTPRequestHandler):
                    def log_message(self, *args):
                        pass

                    def do_GET(self):
                        requests.append(('GET', self.path))
                        self.send_response(503 if case == 'http-error' else 200)
                        self.end_headers()
                        deployment = dict(id=live, environment='preview' if case == 'preview' else 'production',
                                          latest_stage=dict(status='failed' if case == 'failed' else 'success'))
                        response = dict(success=case != 'api-error', result=dict(canonical_deployment=None if case == 'missing' else deployment))
                        self.wfile.write(b'not JSON' if case == 'invalid-json' else json.dumps(response).encode())

                    def do_POST(self):
                        nonlocal live
                        requests.append(('POST', self.path))
                        if case != 'stale':
                            live = 'saved'
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(json.dumps(dict(success=True, result=dict(id='saved'))).encode())

                server = ThreadingHTTPServer(('127.0.0.1', 0), PagesAPI)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                output = Path(directory, 'outputs')
                output.touch()
                stdout = io.StringIO()
                try:
                    with patch.dict(os.environ, CLOUDFLARE_API_BASE_URL=f'http://127.0.0.1:{server.server_port}',
                                    CLOUDFLARE_ACCOUNT_ID='example-account', CLOUDFLARE_API_TOKEN='example-token',
                                    GITHUB_OUTPUT=str(output)), contextlib.redirect_stdout(stdout):
                        if case in ('restore', 'already-live'):
                            web.rollback('example-project', 'saved')
                            self.assertEqual(output.read_text(), 'pages_deployment_id=saved\n')
                        else:
                            with self.assertRaises((ValueError, KeyError, web.urllib.error.HTTPError)) as failure:
                                web.rollback('example-project', 'saved')
                            cause = failure.exception.__cause__
                            if isinstance(cause, web.urllib.error.HTTPError):
                                cause.close()
                            if case == 'stale':
                                self.assertIn('saved deployment is not live', str(failure.exception))
                            self.assertEqual(output.read_text(), '')
                            self.assertEqual(stdout.getvalue(), '')
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=5)
                methods = [method for method, _ in requests]
                self.assertEqual(methods, ['GET', 'POST', 'GET'] if case in ('restore', 'stale') else
                                 ['GET', 'GET'] if case == 'already-live' else ['GET'])
                prefix = '/accounts/example-account/pages/projects/example-project'
                self.assertTrue(all(path == prefix if method == 'GET' else path == prefix + '/deployments/saved/rollback'
                                    for method, path in requests))


if __name__ == '__main__':
    unittest.main()
