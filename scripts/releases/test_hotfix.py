"""The hotfix path must refuse what is not on master, ungated or backwards, and the rehearsal must see a failed rollback."""

import json
import os
import re
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
    def run_plan(self, sha=SHA, environment='production', ref='refs/heads/master', on_master=True, green=True, baseline=BASELINE, ancestry=True):
        github = Mock(**{'is_on_master.return_value': on_master, 'has_green_gate.return_value': green})
        variables = dict(HOTFIX_SHA=sha, HOTFIX_ENVIRONMENT=environment, GITHUB_REF=ref)
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
            (dict(on_master=False), 'not on master'),
            (dict(green=False), 'no successful push Gate'),
            (dict(baseline={**BASELINE, 'target_sha': SHA}), 'already runs'),
            (dict(ancestry=False), 'only moves forward'),
        )
        for changes, message in cases:
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                self.run_plan(**changes)

    def test_the_rehearsal_plans_on_nightly(self):
        self.run_plan(environment='nightly')


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



def workflow_job(workflow, name):
    text = (release.ROOT / '.github/workflows' / workflow).read_text()
    start = text.index(f'\n  {name}:\n')
    following = re.search(r'\n  [A-Za-z0-9_-]+:\n', text[start + 1:])
    return text[start:start + 1 + following.start() if following else len(text)]


class HotfixGraph(unittest.TestCase):
    """The job graph of Hotfix: what runs, in what order, and what sends the previous release back. The verdict tests above judge the
    results; these fail when an edit to the workflow breaks the wiring the verdict relies on."""

    def test_the_hotfix_deploys_the_release_and_the_web_to_production(self):
        block = workflow_job('hotfix.yml', 'release')
        for line in ('needs: [plan, retain]', 'uses: ./.github/workflows/ci.yml', 'release_managed: true', 'deploy_managed: true', 'deploy_web: true',
                     'managed_environment: production'):
            self.assertIn(line, block, line)

    def test_the_real_call_smoke_runs_after_the_release(self):
        block = workflow_job('hotfix.yml', 'smoke')
        for line in ('needs: [plan, release]', 'uses: ./.github/workflows/real-call-proof.yml', 'environment: production'):
            self.assertIn(line, block, line)

    def test_the_rollback_runs_when_the_release_or_the_smoke_did_not_pass(self):
        block = workflow_job('hotfix.yml', 'rollback')
        for line in ('needs: [plan, retain, release, smoke]', "needs.retain.result == 'success'", "needs.release.outputs.applied_release_id != ''",
                     "needs.release.result != 'success'", "needs.smoke.result != 'success'", "needs.smoke.outputs.result != 'passed'"):
            self.assertIn(line, block, line)

    def test_the_rollback_returns_the_baseline_and_the_saved_pages_deployment(self):
        block = workflow_job('hotfix.yml', 'rollback')
        for line in ('release_managed: false', 'deploy_managed: true', 'deploy_web: true', 'managed_environment: production',
                     'target_sha: ${{ fromJSON(needs.plan.outputs.baseline).target_sha }}',
                     'reuse_release_id: ${{ fromJSON(needs.plan.outputs.baseline).release_id }}',
                     'pages_rollback_id: ${{ needs.retain.outputs.pages_deployment_id }}'):
            self.assertIn(line, block, line)

    def test_the_verdict_job_always_runs_after_every_other_job(self):
        block = workflow_job('hotfix.yml', 'result')
        self.assertIn('needs: [plan, retain, release, smoke, rollback]', block)
        self.assertIn('if: always()', block)
        self.assertIn('python3 scripts/releases/hotfix.py verdict', block)

    def test_the_retain_job_saves_the_live_pages_deployment_before_the_release(self):
        self.assertIn('python3 scripts/releases/web.py current', workflow_job('hotfix.yml', 'retain'))
        self.assertIn('needs: [plan, retain]', workflow_job('hotfix.yml', 'release'))


class RehearsalGraph(unittest.TestCase):
    def test_the_host_and_pages_legs_wait_for_the_release_and_never_deploy_it(self):
        release_block = workflow_job('hotfix-rehearsal.yml', 'release')
        for line in ('uses: ./.github/workflows/ci.yml', 'managed_environment: nightly', 'deploy_managed: false', 'publish_runtime_only: true', 'build_web: true'):
            self.assertIn(line, release_block, line)
        self.assertNotIn('deploy_web', release_block)
        self.assertIn('needs: [plan, release]', workflow_job('hotfix-rehearsal.yml', 'rehearse'))
        pages = workflow_job('hotfix-rehearsal.yml', 'pages')
        self.assertIn('needs: [plan, release]', pages)
        self.assertIn('name: nightly\n', pages)
        self.assertIn('web.py rehearse --target nightly', pages)

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


class RollbackCommand(unittest.TestCase):
    def record(self, number, release, states):
        info = dict(channel='production-release', run_id=str(number), target_sha=str(number) * 40, release_id=release,
                    manifest_artifact_id=str(number + 100), manifest_sha256='d' * 64)
        return dict(id=number, payload=info), [dict(state=state) for state in states]

    def run_command(self, records, pages_id=''):
        statuses = {item['id']: states for item, states in records}
        github = Mock()
        github.request.side_effect = lambda route: [item for item, _ in records] if route.startswith('deployments?') else statuses[int(route.split('/')[1])]
        with patch('builtins.print') as printed:
            hotfix.rollback_command(github, Mock(pages_id=pages_id))
        return printed.call_args.args[0]

    def test_it_names_the_release_before_the_running_one_even_when_older_records_went_inactive(self):
        line = self.run_command([self.record(3, 'new', ['success']), self.record(2, 'new', ['inactive', 'success']), self.record(1, 'old', ['inactive', 'success'])], 'pages-1')
        self.assertIn('-f reuse_release_id=old', line)
        self.assertIn('-f manifest_run_id=1 ', line)
        self.assertIn('-f pages_rollback_id=pages-1', line)

    def test_a_failed_record_is_never_a_target(self):
        line = self.run_command([self.record(3, 'new', ['success']), self.record(2, 'bad', ['failure']), self.record(1, 'old', ['inactive', 'success'])])
        self.assertIn('-f reuse_release_id=old', line)
        self.assertIn('-f deploy_web=false', line)

    def test_one_release_has_nothing_to_return_to(self):
        with self.assertRaisesRegex(ValueError, 'no earlier'):
            self.run_command([self.record(1, 'only', ['success'])])


if __name__ == '__main__':
    unittest.main()
