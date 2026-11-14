"""Promotion must retain and recheck the own-SFU proof for the selected cut."""

import copy
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import release
import web
from datetime import datetime, timezone

from github_release import GitHub, digest, first_cut_of_day, payload

FIXTURES = Path(__file__).parent / 'fixtures'
# The commit the nightly fixture card scores: one commit holding perf/budgets.json as it was at 693cb26f (8 Nov 2026),
# with fixed authorship and dates so its SHA never changes. The evaluator reads budgets with `git show <sha>:perf/budgets.json`,
# so the tests build that commit themselves instead of needing an old commit in the checkout's history, which a shallow clone lacks.
SHA = '8e7a9381803d7e24e924a0f847250ec6c2bb390a'
EVALUATE = str(Path(__file__).resolve().parents[2] / 'features/scorecard/evaluate.mjs')
SCORED = None


def setUpModule():
    global SCORED
    directory = tempfile.TemporaryDirectory()
    unittest.addModuleCleanup(directory.cleanup)
    SCORED = Path(directory.name)
    environment = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
                   'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com', 'GIT_AUTHOR_DATE': '2026-11-08T00:00:00Z',
                   'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com', 'GIT_COMMITTER_DATE': '2026-11-08T00:00:00Z'}
    git = lambda *command: subprocess.run(['git', *command], cwd=SCORED, env=environment, check=True,
                                          capture_output=True, text=True).stdout
    (SCORED / 'perf').mkdir()
    (SCORED / 'perf/budgets.json').write_bytes((FIXTURES / 'perf_budgets.json').read_bytes())
    git('init', '--quiet', '--initial-branch', 'main', '.')
    git('add', 'perf/budgets.json')
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'budgets')
    revision = git('rev-parse', 'HEAD').strip()
    if revision != SHA:
        raise AssertionError(f'the scored fixture commit is {revision}, want {SHA}')
OTHER_SHA = 'b' * 40
RUN = '123'


def complete(card, budgets=None):
    """Add the gated chalk_sfu action metrics the card lacks, well under their ceilings, as evaluate.mjs requires."""
    if budgets is None:
        budgets = json.loads((FIXTURES / 'perf_budgets.json').read_text())['budgets']
    have = {metric['id'] for metric in card['metrics']}
    for key, entry in sorted(budgets.items()):
        metric = key.removeprefix('chalk_sfu.')
        if key.startswith('chalk_sfu.action.') and entry['gate'] is True and metric not in have:
            card['metrics'].append(dict(id=metric, unit='ms', n=20, p50=100, p95=100, source='latency-kit'))
    return card


def held(result='passed', sha=SHA, identity=1):
    info = dict(channel='nightly-cut', target_sha=sha, run_id=RUN, proof_run_id=RUN,
                release_id='release', applied_release_id='release', proof_result='passed',
                scorecard_result='passed', scorecard_gated_metrics=[])
    if result is not None:
        info['own_sfu_proof_result'] = result
    return dict(id=identity, created_at='2026-11-08T02:00:00Z', latest_status='success', payload=info)


