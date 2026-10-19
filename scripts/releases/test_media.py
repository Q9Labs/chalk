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
    image = dict(base_snapshot_id='123', image_digest='sha256:' + 'a' * 64, release_id='recorder-render-example', source_revision=SHA, input_sha256='b' * 64, archive_sha256='c' * 64, archive_key='recorder/render/' + 'c' * 64 + '.tar.gz')
    return dict(schema_version=1, recorder_source_bucket='example-artifacts', capture=dict(image, base_snapshot_id='124', archive_key='recorder/capture/' + 'c' * 64 + '.tar.gz'), render=image, dispatcher=dict(bucket='example-artifacts', key='transcription-dispatcher/example/' + 'd' * 64 + '.zip', version_id='immutable-version', sha256='d' * 64, corpus_digest='e' * 64))


class MediaIdentities(unittest.TestCase):
    def test_retained_runtime_keeps_current_archive_pins_for_later_rollback(self):
        from unittest.mock import Mock
        value = members()
        config = {'runtime': {'parameter_prefix': '/chalk/production/managed-episode'}, 'dispatcher': {}}
        provider = Mock()
        def parameter(name):
            role = name.rsplit('/', 1)[1].split('.')[0]
            member = value[role]
            pins = dict(IMAGE_ID=member['base_snapshot_id'], IMAGE_DIGEST=member['image_digest'], RELEASE_ID=member['release_id'],
                        ARCHIVE_BUCKET='production-artifacts', ARCHIVE_KEY=member['archive_key'], ARCHIVE_SHA256=member['archive_sha256'])
            return {'Value': ''.join('CHALK_RECORDER_FLEET_' + key + '=' + item + '\n' for key, item in pins.items())}
        provider.parameter.side_effect = parameter
        dispatcher = value['dispatcher']
        inputs = dict(artifact_s3_bucket=dispatcher['bucket'], artifact_s3_key=dispatcher['key'], artifact_s3_object_version=dispatcher['version_id'], artifact_sha256=dispatcher['sha256'], deepinfra_corpus_digest=dispatcher['corpus_digest'])
        with patch.object(media, 'dispatcher_root', return_value={'module': {'dispatcher': inputs}}):
            retained = media.current(provider, config)
        self.assertEqual(retained['recorder_source_bucket'], 'production-artifacts')
        for role in ('capture', 'render'):
            self.assertEqual(retained[role], {key: value[role][key] for key in ('base_snapshot_id', 'image_digest', 'release_id', 'archive_key', 'archive_sha256')})

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

    def test_reusing_archive_honors_separately_updated_base(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        provider = Mock()
        provider.parameter.return_value = {'Value': 'CHALK_RECORDER_FLEET_IMAGE_ID=222\n'}
        value = members()
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            baseline = directory / 'baseline.json'
            baseline.write_text(json.dumps(value))
            args = SimpleNamespace(directory=directory / 'build', output=directory / 'media.json', baseline=baseline, role='capture')
            with patch.dict(os.environ, CHALK_MEDIA_ARTIFACT_BUCKET=value['recorder_source_bucket']), patch.object(media, 'settings', return_value=(provider, {'runtime': {'parameter_prefix': '/chalk/nightly/managed-episode'}})), patch.object(media, 'fingerprint', return_value=value['capture']['input_sha256']), patch.object(media.recorder_release, 'verify_object'), patch.object(media.recorder_release, 'build') as build:
                media.build_archives(args)
                build.assert_not_called()
            result = json.loads(args.output.read_text())['capture']
            self.assertEqual(result, dict(value['capture'], base_snapshot_id='222'))

    def test_promote_copies_verified_bytes_without_changing_held_members(self):
        from unittest.mock import Mock
        value = members()
        before = json.dumps(value, sort_keys=True)
        data = b'actual held archive bytes'
        sha = digest(data)
        for role in ('capture', 'render'):
            value[role].update(archive_sha256=sha, archive_key=f'recorder/{role}/{sha}.tar.gz')
        before = json.dumps(value, sort_keys=True)
        provider = Mock()
        def download(*args, **kwargs):
            Path(args[-1]).write_bytes(data)
        provider.aws.side_effect = download
        with patch.object(media.recorder_release, 'verify_object', return_value={'ETag': 'held-etag'}), patch.object(media.recorder_release, 'publish') as publish:
            media.materialize_archives(provider, value, 'production-artifacts')
            self.assertEqual(publish.call_count, 2)
            self.assertEqual(publish.call_args.args[1], 'production-artifacts')
        self.assertEqual(json.dumps(value, sort_keys=True), before)
        provider.aws.side_effect = lambda *args, **kwargs: Path(args[-1]).write_bytes(b'changed')
        with patch.object(media.recorder_release, 'verify_object', return_value={'ETag': 'held-etag'}), patch.object(media.recorder_release, 'publish') as publish:
            with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
                media.materialize_archives(provider, value, 'production-artifacts')
            publish.assert_not_called()

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
        images = {str(image['base_snapshot_id']): dict(id=int(image['base_snapshot_id']), status='available', regions=[role + '-region'], min_disk_size=50)
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
        with tempfile.TemporaryDirectory() as directory, patch.object(media, 'settings', return_value=(provider, config)), patch.object(media, 'materialize_archives'):
            output = Path(directory, 'media.json')
            output.write_text(json.dumps(members()))
            args = SimpleNamespace(output=output, region='ap-southeast-1', environment='nightly')
            for role in ('capture', 'render'):
                base_snapshot_id = members()[role]['base_snapshot_id']
                original = copy.deepcopy(images[base_snapshot_id])
                for invalid in (None, dict(original, status='deleted'), dict(original, regions=['wrong-region']), dict(original, min_disk_size=51)):
                    with self.subTest(role=role, invalid=invalid):
                        images[base_snapshot_id] = invalid
                        events.clear()
                        with self.assertRaises((ValueError, RuntimeError)):
                            media.pin_archives(args)
                        self.assertFalse(any(event[0] == 'put' for event in events))
                images[base_snapshot_id] = original
            events.clear()
            media.pin_archives(args)
            image_reads = [i for i, event in enumerate(events) if event[:3] == ('compute', 'image', 'get')]
            writes = [i for i, event in enumerate(events) if event[0] == 'put']
            self.assertEqual(len(image_reads), 2)
            self.assertEqual(len(writes), 2)
            self.assertLess(max(image_reads), min(writes))
            legacy = members()
            legacy.pop('recorder_source_bucket')
            for role in ('capture', 'render'):
                member = legacy[role]
                member['image_id'] = member.pop('base_snapshot_id')
                member.pop('archive_key')
                member.pop('archive_sha256')
            output.write_text(json.dumps(legacy))
            args.environment = 'production'
            media.pin_archives(args)
            for name, parameter in parameters.items():
                if name != 'ca':
                    self.assertNotIn('CHALK_RECORDER_FLEET_ARCHIVE_', parameter['Value'])

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

    def test_first_dispatcher_install_lists_state_only_when_it_exists(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        import contextlib
        import io
        archive_bytes = b'qualified dispatcher bytes'
        value = members()
        value['dispatcher']['sha256'] = digest(archive_bytes)
        config = dict(dispatcher=dict(state_bucket='state', state_key='dispatcher.tfstate', function_name='dispatcher',
                                      scheduler_name='reconcile', scheduler_group='group'))
        for state, expected in [(False, ['init', 'import', 'import', 'plan', 'show', 'apply']),
                                (True, ['init', 'state', 'import', 'plan', 'show', 'apply'])]:
            with self.subTest(state_exists=state):
                provider = Mock()
                def aws(*arguments, **kwargs):
                    if arguments[:2] == ('s3api', 'get-object'):
                        Path(arguments[-1]).write_bytes(archive_bytes)
                        return {}
                    responses = {('s3api', 'list-objects-v2'): dict(Contents=[dict(Key='dispatcher.tfstate')]) if state else {},
                                 ('s3api', 'put-object'): dict(VersionId='v1'), ('scheduler', 'get-schedule'): dict(State='ENABLED')}
                    return responses[arguments[:2]]
                def command(arguments, **kwargs):
                    if arguments[2:4] == ['state', 'list']:
                        # Real tofu exits 1 with "No state file was found" on an empty backend.
                        self.assertTrue(state, 'state list ran before the backend held a state object')
                        return 'module.dispatcher.aws_iam_role.dispatcher\n'
                    return json.dumps(dict(resource_changes=[])) if 'show' in arguments else ''
                provider.aws.side_effect = aws
                provider.command.side_effect = command
                provider.state.return_value = dict(resources=[dict(type='aws_iam_role', name='dispatcher', instances=[dict(attributes={})])])
                with tempfile.TemporaryDirectory() as directory:
                    manifest, output = Path(directory) / 'manifest.json', Path(directory) / 'media.json'
                    manifest.write_text(json.dumps(dict(component_releases=dict(api=dict(release_id='managed-episode-first')))))
                    output.write_text(json.dumps(value))
                    args = SimpleNamespace(manifest=manifest, output=output, dry_run=False, environment='nightly', region='test-region')
                    with patch.object(media, 'settings', return_value=(provider, config)), patch.object(media, 'verify_dispatcher', return_value={}), \
                            patch.dict(os.environ, CHALK_MEDIA_ARTIFACT_BUCKET='example-artifacts'), contextlib.redirect_stdout(io.StringIO()):
                        media.deploy_dispatcher(args)
                calls = [call.args[0] for call in provider.command.call_args_list]
                self.assertEqual([command[2] for command in calls], expected)
                imported = [command[-1] for command in calls if command[2] == 'import']
                self.assertEqual(imported, ['dispatcher-scheduler'] if state else ['dispatcher-execution', 'dispatcher-scheduler'])

    def test_mutable_or_incomplete_members_are_refused(self):
        value = members()
        self.assertEqual(media.validate_members(value), value)
        for field, invalid in [('version_id', 'null'), ('sha256', 'latest'), ('corpus_digest', '')]:
            broken = copy.deepcopy(value)
            broken['dispatcher'][field] = invalid
            with self.assertRaises(ValueError):
                media.validate_members(broken)
        broken = copy.deepcopy(value)
        broken['capture']['base_snapshot_id'] = 'latest'
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


if __name__ == '__main__':
    unittest.main()
