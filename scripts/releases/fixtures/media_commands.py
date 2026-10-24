"""Offline AWS/OpenTofu executables for the dispatcher release boundary tests."""
import copy
import json
import os
from pathlib import Path
import sys

root = Path(os.environ['MEDIA_FIXTURE'])
args = sys.argv[1:]
command = Path(sys.argv[0]).name
with (root / 'calls.jsonl').open('a') as output:
    output.write(json.dumps([command, *args]) + '\n')
config = json.loads((root / 'config.json').read_text())
state = json.loads((root / 'state.json').read_text())


OPERATIONS = {('ssm', 'get-parameter'), ('s3api', 'list-objects-v2'), ('s3api', 'get-object'), ('s3api', 'put-object'),
              ('lambda', 'get-function-configuration'), ('scheduler', 'get-schedule')}


def reply(value):
    print(json.dumps(value))


if command == 'aws':
    environment = {**json.loads((root / 'aws-environment.json').read_text()), 'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'}
    if {key: os.environ.get(key) for key in environment} != environment:
        raise SystemExit('unexpected AWS environment')
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
        reply(dict(VersionId='example-version'))
    elif operation == 'get-function-configuration':
        expected = ['--region', 'example', 'lambda', 'get-function-configuration',
                    '--function-name', config['dispatcher']['function_name'], '--output', 'json']
        if args != expected:
            raise SystemExit('unexpected Lambda verification command')
        function = next(item['instances'][0]['attributes'] for item in state['resources'] if item['type'] == 'aws_lambda_function')
        counter = root / 'lambda-reads'
        reads = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(reads))
        response = dict(State='Active', LastUpdateStatus='Successful', CodeSha256=function['source_code_hash'], Environment=dict(Variables=function['environment'][0]['variables']))
        if reads > 1:
            fault = os.environ.get('MEDIA_FINAL_FAULT', '')
            if fault == 'unhealthy':
                response['LastUpdateStatus'] = 'Failed'
            elif fault == 'wrong-zip':
                response['CodeSha256'] = 'different-live-zip'
            elif fault == 'stale-release':
                response['Environment']['Variables']['CHALK_RELEASE_ID'] = 'example-previous'
        reply(response)
    elif operation == 'get-schedule':
        reply(dict(State='ENABLED'))
    else:
        raise SystemExit('unexpected AWS operation')
else:
    directory = Path(args[0].removeprefix('-chdir='))
    operation = args[1]
    main = directory / 'main.tf.json'
    inputs = json.loads(main.read_text())['module']['dispatcher'] if main.exists() else json.loads((directory / 'terraform.tfvars.json').read_text())
    if operation == 'show':
        mode = os.environ['MEDIA_CASE']
        if mode == 'bad-json':
            print('not JSON')
        else:
            change = dict(actions=['no-op'])
            address = 'module.dispatcher.aws_lambda_function.dispatcher'
            if mode in ('missing-state', 'partial-state') and not (root / 'applied').exists():
                change = dict(actions=['create'], before=None, after={})
            elif mode == 'binding':
                before = next(item['instances'][0]['attributes'] for item in state['resources'] if item['type'] == 'aws_lambda_function')
                after = copy.deepcopy(before)
                after.update(s3_key=inputs['artifact_s3_key'], s3_object_version=inputs['artifact_s3_object_version'],
                             source_code_hash=inputs['artifact_sha256_base64'], description=f"Track-aware transcription dispatcher ({inputs['release_id']})")
                after['environment'][0]['variables'].update(CHALK_RELEASE_ID=inputs['release_id'], CHALK_RELEASE_MANIFEST_DIGEST=inputs['release_manifest_digest'],
                                                          CHALK_CONFIG_DIGEST=inputs['config_digest'], DEEPINFRA_CORPUS_DIGEST=inputs['deepinfra_corpus_digest'])
                for tag in ('tags', 'tags_all'):
                    after[tag].update(chalk_release_id=inputs['release_id'], chalk_release_manifest_digest=inputs['release_manifest_digest'], chalk_config_digest=inputs['config_digest'])
                change = dict(actions=['update'], before=before, after=after)
            elif mode == 'forbidden-update':
                address = 'module.dispatcher.aws_iam_role.dispatcher'
                change = dict(actions=['update'], before={}, after={'name': 'unexpected'})
            reply(dict(resource_changes=[dict(address=address, change=change)],
                       output_changes=dict(identity=dict(actions=['update'] if mode == 'output-update' else ['no-op']))))
    elif operation == 'state':
        print('\n'.join('module.dispatcher.' + item['type'] + '.' + item['name'] for item in state['resources']))
    elif operation == 'apply':
        state = json.loads((root / 'installed-state.json').read_text())
        function = next(item['instances'][0]['attributes'] for item in state['resources'] if item['type'] == 'aws_lambda_function')
        function.update(source_code_hash=inputs['artifact_sha256_base64'], s3_key=inputs['artifact_s3_key'], s3_object_version=inputs['artifact_s3_object_version'])
        function['environment'][0]['variables'].update(CHALK_RELEASE_ID=inputs['release_id'], CHALK_RELEASE_MANIFEST_DIGEST=inputs['release_manifest_digest'],
                                                      DEEPINFRA_CORPUS_DIGEST=inputs['deepinfra_corpus_digest'], CHALK_CONFIG_DIGEST=inputs['config_digest'])
        (root / 'state.json').write_text(json.dumps(state))
        (root / 'applied').touch()
    elif operation not in ('init', 'plan', 'import'):
        raise SystemExit('unexpected tofu operation')
