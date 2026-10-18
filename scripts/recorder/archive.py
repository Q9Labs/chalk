#!/usr/bin/env python3
"""Package a runner-built recorder bundle with its installed-file manifest."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
RECORDER = Path('/opt/chalk-recorder')
UNITS = ROOT / 'infrastructure/recorder/images/cpu/systemd'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def aliases(role):
    result = {
        '/usr/local/sbin/chalk-recorder-bootstrap': '/opt/chalk-recorder/current/bin/chalk-recorder-bootstrap',
        '/etc/chalk-recorder/capture.env': '/opt/chalk-recorder/current/config/capture.env',
        '/opt/chalk-recorder/image-manifest.json': '/opt/chalk-recorder/current/image-manifest.json',
    }
    for unit in ('chalk-recorder-' + role + '.service', 'chalk-recorder-renew.service', 'chalk-recorder-renew.timer'):
        result['/etc/systemd/system/' + unit] = '/opt/chalk-recorder/current/systemd/' + unit
    if role == 'render':
        result['/etc/chalk-recorder/render.env'] = '/opt/chalk-recorder/current/config/render.env'
    return result


def package(role, bundle, output, node_root):
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        with tarfile.open(bundle) as archive:
            archive.extractall(stage, filter='data')
        release = stage / 'release'
        info = json.loads((release / 'build-info.json').read_text())
        release_id = info['release_id']
        if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,127}', release_id):
            raise ValueError('invalid recorder release ID')
        expected_schema = 'chalk_recorder_' + ('capture' if role == 'capture' else 'cpu') + '_build.v1'
        if info['schema_version'] != expected_schema:
            raise ValueError('bundle role does not match its schema')
        (release / 'config').mkdir()
        (release / 'systemd').mkdir()
        (release / 'config/capture.env').write_text('CHALK_RECORDER_KEYFRAME_INTERVAL=10s\n')
        links = aliases(role)
        for destination, target in links.items():
            if destination.startswith('/etc/systemd/system/'):
                shutil.copyfile(UNITS / Path(target).name, release / 'systemd' / Path(target).name)
        if role == 'render':
            if not (node_root / 'bin/node').is_file():
                raise ValueError('render archive requires the pinned Node toolchain')
            shutil.copytree(node_root, release / 'node', symlinks=True)
            (release / 'config/render.env').write_text(
                'CHALK_RECORDING_RENDER_WORK_ROOT=/var/lib/chalk-recorder/render\n'
                'CHALK_RECORDING_NODE_PATH=/opt/chalk-recorder/current/node/bin/node\n'
                'CHALK_RECORDING_RENDERER_SCRIPT=/opt/chalk-recorder/current/renderer/dist/node/compose.js\n'
                'CHALK_RECORDING_FFMPEG_PATH=/usr/bin/ffmpeg\n'
                'CHALK_RECORDING_FFPROBE_PATH=/usr/bin/ffprobe\n'
                'CHALK_RECORDING_VIDEO_ENCODER=libx264\n')
        installed = RECORDER / 'releases' / release_id
        files = []
        for path in sorted(release.rglob('*')):
            if path.is_symlink():
                kind, content = 'symlink', path.readlink().as_posix().encode()
            elif path.is_file():
                kind, content = 'file', path.read_bytes()
            else:
                continue
            files.append(dict(path=str(installed / path.relative_to(release)), type=kind, sha256=sha256(content)))
        links['/opt/chalk-recorder/current'] = 'releases/' + release_id
        files.extend(dict(path=path, type='symlink', sha256=sha256(target.encode())) for path, target in links.items())
        manifest = dict(schema_version='chalk_recorder_cpu_image.v2', release_id=release_id,
                        source_commit=info['source_commit'], source_tree_sha256=info['source_tree_sha256'],
                        profile='capture-minimal-v1' if role == 'capture' else 'cpu-libx264-frame2',
                        files=sorted(files, key=lambda item: item['path']))
        data = encoded(manifest)
        manifest_digest = 'sha256:' + sha256(data)
        (release / 'image-manifest.json').write_bytes(data)
        (release / 'install-links.json').write_bytes(encoded(links))
        (release / 'config/image.env').write_text(
            'CHALK_RECORDER_IMAGE_GPU=false\n'
            f'CHALK_RECORDER_INSTALLED_RELEASE_ID={release_id}\n'
            f'CHALK_RECORDER_INSTALLED_IMAGE_DIGEST={manifest_digest}\n'
            'CHALK_RECORDER_IMAGE_MANIFEST=/opt/chalk-recorder/image-manifest.json\n'
            'CHALK_RECORDER_BOOTSTRAP_CA_FILE=/etc/chalk-recorder/bootstrap-ca.pem\n'
            'CHALK_RECORDER_BOOTSTRAP_SERVER_NAME=unconfigured.invalid\n'
            'CHALK_RECORDER_IDENTITY_DIRECTORY=/etc/chalk-recorder/identity\n'
            'CHALK_RECORDER_WORKER_ENV_FILE=/etc/chalk-recorder/worker.env\n'
            'CHALK_RECORDER_NODE_ENV_FILE=/etc/chalk-recorder/node.env\n')
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for path in [release, *sorted(release.rglob('*'))]:
                    member = archive.gettarinfo(path, str(path.relative_to(stage)))
                    member.uid = member.gid = member.mtime = 0
                    member.uname = member.gname = ''
                    if member.isfile():
                        with path.open('rb') as content:
                            archive.addfile(member, content)
                    else:
                        archive.addfile(member)
        return dict(release_id=release_id, image_digest=manifest_digest,
                    archive_sha256=sha256(output.read_bytes()), source_revision=info['source_commit'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('capture', 'render'), required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--node-root', type=Path, default=Path('/opt/chalk-recorder/toolchains/node-22.23.2'))
    args = parser.parse_args()
    print(json.dumps(package(args.role, args.bundle, args.output, args.node_root)))
