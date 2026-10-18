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

    def test_adding_or_editing_package_manager_config_changes_both_fingerprints(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(media, 'ROOT', Path(directory)):
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', *args])
            git('init', '-q')
            git('commit', '--allow-empty', '-qm', 'base')
            previous = {role: media.fingerprint(role) for role in ('render', 'dispatcher')}
            for name in ('.npmrc', '.pnpmfile.cjs'):
                for value in ('added', 'changed'):
                    Path(directory, name).write_text(value)
                    git('add', name)
                    git('commit', '-qm', 'package manager config')
                    for role in previous:
                        current = media.fingerprint(role)
                        self.assertNotEqual(previous[role], current, (role, name, value))
                        previous[role] = current

    def test_installed_dispatcher_root_change_is_rejected_before_builds(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory, patch.object(media, 'ROOT', Path(directory)):
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', *args])
            git('init', '-q')
            root = Path(directory, 'infrastructure/nightly/transcription/main.tf')
            root.parent.mkdir(parents=True)
            root.write_text('approved configuration')
            git('add', '.')
            git('commit', '-qm', 'installed root')
            with patch.object(media, 'SUPPORTED_DISPATCHER_CONFIGURATION', media.fingerprint('dispatcher_configuration')):
                args = SimpleNamespace(environment='nightly')
                media.check_configuration(args)
                Path(directory, 'worker.js').write_text('code update is supported')
                git('add', 'worker.js')
                git('commit', '-qm', 'code only')
                media.check_configuration(args)
                root.write_text('changed runtime configuration')
                git('add', str(root))
                git('commit', '-qm', 'root change')
                with self.assertRaisesRegex(ValueError, 'dispatcher infrastructure configuration changed'):
                    media.check_configuration(args)
                with patch.object(media, 'settings') as settings, self.assertRaisesRegex(ValueError, 'dispatcher infrastructure configuration changed'):
                    media.deploy_dispatcher(args)
                settings.assert_not_called()

    def test_all_candidate_images_are_checked_before_either_pin_write(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        config = dict(runtime=dict(parameter_prefix='/chalk/nightly/managed-episode'),
                      bootstrap_ca_parameter='ca', bootstrap_server_name='issuer.example')
        parameters = {'ca': dict(Value='public CA')}
        events = []
        provider = Mock()
        for role in ('capture', 'render'):
            name = config['runtime']['parameter_prefix'] + '/recorder/' + role + '.env'
            parameters[name] = dict(Name=name, Type='SecureString', Version=1,
                Value='DIGITALOCEAN_TOKEN=fixture-token\nCHALK_RECORDER_FLEET_REGION=' + role + '-region\nCHALK_RECORDER_FLEET_SIZE=' + role + '-size\n')
        images = {str(image['image_id']): dict(id=int(image['image_id']), status='available', regions=[role + '-region'], min_disk_size=50)
                  for role, image in members().items() if role in ('capture', 'render')}
        def do(*args):
            events.append(args)
            if args[:3] == ('compute', 'size', 'list'):
                return [dict(slug=role + '-size', available=True, regions=[role + '-region'], disk=50) for role in ('capture', 'render')]
            image = images[str(args[3])]
            if image is None:
                raise RuntimeError('candidate snapshot not found')
            return [image]
        def aws(service, operation, *args, payload=None):
            if operation == 'describe-parameters':
                return dict(Parameters=[dict(Tier='Standard')])
            self.assertEqual((service, operation), ('ssm', 'put-parameter'))
            events.append(('put', payload['Name']))
            parameter = parameters[payload['Name']]
            parameter.update(Value=payload['Value'], Version=parameter['Version'] + 1)
            return dict(Version=parameter['Version'])
        provider.parameter.side_effect = lambda name: copy.deepcopy(parameters[name])
        provider.do.side_effect, provider.aws.side_effect = do, aws
        with tempfile.TemporaryDirectory() as directory, patch.object(media, 'settings', return_value=(provider, config)):
            output = Path(directory, 'media.json')
            output.write_text(json.dumps(members()))
            args = SimpleNamespace(output=output)
            for role in ('capture', 'render'):
                image_id = members()[role]['image_id']
                original = copy.deepcopy(images[image_id])
                for invalid in (None, dict(original, status='deleted'), dict(original, regions=['wrong-region']), dict(original, min_disk_size=51)):
                    with self.subTest(role=role, invalid=invalid):
                        images[image_id] = invalid
                        events.clear()
                        with self.assertRaises((ValueError, RuntimeError)):
                            media.pin_images(args)
                        self.assertFalse(any(event[0] == 'put' for event in events))
                images[image_id] = original
            events.clear()
            media.pin_images(args)
            image_reads = [i for i, event in enumerate(events) if event[:3] == ('compute', 'image', 'get')]
            writes = [i for i, event in enumerate(events) if event[0] == 'put']
            self.assertEqual(len(image_reads), 2)
            self.assertEqual(len(writes), 2)
            self.assertLess(max(image_reads), min(writes))

    def test_failed_workflow_preflight_cannot_invalidate_or_publish_pins(self):
        script = (media.ROOT / '.github/workflows/ci.yml').read_text().split('      - name: Deploy, health-check, and prove release\n', 1)[1]
        script = script.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
        script = '\n'.join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindir = root / 'bin'
            bindir.mkdir()
            for name in ('node', 'python3', 'jq'):
                executable = bindir / name
                executable.write_text('#!/bin/sh\n' + ('exit 0\n' if name == 'jq' else 'echo "' + name + ' $*" >> "$EVENT_LOG"\n' + ('exit 9\n' if name == 'node' else 'exit 0\n')))
                executable.chmod(0o755)
            manifests = root / 'managed-release'
            manifests.mkdir()
            for suffix in ('.json', '.media.json'):
                (manifests / ('fixture' + suffix)).write_text('{}')
            script = script.replace('${{ runner.temp }}', directory)
            env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'], EVENT_LOG=str(root / 'events'), RUNNER_TEMP=directory,
                RELEASE_ID='fixture', TARGET_SHA=SHA, MANAGED_ENVIRONMENT='nightly', MANAGED_SECRET_EXCLUSIONS='',
                CHALK_MANAGED_AWS_REGION='test-region', CHALK_MANAGED_INSTANCE_ID='i-12345678',
                CHALK_MANAGED_SSM_DOCUMENT_NAME='fixture', CHALK_MANAGED_PARAMETER_PREFIX='/chalk/nightly/managed-episode',
                CHALK_MANAGED_RECORDER_CONFIG_PARAMETER='/chalk/nightly/release/recorder.json',
                CHALK_MANAGED_LOG_GROUP_NAME='fixture', GITHUB_RUN_ID='1', GITHUB_RUN_ATTEMPT='1')
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 9, result.stderr)
            events = (root / 'events').read_text().splitlines()
            self.assertEqual(len(events), 1, events)
            self.assertTrue(events[0].startswith('node ') and '--dry-run' in events[0], events)

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
        resources = [dict(type=kind, name=name, instances=[dict(attributes={})])
                     for kind, name in media.re.findall(r'^resource "([^"]+)" "([^"]+)"', (media.MODULE / 'main.tf').read_text(), media.re.MULTILINE)
                     if name != 'control_api']
        provider.state.return_value = dict(resources=resources)
        self.assertTrue(media.installed_dispatcher(provider, config))
        for resource in resources:
            with self.subTest(missing=resource['type'] + '.' + resource['name']):
                provider.state.return_value = dict(resources=[item for item in resources if item is not resource])
                self.assertFalse(media.installed_dispatcher(provider, config))

    def test_dispatcher_dry_run_reads_exact_zip_and_plans_without_mutations(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        import contextlib
        import io
        archive_bytes = b'qualified dispatcher bytes'
        value = members()
        value['dispatcher']['sha256'] = digest(archive_bytes)
        provider = Mock()
        def aws(*arguments):
            if arguments[:2] == ('s3api', 'get-object'):
                Path(arguments[-1]).write_bytes(archive_bytes)
                return {}
            self.assertEqual(arguments[:2], ('s3api', 'list-objects-v2'))
            return {}
        provider.aws.side_effect = aws
        provider.command.side_effect = lambda command, **kwargs: json.dumps(dict(resource_changes=[])) if 'show' in command else ''
        config = dict(dispatcher=dict(state_bucket='state', state_key='dispatcher.tfstate'))
        with tempfile.TemporaryDirectory() as directory:
            manifest, output = Path(directory) / 'manifest.json', Path(directory) / 'media.json'
            manifest.write_text(json.dumps(dict(component_releases=dict(api=dict(release_id='managed-episode-preflight')))))
            output.write_text(json.dumps(value))
            args = SimpleNamespace(manifest=manifest, output=output, dry_run=True, environment='nightly', region='test-region')
            stdout = io.StringIO()
            with patch.object(media, 'settings', return_value=(provider, config)), patch.dict(os.environ, CHALK_MEDIA_ARTIFACT_BUCKET='example-artifacts'), contextlib.redirect_stdout(stdout):
                media.deploy_dispatcher(args)
                proof = json.loads(stdout.getvalue())
                self.assertTrue(proof['artifact_verified'] and proof['state_plan_verified'])
                commands = [call.args[0][2] for call in provider.command.call_args_list]
                self.assertEqual(commands, ['init', 'plan', 'show'])
                value['dispatcher']['sha256'] = '0' * 64
                output.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, 'ZIP readback mismatch'):
                    media.deploy_dispatcher(args)
                self.assertEqual(provider.command.call_count, 3)

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
