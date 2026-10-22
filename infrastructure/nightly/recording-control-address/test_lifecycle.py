#!/usr/bin/env python3
"""Apply the real root to a local EC2/SSM emulator, retaining state across retries.

No AWS credentials or endpoints are used. Unknown API actions fail closed.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent


def xml(name, value):
    if isinstance(value, dict):
        body = ''.join(xml(key, item) for key, item in value.items())
    elif isinstance(value, list):
        body = ''.join(xml('item', item) for item in value)
    else:
        body = escape(str(value))
    return f'<{name}>{body}</{name}>'


class Cloud:
    def __init__(self):
        self.target = 'i-11111111111111111'
        self.addresses = {}
        self.calls = []
        self.associations = 0
        self.fail_move = False

    def request(self, action, values):
        self.calls.append(action)
        if action == 'DescribeInstances':
            if values.get('InstanceId.1', self.target) != self.target:
                return dict(reservationSet=[])
            return dict(reservationSet=[dict(instancesSet=[dict(instanceId=self.target,
                imageId='ami-11111111111111111', instanceType='m5.large',
                instanceState=dict(code=16, name='running'), placement=dict(availabilityZone='ap-southeast-1a'),
                rootDeviceType='ebs', rootDeviceName='/dev/xvda', virtualizationType='hvm',
                architecture='x86_64', launchTime='2026-10-22T00:00:00Z',
                privateIpAddress='10.0.0.1', subnetId='subnet-11111111', vpcId='vpc-11111111',
                tagSet=[dict(key='chalk:environment', value='nightly')])])])
        if action == 'DescribeInstanceTypes':
            return dict(instanceTypeSet=[dict(instanceType='m5.large', vCpuInfo=dict(defaultVCpus=2),
                        memoryInfo=dict(sizeInMiB=8192), instanceStorageSupported='false',
                        networkInfo=dict(enaSupport='required'))])
        if action == 'DescribeInstanceAttribute':
            return dict(instanceId=self.target, **{values['Attribute']: dict(value='false')})
        if action == 'AllocateAddress':
            allocation = 'eipalloc-' + str(len(self.addresses) + 1).zfill(17)
            self.addresses[allocation] = dict(allocationId=allocation, publicIp='192.0.2.' + str(len(self.addresses) + 1), domain='vpc')
            return self.addresses[allocation]
        if action == 'CreateTags':
            address = self.addresses.get(values['ResourceId.1'])
            if address is not None:
                address['tagSet'] = [dict(key=value, value=values[key.replace('.Key', '.Value')])
                                     for key, value in values.items() if key.startswith('Tag.') and key.endswith('.Key')]
            return dict(**{'return': 'true'})
        if action == 'DescribeAddressesAttribute':
            return dict(addressSet=[dict(allocationId=values['AllocationId.1'])])
        if action == 'DescribeAddresses':
            addresses = list(self.addresses.values())
            if 'AllocationId.1' in values:
                addresses = [item for item in addresses if item['allocationId'] == values['AllocationId.1']]
            if 'AssociationId.1' in values:
                addresses = [item for item in addresses if item.get('associationId') == values['AssociationId.1']]
            for key, value in values.items():
                if key.endswith('.Name') and value == 'association-id':
                    wanted = values[key.replace('.Name', '.Value.1')]
                    addresses = [item for item in addresses if item.get('associationId') == wanted]
            return dict(addressesSet=addresses)
        if action == 'AssociateAddress':
            self.associations += 1
            address = self.addresses[values['AllocationId']]
            address.update(instanceId=values['InstanceId'], associationId='eipassoc-' + str(self.associations).zfill(17),
                           networkInterfaceId='eni-11111111', privateIpAddress='10.0.0.1')
            if self.fail_move:
                self.fail_move = False
                raise ValueError('Injected: association moved but response lost')
            return dict(associationId=address['associationId'])
        if action == 'DisassociateAddress':
            for address in self.addresses.values():
                if address.get('associationId') == values['AssociationId']:
                    for key in ('associationId', 'instanceId', 'networkInterfaceId', 'privateIpAddress'):
                        address.pop(key, None)
            return dict(**{'return': 'true'})
        raise AssertionError('Unexpected AWS action: ' + action)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        if self.headers.get('X-Amz-Target') == 'AmazonSSM.GetParameter':
            result = dict(Parameter=dict(Name='/chalk/nightly/release/recorder.json', Type='String',
                         Value=json.dumps(dict(runtime=dict(instance_id=self.server.cloud.target))), Version=1))
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-amz-json-1.1')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        values = {key: value[0] for key, value in parse_qs(body.decode()).items()}
        action = values.pop('Action')
        try:
            result = self.server.cloud.request(action, values)
            status, document = 200, xml(action + 'Response', dict(requestId='fixture', **result))
        except (AssertionError, ValueError) as error:
            status, document = 400, xml('Response', dict(Errors=dict(Error=dict(Code='InvalidParameterValue', Message=str(error))), RequestID='fixture'))
        self.send_response(status)
        self.send_header('Content-Type', 'text/xml')
        self.end_headers()
        self.wfile.write(document.encode())

    def log_message(self, *args):
        pass


def exercise(tofu, negative=None):
    cloud = Cloud()
    server = HTTPServer(('127.0.0.1', 0), Handler)
    server.cloud = cloud
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='recorder-address-lifecycle-') as temporary:
            directory = Path(temporary)
            source = (ROOT / 'main.tf').read_text()
            start = source.index('  backend "s3" {')
            end = source.index('\n  }', start) + len('\n  }')
            source = source[:start] + source[end:]
            if negative == 'replacement':
                source = source.replace('    destroy = false', '    destroy = false\n    replace_triggered_by = [terraform_data.host]')
                source += '\nresource "terraform_data" "host" { input = data.aws_instance.nightly.id }\n'
            elif negative == 'retention':
                source = source.replace('    destroy = false', '')
            (directory / 'main.tf').write_text(source)
            shutil.copy(ROOT / '.terraform.lock.hcl', directory)
            endpoint = f'http://127.0.0.1:{server.server_port}'
            (directory / 'provider_override.tf').write_text('''provider "aws" {
  access_key = "fixture"
  secret_key = "fixture"
  skip_credentials_validation = true
  skip_requesting_account_id = true
  skip_metadata_api_check = true
  skip_region_validation = true
  endpoints {
    ec2 = "%s"
    ssm = "%s"
  }
}
''' % (endpoint, endpoint))
            # Reuse only the pinned, checksum-verified provider binary, not backend state.
            providers = ROOT / '.terraform/providers'
            if providers.exists():
                (directory / '.terraform').mkdir()
                (directory / '.terraform/providers').symlink_to(providers.resolve(), target_is_directory=True)
            env = {**os.environ, 'AWS_EC2_METADATA_DISABLED': 'true', 'AWS_MAX_ATTEMPTS': '1'}
            for name in ('AWS_PROFILE', 'AWS_DEFAULT_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ROLE_ARN'):
                env.pop(name, None)

            def call(*args, fails=False):
                print('Running: tofu ' + ' '.join(args), flush=True)
                with subprocess.Popen([tofu, *args], cwd=directory, env=env, text=True,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
                    for heartbeat in range(6):
                        try:
                            output, _ = process.communicate(timeout=15)
                            break
                        except subprocess.TimeoutExpired:
                            print(f'Heartbeat: tofu {args[0]} active ({15 * (heartbeat + 1)}s)', flush=True)
                    else:
                        process.kill()
                        output, _ = process.communicate()
                        raise AssertionError('90s command deadline exceeded\n' + output)
                    if (process.returncode != 0) != fails:
                        raise AssertionError(output)
                    return output

            def state():
                return json.loads(call('show', '-json'))['values']['root_module']['resources']

            def allocation():
                return next(item['values']['id'] for item in state() if item['address'] == 'aws_eip.control')

            def apply(**kwargs):
                return call('apply', '-auto-approve', '-input=false', '-no-color', **kwargs)

            call('init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color')
            apply()
            original = allocation()
            original_ip = cloud.addresses[original]['publicIp']
            assert cloud.calls.count('AllocateAddress') == 1
            cloud.target = 'i-22222222222222222'
            cloud.fail_move = True
            apply(fails=True)
            # AWS changed, but the provider failed before recording the new association.
            assert any(item.get('instanceId') == cloud.target for item in cloud.addresses.values())
            apply()
            assert allocation() == original, 'host replacement must retain the original allocation ID'
            assert len(cloud.addresses) == 1, 'replacement must not allocate an orphan address'
            assert cloud.addresses[original]['instanceId'] == cloud.target
            assert cloud.addresses[original]['publicIp'] == original_ip
            assert cloud.calls.count('AllocateAddress') == 1, 'only the association may move'
            apply()
            call('plan', '-input=false', '-no-color', '-out=retry.plan')
            plan = json.loads(call('show', '-json', 'retry.plan'))
            assert all(item['change']['actions'] == ['no-op'] for item in plan.get('resource_changes', []) if item['mode'] == 'managed'), 'retry must converge to a no-op'
            # Removing the EIP block must forget, not delete, the retained allocation.
            call('plan', '-destroy', '-refresh=false', '-input=false', '-no-color', '-out=retention.plan')
            retention = json.loads(call('show', '-json', 'retention.plan'))
            eip = next(item for item in retention['resource_changes'] if item['address'] == 'aws_eip.control')
            assert eip['change']['actions'] == ['forget'], 'persisted retention must survive removal'
            print('PASS: persistent allocation, association-only replacement, partial failure recovery, no-op retry, retained removal', flush=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tofu', default='tofu')
    parser.add_argument('--negative', choices=('replacement', 'retention'), help='inject a regression; the corresponding assertion must fail')
    args = parser.parse_args()
    exercise(args.tofu, args.negative)
