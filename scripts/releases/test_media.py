"""Media release identities are exact, version-pinned and corruption-sensitive."""
import copy
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import media
import release
from github_release import digest
from test_release import MemoryGitHub, SHA


def members():
    image = dict(image_id='123', image_digest='sha256:' + 'a' * 64, release_id='recorder-render-example', source_revision=SHA, input_sha256='b' * 64, inspection_sha256='c' * 64)
    return dict(schema_version=1, capture=dict(image, image_id='124'), render=image, dispatcher=dict(bucket='example-artifacts', key='transcription-dispatcher/example/' + 'd' * 64 + '.zip', version_id='immutable-version', sha256='d' * 64, corpus_digest='e' * 64))


class MediaIdentities(unittest.TestCase):
    def test_corpus_approval_refreshes_without_rebuilding_or_changing_zip(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        value = members()
        archive = value['dispatcher']
        archive.update(sha256=digest(b'ZIP'), input_sha256='same-inputs')
        provider = Mock()
        provider.aws.side_effect = lambda *args: args[-1].write_bytes(b'ZIP')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory, 'media.json')
            prior = Path(directory, 'baseline.json')
            output.write_text(json.dumps(value))
            prior.write_text(json.dumps(value))
            args = SimpleNamespace(directory=Path(directory), output=output, baseline=prior)
            with patch.object(media, 'settings', return_value=(provider, {})), patch.object(media, 'fingerprint', return_value='same-inputs'), patch.object(media, 'dispatcher_matches', return_value=True), patch.dict(os.environ, CHALK_TRANSCRIPTION_CORPUS_DIGEST='f' * 64):
                media.publish_zip(args)
            current = json.loads(output.read_text())['dispatcher']
            self.assertEqual(current, dict(archive, corpus_digest='f' * 64))
            self.assertEqual(provider.aws.call_count, 1)

    def test_renderer_fingerprint_changes_with_root_config_and_headless_sdk(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(media, 'ROOT', Path(directory)):
            def git(*args):
                return subprocess.run(['git', '-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', *args], check=True, capture_output=True)
            git('init')
            paths = ['tsconfig.json', 'sdks/typescript/react/src/headless.ts', 'apps/api/example.go']
            for name in paths:
                path = Path(directory, name)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            git('add', *paths)
            git('commit', '-m', 'base')
            capture = media.fingerprint('capture')
            previous = media.fingerprint('render')
            for name in paths[:2]:
                Path(directory, name).write_text('changed')
                git('add', name)
                git('commit', '-m', 'change')
                current = media.fingerprint('render')
                self.assertNotEqual(previous, current)
                self.assertEqual(capture, media.fingerprint('capture'))
                previous = current

    def test_release_artifact_reads_each_paired_member_and_rejects_extra_files(self):
        from unittest.mock import Mock
        from github_release import GitHub
        github = GitHub.__new__(GitHub)
        github.repository = 'Q9Labs/chalk'
        github.request = Mock(return_value=dict(expired=False, workflow_run=dict(id=1), name='release-manifest-example'))
        files = {'example.json': b'backend', 'example.media.json': b'media'}
        def download(command, **kwargs):
            for name, data in files.items():
                Path(command[-1], name).write_bytes(data)
        with patch('github_release.subprocess.run', side_effect=download):
            for filename, data in files.items():
                self.assertEqual(github.artifact('1', '2', filename, digest(data)), data)
            files['unexpected.json'] = b'not a member'
            with self.assertRaisesRegex(ValueError, 'unexpected'):
                github.artifact('1', '2', 'example.json')

    def test_deploy_only_current_media_can_seed_the_first_cut(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        import base64
        data = json.dumps(members()).encode()
        github = Mock()
        github.deployments.return_value = [dict(payload=dict(media_base64=base64.b64encode(data).decode(), media_sha256=digest(data)))]
        with tempfile.TemporaryDirectory() as directory, patch.object(media, 'GitHub', return_value=github):
            output = Path(directory) / 'baseline.json'
            media.baseline(SimpleNamespace(output=output))
            self.assertEqual(json.loads(output.read_text()), members())
            github.deployments.assert_called_once_with('nightly', 'media-current')
            github.deployments.return_value[0]['payload']['media_sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                media.baseline(SimpleNamespace(output=output))

    def test_import_only_dispatcher_state_is_resumable_not_installed(self):
        from unittest.mock import Mock
        provider = Mock()
        config = dict(dispatcher=dict(state_bucket='state', state_key='dispatcher.tfstate'))
        provider.aws.return_value = dict(Contents=[dict(Key='dispatcher.tfstate')])
        provider.state.return_value = dict(resources=[dict(type='aws_iam_role', name='dispatcher', instances=[dict(attributes={})])])
        self.assertFalse(media.installed_dispatcher(provider, config))
        provider.state.assert_called_once_with(config['dispatcher'])

    def test_mutable_or_incomplete_members_are_refused(self):
        value = members()
        self.assertEqual(media.validate_members(value), value)
        for field, invalid in [('version_id', 'null'), ('sha256', 'latest'), ('corpus_digest', '')]:
            broken = copy.deepcopy(value)
            broken['dispatcher'][field] = invalid
            with self.assertRaises(ValueError):
                media.validate_members(broken)
        broken = copy.deepcopy(value)
        broken['capture']['image_id'] = 'latest'
        with self.assertRaises(ValueError):
            media.validate_members(broken)

    def test_retained_production_media_survives_artifact_expiry_and_rejects_corruption(self):
        github = MemoryGitHub()
        data = json.dumps(members()).encode()
        import base64
        info = dict(channel='production-release', target_sha=SHA, manifest_sha256='a' * 64, media_sha256=digest(data), media_base64=base64.b64encode(data).decode())
        github.items.append(dict(id=1, environment='production', payload=info, latest_status='success'))
        self.assertEqual(release.media_bytes(github, info), data)
        info['media_base64'] = base64.b64encode(b'corrupt').decode()
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            release.media_bytes(github, info)

    def test_first_install_plan_does_not_read_old_pins_or_dispatcher(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('image_release', media.ROOT / 'scripts/recorder/release.py')
        image_release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(image_release)
        from unittest.mock import Mock
        build = image_release.Release.__new__(image_release.Release)
        build.args = Mock(role='capture')
        build.state = {}
        build.config = dict(runtime=dict(parameter_prefix='/chalk/nightly/managed-episode'), builder={})
        build.provider = Mock()
        build.provider.parameter.return_value = {'Value': 'CHALK_RECORDER_FLEET_SIZE=c-2\nCHALK_RECORDER_FLEET_REGION=test1\n'}
        build.provider.do.return_value = [dict(slug='c-2', available=True, regions=['test1'], disk=50)]
        build.provider.command.return_value = '192.0.2.1'
        build.identity = lambda: dict(source_commit=SHA)
        with tempfile.TemporaryDirectory() as directory:
            build.directory = Path(directory) / 'new'
            build.plan()
            self.assertTrue(json.loads((build.directory / 'release.json').read_text())['planned'])
        build.provider.aws.assert_not_called()
        build.provider.parameter.assert_called_once_with('/chalk/nightly/managed-episode/recorder/capture.env')


if __name__ == '__main__':
    unittest.main()