class WebDirectSyncConfigTests(unittest.TestCase):
    """The direct Sync URL reaches the web build only when the release environment sets it."""

    def config(self, **environment):
        with patch.dict(os.environ):
            os.environ.pop('CHALK_WEB_SYNC_DIRECT_URL', None)
            os.environ.update(environment)
            return web.public_config('nightly', SHA)

    def test_unset_keeps_the_public_config_unchanged(self):
        self.assertNotIn('VITE_CHALK_SYNC_DIRECT_URL', self.config())
        self.assertEqual(self.config(CHALK_WEB_SYNC_DIRECT_URL='  '), self.config())

    def test_a_direct_url_is_passed_to_the_build(self):
        url = 'wss://direct.example.test/v1/sync'
        self.assertEqual(self.config(CHALK_WEB_SYNC_DIRECT_URL=url)['VITE_CHALK_SYNC_DIRECT_URL'], url)

    def test_a_production_build_refuses_a_direct_url(self):
        with patch.dict(os.environ, CHALK_WEB_SYNC_DIRECT_URL='wss://direct.example.test/v1/sync'):
            with self.assertRaises(ValueError):
                web.public_config('production', SHA)
        with patch.dict(os.environ):
            os.environ.pop('CHALK_WEB_SYNC_DIRECT_URL', None)
            self.assertNotIn('VITE_CHALK_SYNC_DIRECT_URL', web.public_config('production', SHA))

    def test_a_production_bundle_that_names_a_direct_host_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Path(directory)
            (client / 'assets').mkdir()
            (client / 'assets/app.js').write_text('connect("wss://sync.chalkmeet.com/v1/sync")')
            web.reject_direct_sync_url(client)
            (client / 'assets/leak.js').write_text('connect("wss://nightly-sync-direct.chalkmeet.com/v1/sync")')
            with self.assertRaises(ValueError):
                web.reject_direct_sync_url(client)

    def test_a_malformed_direct_url_fails_the_release(self):
        for url in ('ws://direct.example.test/v1/sync', 'wss://direct.example.test/other', 'wss://direct.example.test/v1/sync?x=1', 'direct.example.test'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.config(CHALK_WEB_SYNC_DIRECT_URL=url)


class OwnSfuPromotionTests(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.output = Path(directory) / 'output'
        self.enterContext(patch.dict(os.environ, GITHUB_OUTPUT=str(self.output),
                                    GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary'),
                                    SCORECARD_OVERRIDE='',
                                    EXPECTED_RELEASE_SHA=SHA))
        # Unrelated archive, media, Gate and rollback validation has its own boundaries.
        self.enterContext(patch.object(release, 'validate_choice', side_effect=lambda github, item: payload(item)))
        self.enterContext(patch.object(release, 'manifest_bytes', return_value=b'{"images":{}}'))
        self.previous = dict(target_sha=OTHER_SHA)
        self.enterContext(patch.object(release, 'previous_production', return_value=self.previous))
        self.enterContext(patch.object(release, 'ancestor'))

    def github(self, item, latency='passed', scorecard='passed'):
        api = Mock(spec=GitHub)
        record = [] if latency is None else [dict(id=9, payload=dict(
            channel='nightly-latency', target_sha=item['payload']['target_sha'], result=latency, scorecard_result=scorecard,
            scorecard_gated_metrics=['chalk_sfu.action.join.first_audio_ms'] if scorecard == 'gated-breach' else [],
            scorecard_missing_items=['chalk_sfu.action.leave_ms'] if scorecard == 'missing' else []))]
        api.deployments.return_value = [item]
        api.deployments.side_effect = lambda environment, task='nightly-cut', **kwargs: record if task == 'nightly-latency' else api.deployments.return_value
        api.request.side_effect = lambda route: ([dict(state=item['latest_status'])]
                                                 if '/statuses?' in route else item)
        return api

    def assert_blocked(self, action, result):
        with self.assertRaises(ValueError) as error:
            action()
        self.assertEqual(str(error.exception),
                         f'cannot promote SHA {SHA} from nightly run {RUN}: '
                         f'own_sfu_proof_result={result or "missing"}; a passed own-SFU proof for this SHA is required')

    def retain_override(self, audit):
        with tempfile.TemporaryDirectory() as directory:
            manifest = json.dumps(dict(release_id='release', source_revision=SHA)).encode()
            (Path(directory) / 'release.json').write_bytes(manifest)
            api = Mock(spec=GitHub)
            api.request.return_value = dict(id=2)
            with patch.dict(os.environ, RELEASE_ID='release', TARGET_SHA=SHA, GITHUB_RUN_ID='456', CHALK_RELEASE_SEAL_KEY='test-seal-key',
                            MANIFEST_SHA256=digest(manifest), MANIFEST_ARTIFACT_ID='10', PROMOTION_AUDIT=json.dumps(audit)):
                release.retain_production(api, SimpleNamespace(directory=Path(directory)))
            record = api.request.call_args.args[1]
            self.assertEqual(record['task'], 'production-release')
            return record['payload']['scorecard_override']

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

    def test_promote_needs_a_passing_staging_latency_verdict_for_the_selected_sha(self):
        self.assert_blocked(lambda: release.select(self.github(held(), latency=None), None), 'latency-missing')
        self.assert_blocked(lambda: release.select(self.github(held(), latency='failed'), None), 'failed')
        release.select(self.github(held()), None)

    def promoted_sha(self, github):
        release.auto_promote(github, None)
        line = [line for line in self.output.read_text().splitlines() if line.startswith('sha=')][-1]
        return line.removeprefix('sha=')

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
        api.deployments.assert_any_call('nightly', 'nightly-latency', sha=SHA)

    def staging(self, cut=None, sha=OTHER_SHA):
        """A GitHub whose newest nightly write is run RUN, release 'release', at `sha`, and whose newest cut record (any
        proof result) is `cut`."""
        api = Mock(spec=GitHub)
        write = dict(id=10, sha=sha, payload=dict(channel='nightly-write', run_id=RUN, release_id='release'))
        api.deployments.side_effect = lambda environment, task='nightly-cut', **kwargs: (
            [write] if task == 'nightly-write' else [] if cut is None else [cut])
        return api

    def cut(self, sha=OTHER_SHA, id=11, **changes):
        return dict(id=id, payload={**held(None)['payload'], 'deploy_result': 'success', 'target_sha': sha, **changes})

    def test_latency_target_is_the_cut_staging_runs_even_when_that_cut_failed_its_proofs(self):
        release.latency_target(self.staging(self.cut(proof_result='failed')), None)
        self.assertIn(f'sha={OTHER_SHA}\n', self.output.read_text())

    def test_latency_target_is_empty_when_the_newest_write_never_finished_deploying(self):
        cuts = (None, self.cut(deploy_result='failure'), self.cut(run_id='122'),
                self.cut(applied_release_id='an-earlier-attempt-of-this-run'), self.cut(SHA),
                self.cut(id=9))
        for cut in cuts:
            with self.subTest(cut=cut):
                self.output.write_text('')
                release.latency_target(self.staging(cut), None)
                self.assertEqual(self.output.read_text(), 'sha=\n')

    def test_latency_target_is_empty_when_staging_has_no_nightly_write(self):
        api = Mock(spec=GitHub)
        api.deployments.return_value = []
        release.latency_target(api, None)
        self.assertIn('sha=\n', self.output.read_text())

    def test_record_latency_binds_the_verdict_to_the_measured_sha_and_run(self):
        scorecard = dict(target_sha=SHA, run_id='77', result='passed', gated_metrics=[], missing_items=[])
        api = self.staging(self.cut(SHA), SHA)
        api.record_latency.return_value = 5
        environment = dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', LATENCY_RESULT='passed', SCORECARD_RESULT=json.dumps(scorecard))
        with patch.dict(os.environ, environment):
            release.record_latency(api, None)
            saved = api.record_latency.call_args.args
            self.assertEqual(saved[0], SHA)
            self.assertEqual((saved[1]['result'], saved[1]['run_id'], saved[1]['channel']), ('passed', '77', 'nightly-latency'))
            os.environ['LATENCY_RESULT'] = 'failed'
            release.record_latency(api, None)
            self.assertEqual(api.record_latency.call_args.args[1]['result'], 'failed')
            os.environ['SCORECARD_RESULT'] = json.dumps(dict(scorecard, run_id='78'))
            with self.assertRaises(ValueError):
                release.record_latency(api, None)
            os.environ['SCORECARD_RESULT'] = ''
            release.record_latency(api, None)
            self.assertEqual(api.record_latency.call_args.args[1]['scorecard_result'], 'missing')

    def test_record_latency_refuses_a_sha_staging_no_longer_runs(self):
        api = self.staging(self.cut(OTHER_SHA), OTHER_SHA)
        with patch.dict(os.environ, dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', LATENCY_RESULT='passed', SCORECARD_RESULT='')):
            with self.assertRaises(ValueError):
                release.record_latency(api, None)
        api.record_latency.assert_not_called()

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
                                        proof_results=dict(own_sfu_proof_result='failed', scorecard_result='gated-breach'),
                                        gated_metrics=metrics, missing_items=[]))
            self.assertNotIn('scorecard_override', item['payload'])
            with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                release.recheck(api, None)
        summary = Path(os.environ['GITHUB_STEP_SUMMARY']).read_text()
        self.assertIn('## Scorecard override', summary)
        for value in (reason, 'own_sfu_proof_result', 'failed', 'gated-breach', *metrics):
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
                    self.assertEqual(selection['scorecard_override']['proof_results']['own_sfu_proof_result'], result or 'missing')
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
        fixture = Path(__file__).parent / 'fixtures/own_sfu_over_budget.json'
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
        for changes in (dict(own_sfu_proof_result='failed'), dict(target_sha=OTHER_SHA)):
            with self.subTest(changes=changes):
                item = held()
                selection = dict(deployment_id=item['id'], selection=copy.deepcopy(item['payload']), previous=self.previous)
                item['payload'].update(changes)
                with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                    with self.assertRaisesRegex(ValueError, 'selected nightly changed or is no longer held'):
                        release.recheck(self.github(item), None)

    def test_record_binds_all_own_sfu_outcomes_to_cut_sha_and_run_with_the_chalk_sfu_proof_as_the_gate(self):
        for result in ('passed', 'failed', 'skipped'):
            for gate_result in ('passed', 'failed'):
                with self.subTest(result=result, gate_result=gate_result):
                    info = dict(run_id=RUN, release_id='release', applied_release_id='release')
                    api = Mock(spec=GitHub)
                    api.deployments.return_value = [dict(id=1, created_at='2026-11-08T02:00:00Z',
                                                        payload=dict(channel='nightly-write', **info))]
                    api.record.return_value = 2
                    with patch.dict(os.environ, RELEASE=json.dumps(info), TARGET_SHA=SHA, GITHUB_RUN_ID=RUN,
                                    OWN_SFU_RESULT=result, DEPLOY_RESULT='success', PROOF_RESULT=gate_result,
                                    WEB_E2E_RESULT='passed'):
                        release.record(api, None)
                    target, saved, passed = api.record.call_args.args
                    self.assertEqual((target, saved['target_sha'], saved['proof_run_id']), (SHA, SHA, RUN))
                    self.assertEqual(saved['own_sfu_proof_result'], result)
                    self.assertEqual(saved['real_call_proof_result'], gate_result)
                    self.assertEqual(saved['proof_result'], gate_result)
                    self.assertEqual(saved['deploy_result'], 'success')
                    self.assertEqual(passed, gate_result == 'passed')

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
                path.write_text(json.dumps(complete(card)))
                verdict_output = Path(directory) / 'output'
                result = subprocess.run(['node', EVALUATE, SHA, RUN, str(path)],
                                        cwd=SCORED, capture_output=True, text=True,
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
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'card.json'
            cf = copy.deepcopy(fixture)
            cf['mediaPlane'] = 'cf_sfu'
            path.write_text(json.dumps(cf))
            own = Path(directory) / 'own.json'
            for metric in fixture['metrics']:
                metric['p95'] = 100
            own.write_text(json.dumps(complete(fixture)))
            result = subprocess.run(['node', EVALUATE, SHA, RUN, str(path), str(own)], cwd=SCORED,
                                    capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['gated_metrics'], [])

    def evaluate(self, *card_paths):
        result = subprocess.run(['node', EVALUATE, SHA, RUN, *card_paths],
                                cwd=SCORED, capture_output=True, text=True,
                                env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
        self.assertEqual(result.returncode, 1, result.stderr)
        return json.loads(result.stdout)

    def test_the_cut_scores_its_own_cards_without_the_latency_kit_run(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        fixture['metrics'] = [dict(fixture['metrics'][0], p50=1, p95=1)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'proof.json'
            path.write_text(json.dumps(fixture))
            command = ['node', EVALUATE]
            run = lambda *flags: subprocess.run([*command, *flags, SHA, RUN, str(path)], cwd=SCORED, capture_output=True,
                                                text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
            self.assertEqual(json.loads(run().stdout)['result'], 'missing')
            deferred = run('--latency-deferred')
            self.assertEqual((deferred.returncode, json.loads(deferred.stdout)['result']), (0, 'passed'), deferred.stderr)

    def test_the_cut_needs_no_own_card_when_latency_is_deferred(self):
        # The cut's proofs write no scorecard; the staging latency run supplies the own-SFU card that Promote reads next to the cut.
        result = subprocess.run(['node', EVALUATE, '--latency-deferred', SHA, RUN], cwd=SCORED,
                                capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((json.loads(result.stdout)['result'], json.loads(result.stdout)['missing_items']), ('passed', []))

    def test_missing_own_card_cannot_be_replaced_by_cf_card(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        fixture['mediaPlane'] = 'cf_sfu'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cf.json'
            path.write_text(json.dumps(fixture))
            for cards in ([], [str(path)]):
                with self.subTest(cards=cards):
                    verdict = self.evaluate(*cards)
                    self.assertEqual(verdict['result'], 'missing')
                    self.assertEqual(verdict['missing_items'], ['chalk_sfu scorecard'])

    def held_with_missing_card(self):
        """Record a nightly whose own-SFU card never arrived; return the API and the held item carrying that record."""
        item = held()
        api = self.github(item)
        api.deployments.return_value = [dict(id=1, created_at=item['created_at'],
                                            payload=dict(channel='nightly-write', run_id=RUN, release_id='release'))]
        api.record.return_value = 2
        with patch.dict(os.environ, RELEASE=json.dumps(dict(run_id=RUN, release_id='release', applied_release_id='release')),
                        TARGET_SHA=SHA, GITHUB_RUN_ID=RUN, OWN_SFU_RESULT='passed', DEPLOY_RESULT='success',
                        PROOF_RESULT='passed', WEB_E2E_RESULT='passed', SCORECARD_RESULT=json.dumps(self.evaluate())):
            release.record(api, None)
        item['payload'] = api.record.call_args.args[1]
        api.deployments.return_value = [item]
        return api, item

    def test_recorded_missing_own_card_is_named_on_the_cut(self):
        _, item = self.held_with_missing_card()
        self.assertEqual(item['payload']['scorecard_result'], 'missing')
        self.assertEqual(item['payload']['scorecard_missing_items'], ['chalk_sfu scorecard'])

    def test_missing_own_card_blocks_select_and_recheck_without_a_reason(self):
        api, item = self.held_with_missing_card()
        selection = dict(deployment_id=item['id'], selection=item['payload'], previous=self.previous)
        for reason in ('', ' \t\n'):
            for operation in ('select', 'recheck'):
                with self.subTest(reason=reason, operation=operation), \
                        patch.dict(os.environ, SELECTION=json.dumps(selection), SCORECARD_OVERRIDE=reason):
                    with self.assertRaisesRegex(ValueError, 'scorecard_result=missing;.*missing evidence: chalk_sfu scorecard'):
                        getattr(release, operation)(api, None)

    def test_override_reason_lets_a_missing_own_card_through_and_is_retained_naming_it(self):
        api, item = self.held_with_missing_card()
        reason = 'Accept missing own-SFU upload for this rollout.'
        selection = dict(deployment_id=item['id'], selection=item['payload'], previous=self.previous)
        with patch.dict(os.environ, SELECTION=json.dumps(selection), SCORECARD_OVERRIDE=reason):
            release.select(api, None)
            selection = json.loads(self.output.read_text().split('selection=', 1)[1])
            with patch.dict(os.environ, SELECTION=json.dumps(selection)):
                release.recheck(api, None)
        audit = selection['scorecard_override']
        self.assertEqual(audit['missing_items'], ['chalk_sfu scorecard'])
        self.assertEqual(audit['proof_results']['scorecard_result'], 'missing')
        self.assertEqual(self.retain_override(audit), audit)
        summary = Path(os.environ['GITHUB_STEP_SUMMARY']).read_text()
        self.assertIn('## Scorecard override', summary)
        self.assertIn('chalk_sfu scorecard', summary)
        self.assertIn(reason, summary)

    def test_own_card_lacking_a_gated_action_metric_is_missing_and_names_it(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        full = complete(fixture)
        for metric in full['metrics']:
            metric['p95'] = 100
        gone = 'action.leave_media_removed_ms'
        absent = copy.deepcopy(full)
        absent['metrics'] = [metric for metric in absent['metrics'] if metric['id'] != gone]
        empty = copy.deepcopy(full)
        next(metric for metric in empty['metrics'] if metric['id'] == gone).update(n=0, p50=None, p95=None)
        for name, cards, expected in (('absent', [absent], 'missing'), ('no samples', [empty], 'missing'),
                                      ('split across cards', [absent, dict(full, metrics=[m for m in full['metrics'] if m['id'] == gone])], 'passed')):
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                paths = []
                for index, card in enumerate(cards):
                    paths.append(Path(directory) / f'card{index}.json')
                    paths[-1].write_text(json.dumps(card))
                result = subprocess.run(['node', EVALUATE, SHA, RUN, *map(str, paths)], cwd=SCORED,
                                        capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
                verdict = json.loads(result.stdout)
                self.assertEqual(verdict['result'], expected)
                self.assertEqual(result.returncode, 0 if expected == 'passed' else 1, result.stderr)
                self.assertEqual(verdict['missing_items'], [] if expected == 'passed' else [f'chalk_sfu.{gone}'])
                self.assertEqual(verdict['gated_metrics'], [])

    def test_budget_limits_come_from_scored_commit_not_newer_checkout(self):
        script = EVALUATE
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        budgets = json.loads((release.ROOT / 'perf/budgets.json').read_text())
        fixture['metrics'] = [dict(id='action.join.first_audio_ms', unit='ms', n=20, p50=100, p95=300, source='latency-kit')]
        complete(fixture, budgets['budgets'])
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            environment = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GITHUB_OUTPUT': os.devnull}
            subprocess.run(['git', 'init', '--quiet', str(directory)], check=True, env=environment)
            (directory / 'perf').mkdir()
            revisions = []
            for limit in (200, 1000):
                budgets['budgets']['chalk_sfu.action.join.first_audio_ms']['max_p95'] = limit
                (directory / 'perf/budgets.json').write_text(json.dumps(budgets))
                subprocess.run(['git', 'add', 'perf/budgets.json'], cwd=directory, env=environment, check=True)
                subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'budgets'],
                               cwd=directory, env=environment, check=True)
                revisions.append(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=directory, env=environment, text=True).strip())
            for revision, expected in zip(revisions, ('gated-breach', 'passed')):
                with self.subTest(revision=revision):
                    fixture['run']['commit'] = revision
                    path = directory / 'card.json'
                    path.write_text(json.dumps(fixture))
                    result = subprocess.run(['node', str(script), revision, RUN, str(path)], cwd=directory,
                                            env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 1 if expected == 'gated-breach' else 0, result.stderr)
                    verdict = json.loads(result.stdout)
                    self.assertEqual(verdict['result'], expected)
                    self.assertEqual(verdict['budgets_revision'], revision)

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

    def test_evaluator_refuses_a_scorecard_for_another_revision(self):
        card = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
        card['run']['commit'] = OTHER_SHA
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'card.json'
            path.write_text(json.dumps(card))
            result = subprocess.run(['node', EVALUATE, SHA, RUN, str(path)], cwd=SCORED,
                                    capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn(f'scorecard is not for nightly SHA {SHA}', result.stderr)

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


    def run_nightly(self, directory, warn_only, reject_push=False):
        fixture = json.loads((Path(__file__).parent / 'fixtures/own_sfu_over_budget.json').read_text())
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
        for path in release.recording_paths():
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


if __name__ == '__main__':
    unittest.main()
