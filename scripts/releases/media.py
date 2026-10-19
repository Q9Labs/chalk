#!/usr/bin/env python3
"""Immutable recorder archives and dispatcher ZIP members of a managed release."""
import argparse
import base64
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / 'scripts/recorder'))
from release_core import check_image, digest, env_values, require, validate_config
from release_io import Provider, private_json
import importlib.util
_recorder_spec = importlib.util.spec_from_file_location("recorder_archive_release", ROOT / "scripts/recorder/release.py")
recorder_release = importlib.util.module_from_spec(_recorder_spec)
_recorder_spec.loader.exec_module(recorder_release)
from dispatcher_binding import dispatcher_root, binding_target, verify_dispatcher, MODULE
from github_release import GitHub, payload

INPUTS = {
    'capture': ('apps/api/', 'go.work', 'go.work.sum', 'infrastructure/recorder/', 'scripts/recorder/'),
    'render': ('apps/api/', 'apps/recording-renderer/', 'packages/', 'sdks/typescript/', 'tsconfig.json', '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'infrastructure/recorder/', 'scripts/recorder/'),
    'dispatcher': ('infrastructure/opentofu/modules/aws-transcription-dispatcher/', 'infrastructure/nightly/transcription/', 'apps/transcription-dispatcher/', 'scripts/transcription-dispatcher/', '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json'),
    'dispatcher_configuration': ('infrastructure/nightly/transcription/',),
}
# Installed releases reconstruct their root from state; this path cannot migrate root inputs.
SUPPORTED_DISPATCHER_CONFIGURATION = '8ea6b73b24126245ef9ce49a41e69be5f8f0dcd60b4c2d8bd00ad46e15468771'


def fingerprint(member):
    return digest(subprocess.check_output(['git', 'ls-tree', '-r', 'HEAD', '--', *INPUTS[member]], cwd=ROOT))


def validate_members(value):
    require(value.get('schema_version') == 1 and set(value) in ({'schema_version', 'recorder_source_bucket', 'capture', 'render', 'dispatcher'}, {'schema_version', 'capture', 'render', 'dispatcher'}), 'invalid media members')
    portable = 'recorder_source_bucket' in value
    for role in ('capture', 'render'):
        image = value[role]
        require(re.fullmatch(r'[1-9][0-9]*', str(image['base_snapshot_id' if portable else 'image_id'])), 'invalid recorder image ID')
        if portable:
            require(re.fullmatch(r'[0-9a-f]{64}', image['archive_sha256']), 'invalid recorder archive SHA256')
            require(image['archive_key'] == f"recorder/{role}/{image['archive_sha256']}.tar.gz", 'invalid recorder archive key')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image['image_digest']), 'invalid recorder digest')
        require(re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,127}', image['release_id']), 'invalid recorder release')
    if portable:
        require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', value['recorder_source_bucket']), 'invalid recorder source bucket')
    archive = value['dispatcher']
    require(re.fullmatch(r'[0-9a-f]{64}', archive['sha256']), 'invalid dispatcher ZIP digest')
    require(archive['version_id'] and archive['version_id'] != 'null', 'dispatcher ZIP must be version-pinned')
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', archive['bucket']), 'invalid dispatcher bucket')
    require(re.fullmatch(r'[0-9a-f]{64}', archive['corpus_digest'].removeprefix('sha256:')), 'missing approved corpus digest')
    require(archive['key'].startswith('transcription-dispatcher/') and '..' not in archive['key'], 'invalid dispatcher artifact key')
    return value


def settings(args):
    provider = Provider(args.region, os.environ.get('AWS_PROFILE'))
    config = validate_config(json.loads(provider.parameter(args.config_parameter)['Value']), args.environment)
    expected = f'/chalk/{args.environment}/managed-episode'
    require(config['runtime']['parameter_prefix'] == expected, 'media runtime namespace mismatch')
    provider.context = config['do_context']
    return provider, config


