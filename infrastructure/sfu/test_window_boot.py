"""Window node startup checks without cloud services."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from deploy_harness import INFRA, TABLE

REVISION = '0123456789abcdef0123456789abcdef01234567'


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


if __name__ == '__main__':
    unittest.main()
