"""Stateful recorder address recovery, using the real release entry point."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import media
from test_media import members


class EC2:
    def __init__(self):
        self.allocation = dict(AllocationId='eipalloc-retained', PublicIp='192.0.2.1', InstanceId='i-old',
                               Tags=[dict(Key='Name', Value='chalk-nightly-recording-control'),
                                     dict(Key='chalk:environment', Value='nightly')])
        self.instance = 'i-old'
        self.environment = 'nightly'
        self.lose_response = False
        self.delay_visibility = False
        self.moves = []
        self.calls = []

    def parameter(self, name):
        return dict(Value='CHALK_RECORDER_FLEET_REGION=blr1\nCHALK_RECORDER_FLEET_SIZE=c-2\n')

    def aws(self, service, operation, *arguments):
        self.calls.append((service, operation))
        if service != 'ec2':
            raise AssertionError((service, operation))
        if operation == 'describe-instances':
            return dict(Reservations=[dict(Instances=[dict(InstanceId=self.instance, State=dict(Name='running'),
                        Tags=[dict(Key='chalk:environment', Value=self.environment)])])])
        if operation == 'describe-addresses':
            address = copy.deepcopy(self.allocation)
            if self.delay_visibility and '--allocation-ids' in arguments:
                address.pop('InstanceId', None)
            return dict(Addresses=[address])
        if operation == 'associate-address':
            assert arguments == ('--allocation-id', self.allocation['AllocationId'],
                                  '--instance-id', self.instance, '--allow-reassociation')
            self.allocation['InstanceId'] = self.instance
            self.moves.append((self.allocation['AllocationId'], self.instance))
            if self.lose_response:
                self.lose_response = False
                raise RuntimeError('AWS applied the move but its response was lost')
            return dict(AssociationId='eipassoc-new')
        raise AssertionError('Forbidden operation: ' + operation)


class RecorderAddress(unittest.TestCase):
    def setUp(self):
        self.ec2 = EC2()
        self.config = dict(runtime=dict(instance_id='i-old', user_id=1000,
                                        parameter_prefix='/chalk/nightly/managed-episode'), do_context='nightly')
        environment = patch.dict(media.os.environ, CHALK_MANAGED_INSTANCE_ID='i-old')
        environment.start()
        self.addCleanup(environment.stop)

    def select_host(self, instance_id):
        self.ec2.instance = self.config['runtime']['instance_id'] = instance_id
        media.os.environ['CHALK_MANAGED_INSTANCE_ID'] = instance_id

    def reconcile(self):
        media.reconcile_nightly_address(self.ec2, self.config)

    def test_host_replacement_retains_allocation_and_retry_converges_after_lost_response(self):
        original = copy.deepcopy(self.ec2.allocation)
        self.reconcile()
        self.assertEqual(self.ec2.moves, [])
        self.select_host('i-replacement')
        self.ec2.lose_response = True
        with self.assertRaisesRegex(RuntimeError, 'response was lost'):
            self.reconcile()
        self.assertEqual(self.ec2.allocation, dict(original, InstanceId='i-replacement'))
        self.reconcile()
        self.reconcile()
        self.assertEqual(self.ec2.moves, [('eipalloc-retained', 'i-replacement')])
        self.assertEqual(self.ec2.allocation, dict(original, InstanceId='i-replacement'))

    def test_unattached_retained_address_moves_once_and_retries_without_remapping(self):
        self.ec2.allocation.pop('InstanceId')
        self.select_host('i-replacement')
        self.reconcile()
        self.reconcile()
        self.assertEqual(self.ec2.moves, [('eipalloc-retained', 'i-replacement')])

    def test_release_moves_address_before_any_cold_boot_and_refuses_boot_on_partial_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(environment='nightly', config_parameter='/chalk/nightly/release/recorder.json',
                                   output=Path(directory, 'media.json'), directory=Path(directory), region='ap-southeast-1')
            args.output.write_text(json.dumps(members()))
            self.select_host('i-replacement')
            self.ec2.lose_response = True
            with patch.object(media, 'settings', return_value=(self.ec2, self.config)), patch.object(media.subprocess, 'run') as boot:
                with self.assertRaisesRegex(RuntimeError, 'response was lost'):
                    media.qualify(args)
                boot.assert_not_called()
                with patch.dict(media.os.environ, CHALK_MEDIA_ARTIFACT_BUCKET='test'):
                    media.qualify(args)
                self.assertEqual(boot.call_count, 2)
                self.assertEqual(self.ec2.allocation['InstanceId'], 'i-replacement')

    def test_production_qualification_never_reconciles(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(environment='production', output=Path(directory, 'media.json'),
                                   directory=Path(directory), region='ap-southeast-1', config_parameter='/chalk/production/release/recorder.json')
            args.output.write_text(json.dumps(members()))
            with patch.object(media, 'settings', return_value=(self.ec2, self.config)), patch.object(media, 'reconcile_nightly_address') as reconcile, patch.object(media.subprocess, 'run') as boot, patch.dict(media.os.environ, CHALK_MEDIA_ARTIFACT_BUCKET='test'):
                media.qualify(args)
                reconcile.assert_not_called()
                self.assertEqual(boot.call_count, 2)

    def test_rejects_production_host_or_allocation_without_moving_anything(self):
        self.ec2.environment = 'production'
        with self.assertRaisesRegex(ValueError, 'tagged nightly'):
            self.reconcile()
        self.ec2.environment = 'nightly'
        self.ec2.allocation['Tags'][1]['Value'] = 'production'
        with self.assertRaisesRegex(ValueError, 'tagged nightly'):
            self.reconcile()
        self.assertEqual(self.ec2.moves, [])

    def test_no_retained_allocation_fails_closed_instead_of_allocating(self):
        original = self.ec2.aws
        self.ec2.aws = lambda service, operation, *args: dict(Addresses=[]) if operation == 'describe-addresses' else original(service, operation, *args)
        with self.assertRaisesRegex(ValueError, 'exactly one retained'):
            self.reconcile()
        self.assertEqual(self.ec2.moves, [])

    def test_waits_for_association_visibility_then_refuses_cold_boot(self):
        self.select_host('i-replacement')
        self.ec2.delay_visibility = True
        with patch.object(media.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'cold boot refused'):
                self.reconcile()
        self.assertEqual(sleep.call_count, 11)

    def test_rejects_mismatched_or_missing_deployed_target_before_any_aws_call(self):
        self.ec2.allocation.pop('InstanceId')
        for deployed in ('i-other-nightly-host', None):
            with self.subTest(deployed=deployed), patch.dict(media.os.environ):
                if deployed is None:
                    media.os.environ.pop('CHALK_MANAGED_INSTANCE_ID', None)
                else:
                    media.os.environ['CHALK_MANAGED_INSTANCE_ID'] = deployed
                with self.assertRaisesRegex(ValueError, 'must match the deployed instance'):
                    self.reconcile()
        self.assertEqual(self.ec2.calls, [])


if __name__ == '__main__':
    unittest.main()