def current(provider, config):
    prefix = config['runtime']['parameter_prefix']
    result = {'schema_version': 1}
    for role in ('capture', 'render'):
        values = env_values(provider.parameter(prefix + '/recorder/' + role + '.env')['Value'])
        result[role] = {key.lower(): values['CHALK_RECORDER_FLEET_' + key] for key in ('IMAGE_ID', 'IMAGE_DIGEST', 'RELEASE_ID')}
        if values.get('CHALK_RECORDER_FLEET_ARCHIVE_KEY'):
            result[role]['base_snapshot_id'] = result[role].pop('image_id')
            result[role].update({key.lower(): values['CHALK_RECORDER_FLEET_' + key] for key in ('ARCHIVE_KEY', 'ARCHIVE_SHA256')})
            bucket = values['CHALK_RECORDER_FLEET_ARCHIVE_BUCKET']
            require(result.get('recorder_source_bucket', bucket) == bucket, 'recorder archive buckets differ')
            result['recorder_source_bucket'] = bucket
    inputs = dispatcher_root(provider, config['dispatcher'])['module']['dispatcher']
    result['dispatcher'] = dict(bucket=inputs['artifact_s3_bucket'], key=inputs['artifact_s3_key'], version_id=inputs['artifact_s3_object_version'], sha256=inputs['artifact_sha256'], corpus_digest=inputs['deepinfra_corpus_digest'])
    return validate_members(result)


def retain_runtime(args):
    provider, config = settings(args)
    private_json(args.output, current(provider, config))


def baseline(args):
    # A deploy-only first install is not a held cut, but its qualified current
    # members must still be reusable by the first cut without rebuilding them.
    records = GitHub().deployments('nightly', 'media-current')
    if records:
        saved = payload(records[0])
        data = base64.b64decode(saved['media_base64'], validate=True)
        require(digest(data) == saved['media_sha256'], 'current media checksum mismatch')
        previous = validate_members(json.loads(data))
        if 'recorder_source_bucket' in previous:
            private_json(args.output, previous)


def check_configuration(args):
    require(fingerprint('dispatcher_configuration') == SUPPORTED_DISPATCHER_CONFIGURATION,
            'dispatcher infrastructure configuration changed; this media release path cannot migrate root inputs; apply a separately reviewed infrastructure migration before updating the supported configuration checksum')


def record_current(args):
    require(args.environment == 'nightly', 'current media record is nightly-only')
    data = args.output.read_bytes()
    validate_members(json.loads(data))
    receipts = [json.loads((args.directory / (role + '-receipt.json')).read_text()) for role in ('capture', 'render')]
    require(all(item['result'] == 'PASS' and item['fleet_equivalent_signed_boot'] and item['cleanup_confirmed'] for item in receipts), 'current media requires successful signed boot and cleanup')
    GitHub().request('deployments', dict(ref=os.environ['TARGET_SHA'], environment='nightly', task='media-current', auto_merge=False,
                     required_contexts=[], payload=dict(channel='media-current', media_sha256=digest(data), media_base64=base64.b64encode(data).decode())))


def build_archives(args):
    provider, config = settings(args)
    args.directory.mkdir(parents=True, exist_ok=True)
    bucket = os.environ['CHALK_MEDIA_ARTIFACT_BUCKET']
    result = json.loads(args.output.read_text()) if args.output.exists() else {'schema_version': 1, 'recorder_source_bucket': bucket}
    previous = json.loads(args.baseline.read_text()) if args.baseline else {}
    for role in (args.role,) if args.role else ('capture', 'render'):
        checksum = fingerprint(role)
        old = previous.get(role, {})
        values = env_values(provider.parameter(config['runtime']['parameter_prefix'] + '/recorder/' + role + '.env')['Value'])
        if old.get('input_sha256') == checksum and old.get('archive_key') and previous.get('recorder_source_bucket') == bucket:
            recorder_release.verify_object(provider, previous['recorder_source_bucket'], old['archive_key'], old['archive_sha256'])
            result[role] = dict(old, base_snapshot_id=values['CHALK_RECORDER_FLEET_IMAGE_ID'])
            result['recorder_source_bucket'] = previous['recorder_source_bucket']
            continue
        built, path = recorder_release.build(role, args.directory / role)
        key = recorder_release.publish(provider, bucket, role, built, path)
        result[role] = dict(built, base_snapshot_id=values['CHALK_RECORDER_FLEET_IMAGE_ID'], archive_key=key, input_sha256=checksum)
    private_json(args.output, result)


