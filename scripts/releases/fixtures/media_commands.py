"""Offline AWS/OpenTofu executables for the dispatcher release boundary tests."""
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys

root = Path(os.environ['MEDIA_FIXTURE'])
args = sys.argv[1:]
command = Path(sys.argv[0]).name
with (root / 'calls.jsonl').open('a') as output:
    output.write(json.dumps([command, *args]) + '\n')
config = json.loads((root / 'config.json').read_text())
state = json.loads((root / 'state.json').read_text())
paths = json.loads((root / 'paths.json').read_text())
fault = os.environ.get('MEDIA_FAULT', '')

environment = {**json.loads((root / 'aws-environment.json').read_text()), 'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'}
if {key: os.environ.get(key) for key in environment} != environment or any(key.startswith('TF_') for key in os.environ):
    raise SystemExit('unexpected command environment')

OPERATIONS = {('ssm', 'get-parameter'), ('s3api', 'list-objects-v2'), ('s3api', 'get-object'), ('s3api', 'put-object'),
              ('lambda', 'get-function-configuration'), ('scheduler', 'get-schedule')}
LAMBDA = 'module.dispatcher.aws_lambda_function.dispatcher'
LOG_GROUP = 'module.dispatcher.aws_cloudwatch_log_group.dispatcher'
SCHEDULER = 'module.dispatcher.aws_scheduler_schedule.reconcile'


def reply(value):
    print(json.dumps(value))


def serial():
    """Return the state generation: every apply and import changes the state, so an older saved plan is stale."""
    return int((root / 'serial').read_text()) if (root / 'serial').exists() else 0


def attributes(kind):
    return next((item['instances'][0]['attributes'] for item in state['resources'] if item['type'] == kind), None)


def declared(path):
    """Return the variable names a variables file requires and the names it accepts."""
    blocks = re.findall(r'^variable "(\w+)" \{\n(.*?)^\}', path.read_text(), re.M | re.S)
    return {name for name, body in blocks if 'default' not in body}, {name for name, _ in blocks}


def reject(message):
    """End the command with a message the test can read back."""
    (root / 'rejected.txt').write_text(message)
    raise SystemExit(message)


def same(actual, expected, message):
    """Compare as JSON text, so the number 1 is not the boolean true."""
    if json.dumps(actual, sort_keys=True) != json.dumps(expected, sort_keys=True):
        reject(message)


def write_late(directory):
    """Make the injected late write once `init` has accepted the configuration, the way a release script that wrote again would."""
    main = directory / 'main.tf.json'
    variables = directory / 'terraform.tfvars.json'
    if fault == 'extra-override':
        (directory / 'override.tf.json').write_text(json.dumps(dict(module=dict(dispatcher=dict(handler='index.other')))))
    elif fault == 'extra-auto-vars':
        (directory / 'release.auto.tfvars.json').write_text(json.dumps(dict(release_id='example-previous')))
    elif fault == 'extra-module':
        tree = json.loads(main.read_text())
        tree['module']['shadow'] = tree['module']['dispatcher']
        main.write_text(json.dumps(tree))
    elif main.exists():
        tree = json.loads(main.read_text())
        tree['module']['dispatcher']['handler'] = 'index.other'
        main.write_text(json.dumps(tree))
    else:
        values = json.loads(variables.read_text())
        values['release_id'] = 'example-previous'
        variables.write_text(json.dumps(values))


def selected_object():
    """Return the object a release must select (the one this run uploaded, else the installed one) and its base64 hash."""
    uploads = json.loads((root / 'uploads.json').read_text()) if (root / 'uploads.json').exists() else {}
    if uploads:
        (key, item), = uploads.items()
        return dict(artifact_s3_bucket=item['bucket'], artifact_s3_key=key, artifact_s3_object_version=item['version']), item['hash']
    function = attributes('aws_lambda_function')
    return dict(artifact_s3_bucket=function['s3_bucket'], artifact_s3_key=function['s3_key'], artifact_s3_object_version=function['s3_object_version']), function['source_code_hash']


