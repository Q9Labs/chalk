"""Private protocol to the pinned Alchemist engine and closed release policies."""
import copy
import json
import os
import selectors
import subprocess
import tempfile
from pathlib import Path

from release_core import require
from release_io import private_json

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ['pnpm', '--dir', str(ROOT / 'infrastructure'), 'exec', 'tsx', 'alchemy/dispatcher/driver.ts']
TYPES = {
    'ExecutionRole': 'AWS.IAM.Role', 'SchedulerRole': 'AWS.IAM.Role', 'AsyncFailure': 'AWS.SQS.Queue',
    'SchedulerDlq': 'AWS.SQS.Queue', 'Logs': 'AWS.Logs.LogGroup', 'Function': 'Chalk.Lambda.VersionedFunction',
    'Reconcile': 'AWS.Scheduler.Schedule', 'SchedulerPermission': 'AWS.Lambda.Permission',
    'ControlApiPermission': 'AWS.Lambda.Permission',
    **{name: 'AWS.CloudWatch.Alarm' for name in ('Errors', 'Throttles', 'AsyncEventsDropped', 'AsyncFailureDepth', 'SchedulerTargetErrors')},
}


def unredact(value):
    if isinstance(value, dict):
        if set(value) == {'__redacted__'}:
            return unredact(value['__redacted__'])
        return {k: unredact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [unredact(v) for v in value]
    return value


def driver_environment(provider):
    return {**os.environ, 'AWS_REGION': provider.region, **({'AWS_PROFILE': provider.profile} if provider.profile else {})}


def read_inputs(provider, config):
    environment = config['function_name'].removeprefix('chalk-').removesuffix('-transcription-dispatcher')
    require(environment in ('nightly', 'production'), 'unsupported dispatcher environment')
    # Pinned beta.87 DynamoDB output encoding (DynamoDBState.ts:134,1149).
    # Read directly so pin retention/rollback needs only AWS CLI, never a Node
    # install, state bootstrap or a deploy lease. Planning uses StateService.
    result = provider.aws('dynamodb', 'get-item', '--table-name', 'alchemy-state', '--consistent-read',
                          '--key', json.dumps({'PK': {'S': 'STAGE#transcription-dispatcher#' + environment}, 'SK': {'S': 'OUTPUT'}}))
    item = result.get('Item', {})
    require(item, 'Dispatcher has no Alchemy state; explicitly seed the environment before release')
    if 'data' in item:
        output = json.loads(item['data']['S'])
    else:
        require('ref' in item, 'Alchemy output has neither inline data nor an overflow reference')
        require(item['ref']['S'].startswith(f'transcription-dispatcher/{environment}/OUTPUT-'), 'Alchemy output overflow identity mismatch')
        account = provider.aws('sts', 'get-caller-identity')['Account']
        with tempfile.TemporaryDirectory(prefix='chalk-alchemy-output-') as directory:
            path = Path(directory) / 'output.json'
            provider.aws('s3api', 'get-object', '--bucket', f'alchemy-state-overflow-{account}-{provider.region}-an', '--key', item['ref']['S'], path)
            path.chmod(0o600)
            output = json.loads(path.read_text())
    inputs = unredact(output['dispatcher_inputs'])
    require(inputs['function_name'] == config['function_name'] and inputs['environment_name'] == environment,
            'Alchemy dispatcher state identity mismatch')
    return inputs


def check_plan(plan, mutations, output_names):
    """Compare stored desired props, not provider-computed live attributes."""
    seen = set()
    for row in plan['resources']:
        name = row['id']
        require(name in TYPES and name not in seen and row['type'] == TYPES[name], 'dispatcher plan contains an unexpected resource')
        seen.add(name)
        require(row['action'] in ('noop', 'update'), 'dispatcher plan must not create, adopt, delete or replace resources')
        before, after = unredact(copy.deepcopy(row['before'])), unredact(copy.deepcopy(row['after']))
        require(isinstance(before, dict) and isinstance(after, dict), 'dispatcher props must be completely known')
        if row['action'] == 'noop':
            require(before == after, 'no-op dispatcher props differ')
            continue
        require(name in mutations, 'dispatcher plan exceeds resource allowlist')
        mutations[name](before)
        require(before == after, 'dispatcher plan changes a property outside the allowlist')
    required = set(TYPES) - {'ControlApiPermission'}
    require(required <= seen, 'dispatcher plan is partial; full-stack checks are required')
    before = unredact(copy.deepcopy(plan['outputs']['before']))
    after = unredact(copy.deepcopy(plan['outputs']['after']))
    require(set(before) == set(after), 'dispatcher output names changed')
    require(all(before[k] == after[k] for k in before if k not in output_names | {'dispatcher_inputs'}), 'dispatcher plan changes unrelated outputs')
    # Even inactive/unused inputs cannot silently change with a release. The
    # caller checks the exact desired input edits independently of cloud props.


def run_plan(provider, inputs, checker, *, apply=False, plan_output=None, allowed_inputs=()):
    require(not apply or not provider.dry_run, 'dry-run refused Alchemy apply')
    with tempfile.TemporaryDirectory(prefix='chalk-alchemy-dispatcher-') as temporary:
        directory = Path(temporary)
        source = directory / 'inputs.json'
        private_json(source, inputs)
        diagnostics = tempfile.NamedTemporaryFile(prefix='chalk-alchemy-diagnostics-', delete=False)
        diagnostics.close()
        process = subprocess.Popen([*DRIVER, 'plan', inputs['environment_name'], '--protocol'],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, bufsize=1, env={**driver_environment(provider), 'CHALK_DISPATCHER_INPUTS': str(source),
                                                            'CHALK_ALCHEMY_DIAGNOSTICS': diagnostics.name})
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    require(selector.select(600), 'Alchemy dispatcher plan timed out')
                    line = process.stdout.readline()
                    require(line, 'Alchemy dispatcher failed before plan; private diagnostics: ' + diagnostics.name)
                    if line.startswith('CHALK_DISPATCHER_PLAN='):
                        plan = json.loads(line.split('=', 1)[1])
                        break
            if plan_output:
                private_json(plan_output, plan)
            before_inputs = unredact(plan['outputs']['before']['dispatcher_inputs'])
            after_inputs = unredact(plan['outputs']['after']['dispatcher_inputs'])
            require(after_inputs == inputs, 'planned inputs differ from the requested configuration')
            require(set(before_inputs) == set(after_inputs) and all(before_inputs[k] == after_inputs[k] for k in before_inputs if k not in allowed_inputs), 'dispatcher plan changes unrelated inputs')
            checker(plan)
            stdout, _ = process.communicate('approve\n' if apply else 'reject\n', timeout=900)
            require(process.returncode == 0, 'Alchemy dispatcher apply/verification failed; private diagnostics: ' + diagnostics.name)
            results = [json.loads(line.split('=', 1)[1]) for line in stdout.splitlines() if line.startswith('CHALK_DISPATCHER_RESULT=')]
            require(len(results) == 1 and results[0]['applied'] == apply, 'Alchemy dispatcher protocol did not confirm its decision')
            if apply:
                require(results[0].get('second_plan_noop'), 'Alchemy dispatcher second plan was not no-op')
            return results[0]
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
