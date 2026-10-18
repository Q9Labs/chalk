import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = 'a' * 40


class ImageValidation(unittest.TestCase):
    def test_build_validation_checks_both_roles_without_building_or_sealing(self):
        source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        for role in ('capture', 'render'):
            result = subprocess.run(['bash', str(ROOT / 'scripts/recorder/build-and-seal.sh'), '--validate', source, 'contract-check', role], capture_output=True, text=True, check=True)
            proof = json.loads(result.stdout)
            self.assertEqual(proof, dict(result='PASS', role=role, validation_only=True, built=False, sealed=False))
        result = subprocess.run(['bash', str(ROOT / 'scripts/recorder/build-and-seal.sh'), '--validate', 'not-a-source', 'contract-check', 'capture'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_qualifier_validates_real_manifest_bytes_without_running_a_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root / 'opt/chalk-recorder/current/bin/recorder-capture'
            worker.parent.mkdir(parents=True)
            worker.write_bytes(b'not an executable; validation must not execute it')
            manifest = dict(schema_version='chalk_recorder_cpu_image.v2', source_commit=SOURCE, release_id='contract-check',
                            files=[dict(path='/opt/chalk-recorder/current/bin/recorder-capture', type='file', sha256=hashlib.sha256(worker.read_bytes()).hexdigest())])
            data = json.dumps(manifest).encode()
            (root / 'opt/chalk-recorder/image-manifest.json').write_bytes(data)
            command = ['python3', str(ROOT / 'scripts/recorder/qualify-image.py'), 'capture', SOURCE, 'contract-check',
                       'sha256:' + hashlib.sha256(data).hexdigest(), '--validate', '--root', directory]
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            proof = json.loads(result.stdout)
            self.assertTrue(proof['validation_only'])
            self.assertFalse(proof['runtime_user_execution'])
            self.assertFalse(proof['fleet_equivalent_signed_boot'])
            worker.write_bytes(b'corrupt')
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('image file digest mismatch', result.stderr)
