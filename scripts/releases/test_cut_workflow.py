"""Cut planning, trust, release and transcription workflow contracts."""
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from datetime import datetime, timezone

from github_release import GitHub, first_cut_of_day
import proof_cover, release
from test_support import RUN, SHA

class PlanTests(unittest.TestCase):
    """`plan` cuts the revision the run started on, whatever master has become since."""
    OLD, REVISION, NEWER = 'a' * 40, 'c' * 40, 'd' * 40

    def plan(self, *, manual, github):
        with tempfile.TemporaryDirectory() as directory:
            output, summary = Path(directory, 'output'), Path(directory, 'summary')
            environment = {'GITHUB_SHA': self.REVISION, 'GITHUB_OUTPUT': str(output), 'GITHUB_STEP_SUMMARY': str(summary)}
            with patch.dict(os.environ, environment), \
                    patch.object(release, 'previous_production', return_value=dict(recorder_control=False)), \
                    patch.object(release, 'manifest_bytes', side_effect=ValueError('no baseline')):
                release.plan(github, SimpleNamespace(manual=manual))
            written = dict(line.split('=', 1) for line in output.read_text().splitlines())
            return written, summary.read_text() if summary.exists() else ''

    def github(self, *, records=(), newest_green=None, on_master=True):
        github = Mock()
        github.is_on_master.return_value = on_master
        github.newest_green_push_gate.return_value = newest_green
        github.has_green_gate.return_value = True
        github.cuts_on.return_value = []
        github.deployments.side_effect = lambda environment, task='nightly-cut': list(records) if task == 'nightly-cut' else []
        github.is_ancestor.side_effect = lambda sha, descendant: (sha, descendant) in {(self.OLD, self.REVISION), (self.OLD, self.NEWER), (self.REVISION, self.NEWER)}
        return github

    def test_a_manual_cut_ships_the_dispatched_revision_after_master_moved(self):
        github = self.github()
        written, _ = self.plan(manual=True, github=github)
        self.assertEqual((written['should_cut'], written['target_sha']), ('true', self.REVISION))
        github.reserve_cut.assert_called_once_with(self.REVISION)
        github.dispatch_nightly.assert_not_called()
        self.assertNotIn('git/ref/heads/master', [call.args[0] for call in github.request.call_args_list])

    def test_the_schedule_ships_the_newest_green_commit_at_or_before_the_revision(self):
        github = self.github(newest_green=self.OLD)
        written, _ = self.plan(manual=False, github=github)
        github.newest_green_push_gate.assert_called_once_with(self.REVISION)
        self.assertEqual((written['should_cut'], written['target_sha']), ('true', self.OLD))

    def test_a_cut_that_skips_the_recorder_proof_leaves_the_days_transcript_for_a_later_cut(self):
        previous = dict(payload=dict(target_sha=self.OLD, recorder_control=False))
        for changed in (False, True):
            with patch.object(release, 'held_candidates', return_value=[previous]), \
                    patch.object(release, 'recording_changed', return_value=changed):
                written, _ = self.plan(manual=True, github=self.github())
            self.assertEqual((written['recording_changed'], written['transcribe']), (str(changed).lower(),) * 2)

    def test_a_revision_older_than_the_newest_record_defers_without_a_requeue(self):
        newer = dict(id=1, sha=self.NEWER, created_at='2026-11-12T10:00:00Z', payload=dict(channel='nightly-cut', proof_result='passed', target_sha=self.NEWER))
        github = self.github(records=[newer])
        written, summary = self.plan(manual=True, github=github)
        self.assertEqual(written['should_cut'], 'false')
        self.assertIn(f'nightly already has the newer commit {self.NEWER}', summary)
        github.dispatch_nightly.assert_not_called()
        github.reserve_cut.assert_not_called()

    def test_a_revision_that_left_master_requeues_once_and_says_so(self):
        github = self.github(on_master=False)
        written, summary = self.plan(manual=True, github=github)
        self.assertEqual(written['should_cut'], 'false')
        github.dispatch_nightly.assert_called_once_with()
        self.assertIn('requeued on master as a new run', summary)

    def test_a_manual_cut_refuses_a_revision_without_a_green_gate_before_the_release_starts(self):
        # Nightly passes gate_checked to the release, so this refusal is the only Gate check a manual cut gets.
        github = self.github()
        github.has_green_gate.return_value = False
        with self.assertRaisesRegex(ValueError, 'is not successful'):
            self.plan(manual=True, github=github)
        github.has_green_gate.assert_called_with(self.REVISION)

    def test_the_green_commit_search_skips_commits_newer_than_the_revision(self):
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'Q9Labs/chalk'}):
            github = GitHub()
        runs = [dict(head_sha=self.NEWER), dict(head_sha=self.OLD)]
        github.request = Mock(return_value=dict(workflow_runs=runs))
        github.is_ancestor = Mock(side_effect=lambda sha, descendant: sha == self.OLD)
        github.is_on_master = Mock(return_value=True)
        github.has_green_gate = Mock(return_value=True)
        self.assertEqual(github.newest_landed_gate('event=merge_group', self.REVISION), dict(head_sha=self.OLD))

