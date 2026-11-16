"""Shared fixtures and helpers for focused release-contract test modules."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import proof_cover, release
from github_release import GitHub, digest, payload

FIXTURES = Path(__file__).parent / "fixtures"
SHA = "737897ad7361c859b1bc865d26399dd045c4fb9a"
EVALUATE = str(Path(__file__).resolve().parents[2] / "features/scorecard/evaluate.mjs")
os.environ["SCORECARD_HISTORY_REF"] = "origin/no-history"
OTHER_SHA = "b" * 40
RUN = "123"

def complete(card, budgets=None):
    """Add the gated chalk_sfu action metrics the card lacks, well under their ceilings, as evaluate.mjs requires."""
    if budgets is None:
        budgets = json.loads((FIXTURES / 'perf_budgets.json').read_text())['budgets']
    have = {metric['id'] for metric in card['metrics']}
    for key, entry in sorted(budgets.items()):
        metric = key.removeprefix('chalk_sfu.')
        if key.startswith('chalk_sfu.action.') and entry['gate'] is True and metric not in have:
            card['metrics'].append(dict(id=metric, unit='ms', n=60, p50=100, p95=100, source='latency-kit'))
    return card

def held(result='passed', sha=SHA, identity=1):
    info = dict(channel='nightly-cut', target_sha=sha, run_id=RUN, proof_run_id=RUN,
                release_id='release', applied_release_id='release', proof_result='passed',
                scorecard_result='passed', scorecard_gated_metrics=[])
    if result is not None:
        info['chalk_sfu_proof_result'] = result
    return dict(id=identity, created_at='2026-11-08T02:00:00Z', latest_status='success', payload=info)

class PromotionTestCase(unittest.TestCase):
    """Common promotion setup and GitHub response builders."""
    def setUp(self):
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.output = Path(directory) / 'output'
        self.enterContext(patch.dict(os.environ, GITHUB_OUTPUT=str(self.output),
                                    GITHUB_STEP_SUMMARY=str(Path(directory) / 'summary'),
                                    SCORECARD_OVERRIDE='', GITHUB_EVENT_NAME='',
                                    EXPECTED_RELEASE_SHA=SHA))
        # Unrelated archive, media, Gate and rollback validation has its own boundaries.
        self.enterContext(patch.object(release, 'validate_choice', side_effect=lambda github, item: payload(item)))
        self.enterContext(patch.object(release, 'manifest_bytes', return_value=b'{"images":{}}'))
        self.previous = dict(target_sha=OTHER_SHA)
        self.enterContext(patch.object(release, 'previous_production', return_value=self.previous))
        self.enterContext(patch.object(release, 'ancestor'))
        # The fixtures' SHAs are not in this checkout: a latency record covers its own SHA, and the changed-paths answer is set per test.
        self.enterContext(patch.object(proof_cover, 'descends', side_effect=lambda sha, target: sha == target))
        self.changed = self.enterContext(patch.object(proof_cover, 'paths_changed', side_effect=lambda previous, target, prefixes: previous != target))

    def github(self, item, latency='passed', scorecard='passed', host='passed'):
        api = Mock(spec=GitHub)
        record = [] if latency is None else [dict(id=9, payload=dict(
            channel='nightly-latency', target_sha=item['payload']['target_sha'], result=latency, scorecard_result=scorecard,
            scorecard_gated_metrics=['chalk_sfu.action.join.first_audio_ms'] if scorecard == 'gated-breach' else [],
            scorecard_missing_items=['chalk_sfu.action.leave_ms'] if scorecard == 'missing' else []))]
        api.deployments.return_value = [item]
        records = {'nightly-latency': record, 'nightly-host-proof': [] if host is None else [dict(id=8, payload=dict(channel='nightly-host-proof', target_sha=item['payload']['target_sha'], result=host))]}
        api.deployments.side_effect = lambda environment, task='nightly-cut', **kwargs: records.get(task, api.deployments.return_value)
        api.request.side_effect = lambda route: [dict(state=item['latest_status'])] if '/statuses?' in route else item
        return api

    def assert_blocked(self, action, result):
        with self.assertRaises(ValueError) as error:
            action()
        self.assertEqual(str(error.exception),
                         f'cannot promote SHA {SHA} from nightly run {RUN}: '
                         f'chalk_sfu_proof_result={result or "missing"}; a passed Chalk SFU proof for this SHA is required')

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

    def promoted_sha(self, github):
        with patch.object(release.live_calls, 'require_quiet_window'): release.auto_promote(github, None)  # The window and live calls have their own tests.
        line = [line for line in self.output.read_text().splitlines() if line.startswith('sha=')][-1]
        return line.removeprefix('sha=')
