import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import check_wire_protocol as check

NODE = 'features/media/sfu/internal/media/offer.go'
CALLER_API = 'apps/api/internal/adapters/chalksfu/fleet.go'
CALLER_SDK = 'sdks/typescript/client/src/media/client.ts'


class VerdictTest(unittest.TestCase):
    def test_both_sides_changing_together_needs_a_decision(self):
        self.assertIn('Wire-Protocol: unchanged because', check.verdict([NODE, CALLER_SDK], 2, 2, ''))
        self.assertIn('Wire-Protocol: unchanged because', check.verdict([NODE, CALLER_API], 2, 2, 'fix(media): keep listen-only connected'))

    def test_raising_the_protocol_is_the_decision(self):
        self.assertIsNone(check.verdict([NODE, CALLER_SDK, check.PROTOCOL_FILE], 2, 3, ''))

    def test_a_stated_reason_is_the_decision(self):
        self.assertIsNone(check.verdict([NODE, CALLER_SDK], 2, 2, 'x\n\nWire-Protocol: unchanged because the node still accepts the old offer\n'))

    def test_a_reason_must_say_something(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], 2, 2, 'Wire-Protocol: unchanged because '))
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], 2, 2, 'Wire-Protocol: unchanged'))

    def test_one_side_alone_needs_none(self):
        self.assertIsNone(check.verdict([NODE], 2, 2, ''))
        self.assertIsNone(check.verdict([CALLER_SDK, CALLER_API], 2, 2, ''))

    def test_tests_and_docs_do_not_count_as_a_side(self):
        self.assertIsNone(check.verdict([NODE, 'sdks/typescript/client/src/media/client.test.ts'], 2, 2, ''))
        self.assertIsNone(check.verdict(['features/media/sfu/internal/media/offer_test.go', CALLER_SDK], 2, 2, ''))
        self.assertIsNone(check.verdict([NODE, 'features/media/sfu/README.md', 'docs/media.md'], 2, 2, ''))

    def test_editing_the_protocol_file_without_raising_the_number_is_not_a_raise(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK, check.PROTOCOL_FILE], 2, 2, ''))


class RepositoryTest(unittest.TestCase):
    """The same rule read from a real history, started where the Gate starts it: inside features/media/sfu."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git('init', '-q', '-b', 'master')
        self.git('config', 'user.email', 'a@b.c')
        self.git('config', 'user.name', 'a')
        self.write(check.PROTOCOL_FILE, '// WireProtocol is the revision.\nconst WireProtocol = 2\n')
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

    def main(self):
        cwd = os.getcwd()
        os.chdir(self.root / 'features/media/sfu')
        try:
            return check.main(['check', 'master'])
        finally:
            os.chdir(cwd)

    def test_issue_1514_shape_is_refused_and_a_decision_clears_it(self):
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 1)
        self.commit('note\n\nWire-Protocol: unchanged because the node accepts both offers')
        self.assertEqual(self.main(), 0)

    def test_a_real_raise_is_accepted(self):
        self.write(check.PROTOCOL_FILE, '// WireProtocol is the revision.\nconst WireProtocol = 3\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 0)

    def test_a_comment_edit_is_not_a_raise(self):
        self.write(check.PROTOCOL_FILE, '// WireProtocol is the request-body revision.\nconst WireProtocol = 2\n')
        self.commit('fix(media): keep listen-only Participants connected')
        self.assertEqual(self.main(), 1)


if __name__ == '__main__':
    unittest.main()
