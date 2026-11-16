"""Nightly scorecard history and failure handling."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from test_support import PromotionTestCase, RUN, SHA
import release

class NightlyHistoryTests(PromotionTestCase):
    """Gated and warn-only runs keep distinct history semantics."""
    def test_nightly_returns_breach_status_after_saving_history(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
        for passing in (False, True):
            with self.subTest(passing=passing), tempfile.TemporaryDirectory() as directory:
                directory = Path(directory)
                remote = directory / 'history.git'
                subprocess.run(['git', 'init', '--bare', '--quiet', str(remote)], check=True)
                bin_dir = directory / 'bin'
                bin_dir.mkdir()
                gh = bin_dir / 'gh'
                gh.write_text('#!/bin/sh\nexit 0\n')
                gh.chmod(0o755)
                card = copy.deepcopy(fixture)
                if passing:
                    for metric in card['metrics']:
                        metric['p95'] = 100
                path = directory / 'card.json'
                path.write_text(json.dumps(card))
                environment = {**os.environ, 'PATH': f'{bin_dir}{os.pathsep}{os.environ["PATH"]}',
                               'SCORECARD_HISTORY_REMOTE': str(remote), 'GITHUB_REPOSITORY': 'Q9Labs/chalk',
                               'GITHUB_SERVER_URL': 'https://github.com', 'GITHUB_RUN_ID': RUN,
                               'GITHUB_STEP_SUMMARY': str(directory / 'summary'), 'GIT_CONFIG_GLOBAL': os.devnull,
                               'GIT_CONFIG_NOSYSTEM': '1'}
                result = subprocess.run(['bash', 'features/scorecard/nightly.sh', str(path)], cwd=release.ROOT,
                                        env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if passing else 1, result.stderr)
                saved = subprocess.check_output(['git', '--git-dir', str(remote), 'show',
                                                 'scorecard-history:history.jsonl'], text=True)
                self.assertEqual(json.loads(saved)['run']['commit'], SHA)

    def run_nightly(self, directory, warn_only, reject_push=False):
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
        remote = directory / 'history.git'
        subprocess.run(['git', 'init', '--bare', '--quiet', str(remote)], check=True)
        if reject_push:
            hook = remote / 'hooks/pre-receive'
            hook.write_text('#!/bin/sh\necho rejected >&2\nexit 1\n')
            hook.chmod(0o755)
        bin_dir = directory / 'bin'
        bin_dir.mkdir()
        calls = directory / 'gh-calls'
        gh = bin_dir / 'gh'
        gh.write_text(f'#!/bin/sh\necho "$@" >> {calls}\nexit 0\n')
        gh.chmod(0o755)
        path = directory / 'card.json'
        path.write_text(json.dumps(fixture))
        environment = {**os.environ, 'PATH': f'{bin_dir}{os.pathsep}{os.environ["PATH"]}',
                       'SCORECARD_HISTORY_REMOTE': str(remote), 'GITHUB_REPOSITORY': 'Q9Labs/chalk',
                       'GITHUB_SERVER_URL': 'https://github.com', 'GITHUB_RUN_ID': RUN,
                       'GITHUB_STEP_SUMMARY': str(directory / 'summary'), 'GIT_CONFIG_GLOBAL': os.devnull,
                       'GIT_CONFIG_NOSYSTEM': '1'}
        if warn_only:
            environment['SCORECARD_WARN_ONLY'] = 'true'
        result = subprocess.run(['bash', 'features/scorecard/nightly.sh', str(path)], cwd=release.ROOT,
                                env=environment, capture_output=True, text=True)
        return result, remote, calls

    def test_warn_only_nightly_saves_history_and_never_touches_the_issue(self):
        with tempfile.TemporaryDirectory() as directory:
            result, remote, calls = self.run_nightly(Path(directory), warn_only=True)
            # Warn-only still turns the calling job red while a gated metric is over its budget (nightly.sh, #1201).
            self.assertEqual(result.returncode, 1, result.stderr)
            saved = subprocess.check_output(['git', '--git-dir', str(remote), 'show',
                                             'scorecard-history:history.jsonl'], text=True)
            self.assertEqual(json.loads(saved)['run']['commit'], SHA)
            self.assertFalse(calls.exists(), 'a warn-only run must not call gh')

    def test_warn_only_nightly_exits_zero_when_the_history_push_is_always_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _, calls = self.run_nightly(Path(directory), warn_only=True, reject_push=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Could not push the scorecard history.', result.stderr)
            self.assertFalse(calls.exists(), 'a warn-only run must not call gh')

    def test_gated_nightly_still_fails_when_the_history_push_is_always_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            result, _, _ = self.run_nightly(Path(directory), warn_only=False, reject_push=True)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn('Could not push the scorecard history.', result.stderr)