class ManifestTrustTests(unittest.TestCase):
    """A cut's manifest is read from its run only when a master workflow of this repository produced it."""
    INFO = dict(run_id=1, release_id='r1', target_sha=SHA, manifest_artifact_id=2)

    def read(self, **run):
        fields = dict(head_branch='master', head_repository=dict(full_name='Q9Labs/chalk'), path='.github/workflows/nightly.yml@refs/heads/master', event='push')
        github = Mock(spec=GitHub, repository='Q9Labs/chalk')
        github.request.return_value = {**fields, **run}
        github.artifact.return_value = json.dumps(dict(release_id='r1', source_revision=SHA)).encode()
        with patch.object(release, 'ancestor'):
            return release.manifest_bytes(github, self.INFO)

    def test_a_push_started_nightly_cut_is_trusted(self):
        self.assertIn(b'r1', self.read())

    def test_a_run_from_another_branch_event_or_workflow_is_refused(self):
        for run in (dict(head_branch='feature'), dict(event='pull_request'), dict(path='.github/workflows/other.yml@refs/heads/master'),
                    dict(head_repository=dict(full_name='fork/chalk'))):
            with self.subTest(run=run), self.assertRaisesRegex(ValueError, 'untrusted artifact-producing run'):
                self.read(**run)

class RecordingChangedTests(unittest.TestCase):
    """A nightly cut runs the recorder proof only when it changed a recording path."""
    def changed(self, *paths, returncode=0):
        diff = SimpleNamespace(returncode=returncode, stdout='\n'.join(paths))
        with patch.object(release.subprocess, 'run', return_value=diff):
            return release.recording_changed('a' * 40, 'b' * 40)

    def test_a_cut_with_no_baseline_or_no_readable_diff_runs_the_recorder_proof(self):
        self.assertTrue(release.recording_changed('', 'b' * 40))
        self.assertTrue(self.changed(returncode=128))

    def test_a_cut_that_touches_recording_paths_runs_the_recorder_proof(self):
        self.assertTrue(self.changed('apps/web/src/routes/index.tsx', 'infrastructure/recorder/main.tf'))
        self.assertTrue(self.changed('apps/api/internal/recorderfleet/pool.go'))
        self.assertTrue(self.changed('scripts/releases/media.py'))

    def test_a_cut_that_touches_nothing_recorded_skips_it(self):
        self.assertFalse(self.changed('apps/web/src/routes/index.tsx', 'apps/api/internal/recorderfleetx/x.go', 'docs/recording-notes.md'))
        self.assertFalse(self.changed())

    def test_every_recording_path_exists(self):
        for path in proof_cover.recording_paths():
            self.assertTrue((release.ROOT / path).exists(), path)

