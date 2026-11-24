"""Runs `deploy` against the fake node with the OTLP endpoint mocked, so a dead telemetry token stops the deploy before it reaches the
node and a good one passes in the form the exporter would send it."""
import unittest

from deploy_harness import DeployHarness


class OtlpTokenCheckTest(DeployHarness):
    def test_a_rejected_otlp_token_stops_the_deploy_before_it_installs_anything(self):
        self.operator_files('staging', 'otlp-log-headers')
        (self.private / 'staging' / 'otlp-headers').write_text('Authorization=Bearer%20dead-token,X-Axiom-Dataset=metrics')
        result = self.run_deploy('staging', MOCK_OTLP_STATUS='401')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('rejects the token in', result.stderr)
        self.assertNotIn('podman secret create', self.read('ssh-calls'))
        self.assertNotIn('dead-token', self.read('ssh-calls') + self.read('otlp-checks'))

    def test_a_rejected_otlp_token_does_not_block_a_firewall_only_run(self):
        self.operator_files('staging', 'otlp-headers')
        result = self.run_deploy('staging', '--firewall-only', MOCK_OTLP_STATUS='401')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read('otlp-checks'), '')

    def test_the_token_check_sends_the_headers_the_exporter_would(self):
        self.operator_files('staging', 'otlp-log-headers')
        (self.private / 'staging' / 'otlp-headers').write_text('Authorization=Bearer%20abc%3D,X-Axiom-Dataset=metrics\n')
        result = self.run_deploy('staging', SFU_OTLP_ENDPOINT='https://otlp.example.test/')
        self.assert_reached_restart(result)
        self.assertEqual(self.read('otlp-checks').split(), ['https://otlp.example.test/v1/metrics', 'https://otlp.example.test/v1/logs'])
        self.assertIn('Authorization: Bearer abc=\nX-Axiom-Dataset: metrics\n', self.read('otlp-headers-sent'))

    def test_an_unreachable_otlp_endpoint_only_warns(self):
        self.operator_files('staging', 'otlp-headers')
        result = self.run_deploy('staging', MOCK_OTLP_STATUS='503')
        self.assert_reached_restart(result)
        self.assertIn('could not check the token', result.stderr)


if __name__ == '__main__':
    unittest.main()