def materialize_archives(provider, media, bucket):
    source = media['recorder_source_bucket']
    for role in ('capture', 'render'):
        member = media[role]
        key, sha = member['archive_key'], member['archive_sha256']
        observed = recorder_release.verify_object(provider, source, key, sha)
        if source != bucket:
            with tempfile.TemporaryDirectory(prefix='chalk-recorder-promote-') as directory:
                path = Path(directory) / 'archive.tar.gz'
                provider.aws('s3api', 'get-object', '--bucket', source, '--key', key,
                             '--if-match', observed['ETag'], path, timeout=600)
                require(digest(path.read_bytes()) == sha, 'promoted recorder archive SHA256 mismatch')
                recorder_release.publish(provider, bucket, role, member, path)
        recorder_release.verify_object(provider, bucket, key, sha)


def dispatcher_state_exists(provider, config):
    listing = provider.aws('s3api', 'list-objects-v2', '--bucket', config['dispatcher']['state_bucket'], '--prefix', config['dispatcher']['state_key'])
    return any(item['Key'] == config['dispatcher']['state_key'] for item in listing.get('Contents', []))


def installed_dispatcher(provider, config):
    if not dispatcher_state_exists(provider, config):
        return False
    state = provider.state(config['dispatcher'])
    resources = {item['type'] + '.' + item['name']: item for item in state.get('resources', []) if item.get('mode', 'managed') == 'managed'}
    required = {kind + '.' + name for kind, name in re.findall(r'^resource "([^"]+)" "([^"]+)"', (MODULE / 'main.tf').read_text(), re.MULTILINE)}
    # The sole optional resource has count=0 unless an external invoker is configured.
    required.discard('aws_lambda_permission.control_api')
    return all(resources.get(name, {}).get('instances') for name in required)


def dispatcher_matches(provider, config, archive):
    if not installed_dispatcher(provider, config):
        return False
    inputs = dispatcher_root(provider, config['dispatcher'])['module']['dispatcher']
    return inputs['artifact_sha256'] == archive.get('sha256')


def zip_needed(args):
    provider, config = settings(args)
    previous = json.loads(args.baseline.read_text()).get('dispatcher', {}) if args.baseline else {}
    needed = previous.get('input_sha256') != fingerprint('dispatcher') or not dispatcher_matches(provider, config, previous)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('build_zip=' + str(needed).lower() + '\n')


def publish_zip(args):
    provider, config = settings(args)
    result = json.loads(args.output.read_text())
    previous = json.loads(args.baseline.read_text()).get('dispatcher', {}) if args.baseline else {}
    checksum = fingerprint('dispatcher')
    if previous.get('input_sha256') == checksum and dispatcher_matches(provider, config, previous):
        archive = args.directory / 'retained.zip'
        provider.aws('s3api', 'get-object', '--bucket', previous['bucket'], '--key', previous['key'], '--version-id', previous['version_id'], archive)
        require(digest(archive.read_bytes()) == previous['sha256'], 'retained dispatcher ZIP changed')
        result['dispatcher'] = dict(previous, corpus_digest=os.environ['CHALK_TRANSCRIPTION_CORPUS_DIGEST'])
    else:
        archives = list(args.directory.glob('transcription-dispatcher-*.zip'))
        require(len(archives) == 1, 'expected one verified dispatcher ZIP')
        archive = archives[0]
        manifest = json.loads(archive.with_suffix('.manifest.json').read_text())
        sha = digest(archive.read_bytes())
        bucket = os.environ['CHALK_MEDIA_ARTIFACT_BUCKET']
        key = f'transcription-dispatcher/{args.release_id}/{sha}.zip'
        uploaded = provider.aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', archive)
        result['dispatcher'] = dict(bucket=bucket, key=key, version_id=uploaded.get('VersionId'), sha256=sha,
                                    input_sha256=checksum, source_revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                                    manifest_sha256=digest(archive.with_suffix('.manifest.json').read_bytes()), corpus_digest=os.environ['CHALK_TRANSCRIPTION_CORPUS_DIGEST'])
        require(manifest.get('source_state') != 'dirty-local-proof', 'dirty dispatcher artifact')
    private_json(args.output, validate_members(result))