class GateCheckedTests(unittest.TestCase):
    """The release skips its own Gate check only when nightly `plan` already made it for the same target."""
    WORKFLOWS = Path(release.ROOT) / '.github/workflows'

    def test_only_nightly_sets_gate_checked_and_a_dispatch_cannot(self):
        users = sorted(path.name for path in self.WORKFLOWS.glob('*.yml') if 'gate_checked' in path.read_text())
        self.assertEqual(users, ['ci.yml', 'nightly.yml'])
        self.assertRegex((self.WORKFLOWS / 'nightly.yml').read_text(), r'(?m)^      gate_checked: true$')
        ci = (self.WORKFLOWS / 'ci.yml').read_text()
        self.assertEqual(ci.count('gate_checked:'), 1)
        self.assertGreater(ci.index('gate_checked:'), ci.index('\n  workflow_call:'))

    def test_the_release_job_that_repeats_the_check_is_the_only_one_skipped(self):
        ci = (self.WORKFLOWS / 'ci.yml').read_text()
        job = ci[ci.index('\n  require-gate:'):ci.index('\n  plan-managed:')]
        self.assertIn('if: ${{ !inputs.gate_checked }}', job)
        for name in ('plan-managed', 'build-web'):
            start = ci.index(f'\n  {name}:')
            block = ci[start:ci.index('\n    runs-on:', start)]
            self.assertIn('needs: require-gate', block)
            self.assertIn("""contains(fromJSON('["success","skipped"]'), needs.require-gate.result)""", block)

    def test_every_job_below_the_skipped_check_runs_on_a_status_function(self):
        # Without always() or !cancelled(), a skipped ancestor skips a job even when the job's direct needs succeeded.
        ci = (self.WORKFLOWS / 'ci.yml').read_text()
        jobs = ci[ci.index('\njobs:\n'):]
        bodies = dict(re.findall(r'(?ms)^  ([a-z][a-z0-9-]*):\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)', jobs))
        needs = {}
        for name, body in bodies.items():
            found = re.search(r'(?m)^    needs: (.+)$', body)
            needs[name] = re.findall(r'[a-z][a-z0-9-]*', found.group(1)) if found else []
        below, frontier = set(), {'require-gate'}
        while frontier:
            frontier = {name for name, parents in needs.items() if name not in below and frontier & set(parents)}
            below |= frontier
        self.assertTrue({'plan-managed', 'check-managed-contracts', 'build-media', 'publish-managed-manifest', 'build-web', 'deploy-web'} <= below)
        for name in sorted(below):
            condition = re.search(r'(?m)^    if: .*(?:\n {6,}.*)*', bodies[name])
            self.assertIsNotNone(condition, name)
            self.assertRegex(condition.group(0), r'always\(\)|!cancelled\(\)', name)

    def test_nightly_releases_exactly_the_target_its_plan_checked(self):
        nightly = (self.WORKFLOWS / 'nightly.yml').read_text()
        job = nightly[nightly.index('\n  release:'):nightly.index('\n  proof:')]
        self.assertIn('needs: plan', job)
        self.assertIn('target_sha: ${{ needs.plan.outputs.target_sha }}', job)
        self.assertIn('release.py plan', nightly)

