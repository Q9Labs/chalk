"""The MAI configuration migration cannot replace code or broaden its secret grant."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('configure_mai', Path(__file__).with_name('configure-mai.py'))
mai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mai)
ARN = 'arn:aws:ssm:us-east-1:123456789012:parameter/chalk/production/transcription/openrouter-token'
POLICY = {'Version': '2012-10-17', 'Statement': [{'Sid': 'ReadOnlyTranscriptionAndApiSecrets', 'Effect': 'Allow', 'Action': ['ssm:GetParameter', 'ssm:GetParameters'], 'Resource': ['existing-secret']}]}


class MaiMigration(unittest.TestCase):
    def plan(self):
        return {'resource_changes': [{'address': 'module.dispatcher.aws_iam_role_policy.dispatcher', 'change': {
            'actions': ['update'], 'before': {'name': 'least-privilege', 'role': 'dispatcher', 'policy': json.dumps(POLICY)},
            'after': {'name': 'least-privilege', 'role': 'dispatcher', 'policy': json.dumps(mai.policy_with_secret(POLICY, ARN, True))}, 'after_unknown': {}}}]}

    def test_allows_exact_secret_addition_and_idempotent_removal(self):
        plan = self.plan()
        mai.check_plan(plan, ARN, True, {})
        change = plan['resource_changes'][0]['change']
        change['before'], change['after'] = change['after'], change['before']
        mai.check_plan(plan, ARN, False, {})
        self.assertEqual(mai.canonical_policy(mai.policy_with_secret(POLICY, ARN, False)), mai.canonical_policy(POLICY))

    def test_rejects_broader_permission_or_resource_changes(self):
        for kind in ('action', 'secret', 'replacement', 'code'):
            plan = self.plan()
            item = plan['resource_changes'][0]
            if kind in ('action', 'secret'):
                policy = json.loads(item['change']['after']['policy'])
                policy['Statement'][0]['Action' if kind == 'action' else 'Resource'].append('*')
                item['change']['after']['policy'] = json.dumps(policy)
            elif kind == 'replacement':
                item['change']['actions'] = ['delete', 'create']
            else:
                item['address'] = 'module.dispatcher.aws_lambda_function.dispatcher'
                item['change']['before'] = {'environment': [{'variables': {}}], 's3_key': 'old', 'tags': {'chalk_config_digest': 'digest'}, 'tags_all': {'chalk_config_digest': 'digest'}}
                item['change']['after'] = copy.deepcopy(item['change']['before'])
                item['change']['after']['s3_key'] = 'new'
            with self.subTest(kind=kind), self.assertRaises((ValueError, RuntimeError)):
                mai.check_plan(plan, ARN, True, {'CHALK_CONFIG_DIGEST': 'digest'})


if __name__ == '__main__':
    unittest.main()
