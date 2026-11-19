"""Read-only seeded-output retention; plan policy tests live beside the TS policy."""
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock
import alchemy_dispatcher
from alchemy_dispatcher import read_inputs

class DispatcherAlchemyTests(unittest.TestCase):
    def test_pin_retention_reads_seeded_outputs_without_node_or_mutation(self):
        inputs = {'environment_name': 'nightly', 'function_name': 'chalk-nightly-transcription-dispatcher'}
        class AWSBoundary:
            region = 'ap-southeast-1'
            def aws(self, service, operation, *args):
                if (service, operation) != ('dynamodb', 'get-item'):
                    raise AssertionError('pin retention must be read-only')
                return {'Item': {'data': {'S': json.dumps({'dispatcher_inputs': {'__redacted__': inputs}})}}}
        self.assertEqual(read_inputs(AWSBoundary(), {'function_name': inputs['function_name']}), inputs)

    def test_pin_retention_reads_overflow_with_only_get_operations(self):
        inputs = {'environment_name': 'nightly', 'function_name': 'chalk-nightly-transcription-dispatcher'}
        calls = []
        class AWSBoundary:
            region = 'ap-southeast-1'
            def aws(self, service, operation, *args):
                calls.append((service, operation))
                if (service, operation) == ('dynamodb', 'get-item'):
                    return {'Item': {'ref': {'S': 'transcription-dispatcher/nightly/OUTPUT-test.json'}}}
                if (service, operation) == ('sts', 'get-caller-identity'):
                    return {'Account': '1' * 12}
                if (service, operation) == ('s3api', 'get-object'):
                    bucket = args[args.index('--bucket') + 1]
                    key = args[args.index('--key') + 1]
                    if bucket != 'alchemy-state-overflow-' + '1' * 12 + '-ap-southeast-1-an' or key != 'transcription-dispatcher/nightly/OUTPUT-test.json':
                        raise AssertionError('overflow identity changed')
                    Path(args[-1]).write_text(json.dumps({'dispatcher_inputs': {'__redacted__': inputs}}))
                    return {}
                raise AssertionError('pin retention must be read-only')
        self.assertEqual(read_inputs(AWSBoundary(), {'function_name': inputs['function_name']}), inputs)
        self.assertEqual(calls, [('dynamodb', 'get-item'), ('sts', 'get-caller-identity'), ('s3api', 'get-object')])

    def test_unseeded_environment_fails_without_fallback_or_mutation(self):
        class AWSBoundary:
            region = 'ap-southeast-1'
            def aws(self, service, operation, *args):
                if (service, operation) != ('dynamodb', 'get-item'):
                    raise AssertionError('unseeded read must not provision or fall back')
                return {}
        with self.assertRaisesRegex(ValueError, 'explicitly seed'):
            read_inputs(AWSBoundary(), {'function_name': 'chalk-nightly-transcription-dispatcher'})


    def run_plan_with_driver(self, returncode):
        """Run run_plan against a fake driver; return (diagnostics path the driver saw, outcome)."""
        class Provider:
            region = 'ap-southeast-1'
            profile = None
            dry_run = False
        seen = {}
        def driver(command, env, **_):
            seen['path'] = Path(env['CHALK_ALCHEMY_DIAGNOSTICS'])
            seen['path'].write_text('private diagnostics')
            if returncode == 0:
                Path(env['CHALK_INFRA_RESULT']).write_text(json.dumps({'checked': True, 'applied': False}))
            return subprocess.CompletedProcess(command, returncode)
        inputs = {'environment_name': 'nightly', 'function_name': 'chalk-nightly-transcription-dispatcher'}
        with mock.patch.object(alchemy_dispatcher.subprocess, 'run', driver):
            try:
                return seen, alchemy_dispatcher.run_plan(Provider(), inputs), None
            except ValueError as error:
                return seen, None, str(error)

    def test_diagnostics_of_a_successful_plan_are_cleaned_with_its_directory(self):
        seen, result, error = self.run_plan_with_driver(0)
        self.assertIsNone(error)
        self.assertTrue(result['checked'])
        self.assertFalse(seen['path'].exists())

    def test_diagnostics_of_a_failed_plan_are_kept_privately_and_named(self):
        seen, _, error = self.run_plan_with_driver(1)
        kept = Path(error.rsplit(': ', 1)[1])
        self.addCleanup(kept.unlink)
        self.assertFalse(seen['path'].exists())
        self.assertEqual(kept.read_text(), 'private diagnostics')
        self.assertEqual(kept.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
