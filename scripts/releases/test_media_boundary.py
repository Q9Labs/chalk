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
                       CONTROL_API_AUDIENCE='chalk-nightly-control-api', TRANSCRIPTION_PRIVACY_GATE_ACCEPTED='true',
                       CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN='arn:aws:ssm:example:000000000000:parameter/example/workload-auth')
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


STATE_BUCKET = 'chalk-nightly-state-000000000000'
STATE_KEY = 'transcription/terraform.tfstate'


def aws(*words):
    return ('aws', '--region', 'example', *words, '--output', 'json')


def tofu(*words):
    return ('tofu', '-chdir=<work>', *words)


COMMANDS = {
    'config': aws('ssm', 'get-parameter', '--name', '/example/config', '--with-decryption'),
    'list': aws('s3api', 'list-objects-v2', '--bucket', STATE_BUCKET, '--prefix', STATE_KEY),
    'state': aws('s3api', 'get-object', '--bucket', STATE_BUCKET, '--key', STATE_KEY, '<state>/state.json'),
    'artifact': aws('s3api', 'get-object', '--bucket', 'example-artifacts', '--key', 'transcription-dispatcher/example/' + 'd' * 64 + '.zip',
                    '--version-id', 'immutable-version', '<work>/dispatcher.zip'),
    'upload': aws('s3api', 'put-object', '--bucket', 'example-artifacts',
                  '--key', 'transcription-dispatcher/example-release/' + media.digest(b'ZIP') + '.zip', '--body', '<work>/dispatcher.zip'),
    'lambda': aws('lambda', 'get-function-configuration', '--function-name', 'chalk-nightly-transcription-dispatcher'),
    'schedule': aws('scheduler', 'get-schedule', '--name', 'chalk-nightly-transcription-reconcile', '--group-name', 'chalk-nightly'),
    'init': tofu('init', '-input=false', '-upgrade=false'),
    'init-first': tofu('init', '-input=false', '-upgrade=false', '-backend-config=bucket=' + STATE_BUCKET),
    'plan-log': tofu('plan', '-input=false', '-no-color', '-target=module.dispatcher.aws_cloudwatch_log_group.dispatcher', '-out=release.plan'),
    'plan-lambda': tofu('plan', '-input=false', '-no-color', '-target=module.dispatcher.aws_lambda_function.dispatcher', '-out=release.plan'),
    'plan': tofu('plan', '-input=false', '-no-color', '-out=release.plan'),
    'show': tofu('show', '-json', 'release.plan'),
    'apply': tofu('apply', '-input=false', '-no-color', 'release.plan'),
    'state-list': tofu('state', 'list'),
    'import-role': tofu('import', '-input=false', 'module.dispatcher.aws_iam_role.dispatcher', 'chalk-nightly-transcription-dispatcher-execution'),
    'import-scheduler-role': tofu('import', '-input=false', 'module.dispatcher.aws_iam_role.scheduler', 'chalk-nightly-transcription-dispatcher-scheduler'),
    'import-log': tofu('import', '-input=false', 'module.dispatcher.aws_cloudwatch_log_group.dispatcher', '/aws/lambda/chalk-nightly-transcription-dispatcher'),
}
INSTALLED = 'config list state state artifact list state state'
START = INSTALLED + ' upload lambda init'
FIRST_INSTALL = 'config list artifact list upload init-first list import-role import-scheduler-role import-log'
CASE_COMMANDS = {
    ('no-op', ''): INSTALLED + ' lambda init plan-log show plan-lambda show plan show state lambda schedule',
    ('changed-zip', ''): START + ' plan-log show apply plan-lambda show apply plan show apply state lambda schedule',
    ('binding', ''): START + ' plan-log show apply plan-lambda show apply plan show apply state lambda schedule',
    ('output-update', ''): INSTALLED + ' lambda init plan-log show apply plan-lambda show apply plan show apply state lambda schedule',
    ('bad-json', ''): INSTALLED + ' lambda init plan-log show',
    ('missing-state', ''): FIRST_INSTALL + ' plan show apply state lambda schedule',
    ('partial-state', ''): 'config list state artifact list state upload init-first list state-list import-log plan show apply state lambda schedule',
    ('scheduler-repair', ''): INSTALLED + ' lambda init plan-log show plan-lambda show plan show apply state lambda schedule',
    ('no-op', 'disabled-scheduler'): INSTALLED + ' lambda init plan-log show plan-lambda show plan show state lambda schedule',
    ('missing-state', 'production'): 'config list artifact list',
    ('changed-zip', 'production-installed'): START + ' plan-log show apply plan-lambda show apply plan show apply state lambda schedule',
    ('missing-state', 'plan-final-replace'): FIRST_INSTALL + ' plan show',
    ('changed-zip', 'unversioned-upload'): INSTALLED + ' upload',
    ('no-op', 'fail-init'): INSTALLED + ' lambda init',
    ('no-op', 'fail-plan'): INSTALLED + ' lambda init plan-log',
    ('changed-zip', 'fail-apply'): START + ' plan-log show apply',
    ('missing-state', 'fail-import'): FIRST_INSTALL.removesuffix(' import-scheduler-role import-log'),
    ('no-op', 'edit-after-init'): INSTALLED + ' lambda init plan-log',
    ('no-op', 'extra-module'): INSTALLED + ' lambda init plan-log',
    ('no-op', 'extra-override'): INSTALLED + ' lambda init plan-log',
    ('missing-state', 'edit-after-init'): FIRST_INSTALL.removesuffix(' import-scheduler-role import-log'),
    ('missing-state', 'extra-auto-vars'): FIRST_INSTALL.removesuffix(' import-scheduler-role import-log'),
    ('changed-zip', 'corrupt-lock'): START + ' plan-log show apply',
}
for mode in ('no-op', 'changed-zip'):
    for fault in ('unhealthy', 'wrong-zip', 'stale-release'):
        CASE_COMMANDS[mode, fault] = CASE_COMMANDS[mode, ''].removesuffix(' schedule')
