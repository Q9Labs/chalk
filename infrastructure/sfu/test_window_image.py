"""Checks the window node snapshot tooling without a cloud: the boot script on its own, the templates against what
`deploy` writes for the same node, and `window-image build` end to end with its external commands mocked. The mocks
(doctl, docker, git, ssh, curl, openssl) record what they are asked; the build runs every step from the pinned-key
builder to the snapshot record. What no mock can show (a real boot, a real snapshot) is listed in the README.
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from deploy_harness import INFRA, TABLE, DeployHarness

WINDOW_IMAGE = INFRA / 'window-image'
REVISION = '0123456789abcdef0123456789abcdef01234567'  # what the mocked git reports as HEAD
OPERATOR = '203.0.113.9'
BUILDER = '198.51.100.7'


def load_boot():
    loader = importlib.machinery.SourceFileLoader('window_boot', str(INFRA / 'window-boot'))
    spec = importlib.util.spec_from_loader('window_boot', loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class WindowBootTest(unittest.TestCase):
    def setUp(self):
        self.boot = load_boot()

    def address(self, *answers):
        replies = iter(answers)

        def fetch():
            reply = next(replies)
            if isinstance(reply, Exception):
                raise reply
            return reply
        return self.boot.public_ipv4(fetch, attempts=len(answers), pause=0, sleep=lambda _: None)

    def test_a_public_address_is_taken_and_trimmed(self):
        self.assertEqual(self.address('159.89.10.20\n'), '159.89.10.20')

    def test_an_address_that_cannot_be_announced_is_never_taken(self):
        for bad in ('10.1.2.3', '192.168.0.4', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '', 'not an address', '2001:db8::1', '<html>'):
            with self.subTest(bad=bad), self.assertRaises(SystemExit):
                self.address(bad)

    def test_a_slow_metadata_service_is_waited_for(self):
        self.assertEqual(self.address(OSError('refused'), '10.0.0.5', '159.89.10.20'), '159.89.10.20')

    def test_the_node_size_follows_the_vcpu_count_in_the_node_table(self):
        name, size = self.boot.node_size(TABLE, 2)
        self.assertEqual((name, size['vcpus']), ('s-2vcpu-2gb', 2))
        with self.assertRaises(SystemExit):
            self.boot.node_size(TABLE, 3)

    def test_an_unfilled_placeholder_is_an_error(self):
        self.assertEqual(self.boot.render('a=__X__', {'X': '1'}), 'a=1')
        with self.assertRaises(SystemExit):
            self.boot.render('a=__X__ b=__Y__', {'X': '1'})

    def test_boot_writes_the_settings_and_starts_the_node_as_the_node_user(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config, home = root / 'etc', root / 'home'
            config.mkdir()
            (home / '.config/chalk-sfu').mkdir(parents=True)
            (home / '.config/containers/systemd').mkdir(parents=True)
            (config / 'window-image.json').write_text(json.dumps({'revision': REVISION}))
            (config / 'node.json').write_text(json.dumps(TABLE))
            (config / 'sfu.env.template').write_text('SFU_ANNOUNCE_IPS=__ANNOUNCE_IP__\nSFU_NODE_SIZE=__NODE_SIZE__\nGOMEMLIMIT=__GOMEMLIMIT__\n')
            (config / 'chalk-sfu.container.template').write_text('PodmanArgs=--memory=__MEMORY_LIMIT__\n')
            account = mock.Mock(pw_dir=str(home), pw_uid=1001, pw_gid=1001)
            commands = []
            with mock.patch.object(self.boot, 'CONFIG', config), mock.patch.object(self.boot.pwd, 'getpwnam', return_value=account), \
                    mock.patch.object(self.boot.os, 'chown'), mock.patch.object(self.boot.os, 'sched_getaffinity', create=True, return_value={0, 1}), \
                    mock.patch.object(self.boot, 'fetch_metadata', return_value='159.89.10.20'), \
                    mock.patch.object(self.boot, 'local_addresses', return_value={'159.89.10.20'}), \
                    mock.patch.object(self.boot.subprocess, 'run', side_effect=lambda command, **_: commands.append(command)):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.boot.main()
            size = TABLE['sizes']['s-2vcpu-2gb']
            self.assertEqual((home / '.config/chalk-sfu/sfu.env').read_text(),
                             f"SFU_ANNOUNCE_IPS=159.89.10.20\nSFU_NODE_SIZE=s-2vcpu-2gb\nGOMEMLIMIT={size['goMemLimit']}\n")
            self.assertEqual((home / '.config/containers/systemd/chalk-sfu.container').read_text(), f"PodmanArgs=--memory={size['containerMemory']}\n")
            self.assertEqual((home / '.config/chalk-sfu/sfu.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual(commands, [
                ['systemctl', 'start', 'user@1001.service'],
                ['systemctl', '--user', '-M', 'chalk-sfu@', 'daemon-reload'],
                ['systemctl', '--user', '-M', 'chalk-sfu@', 'restart', 'chalk-sfu.service'],
            ])

    def test_boot_starts_nothing_when_no_address_can_be_found(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory)
            (config / 'window-image.json').write_text(json.dumps({'revision': REVISION}))
            (config / 'node.json').write_text(json.dumps(TABLE))
            with mock.patch.object(self.boot, 'CONFIG', config), mock.patch.object(self.boot.os, 'sched_getaffinity', create=True, return_value={0, 1}), \
                    mock.patch.object(self.boot, 'fetch_metadata', side_effect=OSError('unreachable')), mock.patch.object(self.boot.time, 'sleep'), \
                    mock.patch.object(self.boot.subprocess, 'run') as run:
                with self.assertRaises(SystemExit):
                    self.boot.main()
            run.assert_not_called()


class TemplateParityTest(DeployHarness):
    """The snapshot's settings are the ones `deploy` would write for the same node, so a change to either template reaches both."""

    def test_window_templates_render_to_what_deploy_installs(self):
        boot = load_boot()
        self.operator_files('staging')
        self.assert_reached_restart(self.run_deploy('staging'))
        deployed = self.installed()
        vcpus = int(next(iter(TABLE['sizes'].values()))['vcpus'])
        name, size = boot.node_size(TABLE, vcpus)
        out = self.root / 'templates'
        out.mkdir()
        subprocess.run([str(WINDOW_IMAGE), 'templates', str(out), 'staging', REVISION, 'sha256:mock'], check=True, env={**os.environ, 'HOME': str(self.root)})
        env_template = (out / 'sfu.env.template').read_text()
        self.assertEqual(sorted(set(re.findall(r'__[A-Z_]+__', env_template))), ['__ANNOUNCE_IP__', '__GOMEMLIMIT__', '__NODE_SIZE__'])
        self.assertEqual(boot.render(env_template, {'ANNOUNCE_IP': '192.0.2.1', 'NODE_SIZE': name, 'GOMEMLIMIT': size['goMemLimit']}),
                         deployed['.config/chalk-sfu/sfu.env'])
        unit_template = (out / 'chalk-sfu.container.template').read_text()
        self.assertEqual(sorted(set(re.findall(r'__[A-Z_]+__', unit_template))), ['__MEMORY_LIMIT__'])
        unit = boot.render(unit_template, {'MEMORY_LIMIT': size['containerMemory']})
        self.assertNotIn('[Install]', unit, 'only the boot unit may start the node')
        self.assertNotIn('Secret=chalk-sfu-otlp', unit, 'a window image carries no ingest token')

        def body(text):
            return [line for line in text.splitlines() if not line.startswith('#') and not line.startswith('[Install]') and line != 'WantedBy=default.target']
        self.assertEqual(body(unit), body(deployed['.config/containers/systemd/chalk-sfu.container']))


