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


def reply(value):
    print(json.dumps(value))


def attributes(kind):
    return next((item['instances'][0]['attributes'] for item in state['resources'] if item['type'] == kind), None)


def declared(path):
    """Return the variable names a variables file requires and the names it accepts."""
    blocks = re.findall(r'^variable "(\w+)" \{\n(.*?)^\}', path.read_text(), re.M | re.S)
    return {name for name, body in blocks if 'default' not in body}, {name for name, _ in blocks}


def check_configuration(directory):
    """Reject the configuration directory the way `tofu init` and `tofu validate` would."""
    nightly, module = Path(paths['root']), Path(paths['module'])
    if (directory / '.terraform.lock.hcl').read_bytes() != (nightly / '.terraform.lock.hcl').read_bytes():
        raise SystemExit('provider lock file is not the checked-in lock file')
    if (directory / 'main.tf.json').exists():
        tree = json.loads((directory / 'main.tf.json').read_text())
        backend = tree['terraform']['backend']['s3']
        if (backend['bucket'], backend['key'], backend['region']) != (config['dispatcher']['state_bucket'], config['dispatcher']['state_key'], 'example'):
            raise SystemExit('backend does not point at the dispatcher state')
        if tree['provider'] != {'aws': {'region': 'example'}}:
            raise SystemExit('unexpected provider configuration')
        inputs = tree['module']['dispatcher']
        if Path(inputs['source']) != module:
            raise SystemExit('module source is not the dispatcher module')
        required, known = declared(module / 'variables.tf')
        names = set(inputs) - {'source'}
        identity = dict(environment_name='nightly', function_name=config['dispatcher']['function_name'],
                        scheduler_name=config['dispatcher']['scheduler_name'], scheduler_group_name=config['dispatcher']['scheduler_group'],
                        control_api_url='https://nightly-api.chalkmeet.com', control_api_audience='chalk-nightly-control-api')
        if not required <= names <= known or {key: inputs[key] for key in identity} != identity:
            raise SystemExit('module inputs do not match the module declarations')
        live = dict(attributes('aws_lambda_function')['environment'][0]['variables'], CHALK_RELEASE_ID=inputs['release_id'],
                    CHALK_RELEASE_MANIFEST_DIGEST=inputs['release_manifest_digest'], DEEPINFRA_CORPUS_DIGEST=inputs['deepinfra_corpus_digest'])
        live.pop('CHALK_CONFIG_DIGEST')
        if inputs['config_digest'] != 'sha256:' + hashlib.sha256(json.dumps(live, sort_keys=True, separators=(',', ':')).encode()).hexdigest():
            raise SystemExit('config digest does not describe the Lambda environment')
        return
    expected = (nightly / 'main.tf').read_text().replace('source = "../../opentofu/modules/aws-transcription-dispatcher"', 'source = "' + str(module) + '"')
    if (directory / 'main.tf').read_text() != expected or (directory / 'variables.tf').read_bytes() != (nightly / 'variables.tf').read_bytes():
        raise SystemExit('first-install root is not the checked-in root')
    required, known = declared(directory / 'variables.tf')
    values = json.loads((directory / 'terraform.tfvars.json').read_text())
    if not required <= set(values) <= known or values['privacy_gate_accepted'] is not True or values['scheduler_state'] != 'ENABLED':
        raise SystemExit('variable values do not match the root declarations')
    described = {key: value for key, value in values.items() if key not in ('privacy_gate_accepted', 'config_digest')}
    if values['config_digest'] != 'sha256:' + hashlib.sha256(json.dumps(described, sort_keys=True).encode()).hexdigest():
        raise SystemExit('config digest does not describe the variable values')


def planned(inputs, target):
    """Build the plan a real `tofu plan` would save for this case, with the injected fault for its stage."""
    mode = os.environ['MEDIA_CASE']
    stage = 'final' if target is None else 'log' if target.endswith('aws_cloudwatch_log_group.dispatcher') else 'lambda'
    if mode == 'bad-json':
        return 'not JSON'
    address, change = LAMBDA, dict(actions=['no-op'])
    if mode in ('missing-state', 'partial-state') and not (root / 'applied').exists():
        change = dict(actions=['create'], before=None, after={})
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
        change = dict(actions=['update'], before=before, after=after)
    elif fault == f'plan-{stage}-field':
        before = dict(attributes('aws_cloudwatch_log_group'), tags={}, tags_all={})
        after = copy.deepcopy(before)
        after['retention_in_days'] = 14
        for tag in ('tags', 'tags_all'):
            after[tag]['chalk_release_id'] = inputs['release_id']
        address, change = LOG_GROUP, dict(actions=['update'], before=before, after=after)
    elif fault == f'plan-{stage}-replace':
        address, change = LOG_GROUP if stage == 'log' else LAMBDA, dict(actions=['delete', 'create'], before={}, after={})
    elif fault == f'plan-{stage}-resource':
        address, change = 'module.dispatcher.aws_iam_role.dispatcher', dict(actions=['update'], before={}, after={'name': 'unexpected'})
    return dict(resource_changes=[dict(address=address, change=change)],
                output_changes=dict(identity=dict(actions=['update'] if mode == 'output-update' else ['no-op'])))


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
        reply(dict(State='DISABLED' if fault == 'disabled-scheduler' else 'ENABLED'))
    else:
        raise SystemExit('unexpected AWS operation')
else:
    directory = Path(args[0].removeprefix('-chdir='))
    operation = args[1]
    if fault == 'fail-' + operation:
        raise SystemExit('injected OpenTofu failure')
    main = directory / 'main.tf.json'
    inputs = json.loads(main.read_text())['module']['dispatcher'] if main.exists() else json.loads((directory / 'terraform.tfvars.json').read_text())
    if operation == 'init':
        check_configuration(directory)
    elif operation == 'plan':
        target = next((word.removeprefix('-target=') for word in args if word.startswith('-target=')), None)
        saved = directory / next(word.removeprefix('-out=') for word in args if word.startswith('-out='))
        saved.write_text(json.dumps(dict(plan=planned(inputs, target), inputs=inputs)))
    elif operation == 'show':
        plan = json.loads((directory / args[-1]).read_text())['plan']
        print(plan if isinstance(plan, str) else json.dumps(plan))
    elif operation == 'state':
        print('\n'.join('module.dispatcher.' + item['type'] + '.' + item['name'] for item in state['resources']))
    elif operation == 'apply':
        inputs = json.loads((directory / args[-1]).read_text())['inputs']
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
        (root / 'state.json').write_text(json.dumps(state))
        (root / 'applied').touch()
    elif operation != 'import':
        raise SystemExit('unexpected tofu operation')
