#!/usr/bin/env python3
"""Immutable recorder archives and workload ZIP members of a managed release."""
import argparse
import base64
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
from dispatcher_binding import dispatcher_inputs, binding_target, release_config_digest, release_environment, verify_dispatcher
from alchemy_dispatcher import run_plan
from media_members import validate_members
import renderer_media
from github_release import GitHub, payload, retain, retained

INPUTS = {
    'capture': ('apps/api/', 'features/media/sfu/protocol/', 'go.work', 'go.work.sum', 'infrastructure/recorder/', 'scripts/recorder/'),
    'render': ('apps/api/', 'features/media/sfu/protocol/', 'apps/recording-renderer/', 'packages/', 'sdks/typescript/', 'tsconfig.json', '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'infrastructure/recorder/', 'scripts/recorder/'),
    'dispatcher': ('infrastructure/transcription-dispatcher/', 'infrastructure/platform/', 'infrastructure/providers/', 'infrastructure/releases/', 'apps/transcription-dispatcher/', 'packages/transcript-language/', 'scripts/transcription-dispatcher/', '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json'),
    'dispatcher_configuration': ('infrastructure/transcription-dispatcher/',),
}
# Installed releases reconstruct their root from state; this path cannot migrate root inputs.
SUPPORTED_DISPATCHER_CONFIGURATION = '0a417c476f9f987390014507944d3d8a071e0b92490b1fa04cf89af69581dc41'


def fingerprint(member):
    return digest(subprocess.check_output(['git', 'ls-tree', '-r', 'HEAD', '--', *INPUTS[member]], cwd=ROOT))


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
    inputs = dispatcher_inputs(provider, config['dispatcher'])
    result['dispatcher'] = dict(bucket=inputs['artifact_s3_bucket'], key=inputs['artifact_s3_key'], version_id=inputs['artifact_s3_object_version'], sha256=inputs['artifact_sha256'], corpus_digest=inputs['deepinfra_corpus_digest'])
    if config['dispatcher']['function_name'].startswith('chalk-production-'):
        renderer_media.add_current_renderer_member(provider, result)
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
        data = retained(saved, 'media')
        require(digest(data) == saved['media_sha256'], 'current media checksum mismatch')
        previous = validate_members(json.loads(data))
        if 'recorder_source_bucket' in previous:
            private_json(args.output, previous)


def check_configuration(args):
    require(fingerprint('dispatcher_configuration') == SUPPORTED_DISPATCHER_CONFIGURATION,
            'dispatcher infrastructure configuration changed; this media release path cannot migrate root inputs; apply a separately reviewed infrastructure migration before updating the supported configuration checksum')


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


def dispatcher_matches(provider, config, archive):
    inputs = dispatcher_inputs(provider, config['dispatcher'])
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


def publish_renderer(args):
    provider, config = settings(args)
    del config
    renderer_media.publish_renderer(args, provider)


def deploy_renderer(args):
    renderer_media.deploy_renderer(args, Provider(args.region, os.environ.get('AWS_PROFILE')))


def publish_renderer_image(args):
    renderer_media.publish_renderer_image(args, settings(args)[0])


def deploy_renderer_image(args):
    renderer_media.deploy_renderer_image(args, Provider(args.region, os.environ.get('AWS_PROFILE'), args.dry_run))


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


def deploy_dispatcher(args):
    check_configuration(args)
    provider, config = settings(args)
    manifest = json.loads(args.manifest.read_text())
    archive = validate_members(json.loads(args.output.read_text()))['dispatcher']
    matches = dispatcher_matches(provider, config, archive)
    with tempfile.TemporaryDirectory(prefix='chalk-dispatcher-release-') as temp:
        directory = Path(temp)
        zip_path = directory / 'dispatcher.zip'
        provider.aws('s3api', 'get-object', '--bucket', archive['bucket'], '--key', archive['key'], '--version-id', archive['version_id'], zip_path)
        require(digest(zip_path.read_bytes()) == archive['sha256'], 'dispatcher ZIP readback mismatch')
        current_inputs = dispatcher_inputs(provider, config['dispatcher'])
        environment = release_environment(provider, current_inputs, zip_path, archive['corpus_digest'])
        corpus_digest = archive['corpus_digest'] or current_inputs['deepinfra_corpus_digest']
        release = binding_target(manifest)
        # The module requires the current API identity in the object key. Copy exact bytes, never rebuild.
        key = f'transcription-dispatcher/{release}/{archive["sha256"]}.zip'
        bucket = current_inputs['artifact_s3_bucket']
        if args.dry_run:
            bucket, key, version = archive['bucket'], archive['key'], archive['version_id']
        elif (matches and current_inputs['release_id'] == release
              and current_inputs.get('release_manifest_digest') == 'sha256:' + digest(args.manifest.read_bytes())
              and current_inputs['deepinfra_corpus_digest'] == corpus_digest):
            key = current_inputs['artifact_s3_key']
            version = current_inputs['artifact_s3_object_version']
        else:
            uploaded = provider.aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', zip_path)
            version = uploaded.get('VersionId')
        require(version and version != 'null', 'dispatcher destination bucket is not versioned')
        if args.dry_run:
            # The destination object version does not exist until an upload. A
            # dry run verifies the candidate bytes and rejects an in-memory
            # current-state preflight plan; it never invents an S3 version.
            run_plan(provider, current_inputs)
            print(json.dumps({'action': 'deploy-exact-media-zip', 'sha256': archive['sha256'], 'version_id': archive['version_id'],
                              'artifact_verified': True, 'state_plan_verified': True, 'preflight_only': True, 'verified': False}))
            return
        inputs = {**current_inputs, **dict(release_id=release, release_manifest_digest='sha256:' + digest(args.manifest.read_bytes()),
                      artifact_s3_bucket=bucket, artifact_s3_key=key, artifact_s3_object_version=version,
                      artifact_sha256=archive['sha256'], artifact_sha256_base64=base64.b64encode(bytes.fromhex(archive['sha256'])).decode(),
                      scheduler_state='ENABLED', deepinfra_corpus_digest=corpus_digest)}
        inputs['config_digest'] = release_config_digest(environment, inputs)
        run_plan(provider, inputs, 'release', apply=True)
        proof = verify_dispatcher(provider, config['dispatcher'], release)
        schedule = provider.aws('scheduler', 'get-schedule', '--name', config['dispatcher']['scheduler_name'], '--group-name', config['dispatcher']['scheduler_group'])
        require(schedule['State'] == 'ENABLED', 'dispatcher scheduler is not enabled')
        proof.update(artifact_sha256=archive['sha256'], artifact_bucket=bucket, artifact_key=key, artifact_version_id=version, scheduler_state='ENABLED')
        print(json.dumps(proof))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('retain_runtime', 'check_configuration', 'baseline', 'build_archives', 'publish_zip', 'zip_needed', 'publish_renderer', 'publish_renderer_image', 'pin_archives', 'deploy_dispatcher', 'deploy_renderer', 'deploy_renderer_image'))
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
