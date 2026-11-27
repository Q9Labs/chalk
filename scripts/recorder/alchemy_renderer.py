"""Read seeded document-renderer outputs and invoke its checked TypeScript release operation."""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from release_core import require
from release_io import private_json
from alchemy_dispatcher import unredact, driver_environment, keep_private

ROOT = Path(__file__).resolve().parents[2]
DRIVERS = {'zip': 'releases/renderer-driver.ts', 'image': 'releases/renderer-image-driver.ts'}
STACKS = {'zip': ('document-renderer', ''), 'image': ('document-renderer-image', '-image')}
OUTPUT = 'renderer_inputs'


def read_inputs(provider, environment='production', package='zip'):
    require(environment == 'production', 'document-renderer managed releases support production only')
    STACK, suffix = STACKS[package]
    # Same pinned beta.87 DynamoDB output encoding as alchemy_dispatcher.read_inputs.
    result = provider.aws('dynamodb', 'get-item', '--table-name', 'alchemy-state', '--consistent-read',
                          '--key', json.dumps({'PK': {'S': f'STAGE#{STACK}#{environment}'}, 'SK': {'S': 'OUTPUT'}}))
    item = result.get('Item', {})
    require(item, 'Document renderer has no Alchemy state; run the explicit production bootstrap before release')
    if 'data' in item:
        output = json.loads(item['data']['S'])
    else:
        require('ref' in item, 'Alchemy output has neither inline data nor an overflow reference')
        require(item['ref']['S'].startswith(f'{STACK}/{environment}/OUTPUT-'), 'Alchemy renderer output overflow identity mismatch')
        account = provider.aws('sts', 'get-caller-identity')['Account']
        with tempfile.TemporaryDirectory(prefix='chalk-renderer-output-') as directory:
            path = Path(directory) / 'output.json'
            provider.aws('s3api', 'get-object', '--bucket', f'alchemy-state-overflow-{account}-{provider.region}-an', '--key', item['ref']['S'], path)
            path.chmod(0o600)
            output = json.loads(path.read_text())
    inputs = unredact(output[OUTPUT])
    require(inputs['function_name'] == f'chalk-{environment}-document-renderer{suffix}' and inputs['environment_name'] == environment,
            'Alchemy document-renderer state identity mismatch')
    return inputs


def run_plan(provider, inputs, policy='noop', *, apply=False, plan_output=None):
    """Call one checked renderer TypeScript operation and read its single JSON result."""
    require(not apply or not provider.dry_run, 'dry-run refused Alchemy apply')
    require(policy in ('noop', 'release'), 'unknown renderer policy')
    package = inputs.get('package_type', 'zip')
    require(package in DRIVERS, 'unknown renderer package type')
    with tempfile.TemporaryDirectory(prefix='chalk-alchemy-renderer-') as temporary:
        directory = Path(temporary)
        source, result_file = directory / 'inputs.json', directory / 'result.json'
        private_json(source, inputs)
        diagnostics = directory / 'diagnostics.txt'
        process = subprocess.run(['pnpm', '--dir', str(ROOT / 'infrastructure'), 'exec', 'tsx', DRIVERS[package], policy, inputs['environment_name'], *(['--apply'] if apply else [])],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                                 timeout=900, env={**driver_environment(provider), 'CHALK_INFRA_INPUTS': str(source),
                                   'CHALK_ALCHEMY_DIAGNOSTICS': str(diagnostics), 'CHALK_INFRA_RESULT': str(result_file),
                                   **({'CHALK_INFRA_PLAN_OUTPUT': str(plan_output.resolve())} if plan_output else {})})
        if process.returncode != 0 or not result_file.is_file():
            reason = next((line for line in reversed(process.stderr.splitlines()) if line.startswith('Infrastructure ')), 'no failure line')
            raise ValueError(f'Alchemy renderer operation failed ({reason}); private diagnostics: ' + keep_private(diagnostics))
        result = json.loads(result_file.read_text())
        require(result.get('checked') and result.get('applied') == apply, 'Alchemy renderer operation did not confirm its result')
        require(not apply or result.get('second_plan_noop'), 'Alchemy renderer second plan was not no-op')
        return result
