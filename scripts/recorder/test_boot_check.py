import copy
import hashlib
import importlib.util
import http.client
import io
import urllib.request
import json
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


boot = load('boot-check')
host = load('boot-check-host')


class BootCheckTests(unittest.TestCase):
    def test_failure_diagnosis_retains_cloud_init_and_archive_codes_not_log_secrets(self):
        installed = {'commands': {'cloud_init': {'status': 1, 'stdout': 'status: error\nerrors: [SECRET]'}},
                     'files': {'/var/log/cloud-init.log': {'content': 'Failed to run module scripts_user (SECRET)'},
                               '/var/log/cloud-init-output.log': {'content': '\n'.join([
                                   'SECRET https://example.test/?token=SECRET',
                                   'recorder archive installation failed: archive_download_failed',
                                   json.dumps(dict(event='recorder_archive_download', attempt=3, reason_code='timeout',
                                                   http_status=0, bytes_received=42, elapsed_seconds=91, url='SECRET'))])}}}
        evidence = {'record': {'bootstrap_diagnostic': {'step': 'install', 'last_reason_code': 'archive_download_failed',
                                                       'detail': 'SECRET'}}}
        diagnosis = boot.boot_diagnosis(installed, evidence)
        self.assertEqual(diagnosis['cloud_init_status'], 'error')
        self.assertEqual(diagnosis['cloud_init_exit_status'], 1)
        self.assertEqual(diagnosis['failed_modules'], ['scripts_user'])
        self.assertEqual(diagnosis['issuer_archive_failure'], 'archive_download_failed')
        self.assertEqual(diagnosis['archive_failure'], 'archive_download_failed')
        self.assertEqual(diagnosis['missing_files'], ['/etc/chalk-recorder/worker.env', '/etc/chalk-recorder/node.env'])
        self.assertEqual(diagnosis['archive_downloads'][0]['bytes_received'], 42)
        self.assertNotIn('SECRET', json.dumps(diagnosis))
        self.assertEqual(boot.boot_diagnosis(None, evidence)['issuer_archive_failure'], 'archive_download_failed')

    def test_script_messages_survive_and_http_payloads_do_not(self):
        import urllib.error

        secret = 'fake-private-data-sentinel'
        self.assertEqual(boot.safe_error(boot.DiagnosticError('audited message')), 'audited message')
        self.assertEqual(boot.safe_error(urllib.error.URLError(secret)), 'URLError')
        self.assertEqual(boot.safe_error(urllib.error.HTTPError('https://example.test/' + secret, 403, secret, None, None)),
                         'HTTP request failed HTTP 403; payload suppressed')

    def test_untrusted_errors_expose_only_their_class(self):
        import ipaddress
        import urllib.parse
        from datetime import datetime

        secret = 'fake-private-value-sentinel'

        class OpaqueError(Exception):
            def __str__(self):
                raise AssertionError('untrusted error text must not be read')

        self.assertEqual(boot.safe_error(OpaqueError(secret)), 'OpaqueError')
        self.assertEqual(boot.safe_error(RuntimeError(secret)), 'RuntimeError')
        cases = [
            (lambda: datetime.fromisoformat(secret), 'ValueError'),
            (lambda: int(secret), 'ValueError'),
            (lambda: urllib.parse.urlsplit('https://example.test:' + secret).port,
             'ValueError'),
            (lambda: ipaddress.ip_address(secret), 'ValueError'),
        ]
        for parse, expected in cases:
            with self.subTest(expected=expected), self.assertRaises(ValueError) as caught:
                parse()
            self.assertEqual(boot.safe_error(caught.exception), expected)
            self.assertNotIn(secret, boot.safe_error(caught.exception))
        self.assertEqual(boot.safe_error(FileNotFoundError(2, 'No such file or directory', secret)),
                         'FileNotFoundError')
        self.assertEqual(boot.safe_error(UnicodeDecodeError('utf-8', secret.encode(), 0, 1, secret)),
                         'UnicodeDecodeError')
        with self.assertRaises(json.JSONDecodeError) as caught:
            json.loads(secret)
        self.assertEqual(boot.safe_error(caught.exception), 'JSONDecodeError')

    def run_parser_failure(self, directory, issuer_url, cleanup_services=None):
        import os
        from unittest.mock import Mock

        request_path, receipt_path = directory / 'request.json', directory / 'receipt.json'
        request_path.write_text(json.dumps(dict(
            schema_version=1, role='capture', source_commit='a' * 40, release_id='candidate',
            image_id=1, image_digest='sha256:' + 'a' * 64, region='region', size='size',
            archive=dict(bucket='example-artifacts', key='recorder/capture/' + 'a' * 64 + '.tar.gz',
                         sha256='a' * 64, region='region'))))
        services = Mock(profile='', region='region')
        services.host.return_value = dict(
            env=dict(REGION='region', SIZE='size', ENVIRONMENT='test', OWNER_TAG='test',
                     FIREWALL_ID='fake-firewall', BOOTSTRAP_ENDPOINT='https://example.test:443'),
            issuer_control_plane_url=issuer_url, journal=dict(journal=dict(nodes={})))
        services.do.side_effect = [dict(sizes=[dict(slug='size', regions=['region'], price_hourly=0.01)]),
                                   dict(droplets=[]), dict(ssh_key=dict(id=1)), None,
                                   dict(firewall=dict(outbound_rules=[]))]
        services.aws.return_value = dict(PublicAccessBlockConfiguration={
            key: not cleanup_services for key in
            ('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets')})

        def start_guard(*args, **kwargs):
            work = next(directory.glob('boot-check-*'))
            boot.private_json(work / 'watchdog-started.json', {})
            if cleanup_services:
                def wait(**kwargs):
                    (work / 'watchdog-started.json').unlink()
                    boot.append(work, dict(deadline=0, tag_intent=True))
                    with patch.object(boot, 'Services', return_value=cleanup_services):
                        with self.assertRaisesRegex(RuntimeError, 'cleanup unproved'):
                            boot.watchdog(work)
                return Mock(pid=123, returncode=1, wait=Mock(side_effect=wait))
            boot.private_json(work / 'cleanup.json', dict(result='PASS'))
            return Mock(pid=123, returncode=0)

        def command(args, **kwargs):
            if args[0] == 'aws':
                return json.dumps(dict(AccessKeyId='fake-id', SecretAccessKey='fake-key'))
            if args[0] == 'ssh-keygen':
                Path(args[-1] + '.pub').write_text('fake-public-key')
                return ''
            self.assertEqual(args[0], 'curl')
            return '192.0.2.1'

        stdout = io.StringIO()
        with patch.object(boot, 'Services', return_value=services), \
                patch.object(boot.subprocess, 'Popen', side_effect=start_guard), \
                patch.object(boot, 'command', side_effect=command), \
                patch.dict(os.environ, dict(CHALK_BOOT_CHECK_EVIDENCE_BUCKET='example-evidence'), clear=True), \
                patch('sys.stdout', stdout):
            self.assertEqual(boot.run(request_path, receipt_path), 1)
        receipt = json.loads(receipt_path.read_text())
        work = next(directory.glob('boot-check-*'))
        history = [json.loads(line)['cleanup_error'] for line in (work / 'ledger.jsonl').read_text().splitlines()
                   if 'cleanup_error' in json.loads(line)]
        return receipt, history, stdout.getvalue()

    def test_bad_http_status_line_never_reaches_receipt_watchdog_or_stdout(self):
        sentinel = 'fake-private-status-line-sentinel'

        class FakeSocket:
            def makefile(self, *args):
                return io.BytesIO((sentinel + '\r\n\r\n').encode())

            def sendall(self, data):
                pass

            def close(self):
                pass

        class OfflineHTTPSConnection(http.client.HTTPSConnection):
            def connect(self):
                self.sock = FakeSocket()

        class OfflineHTTPSHandler(urllib.request.HTTPSHandler):
            def https_open(self, request):
                return self.do_open(OfflineHTTPSConnection, request)

        services = object.__new__(boot.Services)
        services.token, services.mutation_deadline = 'fake-token', None
        services.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), OfflineHTTPSHandler())
        with tempfile.TemporaryDirectory() as temp:
            receipt, history, stdout = self.run_parser_failure(Path(temp), 'https://example.test:8443', services)
        self.assertFalse(receipt['cleanup_confirmed'])
        self.assertEqual(len(history), 3)
        self.assertEqual(receipt['cleanup_errors'], history)
        self.assertTrue(all('BadStatusLine' in error for error in history))
        for value in (json.dumps(receipt), json.dumps(history), stdout):
            self.assertNotIn(sentinel, value)

    def test_url_normalization_error_never_reaches_receipt_watchdog_or_stdout(self):
        sentinel = 'fake-private-url-sentinel'
        hostname = sentinel + '\uff1aexample.test'
        with tempfile.TemporaryDirectory() as temp:
            receipt, history, stdout = self.run_parser_failure(Path(temp), 'https://' + hostname + ':8443')
        self.assertEqual(receipt['reason'], 'ValueError')
        self.assertTrue(receipt['cleanup_confirmed'])
        for value in (json.dumps(receipt), json.dumps(history), stdout):
            self.assertNotIn(sentinel, value)
            self.assertNotIn(hostname, value)

    def test_run_receipt_preserves_trusted_failure_even_when_cleanup_times_out(self):
        import os
        from unittest.mock import Mock

        request = dict(schema_version=1, role='capture', source_commit='a' * 40, release_id='candidate',
                       image_id=1, image_digest='sha256:' + 'a' * 64, region='region', size='size',
                       archive=dict(bucket='example-artifacts', key='recorder/capture/' + 'a' * 64 + '.tar.gz',
                                    sha256='a' * 64, region='region'))
        for timeout in (False, True):
            with self.subTest(cleanup_timeout=timeout), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                request_path, receipt_path = directory / 'request.json', directory / 'receipt.json'
                request_path.write_text(json.dumps(request))
                services = Mock()
                services.host.return_value = dict(
                    env=dict(REGION='region', SIZE='size', ENVIRONMENT='test', OWNER_TAG='test'),
                    issuer_control_plane_url='https://example.test:8443', journal=dict(journal=dict(nodes={})))
                services.do.side_effect = [dict(sizes=[dict(slug='size', regions=['region'], price_hourly=0.01)]),
                                           dict(droplets=[])]
                services.aws.return_value = dict(PublicAccessBlockConfiguration={})

                def start_guard(*args, **kwargs):
                    work = next(directory.glob('boot-check-*'))
                    boot.private_json(work / 'watchdog-started.json', {})
                    guard = Mock(pid=123, returncode=None if timeout else 0)
                    if timeout:
                        guard.wait.side_effect = subprocess.TimeoutExpired('fake-watchdog', 150)
                    else:
                        boot.private_json(work / 'cleanup.json', dict(result='PASS'))
                    return guard

                with patch.object(boot, 'Services', return_value=services), \
                        patch.object(boot.subprocess, 'Popen', side_effect=start_guard), \
                        patch.dict(os.environ, dict(CHALK_BOOT_CHECK_EVIDENCE_BUCKET='example-evidence'), clear=True), \
                        patch('builtins.print'):
                    self.assertEqual(boot.run(request_path, receipt_path), 1)
                receipt = json.loads(receipt_path.read_text())
                self.assertEqual(receipt['reason'], 'guest evidence bucket must block public access')
                self.assertEqual(receipt['cleanup_confirmed'], not timeout)
                self.assertEqual(receipt['result'], 'FAIL')
                self.assertNotIn('archive', receipt)
                self.assertNotIn('evidence_directory', receipt)
                self.assertNotIn(request['archive']['bucket'], json.dumps(receipt))
                self.assertNotIn(request['archive']['key'], json.dumps(receipt))

    def test_s3_cleanup_explanations_survive_watchdog_and_public_receipt(self):
        from unittest.mock import Mock

        key = 'bootdiag/owned/guest.json'
        cases = [
            ('wrong-key', [], 'guest evidence object ownership mismatch'),
            (key, [dict(Versions=[dict(Key=key + '-extra')])], 'ambiguous guest evidence object prefix'),
            (key, [{}, {}, dict(DeleteMarkers=[dict(Key=key + '-extra')])],
             'ambiguous guest evidence deletion marker'),
            (key, [{}, {}, {}, dict(Versions=[dict(Key=key)])], 'guest evidence object cleanup unproved'),
        ]
        for evidence_key, responses, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                boot.append(directory, dict(name='owned', deadline=0, evidence_bucket='fake-private-bucket',
                                            evidence_key=evidence_key))
                services = Mock()
                services.aws.side_effect = responses * 3
                with patch.object(boot, 'Services', return_value=services):
                    with self.assertRaisesRegex(RuntimeError, 'cleanup unproved'):
                        boot.watchdog(directory)
                history = [json.loads(line)['cleanup_error']
                           for line in (directory / 'ledger.jsonl').read_text().splitlines()
                           if 'cleanup_error' in json.loads(line)]
                self.assertEqual(history, [message] * 3)
                self.assertEqual(json.loads((directory / 'cleanup-failed.json').read_text())['errors'], history)
                receipt = boot.cleanup_receipt(directory, 1)
                self.assertEqual(receipt['cleanup_errors'], history)
                self.assertFalse(receipt['cleanup_confirmed'])
                self.assertNotIn('fake-private-bucket', json.dumps(receipt))
                self.assertNotIn(evidence_key, json.dumps(receipt))

    def test_http_and_managed_host_failures_keep_safe_status_distinctions(self):
        import io
        import urllib.error
        from unittest.mock import Mock

        secret = 'fake-private-payload-sentinel'
        for method in ('GET', 'POST', 'DELETE'):
            for code in (401, 429, 500):
                with self.subTest(method=method, code=code):
                    services = object.__new__(boot.Services)
                    services.token, services.mutation_deadline = secret, None
                    services.http = Mock()
                    services.http.open.side_effect = urllib.error.HTTPError(
                        'https://example.test/' + secret, code, secret, None, io.BytesIO(secret.encode()))
                    with self.assertRaises(RuntimeError) as caught:
                        services.do(method, '/private-resource')
                    message = boot.safe_error(caught.exception)
                    self.assertEqual(message, f'DigitalOcean {method} failed HTTP {code}; payload suppressed')
                    self.assertNotIn(secret, message)
                    self.assertNotIn('https://', message)
        for status in ('Pending', 'InProgress', 'Delayed', 'Failed', 'TimedOut', 'Cancelled', 'Cancelling', secret):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                services = object.__new__(boot.Services)
                services.instance, services.user_id = 'fake-instance', 1000
                responses = [dict(Command=dict(CommandId='fake-command'))]
                if status in ('Pending', 'InProgress', 'Delayed'):
                    responses += [dict(Status=status), dict(Status='Failed')]
                    expected = 'Failed'
                else:
                    responses += [dict(Status=status, StandardErrorContent=secret, StandardOutputContent=secret)]
                    expected = 'Unknown' if status == secret else status
                services.aws = Mock(side_effect=responses)
                with patch.object(boot.time, 'sleep'), self.assertRaises(RuntimeError) as caught:
                    services.host(dict(action='abandon'), Path(temp))
                self.assertEqual(boot.safe_error(caught.exception), 'managed host action failed: ' + expected)
                self.assertNotIn(secret, str(caught.exception))

    def test_cleanup_denial_survives_watchdog_in_public_receipt(self):
        import sys

        class Provider:
            def aws(self, *args):
                return boot.command([sys.executable, '-c',
                    'import sys; sys.stderr.write("An error occurred (AccessDenied) when calling the ListObjectVersions operation: PRIVATE\\n"); sys.exit(1)'])

        with tempfile.TemporaryDirectory() as directory, patch.object(boot, 'Services', return_value=Provider()):
            directory = Path(directory)
            boot.append(directory, dict(name='owned', deadline=0, evidence_bucket='private',
                                        evidence_key='bootdiag/owned/guest.json'))
            with self.assertRaisesRegex(RuntimeError, 'cleanup unproved'):
                boot.watchdog(directory)
            failure = json.loads((directory / 'cleanup-failed.json').read_text())
            self.assertEqual(len(failure['errors']), 3)
            self.assertIn('failed with exit 1; payload suppressed', failure['errors'][0])
            self.assertNotIn('PRIVATE', json.dumps(failure))
            receipt = boot.cleanup_receipt(directory, 1)
            self.assertFalse(receipt['cleanup_confirmed'])
            self.assertEqual(receipt['cleanup_errors'], failure['errors'])
            self.assertIn('cleanup failed', receipt['reason'])

    def test_subprocess_errors_never_leak_into_receipt_or_watchdog_history(self):
        from unittest.mock import Mock

        private_bucket = 'fake-private-bucket-sentinel'
        private_args = 'fake-private-aws-args-sentinel'
        command = ['aws', 's3api', 'list-object-versions', '--bucket', private_bucket, private_args]
        failures = [subprocess.TimeoutExpired(command, 60, output=private_bucket, stderr=private_args),
                    subprocess.CalledProcessError(23, command, output=private_bucket, stderr=private_args)]
        for error in failures:
            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                boot.append(directory, dict(name='owned', deadline=0, evidence_bucket=private_bucket,
                                            evidence_key='bootdiag/owned/guest.json'))
                provider = Mock()
                provider.aws.side_effect = error
                with patch.object(boot, 'Services', return_value=provider):
                    with self.assertRaisesRegex(RuntimeError, 'cleanup unproved'):
                        boot.watchdog(directory)
                receipt = boot.cleanup_receipt(directory, 1)
                serialized = json.dumps(receipt)
                history = [json.loads(line)['cleanup_error']
                           for line in (directory / 'ledger.jsonl').read_text().splitlines()
                           if 'cleanup_error' in json.loads(line)]
                for value in (serialized, json.dumps(history), (directory / 'cleanup-failed.json').read_text()):
                    self.assertNotIn(private_bucket, value)
                    self.assertNotIn(private_args, value)
                    self.assertNotIn(str(command), value)
                self.assertIn('evidence objects', serialized)
                self.assertIn('evidence objects timed out after 60 s' if isinstance(error, subprocess.TimeoutExpired)
                              else 'evidence objects failed with exit 23; payload suppressed', serialized)

    def test_watchdog_timeout_preserves_original_boot_reason(self):
        from unittest.mock import Mock

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            guard = Mock(returncode=None)
            guard.wait.side_effect = subprocess.TimeoutExpired(['private-watchdog-command'], 150)
            for original in ({'reason': 'original boot failure'}, {}):
                with self.subTest(original=original):
                    result = dict(original)
                    boot.finish_cleanup(directory, guard, result)
                    self.assertFalse(result['cleanup_confirmed'])
                    self.assertEqual(result['cleanup_errors'], [])
                    self.assertEqual(result['reason'], original.get('reason',
                        'cleanup watchdog has not completed; retains resource ownership'))

    def test_cleanup_receipt_never_confirms_missing_or_failed_watchdog(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            self.assertFalse(boot.cleanup_receipt(directory, 0)['cleanup_confirmed'])
            boot.private_json(directory / 'cleanup.json', {'result': 'PASS'})
            self.assertFalse(boot.cleanup_receipt(directory, None)['cleanup_confirmed'])
            self.assertFalse(boot.cleanup_receipt(directory, 1)['cleanup_confirmed'])
            self.assertEqual(boot.cleanup_receipt(directory, 0), {'cleanup_confirmed': True})

    def test_host_actions_run_as_the_configured_runtime_user(self):
        import base64
        import os
        import re
        environment = dict(CHALK_BOOT_CHECK_AWS_REGION='test', CHALK_BOOT_CHECK_DO_CONTEXT='test', DIGITALOCEAN_ACCESS_TOKEN='token',
                           CHALK_BOOT_CHECK_INSTANCE_ID='i-0123456789abcdef0')
        with patch.dict(os.environ, environment, clear=True), self.assertRaisesRegex(RuntimeError, 'CHALK_BOOT_CHECK_USER_ID'):
            boot.Services()
        with patch.dict(os.environ, {**environment, 'CHALK_BOOT_CHECK_USER_ID': '1000'}, clear=True):
            services = boot.Services()
        sent = []
        def aws(service, operation, *args, **kwargs):
            if operation == 'send-command':
                parameters = json.loads(Path(args[args.index('--parameters') + 1].removeprefix('file://')).read_text())
                sent.append(json.loads(base64.b64decode(re.search(r"b64decode\('([^']+)'\)", parameters['commands'][0]).group(1))))
                return {'Command': {'CommandId': 'command'}}
            return {'Status': 'Success', 'StandardOutputContent': '{}'}
        with tempfile.TemporaryDirectory() as directory, patch.object(services, 'aws', side_effect=aws):
            services.host({'action': 'summary', 'role': 'capture'}, Path(directory))
        self.assertEqual(sent, [{'action': 'summary', 'role': 'capture', 'user_id': 1000}])
        commands = []
        def check_output(command, text):
            commands.append(command)
            return json.dumps([{'Config': {'Env': []}, 'State': {'Pid': 7}}])
        with patch.object(host.subprocess, 'check_output', side_effect=check_output):
            host.runtime('chalk-recorder-capture', 1000)
        self.assertEqual(commands[0][:6], ['sudo', '-u', '#1000', 'env', 'XDG_RUNTIME_DIR=/run/user/1000', 'podman'])

    def test_early_upload_is_private_fixed_object_and_does_not_need_ssh(self):
        from datetime import datetime, timezone
        from urllib.parse import urlsplit, parse_qs
        credentials = {'AccessKeyId': 'EXAMPLE', 'SecretAccessKey': 'fixture', 'SessionToken': 'temporary token'}
        url = boot.upload.presigned_put('private-bucket', 'bootdiag/owned/guest.json', 'region', credentials, 480,
                                        datetime(2026, 10, 3, tzinfo=timezone.utc))
        parsed = urlsplit(url)
        self.assertEqual(parsed.path, '/bootdiag/owned/guest.json')
        self.assertEqual(parse_qs(parsed.query)['X-Amz-Expires'], ['480'])
        self.assertEqual(parse_qs(parsed.query)['X-Amz-SignedHeaders'], ['host'])
        self.assertNotIn('fixture', url)
        command = boot.upload.boot_command('def collect(): return {}', url, 10, {'name': 'owned'})
        self.assertEqual(command[:2], ['/bin/sh', '-c'])
        self.assertTrue(command[2].endswith('2>&1 &'))
        self.assertNotIn('ssh ', command[2])

    def test_guest_object_cleanup_rejects_wrong_owner_and_removes_versions(self):
        class Service:
            def __init__(self):
                self.versions = [{'Key': 'bootdiag/owned/guest.json', 'VersionId': 'one'}]
                self.deleted = []
            def aws(self, service, operation, *args):
                if operation == 'list-object-versions':
                    return {'Versions': self.versions}
                if '--version-id' in args:
                    self.deleted.append(args[-1]); self.versions = []
                return {}
        service = Service()
        state = {'name': 'owned', 'evidence_bucket': 'private', 'evidence_key': 'bootdiag/owned/guest.json'}
        boot.upload.clean_objects(service, state)
        self.assertEqual(service.deleted, ['one'])
        with self.assertRaisesRegex(RuntimeError, 'ownership'):
            boot.upload.clean_objects(service, {**state, 'evidence_key': 'other/guest.json'})

    def test_uploaded_guest_evidence_requires_exact_boot_and_fresh_timestamp(self):
        class Service:
            def __init__(self, value): self.value = value
            def aws(self, service, operation, *args): Path(args[-1]).write_text(json.dumps(self.value)); return {}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            boot.append(path, {'name': 'owned', 'generation': 7, 'started_at': 10, 'deadline': 20,
                               'evidence_bucket': 'private', 'evidence_key': 'bootdiag/owned/guest.json'})
            value = {'binding': {'name': 'owned', 'boot_generation': 7}, 'collected_at': 15}
            self.assertEqual(boot.guest_evidence(Service(value), path), value)
            for changed in ({**value, 'binding': {'name': 'other', 'boot_generation': 7}},
                            {**value, 'collected_at': 9}, {**value, 'collected_at': 21}):
                with self.assertRaises(RuntimeError): boot.guest_evidence(Service(changed), path)

    def test_aws_empty_delete_response_is_successful(self):
        services = boot.Services.__new__(boot.Services)
        services.profile, services.region = 'profile', 'region'
        with patch.object(boot, 'command', return_value=''):
            self.assertEqual(services.aws('s3api', 'delete-object'), {})

    def test_first_upload_can_arrive_after_certificate_registration(self):
        installed = self.fixture()[3]
        running = copy.deepcopy(installed)
        running['commands']['cloud_init']['stdout'] = 'status: running\n'
        with tempfile.TemporaryDirectory() as directory, patch.object(boot, 'guest_evidence', side_effect=[
                boot.GuestEvidenceUnavailable('not uploaded'), running, installed]) as fetch, \
                patch.object(boot.time, 'time', return_value=10), patch.object(boot.time, 'sleep'):
            self.assertEqual(boot.wait_guest_boot(None, Path(directory), 20), installed)
            self.assertEqual(fetch.call_count, 3)

    def test_missing_guest_upload_is_bounded_and_wrong_boot_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(boot, 'guest_evidence',
                side_effect=boot.GuestEvidenceUnavailable('not uploaded')), patch.object(boot.time, 'time', return_value=20):
            with self.assertRaisesRegex(RuntimeError, 'boot deadline'):
                boot.wait_guest_boot(None, Path(directory), 20)
        with patch.object(boot, 'guest_evidence', side_effect=RuntimeError('boot binding mismatch')) as fetch:
            with self.assertRaisesRegex(RuntimeError, 'binding mismatch'):
                boot.wait_guest_boot(None, Path('/unused'), 20)
            self.assertEqual(fetch.call_count, 1)

    def fixture(self):
        manifest = json.dumps({'source_commit': 'a' * 40, 'release_id': 'candidate'})
        digest = hashlib.sha256(manifest.encode()).hexdigest()
        request = dict(schema_version=1, role='capture', source_commit='a' * 40, release_id='candidate', image_id=1,
                       image_digest='sha256:' + digest, region='region', size='size', archive=dict(bucket='example-artifacts', key='recorder/capture/' + 'a' * 64 + '.tar.gz', sha256='a' * 64, region='ap-southeast-1'))
        bootstrap = dict(provider_id='1', boot_generation=7)
        identity = dict(provider_id='1', role='capture', boot_generation=7, worker_id='worker')
        cert = '-----BEGIN CERTIFICATE-----\nQ0VSVA==\n-----END CERTIFICATE-----\n'
        evidence = dict(controller_response={'status': 200}, record=dict(request=bootstrap, identity=identity,
                        certificates={'f': {'serial_number': 'f', 'pem': cert}}))
        installed = {'commands': {'cloud_init': {'status': 0, 'stdout': 'status: done\n'}},
                     'files': {'/etc/chalk-recorder/worker.env': {'content': 'configuration'},
                              '/etc/chalk-recorder/node.env': {'content': 'CHALK_RECORDER_POOL=capture\nCHALK_RECORDER_RELEASE=candidate\nCHALK_RECORDER_IMAGE_DIGEST=sha256:' + digest + '\nCHALK_RECORDER_BOOT_GENERATION=7\n'},
                              '/opt/chalk-recorder/image-manifest.json': {'content': manifest, 'sha256': digest},
                              '/etc/chalk-recorder/identity/client-cert.pem': {'content': cert + '-----BEGIN CERTIFICATE-----\nQ0E=\n-----END CERTIFICATE-----\n'}}}
        return request, bootstrap, evidence, installed

    def test_receipt_requires_delivered_matching_certificate(self):
        fixture = self.fixture()
        boot.assert_certificate_binding(*fixture)
        for mutation in ('pending', 'no_cert', 'different_cert', 'revoked', 'wrong_image', 'wrong_generation', 'failed_cloud_init', 'missing_worker_config'):
            with self.subTest(mutation=mutation):
                request, bootstrap, evidence, installed = copy.deepcopy(fixture)
                if mutation == 'pending':
                    evidence['controller_response']['status'] = 409
                elif mutation == 'no_cert':
                    evidence['record']['certificates'] = {}
                elif mutation == 'different_cert':
                    installed['files']['/etc/chalk-recorder/identity/client-cert.pem']['content'] = 'OTHER'
                elif mutation == 'revoked':
                    evidence['record']['revoked_at'] = 'now'
                elif mutation == 'wrong_image':
                    request['image_digest'] = 'sha256:' + 'b' * 64
                elif mutation == 'failed_cloud_init':
                    installed['commands']['cloud_init']['status'] = 1
                elif mutation == 'missing_worker_config':
                    del installed['files']['/etc/chalk-recorder/worker.env']
                else:
                    evidence['record']['identity']['boot_generation'] += 1
                with self.assertRaises(RuntimeError):
                    boot.assert_certificate_binding(request, bootstrap, evidence, installed)

    def test_controller_pending_is_typed_not_any_conflict(self):
        self.assertTrue(host.bootstrap_pending({'status': 409, 'body': {'error': {'code': 'recorder_fleet.bootstrap_pending'}}}))
        for result in ({'status': 409, 'body': None}, {'status': 409, 'body': {'error': {'code': 'drift'}}}, {'status': 503}):
            self.assertFalse(host.bootstrap_pending(result))

    def test_fleet_duration_formats_and_deadline_bound(self):
        for value, expected in (('5s', 5), ('500ms', .5), ('1m0s', 60), ('1h2m3s', 3723), ('.5s', .5), ('+5s', 5), (' 5s ', 5), ('1.s', 1)):
            self.assertEqual(host.duration_seconds(value), expected)
        for value in ('0s', '-1s', 'bad'):
            with self.assertRaises(ValueError):
                host.duration_seconds(value)

    def test_worker_isolation_preserves_bootstrap_and_other_egress(self):
        rules = [{'protocol': 'tcp', 'ports': '8443-8444', 'destinations': {'addresses': ['192.0.2.1']}},
                 {'protocol': 'tcp', 'ports': '443', 'destinations': {'addresses': ['0.0.0.0/0']}},
                 {'protocol': 'udp', 'ports': '53', 'destinations': {'addresses': ['0.0.0.0/0']}}]
        output = boot.isolated_rules(rules, 'https://example.test:8443', 'https://example.test:8444')
        self.assertEqual(output[0]['ports'], '8444')
        self.assertEqual(output[1:], rules[1:])
        self.assertEqual(rules[0]['ports'], '8443-8444')
        with self.assertRaises(RuntimeError):
            boot.isolated_rules([{'protocol': 'tcp', 'ports': 'all'}], 'https://example.test:8443', 'https://example.test:8444')

    def test_create_retry_reuses_exact_intent(self):
        class Provider:
            def __init__(self):
                self.calls = []

            def provider(self, task):
                self.calls.append(task)
                if len(self.calls) == 1:
                    raise RuntimeError('project service_down')
                return {'node': {'provider_id': '1'}}

        with tempfile.TemporaryDirectory() as directory, patch.object(boot.time, 'sleep'):
            provider = Provider()
            result = boot.ensure_node(provider, {'request': {'name': 'unique'}}, Path(directory), boot.time.time() + 10)
            self.assertEqual(result['node']['provider_id'], '1')
            self.assertEqual(provider.calls[0], provider.calls[1])

    def test_failed_revocation_does_not_leave_compute_or_local_key(self):
        class Provider:
            def __init__(self):
                self.deleted = False

            def host(self, *args, **kwargs):
                raise RuntimeError('issuer unavailable')

            def do(self, method, path):
                if method == 'DELETE':
                    self.deleted = True
                if self.deleted:
                    return None
                return {'droplet': {'name': 'owned', 'tags': ['owned'], 'created_at': '2026-01-01T00:00:00Z'}}

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            boot.append(directory, dict(node_id=1, name='owned', tags=['owned'], started_at=0, bootstrap={}, role='capture'))
            # A nonempty bootstrap causes the revocation attempt.
            boot.append(directory, {'bootstrap': {'provider_id': '1'}})
            (directory / 'ssh-key').write_text('task secret')
            provider = Provider()
            with self.assertRaisesRegex(RuntimeError, '^RuntimeError$'):
                boot.cleanup(provider, directory)
            self.assertTrue(provider.deleted)
            self.assertFalse((directory / 'ssh-key').exists())
            self.assertFalse((directory / 'cleanup.json').exists())

    def test_cleanup_never_deletes_name_or_tag_mismatch(self):
        class Provider:
            def do(self, method, path):
                if method == 'DELETE':
                    self.fail('unowned DELETE')
                return {'droplet': {'name': 'live', 'tags': ['live']}}

        with self.assertRaisesRegex(RuntimeError, 'ownership mismatch'):
            boot.delete_node(Provider(), {'node_id': 1, 'name': 'diagnostic', 'tags': ['diagnostic']})

    def test_inventory_recovery_failure_does_not_block_known_node_deletion(self):
        class Provider:
            deleted = False

            def do(self, method, path):
                if path.startswith('/firewalls?'):
                    raise RuntimeError('firewall listing unavailable')
                if method == 'DELETE':
                    self.deleted = True
                if self.deleted:
                    return None
                return {'droplet': {'name': 'owned', 'tags': ['owned'], 'created_at': '2026-01-01T00:00:00Z'}}

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            boot.append(directory, dict(node_id=1, name='owned', tags=['owned'], started_at=0, firewall_intent=True))
            (directory / 'ssh-key').write_text('task secret')
            provider = Provider()
            with self.assertRaisesRegex(RuntimeError, 'recover firewall_id: RuntimeError'):
                boot.cleanup(provider, directory)
            self.assertTrue(provider.deleted)
            self.assertFalse((directory / 'ssh-key').exists())

    def test_lost_result_recovers_exact_node_from_accepted_create(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            entry = {'path': '/v2/droplets', 'method': 'POST', 'status': 202, 'response': {'droplet': {'name': 'owned', 'id': 1}}}
            (directory / 'provider.jsonl').write_text(json.dumps(entry) + '\n{"incomplete":')
            state, errors = boot.recover_resources(None, {'name': 'owned', 'create_intent': True}, directory)
            self.assertEqual(state['node_id'], 1)
            self.assertEqual(errors, [])

    def test_cold_receipt_ignores_rejected_key_but_rejects_two_allocations(self):
        request = {'image_id': 1, 'region': 'region', 'size': 'size'}
        inspected = {'node': {**request, 'name': 'owned', 'tags': ['owned']}}
        accepted = {'path': '/v2/droplets', 'method': 'POST', 'status': 202, 'body_sha256': 'a' * 64,
                    'user_data_sha256': 'b' * 64, 'fleet_user_data_sha256': 'c' * 64,
                    'body': {'image': 1, 'name': 'owned', 'user_data': '[redacted]'}, 'original_body': {'user_data': 'original'}}
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            path = directory / 'provider.jsonl'
            rejected = {**accepted, 'status': 422}
            path.write_text(json.dumps(rejected) + '\n' + json.dumps(accepted) + '\n')
            result = boot.provisioning_receipt(directory, request, inspected, ['owned'])
            self.assertEqual(result['create_payload_sha256'], accepted['body_sha256'])
            path.write_text(json.dumps(accepted) + '\n' + json.dumps(accepted) + '\n')
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                boot.provisioning_receipt(directory, request, inspected, ['owned'])

    def test_lost_tag_response_still_cleans_exact_owned_tag(self):
        class Provider:
            deleted = []

            def do(self, method, path):
                if method == 'DELETE':
                    self.deleted.append(path)
                return None

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            boot.append(directory, dict(name='owned', unique_tag='owned', tag_intent=True))
            provider = Provider()
            boot.cleanup(provider, directory)
            self.assertEqual(provider.deleted, ['/tags/owned'])
            self.assertTrue((directory / 'cleanup.json').exists())


if __name__ == '__main__':
    unittest.main()
