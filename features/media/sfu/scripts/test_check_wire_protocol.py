import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import check_wire_protocol as check

V = check.Versions
NODE = 'features/media/sfu/internal/media/offer.go'
CALLER_API = 'apps/api/internal/adapters/chalksfu/fleet.go'
CALLER_SDK = 'sdks/typescript/client/src/media/client.ts'
PROTOCOL = 'features/media/sfu/protocol/version.go'
PROTOCOL_PATH = f'{check.PROTOCOL_PACKAGE}/protocol.go'
FLEET_PATH = f'{check.ADAPTER_PACKAGE}/fleet.go'


class VerdictTest(unittest.TestCase):
    def test_both_sides_changing_together_needs_a_decision(self):
        self.assertIn('Wire-Protocol: unchanged because', check.verdict([NODE, CALLER_SDK], V(2, 2), V(2, 2), ''))
        self.assertIn('Wire-Protocol: unchanged because', check.verdict([NODE, CALLER_API], V(2, 2), V(2, 2), 'fix(media): keep listen-only connected'))

    def test_raising_the_protocol_is_the_decision(self):
        self.assertIsNone(check.verdict([NODE, CALLER_SDK, PROTOCOL], V(2, 2), V(3, 3), ''))

    def test_raising_the_node_protocol_without_the_api_minimum_is_not_the_decision(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK, PROTOCOL], V(2, 2), V(3, 2), ''))

    def test_a_stated_reason_is_the_decision(self):
        self.assertIsNone(check.verdict([NODE, CALLER_SDK], V(2, 2), V(2, 2), 'x\n\nWire-Protocol: unchanged because the node still accepts the old offer\n'))

    def test_a_reason_must_say_something(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], V(2, 2), V(2, 2), 'Wire-Protocol: unchanged because '))
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], V(2, 2), V(2, 2), 'Wire-Protocol: unchanged'))

    def test_one_side_alone_needs_none(self):
        self.assertIsNone(check.verdict([NODE], V(2, 2), V(2, 2), ''))
        self.assertIsNone(check.verdict([CALLER_SDK, CALLER_API], V(2, 2), V(2, 2), ''))

    def test_tests_and_docs_do_not_count_as_a_side(self):
        self.assertIsNone(check.verdict([NODE, 'sdks/typescript/client/src/media/client.test.ts'], V(2, 2), V(2, 2), ''))
        self.assertIsNone(check.verdict(['features/media/sfu/internal/media/offer_test.go', CALLER_SDK], V(2, 2), V(2, 2), ''))
        self.assertIsNone(check.verdict([NODE, 'features/media/sfu/README.md', 'docs/media.md'], V(2, 2), V(2, 2), ''))

    def test_the_refusal_names_the_packages_not_files(self):
        message = check.verdict([NODE, CALLER_SDK], V(2, 2), V(2, 2), '')
        self.assertIn(check.PROTOCOL_PACKAGE, message)
        self.assertIn(check.ADAPTER_PACKAGE, message)
        self.assertNotIn('.go', message.split('Raise')[1])

    def test_editing_the_protocol_file_without_raising_the_number_is_not_a_raise(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK, PROTOCOL], V(2, 2), V(2, 2), ''))


class RepositoryTest(unittest.TestCase):
    """The same rule read from a real history, started where the Gate starts it: inside features/media/sfu."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git('init', '-q', '-b', 'master')
        self.git('config', 'user.email', 'a@b.c')
        self.git('config', 'user.name', 'a')
        self.write(PROTOCOL_PATH, '// WireProtocol is the revision.\nconst WireProtocol = 2\n')
        self.write(FLEET_PATH, 'const (\n\tminNodeProtocol = 2\n)\n')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'base')
        self.git('checkout', '-q', '-b', 'change')
        self.write(NODE, 'x')
        self.write(CALLER_SDK, 'x')

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-q', '--allow-empty', '-m', message)

    def inside(self, call, *args):
        cwd = os.getcwd()
        os.chdir(self.root / 'features/media/sfu')
        try:
            return call(*args)
        finally:
            os.chdir(cwd)

    def main(self):
        return self.inside(check.main, ['check', 'master'])

    def number(self, package, pattern, name):
        return self.inside(check.number_at, 'HEAD', package, pattern, name)

    def test_issue_1514_shape_is_refused_and_a_decision_clears_it(self):
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 1)
        self.commit('note\n\nWire-Protocol: unchanged because the node accepts both offers')
        self.assertEqual(self.main(), 0)

    def test_a_real_raise_is_accepted(self):
        self.write(PROTOCOL_PATH, '// WireProtocol is the revision.\nconst WireProtocol = 3\n')
        self.write(FLEET_PATH, 'const (\n\tminNodeProtocol = 3\n)\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 0)

    def test_raising_the_node_alone_is_refused(self):
        self.write(PROTOCOL_PATH, '// WireProtocol is the revision.\nconst WireProtocol = 3\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 1)

    def test_a_constant_moved_between_files_is_still_read(self):
        (self.root / PROTOCOL_PATH).unlink()
        (self.root / FLEET_PATH).unlink()
        self.write(f'{check.PROTOCOL_PACKAGE}/version.go', '// WireProtocol is the revision.\nconst WireProtocol = 3\n')
        self.write(f'{check.ADAPTER_PACKAGE}/minimum.go', 'const (\n\tminNodeProtocol = 3\n)\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 0)

    def test_a_move_without_a_raise_is_still_refused(self):
        (self.root / PROTOCOL_PATH).unlink()
        self.write(f'{check.PROTOCOL_PACKAGE}/version.go', '// WireProtocol is the revision.\nconst WireProtocol = 2\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 1)

    def test_a_test_file_does_not_declare_the_constant(self):
        self.write(f'{check.PROTOCOL_PACKAGE}/protocol_test.go', 'const WireProtocol = 9\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.number(check.PROTOCOL_PACKAGE, check.PROTOCOL, 'WireProtocol'), 2)

    def test_a_constant_declared_twice_fails_loudly(self):
        self.write(f'{check.PROTOCOL_PACKAGE}/version.go', 'const WireProtocol = 3\n')
        self.commit('fix(media): keep listen-only Participants connected')
        with self.assertRaises(check.ConstantNotFound):
            self.number(check.PROTOCOL_PACKAGE, check.PROTOCOL, 'WireProtocol')
        self.assertEqual(self.main(), 1)

    def test_a_constant_declared_nowhere_fails_loudly(self):
        self.write(FLEET_PATH, 'const (\n)\n')
        self.commit('fix(media): keep listen-only Participants connected')
        with self.assertRaises(check.ConstantNotFound):
            self.number(check.ADAPTER_PACKAGE, check.MINIMUM, 'minNodeProtocol')
        self.assertEqual(self.main(), 1)

    def test_a_comment_edit_is_not_a_raise(self):
        self.write(PROTOCOL_PATH, '// WireProtocol is the request-body revision.\nconst WireProtocol = 2\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 1)


if __name__ == '__main__':
    unittest.main()
