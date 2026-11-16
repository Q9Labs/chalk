"""Scorecard identity, budget and gated-metric release contracts."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from github_release import GitHub
import release
from test_support import FIXTURES, PromotionTestCase, RUN, SHA, complete, held

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

class ScorecardEvaluationTests(PromotionTestCase):
    """A cut is promoted only from its own scored evidence."""
    def test_record_binds_the_proof_and_release_outcomes_to_cut_sha_and_run_with_the_proof_as_the_gate(self):
        for release_result in ('success', 'failure'):
            for proof in ('passed', 'failed'):
                with self.subTest(release_result=release_result, proof=proof):
                    info = dict(run_id=RUN, release_id='release')
                    api = Mock(spec=GitHub)
                    api.record.return_value = 2
                    with patch.dict(os.environ, RELEASE=json.dumps(info), TARGET_SHA=SHA, GITHUB_RUN_ID=RUN,
                                    RELEASE_RESULT=release_result, PROOF_RESULT=proof):
                        release.record(api, None)
                    target, saved, passed = api.record.call_args.args
                    self.assertEqual((target, saved['target_sha'], saved['proof_run_id']), (SHA, SHA, RUN))
                    self.assertEqual(saved['chalk_sfu_proof_result'], proof)
                    self.assertEqual(saved['release_result'], release_result)
                    self.assertEqual(saved['applied_release_id'], 'release')
                    self.assertEqual(saved['proof_result'], 'passed' if passed else 'failed')
                    self.assertEqual(passed, release_result == 'success' and proof == 'passed')

    def test_real_nightly_breaches_and_passing_cards_flow_through_record_to_promotion(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
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
                api.record.return_value = 2
                with patch.dict(os.environ, RELEASE=json.dumps(dict(run_id=RUN, release_id='release')),
                                TARGET_SHA=SHA, GITHUB_RUN_ID=RUN, RELEASE_RESULT='success',
                                PROOF_RESULT='passed', SCORECARD_RESULT=json.dumps(verdict)):
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
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
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
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
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
        # The cut's proofs write no scorecard; the staging latency run supplies the Chalk SFU card that Promote reads next to the cut.
        result = subprocess.run(['node', EVALUATE, '--latency-deferred', SHA, RUN], cwd=SCORED,
                                capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((json.loads(result.stdout)['result'], json.loads(result.stdout)['missing_items']), ('passed', []))

    def test_missing_own_card_cannot_be_replaced_by_cf_card(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
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
        """Record a nightly whose Chalk SFU card never arrived; return the API and the held item carrying that record."""
        item = held()
        api = self.github(item)
        api.record.return_value = 2
        with patch.dict(os.environ, RELEASE=json.dumps(dict(run_id=RUN, release_id='release')),
                        TARGET_SHA=SHA, GITHUB_RUN_ID=RUN, RELEASE_RESULT='success',
                        PROOF_RESULT='passed', SCORECARD_RESULT=json.dumps(self.evaluate())):
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
        reason = 'Accept missing Chalk SFU upload for this rollout.'
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
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
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
                self.assertEqual(verdict['missing_items'], [] if expected == 'passed' else [f'chalk_sfu.{gone} (missing: 0 of 48)'])
                self.assertEqual(verdict['gated_metrics'], [])

    def test_budget_limits_come_from_scored_commit_not_newer_checkout(self):
        script = EVALUATE
        fixture = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
        budgets = json.loads((release.ROOT / 'perf/budgets.json').read_text())
        fixture['metrics'] = [dict(id='action.join.first_audio_ms', unit='ms', n=60, p50=100, p95=300, source='latency-kit')]
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
        card = json.loads((Path(__file__).parent / 'fixtures/chalk_sfu_over_budget.json').read_text())
        card['run']['commit'] = OTHER_SHA
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'card.json'
            path.write_text(json.dumps(card))
            result = subprocess.run(['node', EVALUATE, SHA, RUN, str(path)], cwd=SCORED,
                                    capture_output=True, text=True, env={**os.environ, 'GITHUB_OUTPUT': os.devnull})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn(f'scorecard is not for nightly SHA {SHA}', result.stderr)
