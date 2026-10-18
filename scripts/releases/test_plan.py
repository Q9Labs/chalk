import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReleasePlan(unittest.TestCase):
    def plan(self, root, *, stable=False, baseline=None, duplicate=False):
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
                                env=dict(os.environ, TARGET_SHA=head, DEPLOY_MANAGED='true', ENABLE_RECORDER_CONTROL='false',
                                         PLAN_ROOT=str(root / 'plan'), GITHUB_OUTPUT=str(root / 'output')))
        return result

    def test_first_install_builds_both_components_and_enables_nightly_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = self.plan(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = dict(line.split('=', 1) for line in (root / 'output').read_text().splitlines())
            self.assertEqual(json.loads(output['build_set']), ['api', 'sync'])
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
