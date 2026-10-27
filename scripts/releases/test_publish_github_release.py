import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('publish_github_release.py')


class PublishReleaseTest(unittest.TestCase):
    def test_promotion_release_can_run_when_rollback_is_skipped(self):
        workflow = (SCRIPT.parents[2] / '.github/workflows/promote.yml').read_text()
        job = workflow.split('  github-release:\n', 1)[1]
        self.assertIn("if: ${{ !cancelled() && needs.result.result == 'success' }}", job)

    def test_channels_publish_verified_commit_and_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'config', 'user.email', 'test@example.com'], check=True)
            subprocess.run(['git', '-C', str(root), 'config', 'user.name', 'Test'], check=True)
            for title in ('baseline', 'visible change'):
                subprocess.run(['git', '-C', str(root), 'commit', '--allow-empty', '-qm', title], check=True)
                if title == 'baseline':
                    previous = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            target = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
            gh = root / 'gh'
            gh.write_text('#!/usr/bin/env python3\nimport json, os, sys\n'
                          'if sys.argv[1] == "api": print("[[]]")\n'
                          'else: open(os.environ["CAPTURE"], "w").write(json.dumps([sys.argv[1:], sys.stdin.read()]))\n')
            gh.chmod(0o755)
            for channel in ('nightly', 'production'):
                env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}', CAPTURE=str(root / 'capture'),
                           GITHUB_REPOSITORY='owner/repo', GITHUB_RUN_ID='123', RELEASE_CHANNEL=channel,
                           TARGET_SHA=target, PREVIOUS_SHA=previous)
                subprocess.run(['python3', str(SCRIPT)], cwd=root, env=env, check=True)
                args, notes = json.loads((root / 'capture').read_text())
                self.assertIn(f'{channel}-123', args)
                self.assertIn(target, args)
                self.assertEqual('--prerelease' in args, channel == 'nightly')
                self.assertIn('visible change', notes)
                self.assertNotIn('baseline (', notes)


if __name__ == '__main__':
    unittest.main()