class TranscribeOncePerDayTests(unittest.TestCase):
    NOW = datetime(2026, 11, 10, 14, 0, tzinfo=timezone.utc)

    @staticmethod
    def record(channel, created_at, proof_result='passed', transcribed=True):
        return dict(id=1, created_at=created_at, payload=dict(channel=channel, proof_result=proof_result, transcribed=transcribed))

    def test_the_first_cut_of_a_utc_day_transcribes(self):
        yesterday = self.record('nightly-cut', '2026-11-09T23:59:00Z')
        self.assertTrue(first_cut_of_day([], self.NOW))
        self.assertTrue(first_cut_of_day([yesterday], self.NOW))

    def test_a_later_cut_after_a_passed_cut_the_same_day_does_not(self):
        self.assertFalse(first_cut_of_day([self.record('nightly-cut', '2026-11-10T01:00:00Z')], self.NOW))

    def test_an_attempt_or_failed_cut_does_not_use_up_the_days_transcript(self):
        attempt = self.record('nightly-attempt', '2026-11-10T01:00:00Z')
        failed = self.record('nightly-cut', '2026-11-10T02:00:00Z', proof_result='failed')
        self.assertTrue(first_cut_of_day([attempt, failed], self.NOW))

    def test_a_cut_that_did_not_check_a_transcript_does_not_use_up_the_day(self):
        # A cut planned late the day before finishes after midnight; it was recorded today but never paid for a Transcript.
        skipped = self.record('nightly-cut', '2026-11-10T00:05:00Z', transcribed=False)
        self.assertTrue(first_cut_of_day([skipped], self.NOW))

    def test_a_transcribing_cut_counts_when_a_later_cut_the_same_day_did_not(self):
        # `deployments` returns only the newest passed cut, so the day's cuts come from `cuts_on`.
        newest = dict(id=3, created_at='2026-11-10T09:00:00Z', payload=dict(channel='nightly-cut', proof_result='passed', transcribed=False))
        earlier = dict(id=2, created_at='2026-11-10T03:00:00Z', payload=dict(channel='nightly-cut', proof_result='passed', transcribed=True))
        yesterday = dict(id=1, created_at='2026-11-09T22:00:00Z', payload=dict(channel='nightly-cut', proof_result='passed', transcribed=True))
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'Q9Labs/chalk'}):
            github = GitHub()
        statuses = {3: 'success', 2: 'success', 1: 'success'}
        github.request = Mock(side_effect=lambda route: [dict(state=statuses[int(route.split('/')[1])])] if route.startswith('deployments/') else [newest, earlier, yesterday])
        cuts = github.cuts_on(self.NOW.date())
        self.assertEqual([item['id'] for item in cuts], [3, 2])
        self.assertFalse(first_cut_of_day(cuts, self.NOW))

    def test_a_cut_without_a_final_status_does_not_count(self):
        # `record` creates the deployment before it posts the final status; a failure in between leaves it pending.
        unfinished = dict(id=2, created_at='2026-11-10T03:00:00Z', payload=dict(channel='nightly-cut', proof_result='passed', transcribed=True))
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'Q9Labs/chalk'}):
            github = GitHub()
        github.request = Mock(side_effect=lambda route: [] if route.startswith('deployments/') else [unfinished])
        self.assertEqual(github.cuts_on(self.NOW.date()), [])
        self.assertTrue(first_cut_of_day(github.cuts_on(self.NOW.date()), self.NOW))

    def test_a_manual_cut_always_transcribes(self):
        self.assertTrue(first_cut_of_day([self.record('nightly-cut', '2026-11-10T01:00:00Z')], self.NOW, manual=True))

class PromoteReusesCutTests(unittest.TestCase):
    """Promote deploys the images, media and web bundles that the cut built and proved; it builds nothing again."""

    def job(self, workflow, name):
        text = (release.ROOT / '.github/workflows' / workflow).read_text()
        start = text.index(f'\n  {name}:\n')
        following = re.search(r'\n  [A-Za-z0-9_-]+:\n', text[start + 1:])
        return text[start:start + 1 + following.start() if following else len(text)]

    def test_promote_hands_the_cut_run_to_release(self):
        selection = 'fromJSON(needs.select.outputs.selection)'
        inputs = {
            'manifest_run_id': f'{selection}.selection.run_id',
            'manifest_artifact_id': f'{selection}.selection.manifest_artifact_id',
            'manifest_sha256': f'{selection}.selection.manifest_sha256',
            'reuse_release_id': f'{selection}.selection.release_id',
            'media_sha256': f'{selection}.selection.media_sha256',
            'web_artifact': f'toJSON({selection}.selection.web.production)',
        }
        block = self.job('promote.yml', 'release')
        for key, expression in inputs.items():
            self.assertIn(f'\n      {key}: ${{{{ {expression} }}}}\n', block, key)

    def test_every_build_root_skips_when_a_cut_run_is_reused(self):
        # build-managed-images, merge-managed-images and build-media need plan-managed's outputs, so they skip with it.
        for name in ('plan-managed', 'build-web'):
            self.assertIn("inputs.manifest_run_id == ''", self.job('ci.yml', name).split('runs-on:', 1)[0], name)
        for name in ('build-managed-images', 'merge-managed-images', 'build-media'):
            self.assertIn("needs.plan-managed.outputs.should_publish == 'true'", self.job('ci.yml', name).split('runs-on:', 1)[0], name)

    def test_reuse_skips_the_gate_wait(self):
        with patch.dict(os.environ, {'MANIFEST_RUN_ID': RUN, 'DEPLOY_MANAGED': 'true', 'DEPLOY_WEB': 'true'}):
            self.assertFalse(release.builds_fresh_artifacts())
