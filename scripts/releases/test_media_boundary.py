"""Run dispatcher releases through real settings, state, plans and processes."""
import base64
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import media
from test_media import members


def fixture_state(config, manifest_digest, archive_hash, corpus):
    environment = dict(CHALK_ENVIRONMENT='nightly', CHALK_RELEASE_ID='example-release',
                       CHALK_RELEASE_MANIFEST_DIGEST=manifest_digest, CHALK_CONFIG_DIGEST='sha256:' + '0' * 64,
                       DEEPINFRA_CORPUS_DIGEST=corpus, CONTROL_API_BASE_URL='https://nightly-api.chalkmeet.com',
                       CONTROL_API_AUDIENCE='chalk-nightly-control-api')
    environment['CHALK_CONFIG_DIGEST'] = 'sha256:' + media.digest(json.dumps({key: value for key, value in environment.items() if key != 'CHALK_CONFIG_DIGEST'}, sort_keys=True, separators=(',', ':')))
    function = dict(environment=[dict(variables=environment)], function_name=config['dispatcher']['function_name'],
                    source_code_hash=base64.b64encode(bytes.fromhex(archive_hash)).decode(), s3_bucket='example-artifacts',
                    s3_key='transcription-dispatcher/example-release/example.zip', s3_object_version='example-version',
                    handler='index.handler', timeout=60, memory_size=512, ephemeral_storage=[dict(size=512)], reserved_concurrent_executions=2,
                    tags={}, tags_all={})
    attributes = {
        'aws_lambda_function.dispatcher': function,
        'aws_scheduler_schedule.reconcile': dict(name=config['dispatcher']['scheduler_name'], group_name=config['dispatcher']['scheduler_group'],
                                                state='ENABLED', target=[dict(input='{}', retry_policy=[dict(maximum_event_age_in_seconds=60, maximum_retry_attempts=1)])]),
        'aws_lambda_function_event_invoke_config.dispatcher': dict(maximum_event_age_in_seconds=60, maximum_retry_attempts=1),
        'aws_cloudwatch_log_group.dispatcher': dict(retention_in_days=7, kms_key_id=''),
        'aws_sqs_queue.async_failure': dict(kms_master_key_id=''),
        'aws_cloudwatch_metric_alarm.errors': dict(alarm_actions=[]),
        'aws_iam_role_policy.dispatcher': dict(policy=json.dumps(dict(Statement=[]))),
    }
    resources = []
    for kind, name in re.findall(r'^resource "([^"]+)" "([^"]+)"', (media.MODULE / 'main.tf').read_text(), re.MULTILINE):
        if name == 'control_api':
            continue
        resources.append(dict(module='module.dispatcher', type=kind, name=name,
                              instances=[dict(attributes=attributes.get(kind + '.' + name, {}))]))
    return dict(resources=resources, outputs={})


def fixture_config():
    return dict(schema_version=1, do_context='example-context',
                bootstrap_ca_parameter='/chalk/nightly/example-ca', bootstrap_server_name='nightly-recording-control.chalkmeet.com',
                builder=dict(region='example', size='example', image='example', ttl_seconds=1200, ssh_cidr='192.0.2.1/32'),
                worker=dict(region='example', size='example', disk_gb=25),
                runtime=dict(instance_id='i-00000000000000000', parameter_prefix='/chalk/nightly/managed-episode',
                             document_name='chalk-nightly-managed-episode-release', log_group='/chalk/nightly/managed-episode', user_id=1000),
                dispatcher=dict(state_bucket='chalk-nightly-state-000000000000', state_key='transcription/terraform.tfstate',
                                function_name='chalk-nightly-transcription-dispatcher', scheduler_name='chalk-nightly-transcription-reconcile', scheduler_group='chalk-nightly'))


class DispatcherBoundary(unittest.TestCase):
    def test_dispatcher_release_through_executables(self):
        for mode in ('no-op', 'changed-zip', 'binding', 'output-update', 'forbidden-update', 'bad-json', 'missing-state', 'partial-state'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                executable = '#!' + sys.executable + '\n' + (Path(__file__).parent / 'fixtures/media_commands.py').read_text()
                for name in ('aws', 'tofu'):
                    path = root / name
                    path.write_text(executable)
                    path.chmod(0o700)
                config = fixture_config()
                manifest = root / 'manifest.json'
                manifest.write_text(json.dumps(dict(component_releases=dict(api=dict(release_id='example-release')))))
                value = members()
                value['dispatcher']['sha256'] = media.digest(b'ZIP')
                output = root / 'media.json'
                output.write_text(json.dumps(value))
                state = fixture_state(config, 'sha256:' + media.digest(manifest.read_bytes()),
                                      'a' * 64 if mode == 'changed-zip' else value['dispatcher']['sha256'], value['dispatcher']['corpus_digest'])
                if mode == 'binding':
                    function = next(item for item in state['resources'] if item['type'] == 'aws_lambda_function')
                    function['instances'][0]['attributes']['environment'][0]['variables']['CHALK_RELEASE_ID'] = 'example-previous'
                (root / 'installed-state.json').write_text(json.dumps(state))
                initial = copy.deepcopy(state)
                if mode == 'missing-state':
                    initial['resources'] = []
                elif mode == 'partial-state':
                    initial['resources'] = [item for item in state['resources'] if item['type'] == 'aws_iam_role']
                (root / 'state.json').write_text(json.dumps(initial))
                (root / 'config.json').write_text(json.dumps(config))
                args = SimpleNamespace(region='example', config_parameter='/example/config', environment='nightly',
                                       manifest=manifest, output=output, dry_run=False)
                stdout = io.StringIO()
                with patch.dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'], AWS_PROFILE='',
                                MEDIA_FIXTURE=directory, MEDIA_CASE=mode, CHALK_MEDIA_ARTIFACT_BUCKET='example-artifacts'), contextlib.redirect_stdout(stdout):
                    if mode in ('forbidden-update', 'bad-json'):
                        with self.assertRaisesRegex(ValueError, 'resource allowlist' if mode == 'forbidden-update' else 'Expecting value'):
                            media.deploy_dispatcher(args)
                        self.assertEqual(stdout.getvalue(), '')
                    else:
                        media.deploy_dispatcher(args)
                        self.assertTrue(json.loads(stdout.getvalue())['verified'])
                calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
                applies = [call for call in calls if call[0] == 'tofu' and call[2] == 'apply']
                self.assertEqual(len(applies), 0 if mode in ('no-op', 'forbidden-update', 'bad-json') else
                                 1 if mode in ('missing-state', 'partial-state') else 3)
                self.assertTrue(any('get-parameter' in call for call in calls))
                self.assertTrue(any('show' in call for call in calls))
                if mode not in ('forbidden-update', 'bad-json'):
                    self.assertTrue(any('get-function-configuration' in call for call in calls))
                    self.assertTrue(any('get-schedule' in call for call in calls))


if __name__ == '__main__':
    unittest.main()
