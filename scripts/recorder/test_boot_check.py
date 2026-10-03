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