MOCK = r'''#!/usr/bin/env python3
import json, os, re, socket, sys, time
from pathlib import Path

tool, args, root = os.path.basename(sys.argv[0]), sys.argv[1:], os.environ['MOCK_ROOT']
stdin = '' if sys.stdin.isatty() else sys.stdin.read()
log = lambda name, text: open(f'{root}/{name}', 'a').write(text + '\n')
builder = os.environ['MOCK_BUILDER']

if tool == 'git':
    command = args[2:]
    if command[:2] == ['rev-parse', 'HEAD']:
        print(os.environ['MOCK_HEAD'])
    elif command[:1] == ['status']:
        print(os.environ.get('MOCK_DIRTY', ''), end='')
elif tool == 'docker':
    log('docker-calls', json.dumps(args))
    if args[:1] == ['save']:
        print('image')
elif tool == 'curl':
    if 'api.ipify.org' in ' '.join(args):
        print(os.environ['MOCK_OPERATOR'], end='')
    elif any(a.endswith('/readyz') for a in args):
        print(os.environ['MOCK_READY'], end='')
    else:
        sys.exit(1)
elif tool == 'doctl':
    log('doctl-calls', ' '.join(args))
    if args[:2] == ['compute', 'ssh-key']:
        print(json.dumps([{'id': 4242, 'name': 'chalk-sfu-operator'}]))
    elif args[:3] == ['compute', 'droplet', 'create']:
        Path(root, 'user-data.yaml').write_text(Path(args[args.index('--user-data-file') + 1]).read_text())
        print(json.dumps([{'id': 777, 'networks': {'v4': [{'type': 'private', 'ip_address': '10.0.0.2'}, {'type': 'public', 'ip_address': builder}]}}]))
    elif args[:3] == ['compute', 'snapshot', 'list']:
        name = re.search(r'--snapshot-name (\S+)', Path(root, 'doctl-calls').read_text()).group(1)
        print(json.dumps([{'id': '99001', 'name': name}]))
elif tool == 'ssh':
    if '-N' in args:  # the tunnel: listen where the script expects it, until killed
        port = int(re.search(r'-L (\d+):', ' '.join(args)).group(1))
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('127.0.0.1', port))
        server.listen()
        log('ssh-calls', ' '.join(args))
        time.sleep(60)
        sys.exit(0)
    command = ' '.join(args[next(i for i, a in enumerate(args) if a.startswith('root@')) + 1:])
    log('ssh-calls', ' '.join(args))
    log('ssh-commands', command)
    upload = re.match(r"(?:umask \d+ && )?cat > (\S+)", command)
    if upload:
        path = Path(root, 'node', upload.group(1).lstrip('/'))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stdin)
    if os.environ.get('MOCK_SSH') == 'denied':
        print('root@host: Permission denied (publickey).')
        sys.exit(255)
    if '{{.Id}}' in command:
        print('sha256:feedface')
    elif 'Labels' in command:
        print(os.environ['MOCK_HEAD'])
'''

