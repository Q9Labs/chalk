#!/usr/bin/env python3
"""Migrate only the MAI secret grant and dispatcher selection; never deploy code."""
import argparse
import copy
import json
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/recorder'))
from dispatcher_binding import dispatcher_root, MODULE, has_unknown
from release_core import digest, require, validate_config
from release_io import Provider, private_json


def policy_with_secret(policy, arn, enabled):
    result = copy.deepcopy(policy)
    matched = False
    for statement in result['Statement']:
        if statement.get('Sid') == 'ReadOnlyTranscriptionAndApiSecrets':
            values = statement['Resource']
            values = values if isinstance(values, list) else [values]
            values = set(values)
            values.add(arn) if enabled else values.discard(arn)
            statement['Resource'] = sorted(values)
            matched = True
        condition = statement.get('Condition', {}).get('StringEquals', {})
        if 'kms:EncryptionContext:PARAMETER_ARN' in condition:
            values = condition['kms:EncryptionContext:PARAMETER_ARN']
            values = set(values if isinstance(values, list) else [values])
            values.add(arn) if enabled else values.discard(arn)
            condition['kms:EncryptionContext:PARAMETER_ARN'] = sorted(values)
    require(matched, 'dispatcher secret-read policy is missing')
    return result


def canonical_policy(policy):
    result = copy.deepcopy(policy)
    for statement in result['Statement']:
        for key in ('Resource', 'Action'):
            if key in statement:
                value = statement[key]
                statement[key] = sorted(value if isinstance(value, list) else [value])
        condition = statement.get('Condition', {}).get('StringEquals', {})
        key = 'kms:EncryptionContext:PARAMETER_ARN'
        if key in condition:
            value = condition[key]
            condition[key] = sorted(value if isinstance(value, list) else [value])
    result['Statement'].sort(key=lambda item: item.get('Sid', ''))
    return result


def check_plan(plan, arn, enabled, environment):
    for item in plan.get('resource_changes', []):
        change = item['change']
        if change['actions'] in (['no-op'], ['read']):
            continue
        require(change['actions'] == ['update'], 'MAI migration may not create, replace or delete resources')
        before, after = copy.deepcopy(change['before']), copy.deepcopy(change['after'])
        address = item['address']
        if address == 'module.dispatcher.aws_iam_role_policy.dispatcher':
            expected = canonical_policy(policy_with_secret(json.loads(before.pop('policy')), arn, enabled))
            require(canonical_policy(json.loads(after.pop('policy'))) == expected, 'MAI migration expands permissions beyond its secret')
            require(not has_unknown(change.get('after_unknown', {})), 'MAI policy must be completely known')
        elif address == 'module.dispatcher.aws_lambda_function.dispatcher':
            before['environment'][0]['variables'] = environment
            for key in ('tags', 'tags_all'):
                before[key]['chalk_config_digest'] = environment['CHALK_CONFIG_DIGEST']
            computed = {'last_modified', 'qualified_arn', 'qualified_invoke_arn', 'version', 'code_sha256', 'source_code_size'}
            require(all(name in computed or not has_unknown(value) for name, value in change.get('after_unknown', {}).items()), 'unknown MAI runtime field')
            for name in computed:
                before.pop(name, None)
                after.pop(name, None)
        else:
            raise ValueError('MAI migration exceeds its resource allowlist')
        require(before == after, 'MAI migration changes unrelated resource fields')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', required=True, choices=('nightly', 'production'))
    parser.add_argument('--profile', default='q9labs')
    parser.add_argument('--region', default='ap-southeast-1')
    parser.add_argument('--secret-parameter-arn')
    parser.add_argument('--disable', action='store_true')
    parser.add_argument('--apply', action='store_true', help='Apply the checked plan; otherwise plan only')
    args = parser.parse_args()
    provider = Provider(args.region, args.profile)
    config = validate_config(json.loads(provider.parameter(f'/chalk/{args.environment}/release/recorder.json')['Value']), args.environment)
    root = dispatcher_root(provider, config['dispatcher'])
    inputs = root['module']['dispatcher']
    arn = args.secret_parameter_arn or inputs.get('openrouter_token_parameter_arn', '')
    require(re.fullmatch(r'arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter/chalk/' + args.environment + r'/[A-Za-z0-9_.\-/]+', arn), 'MAI requires an environment-scoped secret ARN')
    current = provider.aws('lambda', 'get-function-configuration', '--function-name', inputs['function_name'])
    require(current['State'] == 'Active' and current['LastUpdateStatus'] == 'Successful', 'dispatcher is not healthy')
    require(current['CodeSha256'] == inputs['artifact_sha256_base64'], 'dispatcher code drifted from state')
    env = dict(current['Environment']['Variables'])
    env.pop('CODESWITCH_PROVIDER', None)
    env.pop('OPENROUTER_TOKEN_PARAMETER_ARN', None)
    if not args.disable:
        env.update(CODESWITCH_PROVIDER='mai', OPENROUTER_TOKEN_PARAMETER_ARN=arn)
    env.pop('CHALK_CONFIG_DIGEST', None)
    inputs['config_digest'] = 'sha256:' + digest(json.dumps(env, sort_keys=True, separators=(',', ':')))
    env['CHALK_CONFIG_DIGEST'] = inputs['config_digest']
    inputs.update(codeswitch_provider='' if args.disable else 'mai', openrouter_token_parameter_arn='' if args.disable else arn)
    with tempfile.TemporaryDirectory(prefix='chalk-mai-configuration-') as temporary:
        directory = Path(temporary)
        private_json(directory / 'main.tf.json', root)
        (directory / '.terraform.lock.hcl').write_bytes((MODULE / '.terraform.lock.hcl').read_bytes())
        def tofu(*arguments):
            return provider.command(['tofu', '-chdir=' + str(directory), *arguments], timeout=600)
        tofu('init', '-input=false', '-upgrade=false')
        tofu('plan', '-input=false', '-no-color', '-out=mai.plan')
        check_plan(json.loads(tofu('show', '-json', 'mai.plan')), arn, not args.disable, env)
        if args.apply:
            tofu('apply', '-input=false', '-no-color', 'mai.plan')
            observed = provider.aws('lambda', 'get-function-configuration', '--function-name', inputs['function_name'])
            require(observed['Environment']['Variables'] == env, 'MAI configuration readback mismatch')
            require(observed['CodeSha256'] == current['CodeSha256'], 'MAI migration changed code')
    print(json.dumps({'checked': True, 'applied': args.apply, 'auto': 'paused' if args.disable else 'mai', 'code_unchanged': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Provider boundaries redact diagnostics; no runtime config or secret values are printed.
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