def write_parameter(provider, parameter, value):
    before = provider.parameter(parameter['Name'])
    require(before['Version'] == parameter['Version'] and before['Value'] == parameter['Value'], 'fleet config changed during deployment')
    if value == parameter['Value']:
        return
    metadata = provider.aws('ssm', 'describe-parameters', '--parameter-filters', 'Key=Name,Option=Equals,Values=' + parameter['Name'])['Parameters']
    require(len(metadata) == 1, 'pin metadata unavailable')
    payload = dict(Name=parameter['Name'], Type=parameter['Type'], Value=value, Overwrite=True)
    for key in ('KeyId', 'Tier', 'DataType', 'Description', 'AllowedPattern'):
        if key in metadata[0]:
            payload[key] = metadata[0][key]
    result = provider.aws('ssm', 'put-parameter', payload=payload)
    after = provider.parameter(parameter['Name'])
    require(after['Version'] == result['Version'] and after['Value'] == value, 'fleet pin readback mismatch')


def pin_archives(args):
    provider, config = settings(args)
    media = validate_members(json.loads(args.output.read_text()))
    portable = 'recorder_source_bucket' in media
    require(portable or args.environment == 'production', 'legacy media is production rollback only')
    bucket = os.environ.get('CHALK_MEDIA_ARTIFACT_BUCKET', '')
    if portable:
        materialize_archives(provider, media, bucket)
    parameters = {role: provider.parameter(config['runtime']['parameter_prefix'] + '/recorder/' + role + '.env') for role in ('capture', 'render')}
    for role, parameter in parameters.items():
        values = env_values(parameter['Value'])
        provider.do_token = values['DIGITALOCEAN_TOKEN']
        sizes = provider.do('compute', 'size', 'list')
        size = next((item for item in sizes if item['slug'] == values['CHALK_RECORDER_FLEET_SIZE']), None)
        region = values['CHALK_RECORDER_FLEET_REGION']
        require(size and size['available'] and region in size['regions'], role + ' fleet size unavailable')
        images = provider.do('compute', 'image', 'get', media[role]['base_snapshot_id' if portable else 'image_id'])
        require(len(images) == 1 and str(images[0]['id']) == str(media[role]['base_snapshot_id' if portable else 'image_id']), role + ' candidate snapshot not found')
        check_image(images[0], dict(region=region, disk_gb=size['disk']))
    ca = provider.parameter(config['bootstrap_ca_parameter'])['Value']
    for role, parameter in parameters.items():
        image = media[role]
        updates = { 'CHALK_RECORDER_FLEET_' + key.upper(): str(image[key]) for key in ('image_digest', 'release_id') }
        updates['CHALK_RECORDER_FLEET_IMAGE_ID'] = str(image['base_snapshot_id' if portable else 'image_id'])
        if portable:
            updates.update(
                       CHALK_RECORDER_FLEET_ARCHIVE_BUCKET=bucket, CHALK_RECORDER_FLEET_ARCHIVE_KEY=image['archive_key'],
                       CHALK_RECORDER_FLEET_ARCHIVE_SHA256=image['archive_sha256'], CHALK_RECORDER_FLEET_ARCHIVE_REGION=args.region,
            )
        updates.update(CHALK_RECORDER_FLEET_BOOTSTRAP_CA_BASE64=base64.b64encode(ca.encode()).decode(),
                       CHALK_RECORDER_FLEET_BOOTSTRAP_SERVER_NAME=config['bootstrap_server_name'],
                       CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST=image['image_digest'])
        lines = parameter['Value'].splitlines()
        removed = set(updates)
        if not portable:
            removed.update('CHALK_RECORDER_FLEET_ARCHIVE_' + key for key in ('BUCKET', 'KEY', 'SHA256', 'REGION'))
        value = '\n'.join(line for line in lines if line.split('=', 1)[0] not in removed) + '\n'
        value += ''.join(key + '=' + item + '\n' for key, item in updates.items())
        write_parameter(provider, parameter, value)


