"""The host proof a promotion needs when a cut changes what runs on the production host."""

import os
import unittest
from unittest.mock import Mock, patch

import release
import proof_cover
from github_release import GitHub
from test_release import SHA, ChalkSfuPromotionTests as Promotion, held


class HostProofTests(unittest.TestCase):
    # The promotion fixtures, without running the promotion tests twice.
    setUp = Promotion.setUp
    github = Promotion.github
    promoted_sha = Promotion.promoted_sha

    def blocked_by_host_proof(self, action, result):
        with self.assertRaisesRegex(ValueError, f'host_proof_result={result}'):
            action()

    def test_promote_needs_a_passing_host_proof_when_production_differs_in_host_paths(self):
        self.blocked_by_host_proof(lambda: release.select(self.github(held(), host=None), None), 'host-proof-missing')
        self.blocked_by_host_proof(lambda: release.select(self.github(held(), host='failed'), None), 'failed')
        release.select(self.github(held()), None)

    def test_promote_needs_no_host_proof_when_production_differs_in_no_host_path(self):
        self.changed.side_effect = lambda previous, target, prefixes: previous != target and tuple(prefixes) != proof_cover.host_paths()
        release.select(self.github(held(), host=None), None)

    def test_the_host_proof_gate_sees_the_controller_host_bootstrap_and_recording_paths(self):
        paths = proof_cover.host_paths()
        for changed in ('infrastructure/managed-episode/controller/chalk-deployment-controller', 'infrastructure/nightly/host-cloud-init.yaml',
                        'scripts/deploy/deploy-managed-release.mjs', 'scripts/recorder/release_core.py', 'apps/api/internal/recorderfleet/fleet.go',
                        '.github/workflows/nightly-host-proof.yml', 'scripts/nightly-host-proof/run'):
            self.assertTrue(any(changed == prefix or changed.startswith(prefix + '/') for prefix in paths), changed)

    def test_an_override_names_a_host_proof_it_accepts_and_the_automatic_path_never_takes_it(self):
        with patch.dict(os.environ, SCORECARD_OVERRIDE='accepted by a person'):
            audit = release.select(self.github(held(), host='failed'), None) or release.choose(self.github(held(), host='failed')).get('scorecard_override')
        self.assertEqual(audit['proof_results'], dict(host_proof_result='failed'))
        self.assertEqual(self.promoted_sha(self.github(held(), host=None)), '')

    def test_host_proof_target_is_the_newest_held_cut_that_no_host_proof_covers_or_any_on_the_weekly_run(self):
        for host, force, expected in ((None, '', SHA), ('failed', '', SHA), ('passed', '', ''), ('passed', 'true', SHA)):
            with self.subTest(host=host, force=force), patch.dict(os.environ, HOST_PROOF_FORCE=force):
                self.output.write_text('')
                release.host_proof_target(self.github(held(), host=host), None)
                lines = dict(line.split('=', 1) for line in self.output.read_text().splitlines())
                self.assertEqual(lines['sha'], expected)
                self.assertEqual(bool(lines['run_id']), bool(expected))

    def test_record_host_proof_binds_the_verdict_and_the_database_mode_to_the_sha_and_run(self):
        api = Mock(spec=GitHub)
        api.record_proof.return_value = 6
        with patch.dict(os.environ, dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', HOST_PROOF_RESULT='passed', HOST_PROOF_DATABASE='container')):
            release.record_host_proof(api, None)
        sha, task, info = api.record_proof.call_args.args
        self.assertEqual((sha, task), (SHA, 'nightly-host-proof'))
        self.assertEqual((info['result'], info['run_id'], info['database']), ('passed', '77', 'container'))
        with patch.dict(os.environ, dict(TARGET_SHA=SHA, GITHUB_RUN_ID='77', HOST_PROOF_RESULT='cancelled')):
            release.record_host_proof(api, None)
        self.assertEqual(api.record_proof.call_args.args[2]['result'], 'failed')

    def test_the_lookup_skips_a_newer_failed_host_proof_to_reach_an_older_pass(self):
        records = [dict(id=2, payload=dict(channel='nightly-host-proof', target_sha=SHA, result='failed')),
                   dict(id=1, payload=dict(channel='nightly-host-proof', target_sha=SHA, result='passed'))]
        github = GitHub.__new__(GitHub)
        github.request = Mock(return_value=records)
        self.assertEqual(github.deployments('nightly', 'nightly-host-proof', sha=SHA)[0]['id'], 1)
        self.assertEqual(github.deployments('nightly', 'nightly-host-proof', sha=SHA, passed_only=False)[0]['id'], 2)

if __name__ == '__main__':
    unittest.main()
