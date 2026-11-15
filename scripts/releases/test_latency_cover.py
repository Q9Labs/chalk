"""The latency record a promotion needs, the cut Nightly's latency lane measures, and the archive-only build's Gate."""

import os
import unittest
from unittest.mock import Mock, patch

import release
import proof_cover
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
        with patch.object(proof_cover, 'descends', return_value=True):
            self.assertEqual(release.covering_latency(api, SHA)['target_sha'], 'c' * 40)
            self.changed.side_effect = lambda previous, target, prefixes: True
            self.assertIsNone(release.covering_latency(api, SHA))

    def test_a_newer_passed_record_of_a_cut_that_was_never_held_does_not_hide_the_record_that_covers_the_held_cut(self):
        records = [dict(id=2, payload=dict(channel='nightly-latency', target_sha='d' * 40, result='passed')),
                   dict(id=1, payload=dict(channel='nightly-latency', target_sha='c' * 40, result='passed'))]
        api = self.github(held())
        api.deployments.side_effect = lambda environment, task='nightly-cut', limit=1, **kwargs: records[:limit]
        self.changed.side_effect = lambda previous, target, prefixes: False
        with patch.object(proof_cover, 'descends', side_effect=lambda sha, target: sha == 'c' * 40):
            self.assertEqual(release.covering_latency(api, SHA)['target_sha'], 'c' * 40)

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

    def test_a_cut_names_its_own_sha_and_is_skipped_when_a_passed_record_covers_it(self):
        for latency, expected in ((None, SHA), ('failed', SHA), ('passed', '')):
            with self.subTest(latency=latency), patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'LATENCY_SHA': SHA}):
                self.output.write_text('')
                release.latency_target(self.github(held(), latency=latency), None)
                self.assertEqual(self.output.read_text(), f'sha={expected}\n')

    def test_a_cut_is_measured_again_when_the_record_of_its_sha_measured_another_release(self):
        for measured, expected in (('another-release', SHA), ('release', ''), (None, '')):
            with self.subTest(measured=measured), patch.dict(os.environ, {'LATENCY_SHA': SHA, 'RELEASE_ID': 'release'}):
                api = self.github(held())
                if measured:
                    api.deployments.side_effect = lambda environment, task='nightly-cut', **kwargs: (
                        [dict(id=9, payload=dict(channel='nightly-latency', target_sha=SHA, result='passed', scorecard_result='passed', release_id=measured))]
                        if task == 'nightly-latency' else [held()])
                self.output.write_text('')
                release.latency_target(api, None)
                self.assertEqual(self.output.read_text(), f'sha={expected}\n')

    def test_promote_refuses_a_record_of_this_sha_that_measured_other_images(self):
        for measured, expected in (('another-release', 'latency-images-differ'), ('release', 'passed'), (None, 'passed')):
            with self.subTest(measured=measured):
                api = self.github(held())
                record = dict(id=9, payload=dict(channel='nightly-latency', target_sha=SHA, result='passed', scorecard_result='passed', **({} if measured is None else dict(release_id=measured))))
                api.deployments.side_effect = lambda environment, task='nightly-cut', **kwargs: [record] if task == 'nightly-latency' else [held()]
                self.assertEqual(release.with_latency(api, held()['payload'], OTHER_SHA)['chalk_sfu_proof_result'], expected)

    def test_record_latency_names_the_release_whose_images_it_measured(self):
        api = Mock(spec=GitHub)
        with patch.dict(os.environ, dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', LATENCY_RESULT='passed', SCORECARD_RESULT='', RELEASE_ID='release')):
            release.record_latency(api, None)
        self.assertEqual(api.record_proof.call_args.args[2]['release_id'], 'release')

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
        self.assertEqual([item['id'] for item in github.deployments('nightly', 'nightly-latency', passed_only=False, limit=5)], [2, 1])


class ArchiveOnlyBuildTests(unittest.TestCase):
    def test_an_archive_only_web_build_is_gated(self):
        with patch.dict(os.environ, {'BUILD_WEB': 'true'}):
            self.assertTrue(release.builds_fresh_artifacts())


if __name__ == '__main__':
    unittest.main()