def check_dispatcher_update(plan, release, archive, key, version, manifest_digest, config_digest):
    for item in plan.get('resource_changes', []):
        change = item['change']
        if change['actions'] in (['no-op'], ['read']):
            continue
        require(change['actions'] == ['update'], 'dispatcher update must not create, replace or delete resources')
        before, after = copy.deepcopy(change['before']), copy.deepcopy(change['after'])
        address = item['address']
        require(address in ('module.dispatcher.aws_lambda_function.dispatcher', 'module.dispatcher.aws_cloudwatch_log_group.dispatcher', 'module.dispatcher.aws_scheduler_schedule.reconcile'), 'dispatcher update exceeds resource allowlist')
        if address.endswith('aws_scheduler_schedule.reconcile'):
            before['state'] = 'ENABLED'
        else:
            for tag in ('tags', 'tags_all'):
                before[tag]['chalk_release_id'] = release
            if address.endswith('aws_lambda_function.dispatcher'):
                before.update(s3_key=key, s3_object_version=version, source_code_hash=base64.b64encode(bytes.fromhex(archive['sha256'])).decode(), description=f'Track-aware transcription dispatcher ({release})')
                env = before['environment'][0]['variables']
                env.update(CHALK_RELEASE_ID=release, CHALK_RELEASE_MANIFEST_DIGEST=manifest_digest, CHALK_CONFIG_DIGEST=config_digest, DEEPINFRA_CORPUS_DIGEST=archive['corpus_digest'])
                for tag in ('tags', 'tags_all'):
                    before[tag].update(chalk_release_manifest_digest=manifest_digest, chalk_config_digest=config_digest)
        computed = ('last_modified', 'qualified_arn', 'qualified_invoke_arn', 'version', 'code_sha256', 'source_code_size')
        for name in computed:
            before.pop(name, None)
            after.pop(name, None)
        require(before == after, 'dispatcher plan changes more than code, binding metadata or scheduler state')


