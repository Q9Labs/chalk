import json
import os
from pathlib import Path
from datetime import datetime, timezone
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import release
from test_release import MemoryGitHub, SHA, held

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

    def cut(self, api, hour, *, manual=False):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,
                GITHUB_OUTPUT=str(Path(directory) / 'output')), patch.object(release, 'datetime') as clock:
            clock.now.return_value = datetime(2026, 10, 17, hour, tzinfo=timezone.utc)
            release.plan(api, SimpleNamespace(manual=manual))
            return dict(line.split('=', 1) for line in (Path(directory) / 'output').read_text().splitlines())

    def test_green_tip_is_retried_after_cooldown_without_a_new_push(self):
        api = MemoryGitHub()
        api.tip = 'b' * 40
        api.gates[0]['head_sha'] = api.tip
        previous = held(date='2026-10-17T02:00:00Z')
        previous.update(environment='nightly')
        previous['payload']['recorder_control'] = True
        api.items.append(previous)
        self.assertEqual(self.cut(api, 3)['should_cut'], 'false')
        api.created_at = '2026-10-17T08:00:00Z'
        result = self.cut(api, 8)
        self.assertEqual(result['should_cut'], 'true')
        self.assertEqual(result['target_sha'], api.tip)
        self.assertEqual(api.items[-1]['ref'], api.tip)

    def test_two_serial_checks_reserve_only_one_cut(self):
        api = MemoryGitHub()
        self.assertEqual(self.cut(api, 2)['should_cut'], 'true')
        self.assertEqual(self.cut(api, 2)['should_cut'], 'false')
        self.assertEqual(len(api.items), 1)

    def test_only_a_successful_push_gate_on_the_tip_allows_a_cut(self):
        for change in [dict(head_sha='b' * 40), dict(conclusion='failure'), dict(conclusion=None),
                       dict(event='schedule'), dict(event='workflow_dispatch'), dict(head_branch='other')]:
            with self.subTest(change=change):
                api = MemoryGitHub()
                api.gates[0].update(change)
                with patch.dict(os.environ, GATE_SHA='b' * 40):
                    result = self.cut(api, 2)
                self.assertEqual(result['should_cut'], 'false')
                self.assertEqual(result['target_sha'], SHA)
                self.assertEqual(api.items, [])

    def test_older_gate_sha_cannot_choose_the_cut_commit(self):
        api = MemoryGitHub()
        with patch.dict(os.environ, GATE_SHA='b' * 40):
            result = self.cut(api, 2)
        self.assertEqual(result['target_sha'], SHA)
        self.assertEqual(api.items[-1]['ref'], SHA)

    def test_tip_moving_during_planning_cannot_reserve_an_older_commit(self):
        api = MemoryGitHub()
        artifact = api.artifact
        def moved(*args, **kwargs):
            api.tip = 'b' * 40
            return artifact(*args, **kwargs)
        with patch.object(api, 'artifact', side_effect=moved):
            self.assertEqual(self.cut(api, 2)['should_cut'], 'false')
        self.assertEqual(api.items, [])

    def test_manual_cut_keeps_its_cooldown_and_gate_event_override(self):
        api = MemoryGitHub()
        api.gates[0]['event'] = 'workflow_dispatch'
        api.reserve_cut(SHA)
        self.assertEqual(self.cut(api, 2, manual=True)['should_cut'], 'true')
        self.assertEqual(len(api.items), 2)

    def test_hourly_workflow_keeps_one_shared_cut_lock_and_manual_dispatch(self):
        workflow = (ROOT / '.github/workflows/nightly.yml').read_text()
        self.assertIn('cron: "17 * * * *"', workflow)
        self.assertIn('  workflow_dispatch:', workflow)
        self.assertNotIn('workflow_run:', workflow)
        self.assertNotIn('GATE_SHA', workflow)
        self.assertIn('  group: chalk-environment-nightly\n  cancel-in-progress: false', workflow)

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
