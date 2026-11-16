"""Selection, recheck and override policy for production promotion."""
import copy
import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

from github_release import GitHub
import proof_cover, release
from test_support import OTHER_SHA, PromotionTestCase, RUN, SHA

class PromotionSelectionTests(PromotionTestCase):
    """A cut's exact proof and override state controls promotion."""
    def test_select_and_recheck_require_passed_proof_even_without_optional_inputs(self):
        for result in ('passed', 'failed', None, 'skipped'):
            for operation in ('select', 'recheck'):
                with self.subTest(result=result, operation=operation):
                    item = held(result)
                    api = self.github(item)
                    selection = dict(deployment_id=item['id'], selection=copy.deepcopy(item['payload']), previous=self.previous)
                    with patch.dict(os.environ, SELECTION=json.dumps(selection), EXPECTED_RELEASE_SHA=''):
                        action = lambda: getattr(release, operation)(api, None)
                        if result == 'passed':
                            action()
                        else:
                            self.assert_blocked(action, result)

    def test_promote_needs_a_passing_latency_record_when_production_differs_in_latency_paths(self):
        self.assert_blocked(lambda: release.select(self.github(held(), latency=None), None), 'latency-missing')
        self.assert_blocked(lambda: release.select(self.github(held(), latency='failed'), None), 'failed')
        release.select(self.github(held()), None)

    def test_automatic_promotion_names_a_held_cut_whose_gates_all_passed(self):
        self.assertEqual(self.promoted_sha(self.github(held())), SHA)

    def test_automatic_promotion_waits_for_the_latency_verdict_and_never_takes_an_override(self):
        self.assertEqual(self.promoted_sha(self.github(held(), latency=None)), '')
        self.assertEqual(self.promoted_sha(self.github(held(), latency='failed')), '')
        self.assertEqual(self.promoted_sha(self.github(held(), scorecard='gated-breach')), '')
        with patch.dict(os.environ, SCORECARD_OVERRIDE='accepted by a person'):
            self.assertEqual(self.promoted_sha(self.github(held(), scorecard='gated-breach')), '')

    def test_automatic_promotion_skips_what_production_already_runs(self):
        self.previous['target_sha'] = SHA
        self.assertEqual(self.promoted_sha(self.github(held())), '')

    def test_a_failed_proof_keeps_its_own_result_whatever_the_latency_says(self):
        self.assert_blocked(lambda: release.select(self.github(held('failed')), None), 'failed')
        self.assert_blocked(lambda: release.select(self.github(held(None), latency=None), None), None)

    def test_the_latency_scorecard_verdict_blocks_promotion_next_to_the_cut_verdict(self):
        for scorecard in ('gated-breach', 'missing'):
            with self.subTest(scorecard=scorecard), self.assertRaises(ValueError) as error:
                release.select(self.github(held(), scorecard=scorecard), None)
            self.assertIn(f'scorecard_result={scorecard}', str(error.exception))

    def test_the_newest_latency_verdict_is_looked_up_for_the_selected_sha(self):
        api = self.github(held())
        release.select(api, None)
        api.deployments.assert_any_call('nightly', 'nightly-latency', limit=proof_cover.LOOKBACK)

    def test_record_latency_binds_the_verdict_to_the_measured_sha_and_run(self):
        scorecard = dict(target_sha=SHA, run_id='77', result='passed', gated_metrics=[], missing_items=[])
        api = Mock(spec=GitHub)
        api.record_proof.return_value = 5
        environment = dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', LATENCY_RESULT='passed', SCORECARD_RESULT=json.dumps(scorecard))
        with patch.dict(os.environ, environment):
            release.record_latency(api, None)
            saved = api.record_proof.call_args.args
            self.assertEqual(saved[0], SHA)
            self.assertEqual((saved[2]['result'], saved[2]['run_id'], saved[2]['channel']), ('passed', '77', 'nightly-latency'))
            os.environ['LATENCY_RESULT'] = 'failed'
            release.record_latency(api, None)
            self.assertEqual(api.record_proof.call_args.args[2]['result'], 'failed')
            os.environ['SCORECARD_RESULT'] = json.dumps(dict(scorecard, run_id='78'))
            with self.assertRaises(ValueError):
                release.record_latency(api, None)
            os.environ['SCORECARD_RESULT'] = ''
            release.record_latency(api, None)
            self.assertEqual(api.record_proof.call_args.args[2]['scorecard_result'], 'missing')

    def test_record_latency_refuses_a_run_with_fewer_than_the_full_samples(self):
        api = Mock(spec=GitHub)
        with patch.dict(os.environ, dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', LATENCY_RESULT='passed', SCORECARD_RESULT='', LATENCY_SAMPLES='3')):
            with self.assertRaises(ValueError):
                release.record_latency(api, None)
        api.record_proof.assert_not_called()

    def test_every_input_of_the_latency_measurement_decides_whether_a_record_still_covers(self):
        paths = proof_cover.latency_paths()
        for changed in ('scripts/prod-proof/latency.mjs', 'perf/budgets.json', '.github/workflows/nightly-proofs.yml', 'features/scorecard/evaluate.mjs', 'sdks/typescript/client/src/connection/lifecycle.ts'):
            self.assertTrue(any(changed == prefix or changed.startswith(prefix + '/') for prefix in paths), changed)

    def test_record_latency_refuses_a_sha_that_is_not_on_master(self):
        api = Mock(spec=GitHub)
        with patch.dict(os.environ, dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', LATENCY_RESULT='passed', SCORECARD_RESULT='')):
            with patch.object(release, 'ancestor', side_effect=subprocess.CalledProcessError(1, 'git')):
                with self.assertRaises(subprocess.CalledProcessError):
                    release.record_latency(api, None)
        api.record_proof.assert_not_called()

    def test_select_never_uses_a_passed_proof_from_another_sha(self):
        item = held('passed', OTHER_SHA)
        with self.assertRaises(ValueError) as error:
            release.select(self.github(item), None)
        self.assertEqual(str(error.exception),
                         f'cannot promote SHA {SHA}: newest held nightly is SHA {OTHER_SHA} from run {RUN}')

    def test_passing_selection_retains_sha_and_proof_run_for_recheck(self):
        api = self.github(held())
        release.select(api, None)
        selection = json.loads(self.output.read_text().split('selection=', 1)[1])
        self.assertEqual(selection['selection']['target_sha'], SHA)
        self.assertEqual(selection['selection']['proof_run_id'], RUN)
        with patch.dict(os.environ, SELECTION=json.dumps(selection)):
            release.recheck(api, None)

    def test_existing_override_reason_continues_and_is_retained_with_results_and_metrics(self):
        reason = 'Accept this staging regression for the approved rollout.'
        metrics = ['chalk_sfu.action.join.first_audio_ms', 'chalk_sfu.action.camera_toggle.off_ms']
        item = held('failed')
        item['payload'].update(scorecard_result='gated-breach', scorecard_gated_metrics=metrics)
        api = self.github(item)
        with patch.dict(os.environ, SCORECARD_OVERRIDE=reason, GITHUB_ACTOR='release-operator'):
            release.select(api, None)
            selection = json.loads(self.output.read_text().split('selection=', 1)[1])
            audit = selection['scorecard_override']
            self.assertEqual(audit, dict(reason=reason, target_sha=SHA, nightly_run_id=RUN, actor='release-operator',
                                        proof_results=dict(chalk_sfu_proof_result='failed', scorecard_result='gated-breach'),
                                        gated_metrics=metrics, missing_items=[]))
            self.assertNotIn('scorecard_override', item['payload'])
            with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                release.recheck(api, None)
        summary = Path(os.environ['GITHUB_STEP_SUMMARY']).read_text()
        self.assertIn('## Scorecard override', summary)
        for value in (reason, 'chalk_sfu_proof_result', 'failed', 'gated-breach', *metrics):
            self.assertIn(value, summary)
        self.assertEqual(self.retain_override(audit), audit)

    def test_blank_override_reasons_keep_the_existing_failure_messages(self):
        for reason in ('', ' \t\n '):
            for scorecard_breach in (False, True):
                for operation in ('select', 'recheck'):
                    with self.subTest(reason=reason, scorecard_breach=scorecard_breach, operation=operation):
                        item = held('failed')
                        if scorecard_breach:
                            item['payload'].update(scorecard_result='gated-breach', scorecard_gated_metrics=['chalk_sfu.action.leave_ms'])
                        selection = dict(deployment_id=item['id'], selection=item['payload'], previous=self.previous)
                        with patch.dict(os.environ, SCORECARD_OVERRIDE=reason, SELECTION=json.dumps(selection)):
                            action = lambda: getattr(release, operation)(self.github(item), None)
                            if not scorecard_breach:
                                self.assert_blocked(action, 'failed')
                            else:
                                with self.assertRaises(ValueError) as error:
                                    action()
                                self.assertEqual(str(error.exception),
                                                 f'cannot promote SHA {SHA} from nightly run {RUN}: '
                                                 'scorecard_result=gated-breach; gated metrics: chalk_sfu.action.leave_ms')

    def test_override_accepts_missing_and_skipped_proof_but_not_sha(self):
        with patch.dict(os.environ, SCORECARD_OVERRIDE='Accept the proof gap.'):
            for result in (None, 'skipped'):
                with self.subTest(result=result):
                    self.output.write_text('')
                    release.select(self.github(held(result)), None)
                    selection = json.loads(self.output.read_text().split('selection=', 1)[1])
                    self.assertEqual(selection['scorecard_override']['proof_results']['chalk_sfu_proof_result'], result or 'missing')
            with self.assertRaisesRegex(ValueError, f'cannot promote SHA {SHA}: newest held nightly is SHA {OTHER_SHA}'):
                release.select(self.github(held('failed', OTHER_SHA)), None)
            item = held('failed')
            del item['payload']['scorecard_result']
            self.output.write_text('')
            release.select(self.github(item), None)
            selection = json.loads(self.output.read_text().split('selection=', 1)[1])
            self.assertEqual(selection['scorecard_override']['missing_items'], ['nightly scorecard result'])

    def test_override_cannot_change_between_selection_and_approval(self):
        api = self.github(held('failed'))
        with patch.dict(os.environ, SCORECARD_OVERRIDE='First reason'):
            release.select(api, None)
        selection = json.loads(self.output.read_text().split('selection=', 1)[1])
        with patch.dict(os.environ, SCORECARD_OVERRIDE='Different reason', SELECTION=json.dumps(selection)):
            with self.assertRaisesRegex(ValueError, 'scorecard override changed after selection'):
                release.recheck(api, None)

    def test_existing_production_scorecard_gate_uses_the_same_nonblank_reason_rule(self):
        fixture = Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json'
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            remote = directory / 'history.git'
            subprocess.run(['git', 'init', '--bare', '--quiet', str(remote)], check=True)
            bin_dir = directory / 'bin'
            bin_dir.mkdir()
            gh = bin_dir / 'gh'
            gh.write_text('#!/bin/sh\nexit 0\n')
            gh.chmod(0o755)
            for reason in ('Accepted regression: monitor during rollout.', '', ' \t\n '):
                with self.subTest(reason=reason):
                    summary = directory / 'summary'
                    summary.write_text('')
                    environment = {**os.environ, 'PATH': f'{bin_dir}{os.pathsep}{os.environ["PATH"]}',
                                   'SCORECARD_HISTORY_REMOTE': str(remote), 'SCORECARD_OVERRIDE': reason,
                                   'GITHUB_REPOSITORY': 'Q9Labs/chalk', 'GITHUB_SERVER_URL': 'https://github.com',
                                   'GITHUB_RUN_ID': RUN, 'GITHUB_STEP_SUMMARY': str(summary),
                                   'GITHUB_OUTPUT': str(directory / 'output')}
                    result = subprocess.run(['bash', 'features/scorecard/promote-gate.sh', 'final', str(fixture.resolve())],
                                            cwd=release.ROOT, env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0 if reason.strip() else 1, result.stderr)
                    if reason.strip():
                        self.assertIn('Scorecard override', summary.read_text())
                        self.assertIn(reason, summary.read_text())

    def test_select_does_not_fall_back_to_an_older_passed_proof(self):
        for older_sha in (SHA, OTHER_SHA):
            with self.subTest(older_sha=older_sha):
                api = self.github(held(None, identity=2))
                api.deployments.return_value.append(held('passed', older_sha))
                self.assert_blocked(lambda: release.select(api, None), None)

    def test_recheck_rejects_changed_proof_or_sha_after_selection(self):
        for changes in (dict(chalk_sfu_proof_result='failed'), dict(target_sha=OTHER_SHA)):
            with self.subTest(changes=changes):
                item = held()
                selection = dict(deployment_id=item['id'], selection=copy.deepcopy(item['payload']), previous=self.previous)
                item['payload'].update(changes)
                with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                    with self.assertRaisesRegex(ValueError, 'selected nightly changed or is no longer held'):
                        release.recheck(self.github(item), None)