for stage, plan, before in (('log', 'plan-log', ''), ('lambda', 'plan-lambda', ' plan-log show apply'), ('final', 'plan', ' plan-log show apply plan-lambda show apply')):
    for kind in ('field', 'replace', 'resource'):
        CASE_COMMANDS['changed-zip', f'plan-{stage}-{kind}'] = START + before + f' {plan} show'
REJECTIONS = {'unhealthy': 'dispatcher update is not healthy', 'wrong-zip': 'dispatcher ZIP digest changed',
              'stale-release': 'dispatcher runtime release binding mismatch', 'disabled-scheduler': 'dispatcher scheduler is not enabled',
              'production': 'production dispatcher must already be provisioned', 'unversioned-upload': 'dispatcher destination bucket is not versioned', 'field': 'dispatcher plan changes more than code',
              'resource': 'dispatcher update exceeds resource allowlist', 'replace': 'dispatcher update must not create, replace or delete resources'}
EXTRA_FILE = 'the directory holds configuration or variable files that the release does not write'
LATE_REJECTIONS = {('no-op', 'edit-after-init'): 'module inputs do not describe the installed dispatcher and the requested release',
                   ('missing-state', 'edit-after-init'): 'variable values do not describe the requested release',
                   ('no-op', 'extra-module'): 'the root declares modules other than the dispatcher',
                   ('no-op', 'extra-override'): EXTRA_FILE, ('missing-state', 'extra-auto-vars'): EXTRA_FILE,
                   ('changed-zip', 'corrupt-lock'): 'provider lock file is not the checked-in lock file'}
ZIP_DIGEST = media.digest(b'ZIP')


def rejection(mode, fault):
    """Return the error that ends a case, or None when the release must succeed."""
    if mode == 'bad-json':
        return 'Expecting value'
    if fault.startswith('fail-') or (mode, fault) in LATE_REJECTIONS:
        return 'tofu operation failed'
    if mode == 'missing-state' and fault == 'plan-final-replace':
        return 'first-install dispatcher plan must not destroy or replace resources'
    return REJECTIONS.get(fault) or REJECTIONS.get(fault.rsplit('-', 1)[-1])


def released(mode):
    """Return the success payload: uploads get a new object, other cases keep the installed one."""
    uploaded = mode in ('changed-zip', 'binding', 'missing-state', 'partial-state')
    return dict(release_id='example-release', verified=True, artifact_sha256=ZIP_DIGEST, artifact_bucket='example-artifacts', scheduler_state='ENABLED',
                artifact_key='transcription-dispatcher/example-release/' + (ZIP_DIGEST if uploaded else 'example') + '.zip',
                artifact_version_id='uploaded-' + ZIP_DIGEST[:8] if uploaded else 'example-version')


