"""Promotion must retain and recheck the own-SFU proof for the selected cut."""

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import release
from github_release import GitHub, payload

SHA = '693cb26f710040c0cbca65f6e299ce0a639bfe40'
OTHER_SHA = 'b' * 40
RUN = '123'


def held(result='passed', sha=SHA, identity=1):
    info = dict(channel='nightly-cut', target_sha=sha, run_id=RUN, proof_run_id=RUN,
                release_id='release', applied_release_id='release', proof_result='passed',
                scorecard_result='passed', scorecard_gated_metrics=[])
    if result is not None:
        info['own_sfu_proof_result'] = result
    return dict(id=identity, created_at='2026-11-08T02:00:00Z', latest_status='success', payload=info)


class OwnSfuPromotionTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.output = Path(directory) / 'output'
        self.enterContext(patch.dict(os.environ, GITHUB_OUTPUT=str(self.output),
                                    GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary'),
                                    EXPECTED_RELEASE_SHA=SHA, LEAVE_BASELINE_MEDIAN_MS='150',
                                    LEAVE_BASELINE_EVIDENCE_SHA256='c' * 64))
        # Unrelated archive, media, Gate and rollback validation has its own boundaries.
        self.enterContext(patch.object(release, 'validate_choice', side_effect=lambda github, item: payload(item)))
        self.enterContext(patch.object(release, 'manifest_bytes', return_value=b'{"images":{}}'))
        self.previous = dict(target_sha=OTHER_SHA)
        self.enterContext(patch.object(release, 'previous_production', return_value=self.previous))

    def github(self, item):
        api = Mock(spec=GitHub)
        api.deployments.return_value = [item]
        api.request.side_effect = lambda route: ([dict(state=item['latest_status'])]
                                                 if '/statuses?' in route else item)
        return api

    def assert_blocked(self, action, result):
        with self.assertRaises(ValueError) as error:
            action()
        self.assertEqual(str(error.exception),
                         f'cannot promote SHA {SHA} from nightly run {RUN}: '
                         f'own_sfu_proof_result={result or "missing"}; a passed own-SFU proof for this SHA is required')

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

    def test_select_does_not_fall_back_to_an_older_passed_proof(self):
        for older_sha in (SHA, OTHER_SHA):
            with self.subTest(older_sha=older_sha):
                api = self.github(held(None, identity=2))
                api.deployments.return_value.append(held('passed', older_sha))
                self.assert_blocked(lambda: release.select(api, None), None)

    def test_recheck_rejects_changed_proof_or_sha_after_selection(self):
        for changes in (dict(own_sfu_proof_result='failed'), dict(target_sha=OTHER_SHA)):
            with self.subTest(changes=changes):
                item = held()
                selection = dict(deployment_id=item['id'], selection=copy.deepcopy(item['payload']), previous=self.previous)
                item['payload'].update(changes)
                with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                    with self.assertRaisesRegex(ValueError, 'selected nightly changed or is no longer held'):
                        release.recheck(self.github(item), None)

    def test_record_binds_all_own_sfu_outcomes_to_cut_sha_and_run_without_changing_cf_gate(self):
        for result in ('passed', 'failed', 'skipped'):
            for cf_result in ('passed', 'failed'):
                with self.subTest(result=result, cf_result=cf_result):
                    info = dict(run_id=RUN, release_id='release', applied_release_id='release')
                    api = Mock(spec=GitHub)
                    api.deployments.return_value = [dict(id=1, created_at='2026-11-08T02:00:00Z',
                                                        payload=dict(channel='nightly-write', **info))]
                    api.record.return_value = 2
                    with patch.dict(os.environ, RELEASE=json.dumps(info), TARGET_SHA=SHA, GITHUB_RUN_ID=RUN,
                                    OWN_SFU_RESULT=result, DEPLOY_RESULT='success', PROOF_RESULT=cf_result,
                                    WEB_E2E_RESULT='passed'):
                        release.record(api, None)
                    target, saved, passed = api.record.call_args.args
                    self.assertEqual((target, saved['target_sha'], saved['proof_run_id']), (SHA, SHA, RUN))
                    self.assertEqual(saved['own_sfu_proof_result'], result)
                    self.assertEqual(saved['real_call_proof_result'], cf_result)
                    self.assertEqual(saved['proof_result'], cf_result)
                    self.assertEqual(passed, cf_result == 'passed')

    def test_real_nightly_breaches_and_passing_cards_flow_through_record_to_promotion(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        expected = sorted(f"chalk_sfu.{metric['id']}" for metric in fixture['metrics'])
        for passing in (False, True):
            with self.subTest(passing=passing), tempfile.TemporaryDirectory() as directory:
                card = copy.deepcopy(fixture)
                if passing:
                    for metric in card['metrics']:
                        metric['p95'] = 100
                path = Path(directory) / 'card.json'
                path.write_text(json.dumps(card))
                verdict_output = Path(directory) / 'output'
                result = subprocess.run(['node', 'features/scorecard/evaluate.mjs', SHA, RUN, str(path)],
                                        cwd=release.ROOT, capture_output=True, text=True,
                                        env={**os.environ, 'GITHUB_OUTPUT': str(verdict_output)})
                self.assertEqual(result.returncode, 0 if passing else 1, result.stderr)
                verdict = json.loads(result.stdout)
                self.assertEqual(verdict['result'], 'passed' if passing else 'gated-breach')
                self.assertEqual(verdict['gated_metrics'], [] if passing else expected)
                self.assertEqual(json.loads(verdict_output.read_text().split('result=', 1)[1]), verdict)
                item = held()
                api = self.github(item)
                api.deployments.return_value = [dict(id=1, created_at=item['created_at'],
                                                    payload=dict(channel='nightly-write', run_id=RUN, release_id='release'))]
                api.record.return_value = 2
                with patch.dict(os.environ, RELEASE=json.dumps(dict(run_id=RUN, release_id='release', applied_release_id='release')),
                                TARGET_SHA=SHA, GITHUB_RUN_ID=RUN, OWN_SFU_RESULT='passed', DEPLOY_RESULT='success',
                                PROOF_RESULT='passed', WEB_E2E_RESULT='passed', SCORECARD_RESULT=json.dumps(verdict)):
                    release.record(api, None)
                item['payload'] = api.record.call_args.args[1]
                self.assertEqual(item['payload']['scorecard_result'], verdict['result'])
                self.assertEqual(item['payload']['scorecard_gated_metrics'], verdict['gated_metrics'])
                api.deployments.return_value = [item]
                selection = dict(deployment_id=item['id'], selection=item['payload'], previous=self.previous)
                with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                    for operation in ('select', 'recheck'):
                        if passing:
                            getattr(release, operation)(api, None)
                        else:
                            with self.assertRaises(ValueError) as error:
                                getattr(release, operation)(api, None)
                            self.assertEqual(str(error.exception),
                                             f'cannot promote SHA {SHA} from nightly run {RUN}: '
                                             f'scorecard_result=gated-breach; gated metrics: {", ".join(expected)}')

    def test_warn_only_breaches_do_not_block(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        fixture['mediaPlane'] = 'cf_sfu'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'card.json'
            path.write_text(json.dumps(fixture))
            result = subprocess.run(['node', 'features/scorecard/evaluate.mjs', SHA, RUN, str(path)], cwd=release.ROOT,
                                    capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['gated_metrics'], [])

    def test_scorecard_must_exist_and_match_cut_identity(self):
        item = held()
        del item['payload']['scorecard_result']
        for operation in ('select', 'recheck'):
            with self.subTest(operation=operation):
                selection = dict(deployment_id=item['id'], selection=item['payload'], previous=self.previous)
                with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                    with self.assertRaisesRegex(ValueError, f'SHA {SHA} from nightly run {RUN}: scorecard_result=missing'):
                        getattr(release, operation)(self.github(item), None)
        for changes in (dict(target_sha=OTHER_SHA), dict(run_id='999')):
            with self.subTest(changes=changes):
                verdict = dict(target_sha=SHA, run_id=RUN, result='passed', gated_metrics=[])
                verdict.update(changes)
                with patch.dict(os.environ, RELEASE=json.dumps(dict(run_id=RUN)), TARGET_SHA=SHA,
                                GITHUB_RUN_ID=RUN, SCORECARD_RESULT=json.dumps(verdict)):
                    with self.assertRaisesRegex(ValueError, 'scorecard identity does not match'):
                        release.record(self.github(item), None)

    def test_evaluator_refuses_wrong_revision_or_contended_evidence(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        for wrong_sha in (True, False):
            with self.subTest(wrong_sha=wrong_sha), tempfile.TemporaryDirectory() as directory:
                card = copy.deepcopy(fixture)
                if wrong_sha:
                    card['run']['commit'] = OTHER_SHA
                else:
                    card['contention'] = dict(contended=True)
                path = Path(directory) / 'card.json'
                path.write_text(json.dumps(card))
                result = subprocess.run(['node', 'features/scorecard/evaluate.mjs', SHA, RUN, str(path)], cwd=release.ROOT,
                                        capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_nightly_returns_breach_status_after_saving_history(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
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


if __name__ == '__main__':
    unittest.main()