OPENSSL = '''#!/bin/sh
case "$*" in
  *-enddate*) echo "notAfter=Jan  1 00:00:00 2030 GMT" ;;
  *-pubkey*|*-pubout*) echo same ;;
esac
'''


class WindowImageBuildTest(DeployHarness):
    """Runs the checkout's copy of `window-image`, so `certs` is the harness's stub and no 1Password is needed."""

    def setUp(self):
        super().setUp()
        self.window = self.deploy.with_name('window-image')
        (self.root / 'bin/mock').write_text(MOCK)
        (self.root / 'bin/openssl').write_text(OPENSSL)
        (self.root / 'bin/openssl').chmod(0o755)
        (self.private / 'staging').mkdir(parents=True)
        for name in ('ca.crt', 'window-server.crt', 'window-server.key'):
            (self.private / 'staging' / name).write_text('x')
        self.env = {
            'PATH': f"{self.root / 'bin'}:{os.environ['PATH']}", 'HOME': str(self.root), 'MOCK_ROOT': str(self.root), 'MOCK_BUILDER': BUILDER,
            'MOCK_OPERATOR': OPERATOR, 'MOCK_HEAD': REVISION, 'MOCK_READY': json.dumps(self.ready()),
            'CHALK_SFU_PRIVATE_DIR': str(self.private), 'SFU_SSH_KEY': str(self.key), 'OPENSSL': str(self.root / 'bin/openssl'),
        }

    def ready(self):
        size = TABLE['sizes']['s-2vcpu-2gb']
        return {'revision': REVISION, 'draining': False, 'allocations': 0, 'packetBudget': size['packetBudget'],
                'host': {'udpReceiveBufferBytes': TABLE['udpBufferBytes'], 'udpSendBufferBytes': TABLE['udpBufferBytes']}}

    def run_window(self, *arguments, **extra):
        return subprocess.run([str(self.window), *arguments], env={**self.env, **extra}, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)

    def build(self, *arguments, **extra):
        return self.run_window('build', 'staging', '--revision', REVISION, '--control-addresses', '192.0.2.10/32', *arguments, **extra)

    def test_the_build_needs_a_pinned_revision_and_the_control_sources(self):
        for arguments in (['--control-addresses', '192.0.2.10/32'], ['--revision', 'main', '--control-addresses', '192.0.2.10/32'],
                          ['--revision', REVISION], ['--revision', REVISION, '--control-addresses', 'api.example.test'],
                          ['--revision', REVISION, '--control-addresses', '192.0.2.10/32', '--size', 's-9vcpu']):
            with self.subTest(arguments=arguments):
                result = self.run_window('build', 'staging', *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.read('doctl-calls').count('droplet create'), 0)

    def test_the_build_refuses_a_checkout_that_is_not_the_pinned_clean_revision(self):
        other = self.build(MOCK_HEAD='f' * 40)
        self.assertIn('the checkout is not at', other.stderr)
        dirty = self.build(MOCK_DIRTY=' M internal/x.go')
        self.assertIn('uncommitted changes', dirty.stderr)
        self.assertNotIn('droplet create', self.read('doctl-calls'))

    def test_the_build_pins_the_builder_host_key_and_deletes_a_builder_it_cannot_reach(self):
        result = self.build(MOCK_SSH='denied')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot authenticate', result.stderr)
        user_data = self.read('user-data.yaml')
        self.assertIn(f'ufw allow proto tcp from {OPERATOR}/32 to any port 22', user_data)
        self.assertIn('ufw allow proto tcp from 192.0.2.10/32 to any port ' + str(TABLE['ports']['control']), user_data)
        self.assertRegex(user_data, r'ssh_keys:\n  ed25519_private: \|\n    -----BEGIN OPENSSH PRIVATE KEY-----')
        calls = self.read('ssh-calls')
        self.assertIn('StrictHostKeyChecking=yes', calls)
        self.assertNotIn('accept-new', calls)
        self.assertIn('compute droplet delete -f 777', self.read('doctl-calls'))

    def test_a_kept_builder_is_not_deleted_and_is_named(self):
        result = self.build('--keep-builder', MOCK_SSH='denied')
        self.assertNotIn('droplet delete', self.read('doctl-calls'))
        self.assertIn('doctl compute droplet delete -f 777', result.stderr)

    def test_a_full_build_seals_snapshots_records_and_deletes_the_builder(self):
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        installed = {str(path.relative_to(self.root / 'node')): path.read_text() for path in (self.root / 'node').rglob('*') if path.is_file()}
        for path in ('etc/chalk-sfu/sfu.env.template', 'etc/chalk-sfu/chalk-sfu.container.template', 'etc/chalk-sfu/window-image.json', 'etc/chalk-sfu/node.json',
                     'usr/local/sbin/chalk-sfu-window-boot', 'etc/systemd/system/chalk-sfu-window.service', 'run/window-seal'):
            self.assertIn(path, installed)
        manifest = json.loads(installed['etc/chalk-sfu/window-image.json'])
        self.assertEqual((manifest['environment'], manifest['revision'], manifest['image_id']), ('staging', REVISION, 'sha256:feedface'))
        self.assertIn('sha256:feedface', installed['etc/chalk-sfu/chalk-sfu.container.template'])
        self.assertNotIn(BUILDER, ''.join(installed.values()), 'the builder address must not be baked into the image')
        commands = self.read('ssh-commands')
        # The node is started by the same unit a clone uses, and proved announcing the builder's own address, before sealing.
        self.assertLess(commands.index('systemctl start chalk-sfu-window.service'), commands.index('bash /run/window-seal'))
        self.assertIn(f"grep -qx 'SFU_ANNOUNCE_IPS={BUILDER}'", commands)
        self.assertIn(f"bash /run/window-seal '{REVISION}' '{BUILDER}' '{OPERATOR}/32'", commands)
        for secret in ('server-cert', 'server-key', 'client-ca'):
            self.assertIn(f'podman secret create chalk-sfu-{secret} -', commands)
        self.assertNotIn('otlp', commands)
        doctl = self.read('doctl-calls')
        self.assertLess(doctl.index('droplet-action power-off 777'), doctl.index('droplet-action snapshot 777'))
        self.assertLess(doctl.index('droplet-action snapshot 777'), doctl.index('droplet delete -f 777'))
        docker = self.read('docker-calls')
        self.assertIn(f'SOURCE_REVISION={REVISION}', docker)
        record = json.loads((self.private / 'staging/window-image-99001.json').read_text())
        self.assertEqual((record['snapshot_id'], record['revision'], record['region']), ('99001', REVISION, 'sgp1'))
        self.assertIn('window-image verify staging 99001', result.stdout)

    def test_a_node_that_is_not_ready_or_on_another_revision_is_not_snapshotted(self):
        for change in ({'revision': 'f' * 40}, {'draining': True}, {'allocations': 3}, {'packetBudget': 1}):
            with self.subTest(change=change):
                (self.root / 'doctl-calls').unlink(missing_ok=True)
                result = self.build(MOCK_READY=json.dumps({**self.ready(), **change}))
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('droplet-action snapshot', self.read('doctl-calls'))
                self.assertIn('droplet delete -f 777', self.read('doctl-calls'))

    def test_verify_refuses_a_snapshot_that_is_not_this_environments_window_image(self):
        # The mocked doctl answers `snapshot get` with nothing a window image has; the clone and its firewall are never made.
        result = self.run_window('verify', 'staging', '99001', '--revision', REVISION)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('droplet create', self.read('doctl-calls'))


