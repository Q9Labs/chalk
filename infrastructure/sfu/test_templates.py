"""Renders the node templates and runs every branch of `deploy` with its external commands mocked,
so a renamed variable, a missing placeholder or an image build that cannot find a module fails here
and not on a fresh node.

The mocks (ssh, doctl, docker, git) record what they are asked and answer what the real ones would.
The mocked ssh stops the deploy at `daemon-reload`, the last step before the restart, so everything
that renders a file, builds an image or issues a certificate has run by then.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path, PurePosixPath

INFRA = Path(__file__).resolve().parent
REPO = INFRA.parents[1]
SFU = REPO / 'features/media/sfu'
TABLE = json.loads((SFU / 'internal/config/node.json').read_text())
BENCH = SFU / 'scripts/bench/bench'
EIGHT_MIB = 8 * 1024 * 1024
STOPPED = 77  # what the mocked ssh exits with at daemon-reload

MOCK = r'''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path

tool, args, root = os.path.basename(sys.argv[0]), sys.argv[1:], os.environ['MOCK_ROOT']
stdin = '' if sys.stdin.isatty() else sys.stdin.read()
log = lambda name, text: open(f'{root}/{name}', 'a').write(text + '\n')

if tool == 'git':
    command = args[2:]
    if command[:2] == ['rev-parse', 'HEAD']:
        print('0123456789abcdef0123456789abcdef01234567')
    elif command[:2] == ['rev-parse', '--show-toplevel']:
        print(root + '/repo')
elif tool == 'docker':
    if args[:2] == ['buildx', 'build']:
        log('docker-builds', json.dumps(args))
    elif args[:1] == ['save']:
        print('image')
elif tool == 'doctl':
    rule = lambda ports: {'protocol': 'tcp', 'ports': ports, 'sources': {'addresses': ['192.0.2.0/24']}}
    print(json.dumps([{'name': 'chalk-sfu-' + os.environ['MOCK_ENV'], 'inbound_rules': [rule(os.environ['MOCK_CONTROL_PORT']), rule('22')]}]))
elif tool == 'ssh':
    command = ' '.join(args[next(i for i, a in enumerate(args) if a.startswith('root@')) + 1:])
    log('ssh-calls', command)
    installed = re.search(r"cat > (\S+?)'?$", command)
    if installed:
        path = Path(root, 'node', installed.group(1))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stdin)
    if command == 'nproc':
        print(os.environ['MOCK_VCPUS'])
    elif "{{.Id}}" in command:
        print('sha256:mock')
    elif 'Labels' in command:
        print('0123456789abcdef0123456789abcdef01234567')
    elif command.endswith('daemon-reload'):
        sys.exit(77)
    elif 'secret inspect' in command:
        sys.exit(1)
'''

CERTS = '''#!/bin/sh
echo "$@" >> "$MOCK_ROOT/certs-calls"
case "$2" in
  capture-worker) touch "$CHALK_SFU_PRIVATE_DIR/$1/capture-worker.crt" "$CHALK_SFU_PRIVATE_DIR/$1/capture-worker.key" ;;
esac
'''


def dockerfile_steps(path):
    """Yields (workdir, instruction, arguments) for each Dockerfile line, with continuations joined."""
    workdir = PurePosixPath('/')
    text = re.sub(r'\\\n', ' ', path.read_text())
    for line in text.splitlines():
        match = re.match(r'(\w+)\s+(.*)', line.strip())
        if not match:
            continue
        instruction, rest = match.group(1).upper(), match.group(2)
        if instruction == 'WORKDIR':
            workdir = workdir / rest
        yield workdir, instruction, rest


def go_replacements(go_mod):
    return re.findall(r'^replace\s+\S+\s+=>\s+(\.\S*)', go_mod.read_text(), re.M)


class TemplateTest(unittest.TestCase):
    def test_main_tf_passes_exactly_the_variables_each_template_uses(self):
        main = (INFRA / 'node/main.tf').read_text()
        for template in (INFRA / 'node').glob('*.tftpl'):
            call = re.search(r'templatefile\("\$\{path\.module\}/' + re.escape(template.name) + r'", \{(.*?)\n  \}\)', main, re.S)
            self.assertIsNotNone(call, f'main.tf does not render {template.name}')
            passed = set(re.findall(r'^\s*(\w+)\s*=', call.group(1), re.M))
            text = template.read_text()
            loop_locals = set(re.findall(r'%\{\s*for (\w+) in', text))
            used = set(re.findall(r'\$\{(\w+)', text)) | set(re.findall(r'%\{\s*for \w+ in (\w+)', text))
            self.assertEqual(used - loop_locals, passed, template.name)

    def test_the_bench_render_of_cloud_init_fills_every_placeholder(self):
        with tempfile.TemporaryDirectory() as private:
            env = {**os.environ, 'CHALK_SFU_PRIVATE_DIR': private}
            rendered = subprocess.run(['bash', '-c', 'source "$1" && render_cloud_init 203.0.113.5/32 198.51.100.7/32', 'bench', str(BENCH)],
                                      env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=True).stdout
        self.assertNotRegex(rendered, r'\$\{|%\{')
        self.assertEqual(rendered.count(str(EIGHT_MIB)), 4, 'the receive and send buffers, each with a max and a default')
        self.assertEqual(TABLE['udpBufferBytes'], EIGHT_MIB)
        self.assertIn(f"ufw allow {TABLE['ports']['media']}/udp", rendered)
        self.assertIn(f"ufw allow proto tcp from 203.0.113.5/32 to any port {TABLE['ports']['control']}", rendered)
        self.assertIn('ufw allow proto tcp from 198.51.100.7/32 to any port 22', rendered)


class DeployBranchesTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        repo = self.root / 'repo'
        (repo / 'infrastructure').mkdir(parents=True)
        shutil.copytree(INFRA, repo / 'infrastructure/sfu', ignore=shutil.ignore_patterns('.terraform*', '*.tfstate*', '__pycache__'))
        (repo / 'infrastructure/sfu/certs').write_text(CERTS)
        (repo / 'infrastructure/sfu/certs').chmod(0o755)
        for path in ('apps/api', 'features/mcp/api', 'features/media/sfu'):
            (repo / path).parent.mkdir(parents=True, exist_ok=True)
            (repo / path).symlink_to(REPO / path)
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'mock').write_text(MOCK)
        (bin_dir / 'mock').chmod(0o755)
        for tool in ('ssh', 'doctl', 'docker', 'git'):
            (bin_dir / tool).symlink_to('mock')
        self.private = self.root / 'private'
        self.key = self.root / 'operator_key'
        self.key.write_text('x')
        self.deploy = repo / 'infrastructure/sfu/deploy'

    def operator_files(self, environment, *names, capture=False):
        directory = self.private / environment
        directory.mkdir(parents=True)
        for name in ('ca.crt', 'server.crt', 'server.key', *names):
            (directory / name).write_text('x')
        if capture:
            (directory / 'capture.conf').write_text('NODE_ID=sfu-1\nCONTROL_PLANE_URL=https://api.example.test\nSERVER_NAME=api.example.test\nSLOTS=3\n')
            (directory / 'capture-ca.crt').write_text('x')
            (directory / 'bridge-ca.crt').write_text('x')

    def run_deploy(self, environment, *arguments, **extra):
        env = {
            'PATH': f"{self.root / 'bin'}:{os.environ['PATH']}", 'HOME': str(self.root), 'MOCK_ROOT': str(self.root),
            'MOCK_ENV': environment, 'MOCK_CONTROL_PORT': str(TABLE['ports']['control']),
            'MOCK_VCPUS': str(next(iter(TABLE['sizes'].values()))['vcpus']),
            'CHALK_SFU_PRIVATE_DIR': str(self.private), 'SFU_SSH_KEY': str(self.key), **extra,
        }
        return subprocess.run([str(self.deploy), environment, '192.0.2.1', *arguments], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)

    def read(self, name):
        path = self.root / name
        return path.read_text() if path.exists() else ''

    def builds(self):
        return [json.loads(line) for line in self.read('docker-builds').splitlines()]

    def installed(self):
        return {str(path.relative_to(self.root / 'node')): path.read_text() for path in (self.root / 'node').rglob('*') if path.is_file()}

    def assert_reached_restart(self, result):
        self.assertEqual(result.returncode, STOPPED, result.stderr)
        self.assertNotIn('unbound variable', result.stderr)
        for name, text in self.installed().items():
            self.assertNotRegex(text, r'__[A-Z][A-Z_]*__|\$\{', f'{name} has an unfilled placeholder')

    def assert_images_build(self, build):
        """Every context a build names exists, and each module its Go code replaces is copied in before the download."""
        arguments = dict(zip(build[:-1], build[1:]))
        contexts = dict(item.split('=', 1) for item, flag in zip(build[1:], build) if flag == '--build-context')
        for name, path in contexts.items():
            self.assertTrue(Path(path).is_dir(), f'build context {name}={path} does not exist')
        dockerfile, context = Path(arguments['--file']), Path(build[-1])
        self.assertTrue(dockerfile.is_file() and context.is_dir())
        module = {'Dockerfile': SFU, 'Dockerfile.capture': REPO / 'apps/api'}[dockerfile.name]
        copied, downloaded, stages = [], False, set()
        for workdir, instruction, rest in dockerfile_steps(dockerfile):
            if instruction == 'FROM' and ' AS ' in rest.upper():
                stages.add(rest.split()[-1])
            elif instruction == 'COPY':
                words = rest.split()
                source = next(word for word in words if not word.startswith('--'))
                destination = workdir / words[-1]
                origin = re.search(r'--from=(\w+)', rest)
                if origin:
                    self.assertIn(origin.group(1), contexts.keys() | stages, f'{dockerfile.name} copies from a context the deploy does not pass')
                else:
                    self.assertTrue((context / source).exists(), f'{dockerfile.name} copies {source}, which is not in its context')
                copied.append(destination)
            elif instruction == 'RUN' and 'go mod download' in rest:
                downloaded = True
                for replaced in go_replacements(module / 'go.mod'):
                    target = PurePosixPath(os.path.normpath(workdir / replaced))
                    self.assertTrue(any(target == dest or target in dest.parents for dest in copied), f'{dockerfile.name} downloads before copying {target}')
        self.assertTrue(downloaded)

    def deploy_with_everything_on(self, environment):
        self.operator_files(environment, 'otlp-headers', 'otlp-log-headers', capture=True)
        extra = {'SFU_PACKET_BUDGET': '1000', 'SFU_MAX_EPISODE_PARTICIPANTS': '8'} if environment == 'bench' else {}
        result = self.run_deploy(environment, **extra)
        self.assert_reached_restart(result)
        images, installed = self.builds(), self.installed()
        self.assertEqual(len(images), 2)
        for build in images:
            self.assert_images_build(build)
        env_file = installed['.config/chalk-sfu/sfu.env']
        self.assertEqual(env_file.count(f'={EIGHT_MIB}'), 2, env_file)
        self.assertIn(f'net.core.wmem_max = {EIGHT_MIB}', self.read('ssh-calls'))
        self.assertIn(f"SFU_TCP_ADDR=:{TABLE['ports']['media']}", env_file)
        self.assertNotIn('__', env_file)
        self.assertIn(f"{TABLE['ports']['control']} {TABLE['ports']['media']}", self.read('ssh-calls'))
        self.assertEqual('SFU_PACKET_BUDGET=1000' in env_file, environment == 'bench')
        capture_env = installed['.config/chalk-sfu/capture.env']
        self.assertIn('CHALK_RECORDER_CAPTURE_SLOTS=3', capture_env)
        self.assertIn('CHALK_RECORDER_CONTROL_PLANE_URL=https://api.example.test', capture_env)
        self.assertIn('Image=sha256:mock', installed['.config/containers/systemd/chalk-recorder-capture.container'])
        certs = self.read('certs-calls')
        self.assertIn(f'{environment} capture-worker sfu-1', certs)
        self.assertIn(f'{environment} capture-worker-check sfu-1', certs)

    def test_staging_with_the_capture_worker_and_metrics_on(self):
        self.deploy_with_everything_on('staging')

    def test_production_with_the_capture_worker_and_metrics_on(self):
        self.deploy_with_everything_on('production')

    def test_bench_with_the_capture_worker_metrics_and_a_packet_budget(self):
        self.deploy_with_everything_on('bench')

    def test_without_capture_or_metrics_the_worker_is_removed_and_one_image_builds(self):
        self.operator_files('staging')
        result = self.run_deploy('staging')
        self.assert_reached_restart(result)
        self.assertIn('the capture worker is off', result.stdout)
        self.assertIn('stop chalk-recorder-capture', self.read('ssh-calls'))
        self.assertIn('rm -f .config/containers/systemd/chalk-recorder-capture.container', self.read('ssh-calls'))
        builds = self.builds()
        self.assertEqual(len(builds), 1)
        self.assert_images_build(builds[0])
        self.assertIn('exports no metrics', result.stderr)
        self.assertEqual(self.read('certs-calls'), '')

    def test_firewall_only_stops_before_any_build(self):
        self.operator_files('staging')
        result = self.run_deploy('staging', '--firewall-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.builds(), [])

    def test_capture_conf_without_its_certificates_is_refused(self):
        self.operator_files('staging', capture=True)
        (self.private / 'staging/bridge-ca.crt').unlink()
        result = self.run_deploy('staging')
        self.assertEqual(result.returncode, 1)
        self.assertIn('bridge-ca.crt is missing', result.stderr)


if __name__ == '__main__':
    unittest.main()
