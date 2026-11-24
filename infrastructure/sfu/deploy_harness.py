"""The fake node `deploy` runs against: its external commands (ssh, doctl, docker, git, curl) are mocks that record what they are
asked, and the mocked ssh stops the deploy at `daemon-reload`, after every file, image and certificate step has run.
"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

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
elif tool == 'curl':
    # The OTLP endpoint takes the token, as Axiom does for an empty request; every other call is real curl.
    if any(re.search(r'/v1/(metrics|logs|traces)$', a) for a in args):
        log('otlp-checks', next(a for a in args if '/v1/' in a))
        log('otlp-headers-sent', ''.join(open(a[1:]).read() for a in args if a.startswith('@')))
        print(os.environ.get('MOCK_OTLP_STATUS', '422'), end='')
    else:
        os.execv('/usr/bin/curl', ['curl', *args])
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



class DeployHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        repo = self.root / 'repo'
        (repo / 'infrastructure').mkdir(parents=True)
        shutil.copytree(INFRA, repo / 'infrastructure/sfu', ignore=shutil.ignore_patterns('.terraform*', '*.tfstate*', '__pycache__'))
        (repo / 'infrastructure/sfu/certs').write_text(CERTS)
        (repo / 'infrastructure/sfu/certs').chmod(0o755)
        for path in ('apps/api', 'features/media/sfu'):
            (repo / path).parent.mkdir(parents=True, exist_ok=True)
            (repo / path).symlink_to(REPO / path)
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'mock').write_text(MOCK)
        (bin_dir / 'mock').chmod(0o755)
        for tool in ('ssh', 'doctl', 'docker', 'git', 'curl'):
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

