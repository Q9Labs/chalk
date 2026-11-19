#!/usr/bin/env python3
"""Migrate only the MAI secret grant and dispatcher selection; never deploy code."""
import argparse
import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/recorder'))
from dispatcher_binding import dispatcher_inputs
from alchemy_dispatcher import run_plan, check_plan as check_alchemy_plan
from release_core import digest, require, validate_config
from release_io import Provider


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
    def role(before):
        policies = before['inlinePolicies']
        require(len(policies) == 1, 'dispatcher execution role has unexpected inline policies')
        name = next(iter(policies))
        policies[name] = canonical_policy(policy_with_secret(policies[name], arn, enabled))
    def function(before):
        before['environment'] = environment
        before['tags']['chalk_config_digest'] = environment['CHALK_CONFIG_DIGEST']
    # Canonicalize IAM's scalar/array and statement ordering without allowing a
    # permission addition other than the exact environment-scoped MAI secret.
    normalized = copy.deepcopy(plan)
    for row in normalized['resources']:
        if row['id'] == 'ExecutionRole':
            for side in ('before', 'after'):
                for name, policy in row[side]['inlinePolicies'].items():
                    row[side]['inlinePolicies'][name] = canonical_policy(policy)
    check_alchemy_plan(normalized, {'ExecutionRole': role, 'Function': function}, {'required_egress_destinations', 'release_identity'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', required=True, choices=('nightly', 'production'))
    parser.add_argument('--profile', default='q9labs')
    parser.add_argument('--region', default='ap-southeast-1')
    parser.add_argument('--secret-parameter-arn')
    parser.add_argument('--disable', action='store_true')
    parser.add_argument('--apply', action='store_true', help='Apply the checked plan; otherwise plan only')
    parser.add_argument('--plan-output', type=Path, help='Save a private review copy of the plan')
    args = parser.parse_args()
    provider = Provider(args.region, args.profile)
    config = validate_config(json.loads(provider.parameter(f'/chalk/{args.environment}/release/recorder.json')['Value']), args.environment)
    inputs = dispatcher_inputs(provider, config['dispatcher'])
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
    run_plan(provider, inputs, lambda plan: check_plan(plan, arn, not args.disable, env), apply=args.apply,
             plan_output=args.plan_output, allowed_inputs={'codeswitch_provider', 'openrouter_token_parameter_arn', 'config_digest'})
    if args.apply:
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