TEMPORARY_STATE = re.compile(re.escape(tempfile.gettempdir()) + r'/chalk-release-state-\w+')


WORK = re.compile(re.escape(tempfile.gettempdir()) + r'/chalk-dispatcher-release-\w+')


def recorded_commands(calls):
    """Name each recorded call by its argv, with the case's temporary directories made stable."""
    work = WORK.search(' '.join(word for call in calls for word in call)).group()
    return [tuple(TEMPORARY_STATE.sub('<state>', word.replace(work, '<work>')) for word in call) for call in calls]


class DispatcherBoundary(unittest.TestCase):
    def test_dispatcher_release_through_executables(self):
        for mode, fault in CASE_COMMANDS:
            with self.subTest(mode=mode, fault=fault), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                executable = '#!' + sys.executable + '\n' + (Path(__file__).parent / 'fixtures/media_commands.py').read_text()
                for name in ('aws', 'tofu'):
                    path = root / name
                    path.write_text(executable)
                    path.chmod(0o700)
                config = fixture_config()
                production = fault in ('production', 'production-installed')
                if production:
                    config['runtime']['parameter_prefix'] = config['runtime']['parameter_prefix'].replace('nightly', 'production')
                    config['bootstrap_ca_parameter'] = config['bootstrap_ca_parameter'].replace('nightly', 'production')
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
                if mode == 'scheduler-repair':
                    next(item for item in state['resources'] if item['type'] == 'aws_scheduler_schedule')['instances'][0]['attributes']['state'] = 'DISABLED'
                (root / 'installed-state.json').write_text(json.dumps(state))
                initial = copy.deepcopy(state)
                if mode == 'missing-state':
                    initial['resources'] = []
                elif mode == 'partial-state':
                    initial['resources'] = [item for item in state['resources'] if item['type'] == 'aws_iam_role']
                (root / 'state.json').write_text(json.dumps(initial))
                (root / 'config.json').write_text(json.dumps(config))
                aws_environment = dict.fromkeys(('AWS_DEFAULT_PROFILE', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_LAMBDA',
                                                 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_SSM', 'AWS_ENDPOINT_URL_SCHEDULER',
                                                 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'))
                aws_environment['AWS_PROFILE'] = ''
                (root / 'aws-environment.json').write_text(json.dumps(aws_environment))
                (root / 'binding.json').write_text(json.dumps(dict(release_id='example-release', manifest_digest='sha256:' + media.digest(manifest.read_bytes()),
                                                                   corpus=value['dispatcher']['corpus_digest'], zip_digest=ZIP_DIGEST)))
                (root / 'paths.json').write_text(json.dumps(dict(module=str(media.MODULE), root=str(media.ROOT / 'infrastructure/nightly/transcription'))))
                args = SimpleNamespace(region='example', config_parameter='/example/config', environment='production' if production else 'nightly',
                                       manifest=manifest, output=output, dry_run=False)
                stdout = io.StringIO()
                with patch.dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'], AWS_PROFILE='',
                                MEDIA_FIXTURE=directory, MEDIA_CASE=mode, MEDIA_FAULT=fault, CHALK_MEDIA_ARTIFACT_BUCKET='example-artifacts'), contextlib.redirect_stdout(stdout):
                    for key, value in aws_environment.items():
                        if value is None:
                            os.environ.pop(key, None)
                    for key in [key for key in os.environ if key.startswith('TF_')]:
                        del os.environ[key]
                    message = rejection(mode, fault)
                    if message:
                        with self.assertRaisesRegex((ValueError, RuntimeError), message):
                            media.deploy_dispatcher(args)
                        self.assertEqual(stdout.getvalue(), '')
                        if (mode, fault) in LATE_REJECTIONS:
                            self.assertEqual((root / 'rejected.txt').read_text(), LATE_REJECTIONS[mode, fault])
                    else:
                        media.deploy_dispatcher(args)
                        self.assertEqual(json.loads(stdout.getvalue()), released(mode))
                calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
                self.assertEqual(recorded_commands(calls), [COMMANDS[name] for name in CASE_COMMANDS[mode, fault].split()])


if __name__ == '__main__':
    unittest.main()
