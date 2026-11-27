"""Document-renderer members and exact-ZIP deployment for managed media releases."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / 'scripts/recorder'))
from release_core import digest, require
from release_io import private_json
from renderer_binding import renderer_inputs, release_config_digest as renderer_config_digest, release_environment as renderer_release_environment, verify_renderer
from alchemy_renderer import run_plan as run_renderer_plan
from dispatcher_binding import binding_target
from media_members import validate_members

RENDERER_INPUTS = ('infrastructure/document-renderer/', 'infrastructure/platform/', 'infrastructure/providers/', 'infrastructure/releases/', 'apps/document-renderer/', 'scripts/build-document-renderer.sh', 'scripts/build-document-renderer-image.sh', '.npmrc', '.pnpmfile.cjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json')



def renderer_release_declared():
    return os.environ.get('CHALK_RENDERER_RELEASE_ENABLED') == 'true'

def renderer_fingerprint():
    return digest(subprocess.check_output(['git', 'ls-tree', '-r', 'HEAD', '--', *RENDERER_INPUTS], cwd=ROOT))


def add_current_renderer_image_member(provider, result):
    if not renderer_image_declared():
        return
    try:
        image = renderer_inputs(provider, 'image')
    except ValueError as error:
        if 'no Alchemy state' not in str(error):
            raise
    else:
        result['renderer_image'] = dict(repository_uri=image['image_repository_uri'], digest=image['image_digest'])


def add_current_renderer_member(provider, result):
    add_current_renderer_image_member(provider, result)
    if not renderer_release_declared():
        return
    try:
        renderer = renderer_inputs(provider)
    except ValueError as error:
        if 'no Alchemy state' not in str(error):
            raise
    else:
        result['renderer'] = dict(bucket=renderer['artifact_s3_bucket'], key=renderer['artifact_s3_key'], version_id=renderer['artifact_s3_object_version'], sha256=renderer['artifact_sha256'])


def renderer_matches(provider, archive):
    try:
        inputs = renderer_inputs(provider)
    except ValueError as error:
        if 'no Alchemy state' in str(error):
            return False
        raise
    return inputs['artifact_sha256'] == archive.get('sha256')


def publish_renderer(args, provider):
    result = json.loads(args.output.read_text())
    previous = json.loads(args.baseline.read_text()).get('renderer', {}) if args.baseline else {}
    checksum = renderer_fingerprint()
    if previous.get('input_sha256') == checksum:
        archive = args.directory / 'retained-renderer.zip'
        provider.aws('s3api', 'get-object', '--bucket', previous['bucket'], '--key', previous['key'], '--version-id', previous['version_id'], archive)
        require(digest(archive.read_bytes()) == previous['sha256'], 'retained renderer ZIP changed')
        result['renderer'] = dict(previous)
    else:
        archives = list(args.directory.glob('document-renderer-linux-arm64.zip'))
        require(len(archives) == 1, 'expected one verified document-renderer ZIP')
        archive = archives[0]
        manifest_path = archive.parent / 'manifest.json'
        require(manifest_path.is_file(), 'document-renderer build manifest missing')
        manifest = json.loads(manifest_path.read_text())
        sha = digest(archive.read_bytes())
        require(manifest.get('sha256') == sha, 'document-renderer manifest digest mismatch')
        bucket = os.environ['CHALK_MEDIA_ARTIFACT_BUCKET']
        key = f'document-renderer/{args.release_id}/{sha}.zip'
        uploaded = provider.aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', archive)
        result['renderer'] = dict(bucket=bucket, key=key, version_id=uploaded.get('VersionId'), sha256=sha,
                                  input_sha256=checksum, source_revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                                  manifest_sha256=digest(manifest_path.read_bytes()), pdfium_version=manifest.get('pdfiumVersion', ''))
    private_json(args.output, validate_members(result))


def deploy_renderer(args, provider):
    manifest = json.loads(args.manifest.read_text())
    archive = validate_members(json.loads(args.output.read_text())).get('renderer')
    if not archive:
        print(json.dumps({'action': 'renderer-not-recorded', 'verified': False, 'skipped': 'media members predate renderer release support', 'left_live': True}))
        return
    if not renderer_release_declared():
        print(json.dumps({'action': 'renderer-not-declared', 'verified': False, 'skipped': 'renderer release is not explicitly enabled for this environment', 'environment': getattr(args, 'environment', None), 'left_live': True}))
        return
    if getattr(args, 'environment', None) != 'production':
        print(json.dumps({'action': 'renderer-not-production-target', 'verified': False, 'skipped': 'document renderer production state is not a target of this environment', 'environment': getattr(args, 'environment', None), 'left_live': True}))
        return
    try:
        current_inputs = renderer_inputs(provider)
    except ValueError as error:
        if 'no Alchemy state' not in str(error):
            raise
        print(json.dumps({'action': 'renderer-not-bootstrapped', 'verified': False, 'skipped': 'document renderer production state does not exist', 'left_live': False}))
        return
    matches = renderer_matches(provider, archive)
    with tempfile.TemporaryDirectory(prefix='chalk-renderer-release-') as temp:
        directory = Path(temp)
        zip_path = directory / 'renderer.zip'
        provider.aws('s3api', 'get-object', '--bucket', archive['bucket'], '--key', archive['key'], '--version-id', archive['version_id'], zip_path)
        require(digest(zip_path.read_bytes()) == archive['sha256'], 'renderer ZIP readback mismatch')
        environment = renderer_release_environment(provider, current_inputs, zip_path)
        release = binding_target(manifest)
        # The module requires the current API identity in the object key. Copy exact bytes, never rebuild.
        key = f'document-renderer/{release}/{archive["sha256"]}.zip'
        bucket = current_inputs['artifact_s3_bucket']
        if args.dry_run:
            bucket, key, version = archive['bucket'], archive['key'], archive['version_id']
        elif (matches and current_inputs['release_id'] == release
              and current_inputs.get('release_manifest_digest') == 'sha256:' + digest(args.manifest.read_bytes())):
            key = current_inputs['artifact_s3_key']
            version = current_inputs['artifact_s3_object_version']
        else:
            uploaded = provider.aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', zip_path)
            version = uploaded.get('VersionId')
        require(version and version != 'null', 'renderer destination bucket is not versioned')
        if args.dry_run:
            run_renderer_plan(provider, current_inputs)
            print(json.dumps({'action': 'deploy-exact-renderer-zip', 'sha256': archive['sha256'],
                              'artifact_verified': True, 'state_plan_verified': True, 'preflight_only': True, 'verified': False}))
            return
        inputs = {**current_inputs, **dict(release_id=release, release_manifest_digest='sha256:' + digest(args.manifest.read_bytes()),
                      artifact_s3_bucket=bucket, artifact_s3_key=key, artifact_s3_object_version=version,
                      artifact_sha256=archive['sha256'], artifact_sha256_base64=base64.b64encode(bytes.fromhex(archive['sha256'])).decode())}
        inputs['config_digest'] = renderer_config_digest(environment, inputs)
        run_renderer_plan(provider, inputs, 'release', apply=True)
        proof = verify_renderer(provider, inputs, release)
        proof.update(artifact_sha256=archive['sha256'])
        print(json.dumps(proof))


def renderer_image_declared():
    return os.environ.get('CHALK_RENDERER_IMAGE_RELEASE_ENABLED') == 'true'


def oci_manifest_digest(archive):
    with tarfile.open(archive) as tar:
        index = json.load(tar.extractfile('index.json'))
    manifests = index['manifests']
    require(len(manifests) == 1 and manifests[0]['mediaType'] in ('application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'), 'renderer image archive must hold exactly one image manifest, not an index')
    return manifests[0]['digest']


def ecr_image_exists(provider, repository, image_digest):
    name = repository.split('/', 1)[1]
    try:
        provider.aws('ecr', 'describe-images', '--repository-name', name, '--image-ids', 'imageDigest=' + image_digest)
    except RuntimeError:
        return False
    return True


def publish_renderer_image(args, provider):
    result = json.loads(args.output.read_text())
    previous = json.loads(args.baseline.read_text()).get('renderer_image', {}) if args.baseline else {}
    checksum = renderer_fingerprint()
    repository = os.environ['CHALK_RENDERER_IMAGE_REPOSITORY_URI']
    if previous.get('input_sha256') == checksum and previous.get('repository_uri') == repository and ecr_image_exists(provider, repository, previous['digest']):
        result['renderer_image'] = dict(previous)
    else:
        archives = list(args.directory.glob('document-renderer-image-linux-arm64.oci.tar'))
        require(len(archives) == 1, 'expected one verified document-renderer image archive')
        archive = archives[0]
        manifest_path = archive.parent / 'image-manifest.json'
        require(manifest_path.is_file(), 'document-renderer image manifest missing')
        manifest = json.loads(manifest_path.read_text())
        image_digest = oci_manifest_digest(archive)
        require(manifest.get('digest') == image_digest, 'document-renderer image manifest digest mismatch')
        password = provider.command(['aws', *(['--profile', provider.profile] if provider.profile else []), '--region', provider.region, 'ecr', 'get-login-password'], read_only=False).strip()
        provider.command(['skopeo', 'copy', '--preserve-digests', '--dest-creds', 'AWS:' + password, f'oci-archive:{archive}', f'docker://{repository}:{args.release_id}'], timeout=1800)
        require(ecr_image_exists(provider, repository, image_digest), 'pushed renderer image digest is missing from ECR')
        result['renderer_image'] = dict(repository_uri=repository, digest=image_digest, tag=args.release_id, input_sha256=checksum,
                                        source_revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                                        manifest_sha256=digest(manifest_path.read_bytes()), pdfium_version=manifest.get('pdfiumVersion', ''))
    private_json(args.output, validate_members(result))


def deploy_renderer_image(args, provider):
    manifest = json.loads(args.manifest.read_text())
    image = validate_members(json.loads(args.output.read_text())).get('renderer_image')
    if not image:
        print(json.dumps({'action': 'renderer-image-not-recorded', 'verified': False, 'skipped': 'media members predate renderer image support', 'left_live': True}))
        return
    if not renderer_image_declared():
        print(json.dumps({'action': 'renderer-image-not-declared', 'verified': False, 'skipped': 'renderer image release is not explicitly enabled for this environment', 'environment': getattr(args, 'environment', None), 'left_live': True}))
        return
    if getattr(args, 'environment', None) != 'production':
        print(json.dumps({'action': 'renderer-image-not-production-target', 'verified': False, 'skipped': 'document renderer image production state is not a target of this environment', 'environment': getattr(args, 'environment', None), 'left_live': True}))
        return
    try:
        current_inputs = renderer_inputs(provider, 'image')
    except ValueError as error:
        if 'no Alchemy state' not in str(error):
            raise
        print(json.dumps({'action': 'renderer-image-not-bootstrapped', 'verified': False, 'skipped': 'document renderer image production state does not exist', 'left_live': False}))
        return
    release = binding_target(manifest)
    manifest_digest = 'sha256:' + digest(args.manifest.read_bytes())
    require(current_inputs['image_repository_uri'] == image['repository_uri'], 'document renderer image repository differs from the bootstrapped one')
    require(ecr_image_exists(provider, image['repository_uri'], image['digest']), 'recorded renderer image digest is missing from ECR')
    environment = renderer_release_environment(provider, current_inputs)
    inputs = {**current_inputs, 'release_id': release, 'release_manifest_digest': manifest_digest, 'image_digest': image['digest']}
    inputs['config_digest'] = renderer_config_digest(environment, inputs)
    if args.dry_run:
        run_renderer_plan(provider, current_inputs)
        print(json.dumps({'action': 'deploy-exact-renderer-image', 'digest': image['digest'], 'image_verified': True, 'state_plan_verified': True, 'preflight_only': True, 'verified': False}))
        return
    run_renderer_plan(provider, inputs, 'release', apply=True)
    proof = verify_renderer(provider, inputs, release)
    proof.update(image_digest=image['digest'])
    print(json.dumps(proof))
