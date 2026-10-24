"""The enforcement envelope requires an expanded candidate and rollback release."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / 'infrastructure/managed-episode/scripts/generate-release-manifest'
RENDER = ROOT / 'infrastructure/managed-episode/scripts/render-runtime'
IMAGE = 'example.invalid/chalk@sha256:' + '1' * 64


class EntryOwnershipTests(unittest.TestCase):
    def generate(self, output, *args, success=True):
        result = subprocess.run([str(GENERATOR), '--output', str(output), '--allow-dirty', *map(str, args)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stderr + result.stdout)
        return json.loads(output.read_text()) if success else result.stderr

    def test_enforcement_cannot_be_silently_ignored_in_reuse_mode(self):
        import os
        from unittest.mock import patch
        import release
        for build, reuse in [('false', ''), ('true', '123')]:
            with self.subTest(build=build, reuse=reuse), patch.dict(os.environ,
                    ENFORCE_ENTRY_OWNERSHIP='true', RELEASE_MANAGED=build, MANIFEST_RUN_ID=reuse):
                with self.assertRaisesRegex(ValueError, 'fresh managed manifest'):
                    release.require_gate(None, None)

    def test_release_workflow_emits_an_enforcement_manifest(self):
        import os
        workflow = (ROOT / '.github/workflows/ci.yml').read_text()
        step = workflow.split('      - name: Generate component-aware manifest\n', 1)[1]
        script = step.split('        run: |\n', 1)[1].split('\n      - name:', 1)[0]
        script = '\n'.join(line[10:] for line in script.splitlines())
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            plan = directory / 'plan'
            images = directory / 'images'
            plan.mkdir()
            images.mkdir()
            self.generate(plan / 'stable-manifest.json', '--api-image', IMAGE, '--sync-image', IMAGE)
            (plan / 'plan.json').write_text(json.dumps(dict(affected_components=[])))
            target = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            identity = f'managed-episode-20261024T000000Z-{target[:12]}-{os.urandom(4).hex()}'
            output = ROOT / 'infrastructure/managed-episode/generated' / (identity + '.json')
            env = dict(os.environ, RELEASE_ID=identity, PLAN_ROOT=str(plan), IMAGE_ROOT=str(images),
                       BUILD_JOB_RESULT='skipped', BUILD_SET='[]', TARGET_SHA=target,
                       ENFORCE_ENTRY_OWNERSHIP='true')
            try:
                result = subprocess.run(['bash', '-c', script], cwd=ROOT, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(json.loads(output.read_text())['protocol_compatibility']['entry_enforcement'])
            finally:
                output.unlink(missing_ok=True)

    def test_expand_then_enforce_and_retained_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            expanded = directory / 'expanded.json'
            value = self.generate(expanded, '--api-image', IMAGE, '--sync-image', IMAGE)
            self.assertEqual(value['protocol_compatibility'], dict(sync=1, entry_writer=1, entry_migrator=1))
            enforced = directory / 'enforced.json'
            value = self.generate(enforced, '--stable-manifest', expanded,
                                  '--affected-components', 'none', '--enforce-entry-ownership')
            self.assertTrue(value['protocol_compatibility']['entry_enforcement'])
            subprocess.run([str(RENDER), str(enforced), str(directory / 'runtime')], check=True, capture_output=True)
            unit = (directory / 'runtime/quadlet/chalk-api-migrate.container').read_text()
            self.assertIn('--entry-writer-protocol 1 --enforce-entry-ownership ', unit)
            self.assertIn('--rollback-entry-writer-protocol 1', unit)
            # The retained expanded image retains its capability and does not
            # request a database downgrade when used as the rollback release.
            rollback = self.generate(directory / 'rollback.json', '--stable-manifest', expanded,
                                     '--affected-components', 'none', '--reuse-envelope')
            self.assertEqual(rollback['protocol_compatibility']['entry_writer'], 1)
            self.assertNotIn('entry_enforcement', rollback['protocol_compatibility'])

    def test_controller_uses_the_restored_release_identity(self):
        controller = (ROOT / 'infrastructure/managed-episode/controller/chalk-deployment-controller').read_text()
        function = 'run_migrations() {' + controller.split('run_migrations() {', 1)[1].split('\nhealth_runtime() {', 1)[0]
        stubs = """
set -euo pipefail
has_migrator_input() { return 0; }
require_regular_file() { test -f "$1"; }
fail() { echo "$1" >&2; exit 1; }
run_user_systemctl() { return 0; }
run_user_podman() { return 0; }
remove_migrator_secret() { return 0; }
remove_staged_tree() { return 0; }
"""
        import os
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            expanded = directory / 'expanded.json'
            self.generate(expanded, '--api-image', IMAGE, '--sync-image', IMAGE)
            enforced = directory / 'release-manifest.json'
            value = self.generate(enforced, '--stable-manifest', expanded,
                                  '--affected-components', 'none', '--enforce-entry-ownership')
            runtime = directory / 'runtime'
            subprocess.run([str(RENDER), str(enforced), str(runtime)], check=True, capture_output=True)
            pointer = directory / 'active.json'
            pointer.write_text(json.dumps(dict(release_root=str(directory))))
            for request in (value['release_id'], '', 'another-candidate'):
                with self.subTest(request=request):
                    env = dict(os.environ, manifest_path=str(enforced), active_pointer=str(pointer),
                               stage_root=str(directory), request_release_id=request,
                               MIGRATOR_SECRET_NAME='chalk-managed-migrator-database-url', RUNTIME=str(runtime))
                    result = subprocess.run(['bash', '-c', stubs + function + '\nrun_migrations "$RUNTIME"'],
                                            env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_obsolete_rollback_baseline_cannot_enable_enforcement(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            legacy = directory / 'legacy.json'
            value = self.generate(legacy, '--api-image', IMAGE, '--sync-image', IMAGE)
            value['protocol_compatibility'] = dict(sync=1)
            legacy.write_text(json.dumps(value))
            error = self.generate(directory / 'invalid.json', '--stable-manifest', legacy,
                                  '--api-image', IMAGE, '--sync-image', IMAGE,
                                  '--enforce-entry-ownership', success=False)
            self.assertIn('expanded rollback baseline', error)
            carried = self.generate(directory / 'carried.json', '--stable-manifest', legacy,
                                    '--api-image', IMAGE, '--affected-components', 'api')
            self.assertNotIn('entry_writer', carried['protocol_compatibility'])
