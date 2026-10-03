import copy
import hashlib
import importlib.util
import json
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
                       image_digest='sha256:' + digest, region='region', size='size')
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
            with self.assertRaisesRegex(RuntimeError, 'issuer unavailable'):
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
            with self.assertRaisesRegex(RuntimeError, 'firewall listing unavailable'):
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
                    'body': {'image': 1, 'name': 'owned', 'user_data': 'transmitted'}, 'original_body': {'user_data': 'original'}}
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
