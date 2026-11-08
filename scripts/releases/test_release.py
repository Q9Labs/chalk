"""Promotion must retain and recheck the own-SFU proof for the selected cut."""

import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import release
from github_release import GitHub, payload

SHA = 'a' * 40
OTHER_SHA = 'b' * 40
RUN = '123'


def held(result='passed', sha=SHA, identity=1):
    info = dict(channel='nightly-cut', target_sha=sha, run_id=RUN, proof_run_id=RUN,
                release_id='release', applied_release_id='release', proof_result='passed')
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


if __name__ == '__main__':
    unittest.main()
