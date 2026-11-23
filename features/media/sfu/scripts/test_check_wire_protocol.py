import subprocess
import unittest
from pathlib import Path

import check_wire_protocol as check

NODE = 'features/media/sfu/internal/media/offer.go'
CALLER_API = 'apps/api/internal/adapters/chalksfu/fleet.go'
CALLER_SDK = 'sdks/typescript/client/src/media/client.ts'
BUMP = '-const WireProtocol = 2\n+const WireProtocol = 3\n'


class VerdictTest(unittest.TestCase):
    def test_both_sides_changing_together_needs_a_decision(self):
        self.assertIn('Wire-Protocol: unchanged because', check.verdict([NODE, CALLER_SDK], '', ''))
        self.assertIn('Wire-Protocol: unchanged because', check.verdict([NODE, CALLER_API], '', 'fix(media): keep listen-only connected'))

    def test_raising_the_protocol_is_the_decision(self):
        self.assertIsNone(check.verdict([NODE, CALLER_SDK, check.PROTOCOL_FILE], BUMP, ''))

    def test_a_stated_reason_is_the_decision(self):
        self.assertIsNone(check.verdict([NODE, CALLER_SDK], '', 'x\n\nWire-Protocol: unchanged because the node still accepts the old offer\n'))

    def test_a_reason_must_say_something(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], '', 'Wire-Protocol: unchanged because '))
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], '', 'Wire-Protocol: unchanged'))

    def test_one_side_alone_needs_none(self):
        self.assertIsNone(check.verdict([NODE], '', ''))
        self.assertIsNone(check.verdict([CALLER_SDK, CALLER_API], '', ''))

    def test_tests_and_docs_do_not_count_as_a_side(self):
        self.assertIsNone(check.verdict([NODE, 'sdks/typescript/client/src/media/client.test.ts'], '', ''))
        self.assertIsNone(check.verdict(['features/media/sfu/internal/media/offer_test.go', CALLER_SDK], '', ''))
        self.assertIsNone(check.verdict([NODE, 'features/media/sfu/README.md', 'docs/media.md'], '', ''))

    def test_editing_a_comment_beside_the_constant_is_not_a_raise(self):
        self.assertIsNotNone(check.verdict([NODE, CALLER_SDK], '+// WireProtocol is the revision\n', ''))


class RepositoryTest(unittest.TestCase):
    """The same rule read from a real history, as the Gate runs it."""

    def test_issue_1514_shape_is_refused_and_a_decision_clears_it(self):
        import os
        import tempfile

        with tempfile.TemporaryDirectory() as name:
            root = Path(name)

            def git(*args):
                subprocess.run(['git', '-C', name, *args], check=True, capture_output=True)

            git('init', '-q', '-b', 'master')
            git('config', 'user.email', 'a@b.c')
            git('config', 'user.name', 'a')
            (root / check.PROTOCOL_FILE).parent.mkdir(parents=True)
            (root / check.PROTOCOL_FILE).write_text('const WireProtocol = 2\n')
            git('add', '-A')
            git('commit', '-q', '-m', 'base')
            git('checkout', '-q', '-b', 'change')
            for path in (NODE, CALLER_SDK):
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_text('x')
            git('add', '-A')
            git('commit', '-q', '-m', 'fix(media): keep listen-only Participants connected')
            cwd = os.getcwd()
            os.chdir(name)
            try:
                self.assertEqual(check.main(['check', 'master']), 1)
                git('commit', '-q', '--allow-empty', '-m', 'note\n\nWire-Protocol: unchanged because the node accepts both offers')
                self.assertEqual(check.main(['check', 'master']), 0)
            finally:
                os.chdir(cwd)


if __name__ == '__main__':
    unittest.main()
