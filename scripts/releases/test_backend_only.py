"""Backend-only bring-up is allowed on nightly, never on production."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import release
from github_release import digest
from test_media import members
from test_release import MemoryGitHub, SHA


def workflow_step(name):
    workflow = (release.ROOT / '.github/workflows/ci.yml').read_text()
    step = workflow.split('      - name: ' + name + '\n', 1)[1]
    script = step.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
    return '\n'.join(line[10:] for line in script.splitlines())


class PreparationTests(unittest.TestCase):
    def test_production_default_plan_preserves_legacy_control_and_prepares_without_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            shutil.copytree(release.ROOT / 'infrastructure/managed-episode', repo / 'infrastructure/managed-episode')
            shutil.copytree(release.ROOT / 'apps/api/db/migrations', repo / 'apps/api/db/migrations')
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            source = root / 'source.json'
            subprocess.run([str(repo / 'infrastructure/managed-episode/scripts/generate-release-manifest'), '--source-revision', SHA,
                            '--api-image', 'example/api@sha256:' + 'a' * 64, '--sync-image', 'example/sync@sha256:' + 'b' * 64,
                            '--recorder-control-image', 'example/control@sha256:' + 'c' * 64, '--output', str(source)],
                           check=True, capture_output=True)
            data = source.read_bytes()
            original = json.loads(data)
            archive = json.dumps(members()).encode()
            download = root / 'stable-download'
            download.mkdir()
            (download / 'legacy.json').write_bytes(data)
            script = workflow_step('Plan changed components')
            for key, value in {'runner.temp': directory, 'inputs.stable_manifest_run_id': '1',
                               'inputs.managed_environment': 'production'}.items():
                script = script.replace('${{ ' + key + ' }}', value)
            env = dict(os.environ, DEPLOY_MANAGED='true', ENABLE_RECORDER_CONTROL='false',
                       PLAN_ROOT=str(root / 'plan'), TARGET_SHA=SHA, GITHUB_OUTPUT=str(root / 'output'))
            planned = subprocess.run(['bash', '-c', script], cwd=release.ROOT, env=env, capture_output=True, text=True)
            self.assertEqual(planned.returncode, 0, planned.stderr)
            self.assertIn('recorder_control=true', (root / 'output').read_text())
            self.assertEqual((root / 'plan/stable-manifest.json').read_bytes(), data)
            for mode, reuse in [('sidecar', True), ('rollback', True), ('legacy', True), ('legacy', False)]:
                with self.subTest(mode=mode, reuse=reuse):
                    output = root / (mode + str(reuse))
                    api = MemoryGitHub()
                    with patch.dict(os.environ, MANAGED_ENVIRONMENT='production', SOURCE_RUN_ID='1',
                                    SOURCE_RELEASE_ID=original['release_id'], SOURCE_ARTIFACT_ID='2', SOURCE_SHA256=digest(data),
                                    SOURCE_MEDIA_SHA256=digest(archive) if mode == 'sidecar' else '', TARGET_SHA=SHA, GITHUB_OUTPUT=os.devnull,
                                    ROLLBACK_MEDIA=archive.decode() if mode == 'rollback' else ''):
                        with patch.object(release, 'ROOT', repo), patch.object(api, 'artifact', side_effect=lambda run, identity, name, expected=None: archive if name.endswith('.media.json') else data):
                            release.prepare(api, SimpleNamespace(reuse=reuse, directory=output))
                    manifest = next(path for path in output.glob('*.json') if not path.name.endswith('.media.json'))
                    applied = json.loads(manifest.read_bytes())
                    self.assertEqual(applied['release_id'] == original['release_id'], not reuse)
                    self.assertEqual(applied['images'], original['images'])
                    self.assertEqual(applied['runtime_artifacts'], original['runtime_artifacts'])
                    sidecar = manifest.with_suffix('.media.json')
                    if mode == 'legacy':
                        self.assertFalse(sidecar.exists())
                    else:
                        self.assertEqual(sidecar.read_bytes(), archive)

    def test_unknown_or_mixed_case_environment_cannot_bypass_production_guard(self):
        for environment in ('Production', 'PRODUCTION', 'staging'):
            with self.subTest(environment=environment), patch.dict(os.environ, MANAGED_ENVIRONMENT=environment):
                with self.assertRaisesRegex(ValueError, 'unsupported managed environment'):
                    release.prepare(MemoryGitHub(), None)

    def test_backend_only_is_nightly_only_even_with_valid_artifact_provenance(self):
        for environment, control, media, reuse in [('nightly', False, False, False), ('production', False, False, False),
                                                    ('production', True, False, False), ('production', False, True, False),
                                                    ('production', True, True, False), ('production', False, False, True),
                                                    ('production', False, True, True)]:
            with self.subTest(environment=environment, control=control, media=media, reuse=reuse), tempfile.TemporaryDirectory() as directory:
                data = json.dumps(dict(release_id='source', source_revision=SHA,
                                       images={'recorder_control': 'example/control@sha256:' + 'a' * 64} if control else {})).encode()
                archive = json.dumps(members()).encode()

                class Artifacts(MemoryGitHub):
                    def artifact(self, run, identity, name, expected=None):
                        value = archive if name.endswith('.media.json') else data
                        if expected and digest(value) != expected:
                            raise ValueError('checksum mismatch')
                        return value

                output = Path(directory) / 'prepared'
                with patch.dict(os.environ, MANAGED_ENVIRONMENT=environment, SOURCE_RUN_ID='1', SOURCE_RELEASE_ID='source',
                                SOURCE_ARTIFACT_ID='2', SOURCE_SHA256=digest(data), SOURCE_MEDIA_SHA256=digest(archive) if media else '',
                                TARGET_SHA=SHA, GITHUB_OUTPUT=os.devnull, ROLLBACK_MEDIA=''):
                    args = SimpleNamespace(reuse=reuse, directory=output)
                    if environment == 'production' and not control:
                        with self.assertRaisesRegex(ValueError, 'production requires recorder control'):
                            release.prepare(Artifacts(), args)
                        self.assertFalse(output.exists())
                    else:
                        release.prepare(Artifacts(), args)
                        self.assertEqual((output / 'source.json').read_bytes(), data)
                        self.assertEqual((output / 'source.media.json').exists(), media)


class WorkflowTests(unittest.TestCase):
    def test_plan_honors_false_on_first_install_and_enabled_baseline(self):
        for enabled, baseline in [('false', False), ('false', True), ('true', False)]:
            with self.subTest(enabled=enabled, baseline=baseline), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                download = root / 'stable-download'
                download.mkdir()
                if baseline:
                    (download / 'stable.json').write_text(json.dumps(dict(source_revision=SHA, images={'recorder_control': 'previous'})))
                script = workflow_step('Plan changed components')
                for key, value in {'runner.temp': directory, 'inputs.stable_manifest_run_id': '1' if baseline else '',
                                   'inputs.managed_environment': 'nightly'}.items():
                    script = script.replace('${{ ' + key + ' }}', value)
                env = dict(os.environ, DEPLOY_MANAGED='true', ENABLE_RECORDER_CONTROL=enabled,
                           PLAN_ROOT=str(root / 'plan'), TARGET_SHA=SHA, GITHUB_OUTPUT=str(root / 'output'))
                result = subprocess.run(['bash', '-c', script], cwd=release.ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('recorder_control=' + enabled, (root / 'output').read_text())
                if baseline:
                    self.assertNotIn('recorder_control', json.loads((root / 'plan/stable-manifest.json').read_text())['images'])

    def test_backend_only_deploy_does_not_bind_dispatcher_or_mutate_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bindir = root / 'bin'
            bindir.mkdir()
            for name in ('node', 'python3'):
                executable = bindir / name
                executable.write_text('#!/bin/sh\necho "' + name + ' $*" >> "$EVENT_LOG"\n')
                executable.chmod(0o755)
            manifests = root / 'managed-release'
            manifests.mkdir()
            (manifests / 'fixture.json').write_text(json.dumps(dict(source_revision=SHA, release_id='fixture', images={})))
            script = workflow_step('Deploy, health-check, and prove release').replace('${{ runner.temp }}', directory)
            env = dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH'], EVENT_LOG=str(root / 'events'), RUNNER_TEMP=directory,
                       RELEASE_ID='fixture', TARGET_SHA=SHA, MANAGED_ENVIRONMENT='nightly', MANAGED_SECRET_EXCLUSIONS='',
                       CHALK_MANAGED_AWS_REGION='test-region', CHALK_MANAGED_INSTANCE_ID='i-12345678',
                       CHALK_MANAGED_SSM_DOCUMENT_NAME='fixture', CHALK_MANAGED_PARAMETER_PREFIX='/chalk/nightly/managed-episode',
                       CHALK_MANAGED_RECORDER_CONFIG_PARAMETER='/chalk/nightly/release/recorder.json',
                       CHALK_MANAGED_LOG_GROUP_NAME='fixture', GITHUB_RUN_ID='1', GITHUB_RUN_ATTEMPT='1')
            result = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            events = (root / 'events').read_text().splitlines()
            self.assertEqual(len(events), 3, events)
            self.assertTrue(all('--dispatcher-config-parameter' not in event and 'media.py' not in event for event in events), events)
            self.assertIn('release.py invalidate', events[1])
            env['CHALK_MANAGED_PARAMETER_PREFIX'] = '/chalk/production/managed-episode'
            rejected = subprocess.run(['bash', '-c', script], env=env, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('nightly requires its own managed parameter prefix', rejected.stderr)
            self.assertEqual((root / 'events').read_text().splitlines(), events)
