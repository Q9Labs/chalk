import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class ReleaseSource(unittest.TestCase):
    def test_release_source_and_deployment_inputs_are_checked(self):
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        for target, build, deploy, error in ((head, 'true', 'true', None), (head, 'false', 'false', None),
                ('', 'true', 'true', 'full lowercase'), ('bad', 'true', 'true', 'full lowercase'), ('0' * 40, 'true', 'true', 'does not match'),
                (head, 'false', 'true', 'requires release_managed')):
            with self.subTest(target=target, build=build, deploy=deploy):
                result = subprocess.run(['bash', 'scripts/releases/check-source.sh'], cwd=ROOT, text=True, capture_output=True,
                                        env=dict(os.environ, TARGET_SHA=target, RELEASE_MANAGED=build, DEPLOY_MANAGED=deploy))
                self.assertEqual(result.returncode == 0, error is None)
                if error:
                    self.assertIn(error, result.stderr)
