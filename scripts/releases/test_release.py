"""Offline release contracts: no provider credentials, builds, or deployments."""
import base64
import contextlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from github_release import SafeRedirect, cut_decision, held_candidates, newest_activation
from observe import check_dispatcher, dispatcher_config_digest
from release_set import canonical, digest, validate, validate_manifest
from web import build, deploy, public_config, read_marker

NOW = datetime(2026, 10, 17, 12, tzinfo=timezone.utc)
SHA = 'a' * 40
HASH = 'b' * 64


def deployment(identifier, activated='2026-10-16T12:00:00Z', state='success', sha=SHA, **updates):
    info = dict(channel='nightly-cut', target_sha=sha, release_id='managed-test', run_id='100', set_artifact_id='101',
                set_sha256=HASH, manifest_artifact_id='102', manifest_sha256=HASH,
                activated_at=activated, proof_result='passed', served_matches=True)
    info.update(updates)
    return {'id': identifier, 'latest_status': state, 'payload': info, 'updated_at': '2026-10-17T12:00:00Z'}


def fixture():
    identity = {'release_id': 'managed-test', 'source_revision': SHA}
    worker = dict(release_id='worker-test', source_revision=SHA, build_sha256=HASH, content_sha256=HASH,
                  image_id='123', bootstrap_server_name='control.example.test', qualification_sha256=HASH)
    dispatcher = dict(source_revision=SHA, zip_sha256=HASH, handler='index.handler', runtime='nodejs22.x',
                      qualification_sha256=HASH, bucket='example-bucket', key='dispatcher/test.zip',
                      version_id='v1', config_sha256=HASH)
    manifest = canonical(dict(release_id='managed-test', source_revision=SHA, source_tree_state='clean',
                              component_releases={'api': identity, 'sync': identity}))
    value = dict(schema_version=1, target_sha=SHA, release_id='managed-test', run_id='100', run_attempt='1',
                 created_at='2026-10-17T00:00:00Z', backend=dict(artifact_id='102', sha256=digest(manifest),
                 components={'api': identity, 'sync': identity}), web={}, runtime={},
                 versions={'runtime_contract': 1, 'sync_protocol': 1})
    for target in ('nightly', 'production'):
        config = public_config(target, SHA)
        value['web'][target] = dict(artifact_id='103' if target == 'nightly' else '104', sha256=HASH,
                                   config=config, config_sha256=digest(canonical(config)))
        value['runtime'][target] = dict(capture=worker.copy(), render=worker.copy(), dispatcher=dispatcher.copy())
    return value, manifest


def archive(config, extra=None):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as output:
        for name, data in {'dist/client/release.json': canonical(dict(config=config, config_sha256=digest(canonical(config)))),
                           'dist/client/_worker.js': b'export default {}', 'wrangler.toml': b'name="test"', **(extra or {})}.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            output.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


class SelectionTests(unittest.TestCase):
    def test_first_cut_and_new_commits(self):
        self.assertTrue(cut_decision(SHA, [], NOW)[0])
        self.assertTrue(cut_decision('c' * 40, [deployment(1)], NOW)[0])
        self.assertFalse(cut_decision(SHA, [deployment(1)], NOW)[0])

    def test_daily_limit_is_utc_activation_not_status_update(self):
        self.assertTrue(cut_decision('c' * 40, [deployment(1)], NOW)[0])
        self.assertFalse(cut_decision('c' * 40, [deployment(1, '2026-10-17T01:00:00Z')], NOW)[0])
        self.assertFalse(cut_decision('c' * 40, [deployment(1, '2026-10-17T01:00:00Z')], NOW, manual=True)[0])

    def test_failed_attempt_cannot_replace_activation_baseline(self):
        failed = deployment(2, state='failure', sha='c' * 40)
        failed['payload'].pop('activated_at')
        self.assertEqual(newest_activation([failed, deployment(1)])['id'], 1)
        self.assertFalse(cut_decision('c' * 40, [failed, deployment(1)], NOW)[0])
        self.assertTrue(cut_decision('c' * 40, [failed, deployment(1)], NOW, manual=True)[0])

    def test_manual_retry_failed_proof_at_same_sha(self):
        failed = deployment(1, state='failure', proof_result='failed')
        self.assertTrue(cut_decision(SHA, [failed], NOW, manual=True)[0])
        self.assertFalse(cut_decision(SHA, [failed], NOW)[0])

    def test_select_by_activation_not_status_time(self):
        old = deployment(1, '2026-10-15T12:00:00Z')
        old['updated_at'] = '2026-10-17T13:00:00Z'
        self.assertEqual([d['id'] for d in held_candidates([old, deployment(2)], NOW)], [2, 1])

    def test_failed_pending_revoked_or_mixed_is_not_held(self):
        cases = [deployment(1, state='failure'), deployment(2, state='pending'), deployment(3, proof_result='failed'),
                 deployment(4, served_matches=False), deployment(5, set_artifact_id=''), deployment(6, '2026-10-18T00:00:00Z')]
        self.assertEqual(held_candidates(cases, NOW), [])
        self.assertEqual(held_candidates(cases + [deployment(7)], NOW)[0]['id'], 7)

    def test_stale_evidence_is_ineligible(self):
        self.assertEqual(held_candidates([deployment(1, '2026-09-01T00:00:00Z')], NOW), [])

    def test_invalid_target_rejected(self):
        with self.assertRaises(ValueError):
            cut_decision('master', [], NOW)

    def test_artifact_redirect_drops_token(self):
        request = urllib.request.Request('https://api.github.com/artifact', headers={'Authorization': 'Bearer test-only'})
        redirected = SafeRedirect().redirect_request(request, None, 302, '', {}, 'https://blob.example.test/file')
        self.assertIsNone(redirected.get_header('Authorization'))


