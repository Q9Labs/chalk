"""The hotfix path must refuse what is not on master, ungated or backwards, and the rehearsal must see a failed rollback."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import hotfix
import rehearsal
import release

SHA = 'a' * 40
BASE = 'b' * 40
BASELINE = dict(run_id='7', target_sha=BASE, release_id='managed-base', manifest_artifact_id='8', manifest_sha256='c' * 64, media_sha256='')


class Files(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.summary = Path(directory.name, 'summary')
        self.output = Path(directory.name, 'output')
        self.enterContext(patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': str(self.summary), 'GITHUB_OUTPUT': str(self.output)}, clear=False))


class RequireGate(Files):
    def run_gate(self, ref, on_master):
        github = Mock(**{'is_on_master.return_value': on_master, 'has_green_gate.return_value': True})
        environment = dict(GITHUB_REF=ref, TARGET_SHA=SHA, RELEASE_MANAGED='true', DEPLOY_MANAGED='true', GITHUB_EVENT_NAME='workflow_dispatch')
        with patch.dict(os.environ, environment):
            release.require_gate(github, None)
        return github

    def test_a_branch_workflow_revision_is_refused_even_when_reusing_artifacts(self):
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/fix'}), self.assertRaisesRegex(ValueError, 'from master'):
            release.require_gate(Mock(), None)

    def test_a_target_off_master_is_refused_before_the_gate_is_read(self):
        with self.assertRaisesRegex(ValueError, 'not on master'):
            self.run_gate('refs/heads/master', False)

    def test_a_master_target_with_a_green_gate_passes(self):
        self.run_gate('refs/heads/master', True).wait_for_gate.assert_called_once()


class Plan(Files):
    def run_plan(self, sha=SHA, environment='production', force='false', ref='refs/heads/master', on_master=True, green=True, baseline=BASELINE, ancestry=True):
        github = Mock(**{'is_on_master.return_value': on_master, 'has_green_gate.return_value': green})
        variables = dict(HOTFIX_SHA=sha, HOTFIX_ENVIRONMENT=environment, FORCE_SMOKE_FAILURE=force, GITHUB_REF=ref)
        failure = None if ancestry else subprocess.CalledProcessError(1, 'git')
        with patch.dict(os.environ, variables), patch.object(hotfix, 'baseline_for', return_value=baseline), \
                patch.object(hotfix, 'ancestor', side_effect=failure):
            hotfix.plan(github, None)
        return github

    def test_it_names_the_rollback_baseline(self):
        self.run_plan()
        self.assertIn(json.dumps(BASELINE), self.output.read_text())

    def test_each_refusal(self):
        cases = (
            (dict(sha='abc'), 'full lowercase'),
            (dict(ref='refs/heads/fix'), 'from master'),
            (dict(force='true'), 'only on nightly'),
            (dict(on_master=False), 'not on master'),
            (dict(green=False), 'no successful push Gate'),
            (dict(baseline={**BASELINE, 'target_sha': SHA}), 'already runs'),
            (dict(ancestry=False), 'only moves forward'),
        )
        for changes, message in cases:
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                self.run_plan(**changes)

    def test_a_forced_smoke_failure_is_allowed_on_nightly(self):
        self.run_plan(environment='nightly', force='true')


class Verdict(Files):
    def judge(self, **changes):
        variables = dict(BASELINE=json.dumps(BASELINE), HOTFIX_SHA=SHA, HOTFIX_ENVIRONMENT='production', RELEASE_RESULT='success',
                         SMOKE_RESULT='success', SMOKE_OUTCOME='passed', ROLLBACK_RESULT='skipped', ROLLBACK='{}', PAGES_ID='pages-1',
                         APPLIED_RELEASE='managed-new')
        variables.update(changes)
        with patch.dict(os.environ, variables):
            try:
                hotfix.verdict(Mock(), None)
            except SystemExit as exit:
                return str(exit)
        return None

    def test_a_passing_smoke_ships(self):
        self.assertIsNone(self.judge())
        self.assertIn('HOTFIX LIVE', self.summary.read_text())

    def test_a_failed_smoke_with_a_verified_rollback_stays_red(self):
        rollback = dict(restored_source_release_id='managed-base', release_id='r', applied_release_id='r', pages_deployment_id='pages-1')
        self.assertIsNotNone(self.judge(SMOKE_OUTCOME='failed', ROLLBACK_RESULT='success', ROLLBACK=json.dumps(rollback)))
        self.assertIn('ROLLBACK VERIFIED', self.summary.read_text())

    def test_a_rollback_to_another_release_is_not_verified(self):
        rollback = dict(restored_source_release_id='managed-other', release_id='r', applied_release_id='r', pages_deployment_id='pages-1')
        self.assertIsNotNone(self.judge(SMOKE_OUTCOME='failed', ROLLBACK_RESULT='success', ROLLBACK=json.dumps(rollback)))
        self.assertIn('ROLLBACK NOT VERIFIED', self.summary.read_text())

    def test_a_release_that_never_reached_the_host_says_so(self):
        self.assertIsNotNone(self.judge(RELEASE_RESULT='failure', SMOKE_RESULT='skipped', SMOKE_OUTCOME='', APPLIED_RELEASE=''))
        self.assertIn('HOTFIX NOT DEPLOYED', self.summary.read_text())


class Rehearsal(Files):
    def cut(self, release_id, proof='passed'):
        return dict(channel='nightly-cut', proof_result=proof, release_id=release_id, target_sha=release_id[0] * 40, run_id='1',
                    manifest_artifact_id='2', manifest_sha256='d' * 64)

    def github(self, *cuts):
        items = [dict(id=index, payload=cut) for index, cut in enumerate(cuts)]
        github = Mock()
        github.request.side_effect = lambda route, data=None: items if route.startswith('deployments?') else [dict(state='inactive'), dict(state='success')]
        return github

    def test_it_takes_the_two_newest_passed_cuts_and_skips_a_failed_one(self):
        github = self.github(self.cut('x-new'), self.cut('y-failed', 'failed'), self.cut('z-old'))
        self.assertEqual([cut['release_id'] for cut in rehearsal.passed_cuts(github, 2)], ['x-new', 'z-old'])

    def test_one_passed_cut_is_not_enough(self):
        with patch.object(rehearsal, 'manifest_bytes'), self.assertRaisesRegex(ValueError, 'two nightly cuts'):
            rehearsal.plan(self.github(self.cut('x-new')), None)

    def judge(self, rollback_source):
        current, previous = self.cut('x-new'), self.cut('z-old')
        leg = lambda source: json.dumps(dict(restored_source_release_id=source, release_id='fresh', applied_release_id='fresh'))
        variables = dict(CURRENT=json.dumps(current), PREVIOUS=json.dumps(previous), BASELINE=leg('x-new'), ROLLBACK=leg(rollback_source), FORWARD=leg('x-new'))
        with patch.dict(os.environ, variables):
            rehearsal.verdict(Mock(), None)

    def test_three_legs_on_their_own_sources_pass(self):
        self.judge('z-old')
        self.assertIn('passed', self.summary.read_text())

    def test_a_rollback_that_applied_another_release_fails_loudly(self):
        with self.assertRaisesRegex(SystemExit, 'roll back'):
            self.judge('x-new')


if __name__ == '__main__':
    unittest.main()
