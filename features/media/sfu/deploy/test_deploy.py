import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

DEPLOY = Path(__file__).with_name('deploy')


class DeployStartTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        private = self.root / 'private' / 'staging'
        private.mkdir(parents=True)
        for name in ('ca.crt', 'server.crt', 'server.key'):
            (private / name).write_text('x')
        (self.root / 'home').mkdir()
        fake = self.root / 'bin'
        fake.mkdir()
        # The fake ssh records its arguments and fails, so deploy stays in its bootstrap wait.
        (fake / 'ssh').write_text(f'#!/bin/sh\necho "$@" >> {self.root}/ssh-calls\nexit 99\n')
        (fake / 'ssh').chmod(0o755)
        self.env = {
            'PATH': f'{fake}:{os.environ["PATH"]}',
            'HOME': str(self.root / 'home'),
            'CHALK_SFU_PRIVATE_DIR': str(self.root / 'private'),
        }

    def test_missing_key_fails_at_the_start_without_ssh(self):
        result = subprocess.run([str(DEPLOY), 'staging', '192.0.2.1'], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('no SSH key at', result.stderr)
        self.assertFalse((self.root / 'ssh-calls').exists())

    def test_key_from_environment_is_passed_to_ssh(self):
        key = self.root / 'operator_key'
        key.write_text('x')
        process = subprocess.Popen([str(DEPLOY), 'staging', '192.0.2.1'], env={**self.env, 'SFU_SSH_KEY': str(key)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        calls = self.root / 'ssh-calls'
        deadline = time.time() + 20
        while not calls.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertIn(f'-i {key}', calls.read_text())


if __name__ == '__main__':
    unittest.main()
