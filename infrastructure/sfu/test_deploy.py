import json
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

    def test_a_release_run_reconciles_no_firewall_and_trusts_no_new_host(self):
        key = self.root / 'operator_key'
        key.write_text('x')
        fake = self.root / 'bin'
        (fake / 'ssh').write_text(f'#!/bin/sh\necho "$@" >> {self.root}/ssh-calls\nexit 0\n')
        (fake / 'doctl').write_text(f'#!/bin/sh\ntouch {self.root}/doctl-called\nexit 1\n')
        (fake / 'doctl').chmod(0o755)
        result = subprocess.run([str(DEPLOY), 'staging', '192.0.2.1'], env={**self.env, 'SFU_SSH_KEY': str(key), 'SFU_FROM_CI': '1'}, capture_output=True, text=True, timeout=30)
        # The fake node has no vCPU count, so the run stops there, after the step that would have called doctl and issued nothing.
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('release run: the host firewall stays', result.stdout)
        self.assertFalse((self.root / 'doctl-called').exists())
        self.assertIn('StrictHostKeyChecking=yes', (self.root / 'ssh-calls').read_text())
        self.assertNotIn('accept-new', (self.root / 'ssh-calls').read_text())


    def fake_otlp_endpoint(self, status):
        """Writes a metrics header file and a curl that records its arguments and the headers it read, and answers status."""
        (self.root / 'private' / 'staging' / 'otlp-headers').write_text('Authorization=Bearer%20secret-token,X-Axiom-Dataset=metrics')
        curl = self.root / 'bin' / 'curl'
        curl.write_text(
            '#!/bin/sh\n'
            f'echo "$@" >> {self.root}/curl-calls\n'
            'for argument in "$@"; do case "$argument" in @*) cat "${argument#@}" >> ' f'{self.root}/curl-headers;; esac; done\n'
            f'printf {status}\n'
        )
        curl.chmod(0o755)

    def test_a_rejected_otlp_token_stops_the_deploy_before_it_reaches_the_node(self):
        key = self.root / 'operator_key'
        key.write_text('x')
        self.fake_otlp_endpoint(401)
        result = subprocess.run([str(DEPLOY), 'staging', '192.0.2.1'], env={**self.env, 'SFU_SSH_KEY': str(key)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn('rejects the token in', result.stderr)
        self.assertFalse((self.root / 'ssh-calls').exists())
        self.assertIn('/v1/metrics', (self.root / 'curl-calls').read_text())
        self.assertNotIn('secret-token', (self.root / 'curl-calls').read_text())
        self.assertIn('Authorization: Bearer secret-token', (self.root / 'curl-headers').read_text())

    def test_an_accepted_otlp_token_lets_the_deploy_go_on(self):
        key = self.root / 'operator_key'
        key.write_text('x')
        self.fake_otlp_endpoint(422)
        # The fake ssh fails, so the deploy waits for the bootstrap; reaching ssh at all is the proof.
        process = subprocess.Popen([str(DEPLOY), 'staging', '192.0.2.1'], env={**self.env, 'SFU_SSH_KEY': str(key)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        calls = self.root / 'ssh-calls'
        deadline = time.time() + 20
        while not calls.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(calls.exists())
        self.assertIn('/v1/metrics', (self.root / 'curl-calls').read_text())

class ReadyzTest(unittest.TestCase):
    """readyz prints the body of a ready node and of a draining one, which answers 503, and refuses any other status."""

    def run_readyz(self, status):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / 'private' / 'production').mkdir(parents=True)
            key = root / 'key'
            key.write_text('x')
            fake = root / 'bin'
            fake.mkdir()
            # The fake ssh opens the forwarded port the way the tunnel would, and the fake curl answers as the node does.
            (fake / 'ssh').write_text('#!/bin/sh\nfor a in "$@"; do case "$a" in *:127.0.0.1:*) port="${a%%:*}";; esac; done\n'
                                      'exec python3 -c "import socket,sys,time\ns=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind((\'127.0.0.1\',int(sys.argv[1])));s.listen();time.sleep(30)" "$port"\n')
            (fake / 'curl').write_text(f'#!/bin/sh\nprintf \'{{"protocol":2,"revision":"abc"}}\\n{status}\'\n')
            for tool in ('ssh', 'curl'):
                (fake / tool).chmod(0o755)
            env = {**os.environ, 'PATH': f'{fake}:{os.environ["PATH"]}', 'CHALK_SFU_PRIVATE_DIR': str(root / 'private'), 'SFU_SSH_KEY': str(key), 'SFU_FROM_CI': '1'}
            return subprocess.run([str(DEPLOY.with_name('readyz')), 'production', '192.0.2.1'], env=env, capture_output=True, text=True, timeout=30)

    def test_a_ready_node_and_a_draining_node_both_print_their_state(self):
        for status in (200, 503):
            result = self.run_readyz(status)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['protocol'], 2)

    def test_any_other_status_fails(self):
        result = self.run_readyz(502)
        self.assertEqual(result.returncode, 1)
        self.assertIn('answered 502', result.stderr)


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

    def test_check_refuses_an_identity_that_is_not_the_nodes_or_is_about_to_lapse(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'CHALK_SFU_PRIVATE_DIR': directory}
            certs = str(DEPLOY.with_name('certs'))

            def run(*command):
                return subprocess.run([certs, 'bench', *command], env=env, capture_output=True, text=True, timeout=60)

            self.assertEqual(run('capture-ca').returncode, 0)
            self.assertEqual(run('capture-worker', 'sfu-1').returncode, 0)
            self.assertEqual(run('capture-worker-check', 'sfu-1').returncode, 0)
            other = run('capture-worker-check', 'sfu-2')
            self.assertNotEqual(other.returncode, 0)
            self.assertIn('does not carry exactly the identity', other.stderr)

            bench = Path(directory) / 'bench'
            # A short-lived certificate from the same CA must be refused for its remaining lifetime.
            short = Path(directory) / 'short'
            short.mkdir()
            subprocess.run(['openssl', 'req', '-new', '-key', str(bench / 'capture-worker.key'), '-subj', '/CN=short', '-out', str(short / 'w.csr')], check=True, capture_output=True)
            ext = subprocess.run(['openssl', 'x509', '-in', str(bench / 'capture-worker.crt'), '-noout', '-ext', 'subjectAltName'], check=True, capture_output=True, text=True).stdout
            uri = ext.split('URI:')[1].strip()
            (short / 'w.ext').write_text(f'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:{uri}\n')
            subprocess.run(['openssl', 'x509', '-req', '-in', str(short / 'w.csr'), '-CA', str(bench / 'capture-ca.crt'), '-CAkey', str(bench / 'capture-ca.key'),
                            '-set_serial', '7', '-days', '3', '-sha256', '-extfile', str(short / 'w.ext'), '-out', str(bench / 'capture-worker.crt')], check=True, capture_output=True)
            lapsing = run('capture-worker-check', 'sfu-1')
            self.assertNotEqual(lapsing.returncode, 0)
            self.assertIn('expires within 14 days', lapsing.stderr)


class CaptureSecretsTest(unittest.TestCase):
    def test_every_deploy_installs_the_worker_identity_it_just_issued(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / 'private'
            bench = private / 'bench'
            bench.mkdir(parents=True)
            fake = root / 'bin'
            fake.mkdir()
            secrets = root / 'secrets'
            secrets.mkdir()
            rule = {'protocol': 'tcp', 'sources': {'addresses': ['192.0.2.0/24']}}
            firewall = json.dumps([{'name': 'chalk-sfu-bench', 'inbound_rules': [{**rule, 'ports': '8443'}, {**rule, 'ports': '22'}]}])
            # The fake node answers what deploy reads and keeps each Podman secret it is given; the run ends at daemon-reload.
            ssh = f"""cmd="$*"
case "$cmd" in
  *"secret create"*) name="$(echo "$cmd" | sed -E 's/.*secret create +(--replace +)?([^ ]+) .*/\\2/')"; tee "{secrets}/$name" >/dev/null ;;
  *MemTotal*) echo "MemTotal: 2097152 kB" ;;
  *nproc*) echo 2 ;;
  *"{{{{.Id}}}}"*) echo sha256:fakeimage ;;
  *Labels*) echo fakerevision ;;
  *daemon-reload*) exit 97 ;;
  *) cat >/dev/null ;;
esac
"""
            tools = {
                'doctl': f"echo '{firewall}'\n",
                'docker': 'cat >/dev/null\n',
                'git': 'case "$*" in *rev-parse*) echo fakerevision;; esac\n',
                'ssh': ssh,
            }
            for name, body in tools.items():
                (fake / name).write_text(f'#!/bin/sh\n{body}')
                (fake / name).chmod(0o755)
            (root / 'key').write_text('x')
            (root / 'home').mkdir()
            for name in ('ca.crt', 'server.crt', 'server.key', 'bridge-ca.crt'):
                (bench / name).write_text('x')
            (bench / 'capture.conf').write_text('NODE_ID=sfu-1\nCONTROL_PLANE_URL=https://control.invalid\nSERVER_NAME=control.invalid\n')
            env = {**os.environ, 'PATH': f'{fake}:{os.environ["PATH"]}', 'HOME': str(root / 'home'),
                   'CHALK_SFU_PRIVATE_DIR': str(private), 'SFU_SSH_KEY': str(root / 'key')}
            subprocess.run([str(DEPLOY.with_name('certs')), 'bench', 'capture-ca'], env=env, check=True, capture_output=True, timeout=60)

            issued = []
            for _ in range(2):
                # Exit 97 is the fake node's daemon-reload, so every secret was created before it.
                result = subprocess.run([str(DEPLOY), 'bench', '192.0.2.1'], env=env, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
                self.assertEqual(result.returncode, 97, result.stderr)
                for secret, file in (('worker-cert', 'capture-worker.crt'), ('worker-key', 'capture-worker.key')):
                    self.assertEqual((secrets / f'chalk-capture-{secret}').read_bytes(), (bench / file).read_bytes())
                issued.append((bench / 'capture-worker.crt').read_bytes())
            self.assertNotEqual(issued[0], issued[1])


if __name__ == '__main__':
    unittest.main()
