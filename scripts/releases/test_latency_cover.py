"""The latency record a promotion needs, the cut Nightly's latency lane measures, and the archive-only build's Gate."""

import os
import unittest
from unittest.mock import Mock, patch

import release
from github_release import GitHub
from test_release import SHA, OTHER_SHA, ChalkSfuPromotionTests as Promotion, held


class LatencyCoverTests(unittest.TestCase):
    # The promotion fixtures (a stubbed GitHub, a temporary output file), without running the promotion tests twice.
    setUp = Promotion.setUp
    github = Promotion.github
    promoted_sha = Promotion.promoted_sha

    def test_promote_needs_no_latency_record_when_production_differs_in_no_latency_path(self):
        self.changed.side_effect = None
        self.changed.return_value = False
        release.select(self.github(held(), latency=None), None)
        self.assertEqual(self.promoted_sha(self.github(held(), latency=None)), SHA)

    def test_an_older_passed_latency_record_covers_a_cut_with_no_latency_path_changed_since(self):
        self.changed.side_effect = lambda previous, target, prefixes: previous == OTHER_SHA
        api = self.github(held())
        api.deployments.side_effect = lambda environment, task='nightly-cut', **kwargs: (
            [dict(id=9, payload=dict(channel='nightly-latency', target_sha='c' * 40, result='passed', scorecard_result='passed'))]
            if task == 'nightly-latency' else [held()])
        with patch.object(release, 'descends', return_value=True):
            self.assertEqual(release.covering_latency(api, SHA)['target_sha'], 'c' * 40)
            self.changed.side_effect = lambda previous, target, prefixes: True
            self.assertIsNone(release.covering_latency(api, SHA))

    def test_latency_target_is_the_newest_held_cut_that_no_latency_record_covers(self):
        for latency, expected in ((None, SHA), ('failed', SHA), ('passed', '')):
            with self.subTest(latency=latency):
                self.output.write_text('')
                release.latency_target(self.github(held(), latency=latency), None)
                self.assertEqual(self.output.read_text(), f'sha={expected}\n')

    def test_a_person_dispatch_measures_a_held_cut_that_a_passed_record_covers(self):
        for event, expected in (('workflow_run', ''), ('schedule', ''), ('workflow_dispatch', SHA)):
            with self.subTest(event=event), patch.dict(os.environ, {'GITHUB_EVENT_NAME': event}):
                self.output.write_text('')
                release.latency_target(self.github(held(), latency='passed'), None)
                self.assertEqual(self.output.read_text(), f'sha={expected}\n')

    def test_latency_target_is_empty_without_a_held_cut(self):
        api = Mock(spec=GitHub)
        api.deployments.return_value = []
        release.latency_target(api, None)
        self.assertEqual(self.output.read_text(), 'sha=\n')

    def test_the_lookup_skips_a_newer_failed_record_to_reach_an_older_pass(self):
        records = [dict(id=2, payload=dict(channel='nightly-latency', target_sha='d' * 40, result='failed')),
                   dict(id=1, payload=dict(channel='nightly-latency', target_sha='c' * 40, result='passed'))]
        github = GitHub.__new__(GitHub)
        github.request = Mock(return_value=records)
        self.assertEqual(github.deployments('nightly', 'nightly-latency')[0]['id'], 1)
        self.assertEqual(github.deployments('nightly', 'nightly-latency', passed_only=False)[0]['id'], 2)


class ArchiveOnlyBuildTests(unittest.TestCase):
    def test_an_archive_only_web_build_is_gated(self):
        with patch.dict(os.environ, {'BUILD_WEB': 'true'}):
            self.assertTrue(release.builds_fresh_artifacts())


if __name__ == '__main__':
    unittest.main()