class WindowServerCertificateTest(unittest.TestCase):
    def test_the_window_certificate_has_its_own_key_and_passes_the_builds_check(self):
        help_text = subprocess.run(['openssl', 'verify', '-help'], capture_output=True, text=True)
        if 'verify_hostname' not in help_text.stdout + help_text.stderr:
            self.skipTest('this openssl cannot verify a host name')
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'CHALK_SFU_PRIVATE_DIR': directory}
            certs = str(INFRA / 'certs')
            for command in (['ca'], ['server'], ['window-server']):
                subprocess.run([certs, 'bench', *command], env=env, check=True, capture_output=True, timeout=60)
            bench = Path(directory) / 'bench'
            for name in ('server', 'window-server'):
                subprocess.run(['openssl', 'verify', '-CAfile', str(bench / 'ca.crt'), '-purpose', 'sslserver', '-verify_hostname', 'chalk-sfu', str(bench / f'{name}.crt')],
                               check=True, capture_output=True)
            self.assertNotEqual((bench / 'server.key').read_text(), (bench / 'window-server.key').read_text(), 'a leaked snapshot must not expose the static nodes key')
            pubkey = lambda name: subprocess.run(['openssl', 'x509', '-in', str(bench / f'{name}.crt'), '-noout', '-pubkey'], check=True, capture_output=True, text=True).stdout
            self.assertEqual(pubkey('window-server'), subprocess.run(['openssl', 'pkey', '-in', str(bench / 'window-server.key'), '-pubout'], check=True, capture_output=True, text=True).stdout)


class StaticChecks(unittest.TestCase):
    def test_boot_unit_and_scripts_are_consistent(self):
        unit = (INFRA / 'window-boot.service').read_text()
        self.assertIn('ExecStart=/usr/local/sbin/chalk-sfu-window-boot', unit)
        self.assertIn('Restart=on-failure', unit)
        seal = (INFRA / 'window-seal').read_text()
        # Everything the builder used to get in is on the seal's list.
        for word in ('authorized_keys', 'ssh_host_', 'mask ssh.service ssh.socket', 'cloud-init clean', 'operator.*', 'otlp-*', '50-cloud-init.yaml'):
            self.assertIn(word, seal)
        for script in ('window-image', 'window-seal'):
            subprocess.run(['bash', '-n', str(INFRA / script)], check=True)

    def test_the_node_never_opens_ssh_or_takes_a_key_from_user_data(self):
        for name in ('window-boot', 'window-boot.service'):
            text = (INFRA / name).read_text()
            self.assertNotRegex(text, r'user.data|userdata|authorized_keys|ssh', f'{name} must not read or open anything over SSH')


if __name__ == '__main__':
    unittest.main()
