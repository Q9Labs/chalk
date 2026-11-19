"""Release policy behavior over the Alchemy driver's complete desired-prop view."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

from alchemy_dispatcher import TYPES, check_plan, read_inputs
from dispatcher_binding import check_binding_plan

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/releases'))
from media import check_dispatcher_update
spec = importlib.util.spec_from_file_location('configure_mai', ROOT / 'scripts/transcription-dispatcher/configure-mai.py')
mai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mai)


def fixture():
    props = {name: {'name': name} for name in TYPES if name != 'ControlApiPermission'}
    props['Function'] = dict(functionName='dispatcher', description='Track-aware transcription dispatcher (release-old)',
                             code=dict(bucket='private', key='release-old/code.zip', version='old-version', sha256='old-hash'),
                             environment={'__redacted__': dict(CHALK_RELEASE_ID='release-old', CHALK_CONFIG_DIGEST='old-config', CHALK_RELEASE_MANIFEST_DIGEST='old-manifest', DEEPINFRA_CORPUS_DIGEST='old-corpus')},
                             tags=dict(chalk_release_id='release-old', chalk_config_digest='old-config', chalk_release_manifest_digest='old-manifest'),
                             role='unchanged-role', timeout=600)
    props['Logs'] = dict(logGroupName='/aws/lambda/dispatcher', tags=dict(chalk_release_id='release-old'))
    props['Reconcile'] = dict(state='DISABLED', target={'Arn': 'unchanged-function'}, scheduleExpression='rate(1 minute)')
    props['ExecutionRole'] = dict(roleName='execution', assumeRolePolicyDocument={'unchanged': True}, inlinePolicies={'least-privilege': {'Version': '2012-10-17', 'Statement': [{'Sid': 'ReadOnlyTranscriptionAndApiSecrets', 'Effect': 'Allow', 'Action': ['ssm:GetParameter'], 'Resource': ['arn:workload']}]}})
    outputs = dict(dispatcher_inputs={'__redacted__': {'release_id': 'release-old'}}, artifact_identity='old-artifact', release_identity='old-release', required_egress_destinations=['ssm'], unrelated='preserved')
    return dict(resources=[dict(id=name, type=TYPES[name], action='noop', before=copy.deepcopy(p), after=copy.deepcopy(p)) for name, p in props.items()], outputs=dict(before=copy.deepcopy(outputs), after=copy.deepcopy(outputs)))


def change(plan, name):
    row = next(row for row in plan['resources'] if row['id'] == name)
    row['action'] = 'update'
    return row['after']


class DispatcherAlchemyTests(unittest.TestCase):
    def test_pin_retention_reads_seeded_outputs_without_node_or_mutation(self):
        inputs = {'environment_name': 'nightly', 'function_name': 'chalk-nightly-transcription-dispatcher'}
        class AWSBoundary:
            region = 'ap-southeast-1'
            def aws(self, service, operation, *args):
                if (service, operation) != ('dynamodb', 'get-item'):
                    raise AssertionError('pin retention must be read-only')
                return {'Item': {'data': {'S': json.dumps({'dispatcher_inputs': {'__redacted__': inputs}})}}}
        self.assertEqual(read_inputs(AWSBoundary(), {'function_name': inputs['function_name']}), inputs)

    def test_pin_retention_reads_overflow_with_only_get_operations(self):
        inputs = {'environment_name': 'nightly', 'function_name': 'chalk-nightly-transcription-dispatcher'}
        calls = []
        class AWSBoundary:
            region = 'ap-southeast-1'
            def aws(self, service, operation, *args):
                calls.append((service, operation))
                if (service, operation) == ('dynamodb', 'get-item'):
                    return {'Item': {'ref': {'S': 'transcription-dispatcher/nightly/OUTPUT-test.json'}}}
                if (service, operation) == ('sts', 'get-caller-identity'):
                    return {'Account': '1' * 12}
                if (service, operation) == ('s3api', 'get-object'):
                    bucket = args[args.index('--bucket') + 1]
                    key = args[args.index('--key') + 1]
                    if bucket != 'alchemy-state-overflow-' + '1' * 12 + '-ap-southeast-1-an' or key != 'transcription-dispatcher/nightly/OUTPUT-test.json':
                        raise AssertionError('overflow identity changed')
                    Path(args[-1]).write_text(json.dumps({'dispatcher_inputs': {'__redacted__': inputs}}))
                    return {}
                raise AssertionError('pin retention must be read-only')
        self.assertEqual(read_inputs(AWSBoundary(), {'function_name': inputs['function_name']}), inputs)
        self.assertEqual(calls, [('dynamodb', 'get-item'), ('sts', 'get-caller-identity'), ('s3api', 'get-object')])

    def test_unseeded_environment_fails_without_fallback_or_mutation(self):
        class AWSBoundary:
            region = 'ap-southeast-1'
            def aws(self, service, operation, *args):
                if (service, operation) != ('dynamodb', 'get-item'):
                    raise AssertionError('unseeded read must not provision or fall back')
                return {}
        with self.assertRaisesRegex(ValueError, 'explicitly seed'):
            read_inputs(AWSBoundary(), {'function_name': 'chalk-nightly-transcription-dispatcher'})

    def test_complete_noop_is_safe(self):
        check_plan(fixture(), {}, set())

    def test_rejects_dangerous_actions_even_for_allowlisted_resources(self):
        for action in ('delete', 'orphaned', 'replace', 'create', 'adopted'):
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'must not create'):
                plan = fixture()
                plan['resources'][0]['action'] = action
                check_plan(plan, {plan['resources'][0]['id']: lambda props: None}, set())

    def test_rejects_partial_plan_and_resource_type_swap(self):
        for edit in (lambda p: p['resources'].pop(), lambda p: p['resources'][0].update(type='AWS.IAM.User'), lambda p: p['resources'].append(copy.deepcopy(p['resources'][0]))):
            plan = fixture()
            edit(plan)
            with self.assertRaises(ValueError):
                check_plan(plan, {}, set())

    def test_binding_changes_only_release_identity(self):
        plan = fixture()
        function = change(plan, 'Function')
        function['description'] = 'Track-aware transcription dispatcher (release-new)'
        function['code'].update(key='release-new/code.zip', version='new-version')
        function['environment']['__redacted__'].update(CHALK_RELEASE_ID='release-new', CHALK_CONFIG_DIGEST='new-config')
        function['tags'].update(chalk_release_id='release-new', chalk_config_digest='new-config')
        change(plan, 'Logs')['tags']['chalk_release_id'] = 'release-new'
        check_binding_plan(plan, 'release-new', 'release-new/code.zip', 'new-version', 'new-config')
        for field, value in [('timeout', 900), ('role', 'expanded-role')]:
            invalid = copy.deepcopy(plan)
            change(invalid, 'Function')[field] = value
            with self.assertRaisesRegex(ValueError, 'outside the allowlist'):
                check_binding_plan(invalid, 'release-new', 'release-new/code.zip', 'new-version', 'new-config')
        function['code']['sha256'] = 'different-bytes'
        with self.assertRaises(ValueError):
            check_binding_plan(plan, 'release-new', 'release-new/code.zip', 'new-version', 'new-config')

    def test_media_release_changes_only_exact_artifact_and_metadata(self):
        plan = fixture()
        f = change(plan, 'Function')
        import base64
        f['description'] = 'Track-aware transcription dispatcher (release-new)'
        f['code'].update(key='release-new/code.zip', version='new-version', sha256=base64.b64encode(bytes.fromhex('ab' * 32)).decode())
        f['environment']['__redacted__'].update(CHALK_RELEASE_ID='release-new', CHALK_CONFIG_DIGEST='new-config', CHALK_RELEASE_MANIFEST_DIGEST='new-manifest', DEEPINFRA_CORPUS_DIGEST='new-corpus')
        f['tags'].update(chalk_release_id='release-new', chalk_config_digest='new-config', chalk_release_manifest_digest='new-manifest')
        change(plan, 'Logs')['tags']['chalk_release_id'] = 'release-new'
        change(plan, 'Reconcile')['state'] = 'ENABLED'
        verify = lambda p: check_dispatcher_update(p, 'release-new', {'sha256': 'ab' * 32, 'corpus_digest': 'new-corpus'}, 'release-new/code.zip', 'new-version', 'new-manifest', 'new-config')
        verify(plan)
        change(plan, 'Reconcile')['scheduleExpression'] = 'rate(1 hour)'
        with self.assertRaises(ValueError):
            verify(plan)

    def test_mai_does_not_expand_other_permissions_or_change_code(self):
        plan = fixture()
        arn = 'arn:mai-secret'
        role = change(plan, 'ExecutionRole')
        role['inlinePolicies']['least-privilege']['Statement'][0]['Resource'].append(arn)
        environment = {'CHALK_RELEASE_ID': 'release-old', 'CHALK_CONFIG_DIGEST': 'new-config', 'CHALK_RELEASE_MANIFEST_DIGEST': 'old-manifest', 'DEEPINFRA_CORPUS_DIGEST': 'old-corpus', 'CODESWITCH_PROVIDER': 'mai', 'OPENROUTER_TOKEN_PARAMETER_ARN': arn}
        f = change(plan, 'Function')
        f['environment']['__redacted__'] = environment
        f['tags']['chalk_config_digest'] = 'new-config'
        mai.check_plan(plan, arn, True, environment)
        role['inlinePolicies']['least-privilege']['Statement'][0]['Action'].append('ssm:GetParametersByPath')
        with self.assertRaises(ValueError):
            mai.check_plan(plan, arn, True, environment)

    def test_unrelated_outputs_and_noop_prop_changes_are_rejected(self):
        for edit in (lambda p: p['outputs']['after'].update(unrelated='changed'), lambda p: p['resources'][0]['after'].update(extra='unapproved')):
            plan = fixture()
            edit(plan)
            with self.assertRaises(ValueError):
                check_plan(plan, {}, set())


if __name__ == '__main__':
    unittest.main()
