"""Renderer media rollout and rollback semantics before and after bootstrap."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[1] / 'recorder'))

import renderer_media
from release_io import Provider
import subprocess


def member_files(renderer=True):
    media = {
        'schema_version': 1,
        'capture': {'image_id': '1', 'image_digest': 'sha256:' + 'a' * 64, 'release_id': 'release-old'},
        'render': {'image_id': '2', 'image_digest': 'sha256:' + 'b' * 64, 'release_id': 'release-old'},
        'dispatcher': {'bucket': 'media-artifacts', 'key': 'transcription-dispatcher/release-old/' + 'c' * 64 + '.zip', 'version_id': 'dispatcher-version', 'sha256': 'c' * 64, 'corpus_digest': 'd' * 64},
    }
    if renderer:
        media['renderer'] = {'bucket': 'media-artifacts', 'key': 'document-renderer/release-old/' + 'e' * 64 + '.zip', 'version_id': 'renderer-version', 'sha256': 'e' * 64}
    return media


def args_for(directory, media):
    root = Path(directory)
    (root / 'release.media.json').write_text(json.dumps(media))
    (root / 'release.json').write_text(json.dumps({'component_releases': {'api': {'release_id': 'release-old'}}}))
    return SimpleNamespace(manifest=root / 'release.json', output=root / 'release.media.json', environment='production', dry_run=True)


class RendererMediaTest(unittest.TestCase):
    def run_deploy(self, args, provider=object()):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            renderer_media.deploy_renderer(args, provider)
        return json.loads(stdout.getvalue())

    def test_pre_renderer_rollback_member_explicitly_leaves_renderer_idle(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_deploy(args_for(directory, member_files(renderer=False)))
        self.assertEqual(result['action'], 'renderer-not-recorded')
        self.assertIs(result['left_live'], True)
        self.assertIn('predate renderer', result['skipped'])
        self.assertFalse(any(key in result for key in ('artifact_bucket', 'artifact_key', 'artifact_version_id', 'version_id')))

    def test_missing_production_state_skips_before_bootstrap_without_blocking_release(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {'CHALK_RENDERER_RELEASE_ENABLED': 'true'}), mock.patch.object(renderer_media, 'renderer_inputs', side_effect=ValueError('Document renderer has no Alchemy state; run bootstrap')):
                result = self.run_deploy(args_for(directory, member_files()))
        self.assertEqual(result['action'], 'renderer-not-bootstrapped')
        self.assertIs(result['verified'], False)
        self.assertIn('state does not exist', result['skipped'])


    def test_undeclared_renderer_member_skips_without_reading_state(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(renderer_media, 'renderer_inputs', side_effect=AssertionError('state was read')):
                result = self.run_deploy(args_for(directory, member_files()))
        self.assertEqual(result['action'], 'renderer-not-declared')
        self.assertIs(result['left_live'], True)

    def test_provider_timeout_redacts_command_arguments(self):
        provider = Provider('ap-southeast-1', None)
        with mock.patch('subprocess.run', side_effect=subprocess.TimeoutExpired(['aws', '--region', 'ap-southeast-1', 's3api', 'get-object', '--bucket', 'secret-bucket', '--key', 'secret-key', '--version-id', 'secret-version'], 1)):
            with self.assertRaises(RuntimeError) as raised:
                provider.command(['aws', '--region', 'ap-southeast-1', 's3api', 'get-object', '--bucket', 'secret-bucket', '--key', 'secret-key', '--version-id', 'secret-version'], timeout=1)
        message = str(raised.exception)
        self.assertIn('timed out', message)
        for forbidden in ('secret-bucket', 'secret-key', 'secret-version'):
            self.assertNotIn(forbidden, message)

    def test_nightly_renderer_member_is_not_a_production_binding_target(self):
        with tempfile.TemporaryDirectory() as directory:
            args = args_for(directory, member_files())
            args.environment = 'nightly'
            with mock.patch.dict(os.environ, {'CHALK_RENDERER_RELEASE_ENABLED': 'true'}):
                result = self.run_deploy(args)
        self.assertEqual(result['action'], 'renderer-not-production-target')
        self.assertEqual(result['environment'], 'nightly')

    def test_successful_rollout_stdout_never_contains_artifact_coordinates(self):
        class FakeProvider:
            def aws(self, *args):
                if args[:2] == ('s3api', 'get-object'):
                    Path(args[-1]).write_bytes(bytes.fromhex('e' * 64))
                    return {}
                return {'VersionId': 'destination-version'}

        digest_patch = mock.patch.object(renderer_media, 'digest', return_value='e' * 64)
        digest_patch.start()
        self.addCleanup(digest_patch.stop)
        with tempfile.TemporaryDirectory() as directory:
            current = {'artifact_s3_bucket': 'module-bucket', 'artifact_s3_key': 'old-key', 'artifact_s3_object_version': 'old-version', 'artifact_sha256': '0' * 64, 'release_id': 'release-old', 'release_manifest_digest': 'sha256:old'}
            with mock.patch.object(renderer_media, 'renderer_inputs', return_value=current),                  mock.patch.object(renderer_media, 'renderer_release_environment', return_value={}),                  mock.patch.object(renderer_media, 'renderer_config_digest', return_value='sha256:config'),                  mock.patch.object(renderer_media, 'run_renderer_plan'),                  mock.patch.object(renderer_media, 'verify_renderer', return_value={'action': 'verified', 'verified': True}):
                args = args_for(directory, member_files())
                args.dry_run = False
                with mock.patch.dict(os.environ, {'CHALK_RENDERER_RELEASE_ENABLED': 'true'}):
                    result = self.run_deploy(args, FakeProvider())
        encoded = json.dumps(result)
        self.assertTrue(result['verified'])
        for forbidden in ('media-artifacts', 'module-bucket', 'renderer-version', 'destination-version', 'document-renderer/release-old'):
            self.assertNotIn(forbidden, encoded)

    def test_public_proof_never_prints_artifact_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {'CHALK_RENDERER_RELEASE_ENABLED': 'true'}), mock.patch.object(renderer_media, 'renderer_inputs', side_effect=ValueError('Document renderer has no Alchemy state; run bootstrap')):
                result = self.run_deploy(args_for(directory, member_files()))
        encoded = json.dumps(result)
        self.assertNotIn('media-artifacts', encoded)
        self.assertNotIn('renderer-version', encoded)
        self.assertNotIn('document-renderer/release-old', encoded)


if __name__ == '__main__':
    unittest.main()