class ReleaseSetTests(unittest.TestCase):
    def test_complete_set_and_exact_bytes(self):
        value, manifest = fixture()
        self.assertEqual(validate(value), value)
        self.assertEqual(validate_manifest(value, manifest)['release_id'], 'managed-test')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            validate_manifest(value, manifest + b' ')

    def test_missing_or_extra_members_fail_closed(self):
        for mutation in ('missing-runtime', 'secret', 'wrong-sha', 'bad-time', 'bad-artifact'):
            with self.subTest(mutation=mutation):
                value, _ = fixture()
                if mutation == 'missing-runtime': del value['runtime']['production']['capture']
                elif mutation == 'secret': value['runtime']['production']['dispatcher']['api_token'] = 'not-a-secret-test'
                elif mutation == 'wrong-sha': value['target_sha'] = 'master'
                elif mutation == 'bad-time': value['created_at'] = 'yesterday'
                else: value['web']['production']['artifact_id'] = 'latest'
                with self.assertRaises(Exception): validate(value)

    def test_config_fingerprint_cannot_be_stale(self):
        value, _ = fixture()
        value['web']['nightly']['config']['api_url'] = 'https://wrong.example.test'
        with self.assertRaisesRegex(ValueError, 'fingerprint'): validate(value)

    def test_same_component_images_can_have_older_source_identities(self):
        value, manifest = fixture()
        parsed = json.loads(manifest)
        parsed['component_releases']['api']['source_revision'] = 'c' * 40
        data = canonical(parsed)
        value['backend']['components'] = parsed['component_releases']
        value['backend']['sha256'] = digest(data)
        validate_manifest(validate(value), data)


class DispatcherIdentityTests(unittest.TestCase):
    def function(self, release):
        variables = {'CHALK_ENVIRONMENT': 'nightly', 'CHALK_RELEASE_ID': release, 'CONTROL_API_BASE_URL': 'https://api.example.test'}
        variables['CHALK_CONFIG_DIGEST'] = 'sha256:' + digest(json.dumps(variables, sort_keys=True, separators=(',', ':')).encode())
        return {'State': 'Active', 'LastUpdateStatus': 'Successful', 'CodeSha256': base64.b64encode(bytes.fromhex(HASH)).decode(),
                'Handler': 'index.handler', 'Runtime': 'nodejs22.x', 'Environment': {'Variables': variables}}

    def test_provider_prefix_and_binding_are_separate_from_immutable_config(self):
        old = self.function('old-api-release')
        new = self.function('new-api-release')
        member = fixture()[0]['runtime']['nightly']['dispatcher']
        member['config_sha256'] = dispatcher_config_digest(old['Environment']['Variables'])
        self.assertEqual(member['config_sha256'], dispatcher_config_digest(new['Environment']['Variables']))
        check_dispatcher(old, member)  # Preflight accepts a pending rebind.
        check_dispatcher(new, member, 'new-api-release')
        check_dispatcher(old, member, 'old-api-release')  # The same immutable member supports rollback.
        with self.assertRaisesRegex(ValueError, 'binding'):
            check_dispatcher(old, member, 'new-api-release')

    def test_mutable_or_corrupt_config_still_fails(self):
        function = self.function('old-api-release')
        member = fixture()[0]['runtime']['nightly']['dispatcher']
        member['config_sha256'] = dispatcher_config_digest(function['Environment']['Variables'])
        function['Environment']['Variables']['CONTROL_API_BASE_URL'] = 'https://wrong.example.test'
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            check_dispatcher(function, member)


class WebArchiveTests(unittest.TestCase):
    def test_targets_have_explicit_sync_and_different_api(self):
        nightly = public_config('nightly', SHA)
        production = public_config('production', SHA)
        self.assertEqual(nightly['sync_url'], 'wss://nightly-sync.chalkmeet.com/v1/sync')
        self.assertNotEqual(nightly['api_url'], production['api_url'])

    def test_archive_rejects_traversal_and_wrong_binding(self):
        config = public_config('nightly', SHA)
        read_marker(archive(config))
        with self.assertRaisesRegex(ValueError, 'unsafe'): read_marker(archive(config, {'../escape': b'bad'}))
        config['api_url'] = 'https://api.chalkmeet.com'
        with self.assertRaisesRegex(ValueError, 'endpoints'): read_marker(archive(config))

    def test_dry_run_does_not_build_or_write(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()) as output:
            destination = Path(directory) / 'not-created'
            build('nightly', SHA, destination, dry_run=True)
            self.assertFalse(destination.exists())
            self.assertIn('nightly-sync.chalkmeet.com', output.getvalue())

    def test_promotion_uploads_exact_prebuilt_archive_or_fails(self):
        value, _ = fixture()
        data = archive(public_config('production', SHA))
        value['web']['production']['sha256'] = digest(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'set.json').write_bytes(canonical(value))
            (root / 'web.tar.gz').write_bytes(data)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                deploy('production', root / 'set.json', root / 'web.tar.gz', 'example-project', dry_run=True)
            result = json.loads(output.getvalue())
            self.assertIn('--no-bundle', result['command'])
            self.assertEqual(result['archive_sha256'], digest(data))
            (root / 'web.tar.gz').write_bytes(data + b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                deploy('production', root / 'set.json', root / 'web.tar.gz', 'example-project', dry_run=True)

    def test_real_cli_dry_run_without_credentials(self):
        result = subprocess.run([sys.executable, 'scripts/releases/web.py', 'build', '--target', 'production', '--sha', SHA,
                                 '--dry-run'], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['config']['environment'], 'production')


if __name__ == '__main__':
    unittest.main()
