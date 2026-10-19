import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import release
from test_release import MemoryGitHub, SHA

ROOT = Path(__file__).resolve().parents[2]


class ReleasePlan(unittest.TestCase):
    def plan(self, root, *, stable=False, baseline=None, duplicate=False, recorder_control=False):
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        script = workflow.split('      - name: Plan changed components\n', 1)[1].split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
        script = '\n'.join(line[10:] for line in script.splitlines())
        for key, value in {'inputs.stable_manifest_run_id': 'fixture' if stable else '',
                           'inputs.managed_environment': 'nightly', 'runner.temp': str(root)}.items():
            script = script.replace('${{ ' + key + ' }}', value)
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        if stable:
            download = root / 'stable-download'
            download.mkdir()
            manifest = dict(source_revision=baseline or head, images=dict(recorder_control='fixture-only'))
            (download / 'fixture.json').write_text(json.dumps(manifest))
            if duplicate:
                (download / 'duplicate.json').write_text(json.dumps(manifest))
        # Run a script, not stdin: the component planner also reads stdin for paths.
        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', script], cwd=ROOT, stdin=subprocess.DEVNULL, text=True, capture_output=True,
                                env=dict(os.environ, TARGET_SHA=head, DEPLOY_MANAGED='true', ENABLE_RECORDER_CONTROL=str(recorder_control).lower(),
                                         PLAN_ROOT=str(root / 'plan'), GITHUB_OUTPUT=str(root / 'output')))
        return result

    def test_gate_cut_keeps_gate_sha_when_master_moves(self):
        api = MemoryGitHub()
        gate_sha = SHA
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, GATE_SHA=gate_sha,
                GITHUB_OUTPUT=str(Path(directory) / 'output')), patch.object(api, 'gate') as gate, \
                patch.object(release.subprocess, 'check_output', return_value='b' * 40):
            release.plan(api, SimpleNamespace(manual=False))
            output = dict(line.split('=', 1) for line in (Path(directory) / 'output').read_text().splitlines())
        self.assertEqual(output['should_cut'], 'true')
        self.assertEqual(output['target_sha'], gate_sha)
        gate.assert_called_once_with(gate_sha)
        self.assertEqual(api.items[-1]['ref'], gate_sha)

    def test_stale_gate_does_not_reserve_a_cut_or_consume_the_gap(self):
        api = MemoryGitHub()
        tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip()
        with patch.dict(os.environ, GIT_AUTHOR_NAME='Test', GIT_AUTHOR_EMAIL='test@example.invalid',
                        GIT_COMMITTER_NAME='Test', GIT_COMMITTER_EMAIL='test@example.invalid'):
            newer = subprocess.check_output(['git', 'commit-tree', tree, '-p', SHA, '-m', 'newer baseline'],
                                            cwd=ROOT, text=True).strip()
        baseline = dict(target_sha=newer)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, GATE_SHA=SHA,
                GITHUB_OUTPUT=str(Path(directory) / 'output')), patch.object(api, 'gate'), \
                patch.object(release, 'previous_production', return_value=baseline):
            release.plan(api, SimpleNamespace(manual=False))
            output = dict(line.split('=', 1) for line in (Path(directory) / 'output').read_text().splitlines())
        self.assertEqual(output['should_cut'], 'false')
        self.assertEqual(api.items, [])

    def test_first_install_builds_both_components_and_follows_recording_input(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result = self.plan(root, recorder_control=enabled)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = dict(line.split('=', 1) for line in (root / 'output').read_text().splitlines())
                self.assertEqual(json.loads(output['build_set']), ['api', 'sync'])
                self.assertEqual(output['recorder_control'], str(enabled).lower())
                self.assertEqual(output['should_publish'], 'true')

    def test_nightly_cut_forwards_recording_from_production_baseline(self):
        api = MemoryGitHub()
        original_artifact = api.artifact
        manifest = json.dumps(dict(release_id='previous', source_revision=SHA,
                                   images=dict(recorder_control='production-control'))).encode()

        def artifact(run, identity, name, expected=None):
            if name == 'previous.json':
                return manifest
            return original_artifact(run, identity, name, expected)

        with tempfile.TemporaryDirectory() as directory, patch.object(api, 'artifact', side_effect=artifact):
            root = Path(directory)
            self.assertTrue(release.previous_production(api)['recorder_control'])
            with patch.dict(os.environ, GITHUB_OUTPUT=str(root / 'cut-output'), GITHUB_RUN_ID='1'):
                release.plan(api, SimpleNamespace(manual=True))
            cut = dict(line.split('=', 1) for line in (root / 'cut-output').read_text().splitlines())
            self.assertEqual(cut['recorder_control'], 'true')
            workflow = (ROOT / '.github/workflows/nightly.yml').read_text()
            self.assertIn("enable_recorder_control: ${{ needs.plan.outputs.recorder_control == 'true' }}", workflow)
            result = self.plan(root, stable=True, recorder_control=cut['recorder_control'] == 'true')
            self.assertEqual(result.returncode, 0, result.stderr)
            output = dict(line.split('=', 1) for line in (root / 'output').read_text().splitlines())
            self.assertEqual(output['recorder_control'], 'true')
            self.assertEqual(output['should_publish'], 'true')

    def test_unchanged_baseline_can_deploy_without_rebuilding_backend_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.plan(root, stable=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = dict(line.split('=', 1) for line in (root / 'output').read_text().splitlines())
            self.assertEqual(json.loads(output['build_set']), [])
            self.assertEqual(output['should_publish'], 'true')

    def test_missing_or_ambiguous_baseline_cannot_publish_a_plan(self):
        for kwargs in (dict(baseline='0' * 40), dict(duplicate=True)):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                result = self.plan(root, stable=True, **kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((root / 'output').exists())
