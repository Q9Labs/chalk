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
        self.assertIn('no readable SSH key at', result.stderr)
        self.assertFalse((self.root / 'ssh-calls').exists())

    @unittest.skipIf(os.geteuid() == 0, 'root reads any file')
    def test_unreadable_key_fails_at_the_start_without_ssh(self):
        key = self.root / 'operator_key'
        key.write_text('x')
        key.chmod(0)
        result = subprocess.run([str(DEPLOY), 'staging', '192.0.2.1'], env={**self.env, 'SFU_SSH_KEY': str(key)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('no readable SSH key at', result.stderr)
        self.assertFalse((self.root / 'ssh-calls').exists())

    def test_key_the_node_rejects_fails_without_waiting(self):
        key = self.root / 'operator_key'
        key.write_text('x')
        (self.root / 'bin' / 'ssh').write_text('#!/bin/sh\necho "root@host: Permission denied (publickey)." >&2\nexit 255\n')
        result = subprocess.run([str(DEPLOY), 'staging', '192.0.2.1'], env={**self.env, 'SFU_SSH_KEY': str(key)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ssh cannot authenticate', result.stderr)
        self.assertIn('Permission denied', result.stderr)

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


class CaptureWorkerCertificateTest(unittest.TestCase):
    def test_worker_identity_names_the_id_the_api_derives_for_the_node(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'CHALK_SFU_PRIVATE_DIR': directory}
            certs = DEPLOY.with_name('certs')
            for command in (['capture-ca'], ['capture-worker', 'sfu-1']):
                subprocess.run([str(certs), 'bench', *command], env=env, check=True, capture_output=True, timeout=60)
            bench = Path(directory) / 'bench'
            names = subprocess.run(['openssl', 'x509', '-in', str(bench / 'capture-worker.crt'), '-noout', '-ext', 'subjectAltName'],
                                   check=True, capture_output=True, text=True).stdout
            # apps/api/internal/workeridentity/colocated_test.go pins the same value.
            self.assertIn('URI:spiffe://chalkmeet.com/environment/bench/capture/5bf8647d-4fac-8dd9-86a0-411de7850d79', names)
            subprocess.run(['openssl', 'verify', '-CAfile', str(bench / 'capture-ca.crt'), str(bench / 'capture-worker.crt')], check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