def deploy_dispatcher(args):
    check_configuration(args)
    provider, config = settings(args)
    manifest = json.loads(args.manifest.read_text())
    archive = validate_members(json.loads(args.output.read_text()))['dispatcher']
    with tempfile.TemporaryDirectory(prefix='chalk-dispatcher-release-') as temp:
        directory = Path(temp)
        zip_path = directory / 'dispatcher.zip'
        provider.aws('s3api', 'get-object', '--bucket', archive['bucket'], '--key', archive['key'], '--version-id', archive['version_id'], zip_path)
        require(digest(zip_path.read_bytes()) == archive['sha256'], 'dispatcher ZIP readback mismatch')
        installed = installed_dispatcher(provider, config)
        if installed:
            root = dispatcher_root(provider, config['dispatcher'])
        else:
            require(args.environment == 'nightly', 'production dispatcher must already be provisioned')
            # Use the existing root's module without nesting its backend/provider.
            # The checked-in root is copied so its module source remains absolute.
            source = (ROOT / 'infrastructure/nightly/transcription/main.tf').read_text()
            source = source.replace('source = "../../opentofu/modules/aws-transcription-dispatcher"', 'source = "' + str(MODULE) + '"')
            (directory / 'main.tf').write_text(source)
            (directory / 'variables.tf').write_bytes((ROOT / 'infrastructure/nightly/transcription/variables.tf').read_bytes())
            root = None
        release = binding_target(manifest)
        # The module requires the current API identity in the object key. Copy exact bytes, never rebuild.
        key = f'transcription-dispatcher/{release}/{archive["sha256"]}.zip'
        bucket = os.environ['CHALK_MEDIA_ARTIFACT_BUCKET'] if not installed else root['module']['dispatcher']['artifact_s3_bucket']
        if args.dry_run:
            bucket, key, version = archive['bucket'], archive['key'], archive['version_id']
        else:
            uploaded = provider.aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', zip_path)
            version = uploaded.get('VersionId')
        require(version and version != 'null', 'dispatcher destination bucket is not versioned')
        inputs = dict(release_id=release, release_manifest_digest='sha256:' + digest(args.manifest.read_bytes()),
                      artifact_s3_bucket=bucket, artifact_s3_key=key, artifact_s3_object_version=version,
                      artifact_sha256=archive['sha256'], artifact_sha256_base64=base64.b64encode(bytes.fromhex(archive['sha256'])).decode(),
                      scheduler_state='ENABLED', deepinfra_corpus_digest=archive['corpus_digest'])
        if root:
            environment = provider.aws('lambda', 'get-function-configuration', '--function-name', config['dispatcher']['function_name'])['Environment']['Variables']
            environment.update(CHALK_RELEASE_ID=release, CHALK_RELEASE_MANIFEST_DIGEST=inputs['release_manifest_digest'], DEEPINFRA_CORPUS_DIGEST=archive['corpus_digest'])
            environment.pop('CHALK_CONFIG_DIGEST', None)
            inputs['config_digest'] = 'sha256:' + digest(json.dumps(environment, sort_keys=True, separators=(',', ':')))
            if not args.dry_run:
                root['module']['dispatcher'].update(inputs)
            private_json(directory / 'main.tf.json', root)
        else:
            inputs.pop('artifact_s3_bucket')
            inputs.update(privacy_gate_accepted=True, config_digest='sha256:' + digest(json.dumps(inputs, sort_keys=True)))
            private_json(directory / 'terraform.tfvars.json', inputs)
        (directory / '.terraform.lock.hcl').write_bytes((ROOT / 'infrastructure/nightly/transcription/.terraform.lock.hcl').read_bytes())
        def tofu(*values):
            return provider.command(['tofu', '-chdir=' + str(directory), *values], timeout=900)
        backend = ['-backend-config=bucket=' + config['dispatcher']['state_bucket']] if not installed else []
        tofu('init', '-input=false', '-upgrade=false', *backend)
        if args.dry_run:
            flags = ['-refresh-only'] if installed else []
            tofu('plan', '-input=false', '-lock=false', '-no-color', *flags, '-out=preflight.plan')
            plan = json.loads(tofu('show', '-json', 'preflight.plan'))
            for item in plan.get('resource_changes', []):
                require('delete' not in item['change']['actions'], 'dispatcher preflight must not destroy or replace resources')
            print(json.dumps({'action': 'deploy-exact-media-zip', 'sha256': archive['sha256'], 'version_id': archive['version_id'],
                              'artifact_verified': True, 'state_plan_verified': True, 'verified': False}))
            return
        if not installed:
            # These belong to the dispatcher module but provisioning created them before the first ZIP.
            # `tofu state list` exits 1 until the backend holds a state object.
            present = set(tofu('state', 'list').splitlines()) if dispatcher_state_exists(provider, config) else set()
            function = config['dispatcher']['function_name']
            for resource, name in [('aws_iam_role.dispatcher', function + '-execution'), ('aws_iam_role.scheduler', function + '-scheduler'),
                                   ('aws_cloudwatch_log_group.dispatcher', '/aws/lambda/' + function)]:
                address = 'module.dispatcher.' + resource
                if address not in present:
                    tofu('import', '-input=false', address, name)
        if installed:
            for target in ('aws_cloudwatch_log_group.dispatcher', 'aws_lambda_function.dispatcher'):
                tofu('plan', '-input=false', '-no-color', '-target=module.dispatcher.' + target, '-out=release.plan')
                plan = json.loads(tofu('show', '-json', 'release.plan'))
                check_dispatcher_update(plan, release, archive, key, version, inputs['release_manifest_digest'], inputs['config_digest'])
                tofu('apply', '-input=false', '-no-color', 'release.plan')
        tofu('plan', '-input=false', '-no-color', '-out=release.plan')
        plan = json.loads(tofu('show', '-json', 'release.plan'))
        if installed:
            check_dispatcher_update(plan, release, archive, key, version, inputs['release_manifest_digest'], inputs['config_digest'])
        else:
            for item in plan.get('resource_changes', []):
                require('delete' not in item['change']['actions'], 'first-install dispatcher plan must not destroy or replace resources')
        tofu('apply', '-input=false', '-no-color', 'release.plan')
        proof = verify_dispatcher(provider, config['dispatcher'], release)
        schedule = provider.aws('scheduler', 'get-schedule', '--name', config['dispatcher']['scheduler_name'], '--group-name', config['dispatcher']['scheduler_group'])
        require(schedule['State'] == 'ENABLED', 'dispatcher scheduler is not enabled')
        proof.update(artifact_sha256=archive['sha256'], artifact_bucket=bucket, artifact_key=key, artifact_version_id=version, scheduler_state='ENABLED')
        print(json.dumps(proof))


