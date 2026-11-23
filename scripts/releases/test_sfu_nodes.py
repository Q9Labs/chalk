import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import sfu_nodes
from sfu_nodes import NodeError


def git(root, *args):
    return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True, check=True).stdout.strip()


class Repository:
    """A history shaped like master: commits that touch the SFU source between commits that do not."""

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        git(self.root, 'init', '-q', '-b', 'master')
        git(self.root, 'config', 'user.email', 'test@example.com')
        git(self.root, 'config', 'user.name', 'test')
        (self.root / 'apps/api/internal/adapters/chalksfu').mkdir(parents=True)
        (self.root / 'features/media/sfu').mkdir(parents=True)
        self.n = 0

    def commit(self, path, text=None):
        self.n += 1
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text if text is not None else f'change {self.n}\n')
        git(self.root, 'add', '-A')
        git(self.root, 'commit', '-q', '-m', f'change {self.n}')
        return git(self.root, 'rev-parse', 'HEAD')

    def sfu(self):
        return self.commit('features/media/sfu/internal/offer.go')

    def other(self):
        return self.commit('apps/web/page.ts')

    def fleet(self, minimum):
        return self.commit(sfu_nodes.FLEET_SOURCE, f'const (\n\tminNodeProtocol = {minimum}\n)\n')


class AssessTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Repository(directory.name)
        self.fleet = self.repo.fleet(2)
        self.old_sfu = self.repo.sfu()
        self.unrelated = self.repo.other()
        self.new_sfu = self.repo.sfu()
        self.head = self.repo.other()

    def current(self, revision, protocol=2, source=None, minimum=2, **ready):
        verdict = sfu_nodes.assess(self.repo.root, source or self.new_sfu, minimum, {'revision': revision, 'protocol': protocol, **ready})
        return verdict.current

    def test_the_release_source_is_the_last_commit_that_touched_the_sfu(self):
        self.assertEqual(sfu_nodes.source_commit(self.repo.root, self.head), self.new_sfu)
        self.assertEqual(sfu_nodes.source_commit(self.repo.root, self.unrelated), self.old_sfu)

    def test_a_node_built_before_the_source_is_behind(self):
        self.assertFalse(self.current(self.old_sfu))
        self.assertFalse(self.current(self.unrelated))

    def test_a_node_built_at_or_after_the_source_is_current(self):
        self.assertTrue(self.current(self.new_sfu))
        self.assertTrue(self.current(self.head))

    def test_an_unrelated_release_does_not_ask_for_a_node_deploy(self):
        later_unrelated = self.repo.other()
        self.assertTrue(self.current(self.new_sfu, source=sfu_nodes.source_commit(self.repo.root, later_unrelated)))

    def test_a_node_newer_than_the_release_stays_for_a_rollback(self):
        rollback_source = sfu_nodes.source_commit(self.repo.root, self.unrelated)
        self.assertTrue(self.current(self.head, source=rollback_source))

    def test_a_build_that_is_not_a_commit_here_is_behind(self):
        self.assertFalse(self.current('dev'))
        self.assertFalse(self.current(''))
        self.assertFalse(self.current('f' * 40))

    def test_a_node_below_the_release_protocol_is_behind_even_at_the_right_commit(self):
        self.assertFalse(self.current(self.head, protocol=1))
        self.assertFalse(self.current(self.head, protocol=0, minimum=1))
        self.assertTrue(self.current(self.head, protocol=3, minimum=3))

    def test_minimum_protocol_is_read_from_the_target(self):
        self.assertEqual(sfu_nodes.minimum_protocol(self.repo.root, self.head), 2)
        raised = self.repo.fleet(3)
        self.assertEqual(sfu_nodes.minimum_protocol(self.repo.root, raised), 3)
        self.assertEqual(sfu_nodes.minimum_protocol(self.repo.root, self.head), 2)


class RunTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.repo = Repository(self.root / 'repo')
        self.repo.fleet(2)
        self.old = self.repo.sfu()
        self.new = self.repo.sfu()
        self.head = self.repo.other()
        self.private = self.root / 'private'
        self.private.mkdir()
        self.state = self.root / 'state'
        self.state.mkdir()
        self.calls = self.root / 'calls'
        # The fake readyz reads the node's state from a file; the fake deploy records the call and, unless told to fail, moves the node to the release.
        self.readyz = self.script('readyz', f'#!/bin/sh\nf={self.state}/"$2"\n[ -f "$f" ] || {{ echo "tunnel closed" >&2; exit 1; }}\ncat "$f"\n')
        self.deploy = self.script(
            'deploy',
            f'#!/bin/sh\necho "$@" >> {self.calls}\n[ -f {self.state}/fail-deploy ] && exit 7\n[ -f {self.state}/stuck ] && exit 0\n'
            f'printf \'{{"revision":"{self.head}","protocol":2}}\' > {self.state}/"$2"\n',
        )

    def script(self, name, body):
        path = self.root / name
        path.write_text(body)
        path.chmod(0o755)
        return str(path)

    def node(self, address, revision, protocol=2):
        (self.state / address).write_text(json.dumps({'revision': revision, 'protocol': protocol}))

    def nodes(self, text):
        (self.private / 'nodes').write_text(text)

    def run_command(self, command, **options):
        return sfu_nodes.run(command, 'production', self.head, repository=self.repo.root, directory=self.private, readyz=self.readyz, deploy=self.deploy, **options)

    def deployed(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def test_only_the_node_that_is_behind_is_deployed_and_the_primary_goes_first(self):
        self.nodes('# primary first\n10.0.0.1\n10.0.0.2  # standby\n10.0.0.3\n')
        self.node('10.0.0.1', self.old)
        self.node('10.0.0.2', self.new)
        self.node('10.0.0.3', 'dev')
        lines = self.run_command('deploy')
        self.assertEqual(self.deployed(), ['production 10.0.0.1', 'production 10.0.0.3'])
        self.assertIn('node 2: current', '\n'.join(lines))
        self.assertNotIn('10.0.0', '\n'.join(lines))
        self.assertEqual(sum('deploying' in line for line in lines), 2)

    def test_a_release_whose_nodes_are_current_deploys_nothing(self):
        self.nodes('10.0.0.1\n')
        self.node('10.0.0.1', self.head)
        self.run_command('deploy')
        self.assertEqual(self.deployed(), [])

    def test_check_reads_every_node_and_deploys_nothing(self):
        self.nodes('10.0.0.1\n10.0.0.2\n')
        self.node('10.0.0.1', self.old)
        self.node('10.0.0.2', self.old)
        lines = self.run_command('check')
        self.assertEqual(self.deployed(), [])
        self.assertEqual(sum('behind' in line for line in lines), 2)

    def test_force_restarts_without_waiting_for_calls(self):
        self.nodes('10.0.0.1\n')
        self.node('10.0.0.1', self.old)
        self.run_command('deploy', force=True)
        self.assertEqual(self.deployed(), ['production 10.0.0.1 --force'])

    def test_an_unreadable_node_fails_before_any_deploy_that_follows_it(self):
        self.nodes('10.0.0.1\n10.0.0.2\n')
        self.node('10.0.0.2', self.old)
        with self.assertRaisesRegex(NodeError, r'node 1: cannot read /readyz .*tunnel closed'):
            self.run_command('deploy')
        self.assertEqual(self.deployed(), [])

    def test_a_failed_node_deploy_stops_the_run_so_the_api_does_not_follow(self):
        self.nodes('10.0.0.1\n10.0.0.2\n')
        self.node('10.0.0.1', self.old)
        self.node('10.0.0.2', self.old)
        (self.state / 'fail-deploy').write_text('')
        with self.assertRaisesRegex(NodeError, r'node 1: deploy failed \(7\)'):
            self.run_command('deploy')
        self.assertEqual(self.deployed(), ['production 10.0.0.1'])

    def test_a_node_that_is_still_behind_after_its_deploy_fails_the_run(self):
        self.nodes('10.0.0.1\n')
        self.node('10.0.0.1', self.old)
        (self.state / 'stuck').write_text('')
        with self.assertRaisesRegex(NodeError, r'still behind after the deploy'):
            self.run_command('deploy')

    def test_a_missing_or_empty_node_list_fails(self):
        with self.assertRaisesRegex(NodeError, 'no node list'):
            self.run_command('deploy')
        self.nodes('# nothing\n')
        with self.assertRaisesRegex(NodeError, 'lists no node'):
            self.run_command('deploy')

    def test_a_node_that_does_not_answer_with_json_fails(self):
        self.nodes('10.0.0.1\n')
        (self.state / '10.0.0.1').write_text('<html>')
        with self.assertRaisesRegex(NodeError, 'not JSON'):
            self.run_command('check')


class CertificateTest(unittest.TestCase):
    def issue(self, directory, name, days):
        subprocess.run(
            ['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=test', '-days', str(days), '-keyout', os.devnull, '-out', str(directory / name)],
            check=True,
            capture_output=True,
        )

    def test_a_certificate_close_to_expiry_refuses_with_the_command_that_fixes_it(self):
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            self.issue(directory, 'operator.crt', 30)
            self.issue(directory, 'server.crt', 90)
            sfu_nodes.check_certificates(directory)
            self.issue(directory, 'operator.crt', 1)
            with self.assertRaisesRegex(NodeError, r'operator\.crt expires within 3 days.*ci-secret publish'):
                sfu_nodes.check_certificates(directory)
            self.issue(directory, 'operator.crt', 30)
            (directory / 'server.crt').unlink()
            with self.assertRaisesRegex(NodeError, r'missing .*server\.crt'):
                sfu_nodes.check_certificates(directory)


class BundleTest(unittest.TestCase):
    CI_SECRET = Path(sfu_nodes.SFU_DIRECTORY) / 'ci-secret'

    def bundle(self, directory, names):
        for name in names:
            (directory / name).write_text(name)
        packed = subprocess.run(f'tar -czf - -C {directory} . | base64 | tr -d "\\n"', shell=True, capture_output=True, text=True, check=True)
        return packed.stdout

    def unpack(self, value, destination):
        return subprocess.run([str(self.CI_SECRET), 'unpack', 'production', str(destination)], env={**os.environ, 'CHALK_SFU_DEPLOY_BUNDLE': value}, capture_output=True, text=True)

    def test_unpack_writes_the_files_deploy_reads_with_private_modes(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source = root / 'source'
            source.mkdir()
            names = ['ca.crt', 'server.crt', 'server.key', 'operator.crt', 'operator.key', 'known_hosts', 'nodes', 'ssh_key', 'otlp-headers']
            result = self.unpack(self.bundle(source, names), root / 'out')
            self.assertEqual(result.returncode, 0, result.stderr)
            for file in names:
                self.assertEqual((root / 'out' / 'production' / file).read_text(), file)
            self.assertEqual((root / 'out' / 'production' / 'ssh_key').stat().st_mode & 0o077, 0)

    def test_unpack_names_the_missing_file_and_the_command_that_fixes_it(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            source = root / 'source'
            source.mkdir()
            result = self.unpack(self.bundle(source, ['ca.crt', 'server.crt', 'server.key', 'operator.crt', 'operator.key', 'known_hosts', 'ssh_key']), root / 'out')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('lacks nodes', result.stderr)
            self.assertIn('ci-secret publish production', result.stderr)

    def test_an_empty_secret_fails_with_the_command_that_fixes_it(self):
        with tempfile.TemporaryDirectory() as name:
            result = self.unpack('', Path(name))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ci-secret publish production', result.stderr)


if __name__ == '__main__':
    unittest.main()
