"""Exercise Pages rollback through real HTTP requests and release outputs."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import subprocess
import tarfile
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import web


class PagesRollback(unittest.TestCase):
    def test_rollback_over_http(self):
        rejected_hosts = {'non-loopback': '0.0.0.0', 'localhost-substring': 'localhost.evil.example',
                          'ipv4-substring': '127.0.0.1.evil.example', 'userinfo-host': 'user@evil.example',
                          'mapped-dotted': '[::ffff:127.0.0.1]', 'mapped-hex': '[::ffff:7f00:1]'}
        for case in ('restore', 'already-live', 'stale', 'http-error', 'invalid-json',
                     'api-error', 'preview', 'failed', 'missing', 'post-id-mismatch', *rejected_hosts):
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
                        self.wfile.write(json.dumps(dict(success=True, result=dict(id='other' if case == 'post-id-mismatch' else 'saved'))).encode())

                server = ThreadingHTTPServer(('127.0.0.1', 0), PagesAPI)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                output = Path(directory, 'outputs')
                output.touch()
                stdout = io.StringIO()
                try:
                    host = rejected_hosts.get(case, '127.0.0.1')
                    with patch.dict(os.environ, CLOUDFLARE_API_BASE_URL=f'http://{host}:{server.server_port}', NO_PROXY='*', no_proxy='*',
                                    CLOUDFLARE_ACCOUNT_ID='example-account', CLOUDFLARE_API_TOKEN='example-token',
                                    GITHUB_OUTPUT=str(output)), contextlib.redirect_stdout(stdout), patch.object(web.subprocess, 'run') as probe:
                        if case in ('restore', 'already-live'):
                            web.rollback('example-project', 'saved')
                            self.assertEqual(output.read_text(), 'pages_deployment_id=saved\n')
                            self.assertTrue(probe.call_args.args[0][1].endswith('/verify-vendor-store.mjs'))
                        else:
                            with self.assertRaises((ValueError, KeyError, web.urllib.error.HTTPError)) as failure:
                                web.rollback('example-project', 'saved')
                            cause = failure.exception.__cause__
                            if isinstance(cause, web.urllib.error.HTTPError):
                                cause.close()
                            if case in rejected_hosts:
                                self.assertIn('override must use a loopback host', str(failure.exception))
                            if case == 'non-loopback':
                                os.environ.pop('CLOUDFLARE_API_TOKEN')
                                with self.assertRaisesRegex(ValueError, 'override must use a loopback host'):
                                    web.rollback('example-project', 'saved')
                            if case == 'post-id-mismatch':
                                self.assertIn('returned a different deployment', str(failure.exception))
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
                                 ['GET', 'GET'] if case == 'already-live' else
                                 ['GET', 'POST'] if case == 'post-id-mismatch' else [] if case in rejected_hosts else ['GET'])
                prefix = '/accounts/example-account/pages/projects/example-project'
                self.assertTrue(all(path == prefix if method == 'GET' else path == prefix + '/deployments/saved/rollback'
                                    for method, path in requests))


    def test_override_ignores_environment_proxy(self):
        received = []

        class API(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                received.append((self.server.label, self.headers.get('Authorization')))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(dict(success=True, result=dict(canonical_deployment=dict(
                    id='saved', environment='production', latest_stage=dict(status='success'))))).encode())

        with contextlib.ExitStack() as stack:
            target, proxy = [stack.enter_context(ThreadingHTTPServer(('127.0.0.1', 0), API)) for _ in range(2)]
            for server, label in ((target, 'target'), (proxy, 'proxy')):
                server.label = label
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                stack.callback(thread.join, 5)
                stack.callback(server.shutdown)
            directory = stack.enter_context(tempfile.TemporaryDirectory())
            output = Path(directory, 'outputs')
            output.touch()
            proxy_url = f'http://127.0.0.1:{proxy.server_port}'
            with patch.dict(os.environ, CLOUDFLARE_API_BASE_URL=f'http://127.0.0.1:{target.server_port}',
                            HTTP_PROXY=proxy_url, http_proxy=proxy_url, NO_PROXY='', no_proxy='',
                            CLOUDFLARE_ACCOUNT_ID='example-account', CLOUDFLARE_API_TOKEN='dummy-token',
                            GITHUB_OUTPUT=str(output)), contextlib.redirect_stdout(io.StringIO()), patch.object(web.subprocess, 'run') as probe:
                web.rollback('example-project', 'saved')
            self.assertEqual(received, [('target', 'Bearer dummy-token')] * 2)
            self.assertEqual(output.read_text(), 'pages_deployment_id=saved\n')
            self.assertTrue(probe.call_args.args[0][1].endswith('/verify-vendor-store.mjs'))


    def test_override_does_not_follow_redirect(self):
        received = []

        class Destination(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                received.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(dict(success=True, result=dict(canonical_deployment=dict(
                    id='saved', environment='production', latest_stage=dict(status='success'))))).encode())

        @contextlib.contextmanager
        def serving(handler):
            with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    yield server
                finally:
                    server.shutdown()
                    thread.join(timeout=5)

        with serving(Destination) as destination:
            class Redirect(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass

                def do_GET(self):
                    self.send_response(302)
                    self.send_header('Location', f'http://0.0.0.0:{destination.server_port}/capture')
                    self.end_headers()

            with serving(Redirect) as redirect, tempfile.TemporaryDirectory() as directory:
                output = Path(directory, 'outputs')
                output.touch()
                stdout = io.StringIO()
                with patch.dict(os.environ, CLOUDFLARE_API_BASE_URL=f'http://127.0.0.1:{redirect.server_port}',
                                CLOUDFLARE_ACCOUNT_ID='example-account', CLOUDFLARE_API_TOKEN='dummy-token',
                                GITHUB_OUTPUT=str(output), NO_PROXY='*', no_proxy='*'), contextlib.redirect_stdout(stdout), patch.object(web.subprocess, 'run'):
                    with self.assertRaises(ValueError) as failure:
                        web.rollback('example-project', 'saved')
                    if isinstance(failure.exception.__cause__, web.urllib.error.HTTPError):
                        failure.exception.__cause__.close()
                self.assertEqual(received, [])
                self.assertEqual(output.read_text(), '')
                self.assertEqual(stdout.getvalue(), '')


SHA = 'a' * 40


def legacy_artifact(target):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as archive:
        marker = json.dumps({'environment': target, 'commit': SHA}).encode()
        member = tarfile.TarInfo('dist/client/release.json')
        member.size = len(marker)
        archive.addfile(member, io.BytesIO(marker))
    return data.getvalue()


@patch.dict(os.environ, CLOUDFLARE_ACCOUNT_ID='fixture-account', GITHUB_REPOSITORY='fixture/repository')
class WebVendorStore(unittest.TestCase):
    def test_worker_probe_failure_stops_native_pages_rollback(self):
        with patch.object(web.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'verify-vendor-store')), patch.object(web, 'pages', return_value={'id': 'saved'}) as pages, patch.object(web, 'current', return_value='saved'), patch.object(web, 'outputs'):
            with self.assertRaises(subprocess.CalledProcessError):
                web.rollback('chalk', 'saved')
            pages.assert_not_called()

    def test_legacy_archives_deploy_without_an_asset_manifest(self):
        for target in ['production', 'nightly']:
            with self.subTest(target=target):
                def execute(args, **kwargs):
                    if args[1].endswith('/prepare-vendor-store.ts'):
                        self.assertEqual(os.listdir(args[args.index('--directory') + 1]), ['release.json'])
                    return subprocess.CompletedProcess(args, 0)

                with patch.object(web.GitHub, 'artifact', return_value=legacy_artifact(target)), patch.object(web.subprocess, 'run', side_effect=execute) as run:
                    web.deploy(target, SHA, '1', {'sha256': 'b' * 64, 'artifact_id': '2'}, 'fixture-project')
                publish, upload, verify = [call.args[0] for call in run.call_args_list]
                self.assertEqual(publish[-2:], ['--target', target])
                self.assertEqual(upload[1:4], ['pages', 'deploy', 'dist/client'])
                self.assertIn(web.public_config(target, SHA)['VITE_PUBLIC_APP_URL'], verify)

    def test_vendor_upload_failure_stops_pages_publication(self):
        with patch.object(web.GitHub, 'artifact', return_value=legacy_artifact('production')), patch.object(web.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'upload-vendor-assets')) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                web.deploy('production', SHA, '1', {'sha256': 'b' * 64, 'artifact_id': '2'}, 'fixture-project')
            self.assertEqual(run.call_count, 1)
            self.assertTrue(run.call_args.args[0][1].endswith('/prepare-vendor-store.ts'))


if __name__ == '__main__':
    unittest.main()
