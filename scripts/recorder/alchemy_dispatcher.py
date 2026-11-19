"""Read seeded outputs and invoke the checked TypeScript release operation."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from release_core import require
from release_io import private_json

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ['pnpm', '--dir', str(ROOT / 'infrastructure'), 'exec', 'tsx', 'releases/driver.ts']


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


def run_plan(provider, inputs, policy='noop', *, apply=False, plan_output=None):
    """Call one checked TypeScript operation and read its single JSON result."""
    require(not apply or not provider.dry_run, 'dry-run refused Alchemy apply')
    require(policy in ('noop', 'binding', 'release', 'mai'), 'unknown dispatcher policy')
    with tempfile.TemporaryDirectory(prefix='chalk-alchemy-dispatcher-') as temporary:
        directory = Path(temporary)
        source, result_file = directory / 'inputs.json', directory / 'result.json'
        private_json(source, inputs)
        diagnostics = tempfile.NamedTemporaryFile(prefix='chalk-alchemy-diagnostics-', delete=False)
        diagnostics.close()
        process = subprocess.run([*DRIVER, policy, inputs['environment_name'], *(['--apply'] if apply else [])],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 timeout=900, env={**driver_environment(provider), 'CHALK_INFRA_INPUTS': str(source),
                                   'CHALK_ALCHEMY_DIAGNOSTICS': diagnostics.name, 'CHALK_INFRA_RESULT': str(result_file),
                                   **({'CHALK_INFRA_PLAN_OUTPUT': str(plan_output.resolve())} if plan_output else {})})
        require(process.returncode == 0 and result_file.is_file(), 'Alchemy operation failed; private diagnostics: ' + diagnostics.name)
        result = json.loads(result_file.read_text())
        require(result.get('checked') and result.get('applied') == apply, 'Alchemy operation did not confirm its result')
        require(not apply or result.get('second_plan_noop'), 'Alchemy second plan was not no-op')
        return result
