#!/usr/bin/env python3
"""Build a recorder archive on the runner. No DigitalOcean allocation or baking."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

from archive import package
from release_core import digest, require

ROOT = Path(__file__).resolve().parents[2]


def build(role, directory):
    directory.mkdir(parents=True, exist_ok=True)
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    release_id = f'recorder-{role}-{source}'
    bundle = directory / f'{role}-bundle.tar.gz'
    output = directory / f'{role}-archive.tar.gz'
    if not output.exists():
        script = ROOT / 'infrastructure/recorder/images' / ('capture' if role == 'capture' else 'cpu') / 'build-release.sh'
        if not bundle.exists():
            command = ['bash', str(script), '--source', str(ROOT), '--release-id', release_id, '--output', str(bundle)]
            if role == 'render' and os.geteuid() != 0:
                command = ['sudo', 'env', 'GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=safe.directory',
                           'GIT_CONFIG_VALUE_0=' + str(ROOT), *command]
            subprocess.run(command, check=True)
        result = package(role, bundle, output, Path('/opt/chalk-recorder/toolchains/node-22.23.2'))
        (directory / f'{role}-archive.json').write_text(json.dumps(result, indent=2) + '\n')
    result = json.loads((directory / f'{role}-archive.json').read_text())
    require(result['source_revision'] == source and result['release_id'] == release_id, 'archive source changed; use a new build directory')
    require(digest(output.read_bytes()) == result['archive_sha256'], 'built recorder archive changed')
    return result, output


def verify_object(provider, bucket, key, sha):
    observed = provider.aws('s3api', 'head-object', '--bucket', bucket, '--key', key, '--checksum-mode', 'ENABLED')
    expected = base64.b64encode(bytes.fromhex(sha)).decode()
    require(observed.get('ChecksumSHA256') == expected, 'recorder object SHA256 mismatch')
    return observed


def publish(provider, bucket, role, result, path):
    sha = result['archive_sha256']
    key = f'recorder/{role}/{sha}.tar.gz'
    # Conditional creation is safe across retries and concurrent identical builds.
    try:
        provider.aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', path,
                     '--if-none-match', '*', '--checksum-algorithm', 'SHA256', '--checksum-sha256',
                     base64.b64encode(bytes.fromhex(sha)).decode(), timeout=600)
    except RuntimeError:
        # A timeout or a precondition failure may mean the exact object already exists.
        # Only the server-verified checksum can turn that outcome into success.
        verify_object(provider, bucket, key, sha)
    verify_object(provider, bucket, key, sha)
    return key


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=('capture', 'render'), required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        result, path = build(args.role, args.directory.resolve())
        print(json.dumps({**result, 'archive_path': str(path)}))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