def check_lock(directory):
    """Reject a dependency lock file that is not the checked-in one; `tofu apply` reads it too."""
    if (directory / '.terraform.lock.hcl').read_bytes() != (Path(paths['root']) / '.terraform.lock.hcl').read_bytes():
        reject('provider lock file is not the checked-in lock file')


def check_configuration(directory):
    """Reject the configuration directory the way `tofu init` and `tofu validate` would."""
    nightly, module = Path(paths['root']), Path(paths['module'])
    loaded = sorted(path.name for path in directory.iterdir() if path.name.endswith(('.tf', '.tf.json', '.tofu', '.tofu.json', '.tfvars', '.tfvars.json')))
    same(loaded, ['main.tf.json'] if (directory / 'main.tf.json').exists() else ['main.tf', 'terraform.tfvars.json', 'variables.tf'],
         'the directory holds configuration or variable files that the release does not write')
    check_lock(directory)
    binding = json.loads((root / 'binding.json').read_text())
    chosen, object_hash = selected_object()
    release = dict(release_id=binding['release_id'], release_manifest_digest=binding['manifest_digest'], deepinfra_corpus_digest=binding['corpus'],
                   artifact_sha256=binding['zip_digest'], artifact_sha256_base64=object_hash, scheduler_state='ENABLED')
    if (directory / 'main.tf.json').exists():
        tree = json.loads((directory / 'main.tf.json').read_text())
        modules = tree.pop('module')
        same(sorted(modules), ['dispatcher'], 'the root declares modules other than the dispatcher')
        inputs = modules['dispatcher']
        same(tree, dict(terraform=dict(required_providers=dict(aws=dict(source='hashicorp/aws', version='~> 5.0')),
                                       backend=dict(s3=dict(bucket=config['dispatcher']['state_bucket'], key=config['dispatcher']['state_key'],
                                                            region='example', encrypt=True, use_lockfile=True))),
                        provider=dict(aws=dict(region='example'))), 'backend, providers or outputs are not the dispatcher root')
        function, log, invoke = attributes('aws_lambda_function'), attributes('aws_cloudwatch_log_group'), attributes('aws_lambda_function_event_invoke_config')
        target = attributes('aws_scheduler_schedule')['target'][0]
        retry = target['retry_policy'][0]
        variables = function['environment'][0]['variables']
        live = dict(variables, CHALK_RELEASE_ID=release['release_id'], CHALK_RELEASE_MANIFEST_DIGEST=release['release_manifest_digest'],
                    DEEPINFRA_CORPUS_DIGEST=release['deepinfra_corpus_digest'])
        live.pop('CHALK_CONFIG_DIGEST')
        expected = dict({**release, **chosen}, source=str(module), environment_name='nightly', function_name=config['dispatcher']['function_name'],
                        scheduler_name=config['dispatcher']['scheduler_name'], scheduler_group_name=config['dispatcher']['scheduler_group'],
                        control_api_url='https://nightly-api.chalkmeet.com', control_api_audience='chalk-nightly-control-api',
                        api_workload_auth_parameter_arn=variables['CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN'],
                        privacy_gate_accepted=variables['TRANSCRIPTION_PRIVACY_GATE_ACCEPTED'] == 'true',
                        handler=function['handler'], timeout_seconds=function['timeout'], memory_size=function['memory_size'],
                        ephemeral_storage_size=function['ephemeral_storage'][0]['size'], reserved_concurrency=function['reserved_concurrent_executions'],
                        async_max_event_age_seconds=invoke['maximum_event_age_in_seconds'], async_maximum_retry_attempts=invoke['maximum_retry_attempts'],
                        scheduler_input_json=target['input'], scheduler_max_event_age_seconds=retry['maximum_event_age_in_seconds'],
                        scheduler_maximum_retry_attempts=retry['maximum_retry_attempts'], log_retention_days=log['retention_in_days'],
                        log_kms_key_arn=log['kms_key_id'] or None, failure_queue_kms_key_arn=attributes('aws_sqs_queue')['kms_master_key_id'] or None,
                        alarm_actions=attributes('aws_cloudwatch_metric_alarm')['alarm_actions'], ssm_kms_key_arns=[],
                        config_digest='sha256:' + hashlib.sha256(json.dumps(live, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
        required, known = declared(module / 'variables.tf')
        if not required <= set(expected) - {'source'} <= known:
            raise SystemExit('module inputs do not match the module declarations')
        same(inputs, expected, 'module inputs do not describe the installed dispatcher and the requested release')
        return
    expected = (nightly / 'main.tf').read_text().replace('source = "../../opentofu/modules/aws-transcription-dispatcher"', 'source = "' + str(module) + '"')
    if (directory / 'main.tf').read_text() != expected or (directory / 'variables.tf').read_bytes() != (nightly / 'variables.tf').read_bytes():
        raise SystemExit('first-install root is not the checked-in root')
    values = dict(release, privacy_gate_accepted=True, **{key: value for key, value in chosen.items() if key != 'artifact_s3_bucket'})
    values['config_digest'] = 'sha256:' + hashlib.sha256(json.dumps({key: value for key, value in values.items() if key != 'privacy_gate_accepted'}, sort_keys=True).encode()).hexdigest()
    required, known = declared(directory / 'variables.tf')
    if not required <= set(values) <= known:
        raise SystemExit('variable values do not match the root declarations')
    same(json.loads((directory / 'terraform.tfvars.json').read_text()), values, 'variable values do not describe the requested release')


def listed(changed):
    """List every module resource the way a plan does: the changed entries sit between untouched ones."""
    installed = json.loads((root / 'installed-state.json').read_text())
    quiet = [dict(address='module.dispatcher.' + item['type'] + '.' + item['name'], change=dict(actions=['no-op']))
             for item in installed['resources'] if 'module.dispatcher.' + item['type'] + '.' + item['name'] not in changed]
    middle = len(quiet) // 2
    return quiet[:middle] + [dict(address=address, change=change) for address, change in changed.items()] + quiet[middle:]


def planned(inputs, target):
    """Build the plan a real `tofu plan` would save for this case, with the injected fault for its stage."""
    mode = os.environ['MEDIA_CASE']
    stage = 'final' if target is None else 'log' if target.endswith('aws_cloudwatch_log_group.dispatcher') else 'lambda'
    if mode == 'bad-json':
        return 'not JSON'
    changed = {}
    if mode in ('missing-state', 'partial-state') and not (root / 'applied').exists():
        changed[LAMBDA] = dict(actions=['create'], before=None, after={})
    if mode == 'binding' or fault == f'plan-{stage}-field' and stage != 'log':
        before = attributes('aws_lambda_function')
        after = copy.deepcopy(before)
        after.update(s3_key=inputs['artifact_s3_key'], s3_object_version=inputs['artifact_s3_object_version'],
                     source_code_hash=inputs['artifact_sha256_base64'], description=f"Track-aware transcription dispatcher ({inputs['release_id']})")
        after['environment'][0]['variables'].update(CHALK_RELEASE_ID=inputs['release_id'], CHALK_RELEASE_MANIFEST_DIGEST=inputs['release_manifest_digest'],
                                                  CHALK_CONFIG_DIGEST=inputs['config_digest'], DEEPINFRA_CORPUS_DIGEST=inputs['deepinfra_corpus_digest'])
        for tag in ('tags', 'tags_all'):
            after[tag].update(chalk_release_id=inputs['release_id'], chalk_release_manifest_digest=inputs['release_manifest_digest'], chalk_config_digest=inputs['config_digest'])
        if fault == f'plan-{stage}-field':
            after['handler'] = 'index.other'
        changed[LAMBDA] = dict(actions=['update'], before=before, after=after)
    elif fault == f'plan-{stage}-field':
        before = dict(attributes('aws_cloudwatch_log_group'), tags={}, tags_all={})
        after = copy.deepcopy(before)
        after['retention_in_days'] = 14
        for tag in ('tags', 'tags_all'):
            after[tag]['chalk_release_id'] = inputs['release_id']
        changed[LOG_GROUP] = dict(actions=['update'], before=before, after=after)
    elif fault == f'plan-{stage}-replace':
        changed[LOG_GROUP if stage == 'log' else LAMBDA] = dict(actions=['delete', 'create'], before={}, after={})
    elif fault == f'plan-{stage}-resource':
        changed['module.dispatcher.aws_iam_role.dispatcher'] = dict(actions=['update'], before={}, after={'name': 'unexpected'})
    if mode == 'scheduler-repair' and stage == 'final':
        before = attributes('aws_scheduler_schedule')
        changed[SCHEDULER] = dict(actions=['update'], before=before, after=dict(before, state='ENABLED'))
    return dict(resource_changes=listed(changed),
                output_changes=dict(function_arn=dict(actions=['no-op']), identity=dict(actions=['update'] if mode == 'output-update' else ['no-op']),
                                    scheduler_arn=dict(actions=['no-op'])))


if command == 'aws':
    words = args[2:] if args[:1] == ['--profile'] else args
    if words[:1] != ['--region'] or tuple(words[2:4]) not in OPERATIONS:
        raise SystemExit('unexpected AWS command')
    operation = words[3]
    if operation == 'get-parameter':
        reply(dict(Parameter=dict(Value=json.dumps(config))))
    elif operation == 'list-objects-v2':
        reply(dict(Contents=[] if os.environ['MEDIA_CASE'] == 'missing-state' and not (root / 'applied').exists()
                   else [dict(Key=config['dispatcher']['state_key'])]))
    elif operation == 'get-object':
        destination = Path(args[-3])
        destination.write_text(json.dumps(state)) if args[args.index('--key') + 1] == config['dispatcher']['state_key'] else destination.write_bytes(b'ZIP')
        reply({})
    elif operation == 'put-object':
        body = Path(words[words.index('--body') + 1]).read_bytes()
        key = words[words.index('--key') + 1]
        if Path(key).name != hashlib.sha256(body).hexdigest() + '.zip':
            raise SystemExit('uploaded bytes do not match the content-addressed key')
        uploads = json.loads((root / 'uploads.json').read_text()) if (root / 'uploads.json').exists() else {}
        version = 'null' if fault == 'unversioned-upload' else 'uploaded-' + hashlib.sha256(body).hexdigest()[:8]
        uploads[key] = dict(bucket=words[words.index('--bucket') + 1], version=version, hash=base64.b64encode(hashlib.sha256(body).digest()).decode())
        (root / 'uploads.json').write_text(json.dumps(uploads))
        reply(dict(VersionId=version))
    elif operation == 'get-function-configuration':
        expected = ['--region', 'example', 'lambda', 'get-function-configuration',
                    '--function-name', config['dispatcher']['function_name'], '--output', 'json']
        if args != expected:
            raise SystemExit('unexpected Lambda verification command')
        function = attributes('aws_lambda_function')
        counter = root / 'lambda-reads'
        reads = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(reads))
        response = dict(State='Active', LastUpdateStatus='Successful', CodeSha256=function['source_code_hash'], Environment=dict(Variables=function['environment'][0]['variables']))
        if reads > 1:
            if fault == 'unhealthy':
                response['LastUpdateStatus'] = 'Failed'
            elif fault == 'wrong-zip':
                response['CodeSha256'] = 'different-live-zip'
            elif fault == 'stale-release':
                response['Environment']['Variables']['CHALK_RELEASE_ID'] = 'example-previous'
        reply(response)
    elif operation == 'get-schedule':
        reply(dict(State='DISABLED' if fault == 'disabled-scheduler' else attributes('aws_scheduler_schedule')['state']))
    else:
        raise SystemExit('unexpected AWS operation')
else:
    directory = Path(args[0].removeprefix('-chdir='))
    operation = args[1]
    if fault == 'fail-' + operation:
        raise SystemExit('injected OpenTofu failure')
    main = directory / 'main.tf.json'
    inputs = json.loads(main.read_text())['module']['dispatcher'] if main.exists() else json.loads((directory / 'terraform.tfvars.json').read_text())
    if operation in ('init', 'plan', 'import'):
        check_configuration(directory)
    if operation == 'init':
        if fault in ('edit-after-init', 'extra-module', 'extra-override', 'extra-auto-vars'):
            write_late(directory)
    elif operation == 'plan':
        target = next((word.removeprefix('-target=') for word in args if word.startswith('-target=')), None)
        saved = directory / next(word.removeprefix('-out=') for word in args if word.startswith('-out='))
        saved.write_text(json.dumps(dict(plan=planned(inputs, target), inputs=inputs, serial=serial())))
    elif operation == 'show':
        saved = directory / args[-1]
        shown = json.loads((root / 'shown.json').read_text()) if (root / 'shown.json').exists() else {}
        shown[args[-1]] = hashlib.sha256(saved.read_bytes()).hexdigest()
        (root / 'shown.json').write_text(json.dumps(shown))
        plan = json.loads(saved.read_text())['plan']
        print(plan if isinstance(plan, str) else json.dumps(plan))
        if fault == 'corrupt-lock':
            (directory / '.terraform.lock.hcl').write_text('provider {')
    elif operation == 'state':
        print('\n'.join('module.dispatcher.' + item['type'] + '.' + item['name'] for item in state['resources']))
    elif operation == 'apply':
        check_lock(directory)
        saved = directory / args[-1]
        shown = json.loads((root / 'shown.json').read_text()) if (root / 'shown.json').exists() else {}
        if shown.get(args[-1]) != hashlib.sha256(saved.read_bytes()).hexdigest():
            raise SystemExit('saved plan is not the plan that was shown')
        if json.loads(saved.read_text())['serial'] != serial():
            raise SystemExit('Saved plan is stale')
        inputs = json.loads(saved.read_text())['inputs']
        uploads = json.loads((root / 'uploads.json').read_text()) if (root / 'uploads.json').exists() else {}
        installed = attributes('aws_lambda_function')
        objects = [(item['bucket'], key, item['version'], item['hash']) for key, item in uploads.items()]
        if installed:
            objects.append((installed['s3_bucket'], installed['s3_key'], installed['s3_object_version'], installed['source_code_hash']))
        chosen = (inputs.get('artifact_s3_bucket'), inputs['artifact_s3_key'], inputs['artifact_s3_object_version'], inputs['artifact_sha256_base64'])
        if not any(chosen[1:] == item[1:] and chosen[0] in (None, item[0]) for item in objects):
            raise SystemExit('plan selects an object that was neither uploaded nor installed')
        state = json.loads((root / 'installed-state.json').read_text())
        function = attributes('aws_lambda_function')
        function.update(source_code_hash=inputs['artifact_sha256_base64'], s3_key=inputs['artifact_s3_key'], s3_object_version=inputs['artifact_s3_object_version'])
        function['environment'][0]['variables'].update(CHALK_RELEASE_ID=inputs['release_id'], CHALK_RELEASE_MANIFEST_DIGEST=inputs['release_manifest_digest'],
                                                      DEEPINFRA_CORPUS_DIGEST=inputs['deepinfra_corpus_digest'], CHALK_CONFIG_DIGEST=inputs['config_digest'])
        schedule = attributes('aws_scheduler_schedule')
        schedule['state'] = inputs['scheduler_state']
        (root / 'state.json').write_text(json.dumps(state))
        (root / 'applied').touch()
        (root / 'serial').write_text(str(serial() + 1))
    elif operation == 'import':
        (root / 'serial').write_text(str(serial() + 1))
    else:
        raise SystemExit('unexpected tofu operation')