def qualify(args):
    provider, config = settings(args)
    media = validate_members(json.loads(args.output.read_text()))
    args.directory.mkdir(parents=True, exist_ok=True)
    for role in ('capture', 'render'):
        values = env_values(provider.parameter(config['runtime']['parameter_prefix'] + '/recorder/' + role + '.env')['Value'])
        image = media[role]
        request = dict(schema_version=1, role=role, source_commit=image['source_revision'], release_id=image['release_id'], image_id=int(image['base_snapshot_id']), archive=dict(bucket=os.environ['CHALK_MEDIA_ARTIFACT_BUCKET'], key=image['archive_key'], sha256=image['archive_sha256'], region=args.region), image_digest=image['image_digest'], region=values['CHALK_RECORDER_FLEET_REGION'], size=values['CHALK_RECORDER_FLEET_SIZE'])
        path, receipt = args.directory / (role + '-request.json'), args.directory / (role + '-receipt.json')
        private_json(path, request)
        subprocess.run([sys.executable, str(ROOT / 'scripts/recorder/boot-check.py'), '--request', str(path), '--receipt', str(receipt)], check=True,
                       env={**os.environ, 'CHALK_BOOT_CHECK_INSTANCE_ID': config['runtime']['instance_id'], 'CHALK_BOOT_CHECK_DO_CONTEXT': config['do_context'], 'CHALK_RECORDER_RELEASE_CONFIG_PARAMETER': args.config_parameter})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('retain_runtime', 'check_configuration', 'baseline', 'record_current', 'build_archives', 'publish_zip', 'zip_needed', 'pin_archives', 'deploy_dispatcher', 'qualify'))
    parser.add_argument('--environment', choices=('nightly', 'production'), default=os.environ.get('MANAGED_ENVIRONMENT', 'nightly'))
    parser.add_argument('--region', default=os.environ.get('AWS_REGION'))
    parser.add_argument('--config-parameter', default=os.environ.get('CHALK_MANAGED_RECORDER_CONFIG_PARAMETER'))
    parser.add_argument('--directory', type=Path, default=Path('/tmp/chalk-media-release'))
    parser.add_argument('--output', type=Path, default=Path('media.json'))
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--release-id')
    parser.add_argument('--role', choices=('capture', 'render'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    globals()[args.command](args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(f'Media release refused: {error}')
