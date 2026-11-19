"""Read-only seeded-output retention; plan policy tests live beside the TS policy."""
import json
import unittest
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
