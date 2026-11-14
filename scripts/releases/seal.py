#!/usr/bin/env python3
"""Seal release files so a public repository holds only ciphertext.

Release manifests and media pins name the AWS account, registry and bucket, so they never travel as plaintext: not as
workflow artifacts and not in Deployment payloads. The key is the repository secret CHALK_RELEASE_SEAL_KEY. A sealed
file has the `.sealed` suffix. Integrity comes from the caller, which checks the plaintext digest it already recorded.
"""

import argparse
import base64
import glob
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SUFFIX = '.sealed'


def _gpg(args, data):
    key = os.environ.get('CHALK_RELEASE_SEAL_KEY', '')
    if not key:
        raise ValueError('missing CHALK_RELEASE_SEAL_KEY; release files cannot be sealed or opened')
    read_fd, write_fd = os.pipe()
    os.write(write_fd, key.encode())
    os.close(write_fd)
    try:
        with tempfile.TemporaryDirectory(prefix='seal-') as home:
            result = subprocess.run(['gpg', '--homedir', home, '--batch', '--quiet', '--yes', '--pinentry-mode', 'loopback',
                                     '--passphrase-fd', str(read_fd), *args], input=data, capture_output=True, pass_fds=[read_fd])
    finally:
        os.close(read_fd)
    if result.returncode:
        raise ValueError('gpg failed: ' + result.stderr.decode(errors='replace').strip()[-300:])
    return result.stdout


def seal(data):
    return _gpg(['--symmetric', '--cipher-algo', 'AES256', '--compress-algo', 'none', '--s2k-mode', '3',
                 '--s2k-digest-algo', 'SHA512', '--s2k-count', '65011712', '-o', '-'], data)


def unseal(data):
    return _gpg(['--decrypt', '-o', '-'], data)


def seal_text(data):
    return base64.b64encode(seal(data)).decode()


def unseal_text(text):
    return unseal(base64.b64decode(text, validate=True))


def expand(patterns):
    """Resolve each argument like upload-artifact: wildcards match like a shell glob, and a path that matches nothing is skipped."""
    return [Path(match) for pattern in patterns for match in sorted(glob.glob(str(pattern))) or [str(pattern)]]


def seal_files(paths, out, allow_empty=False):
    """Write a sealed copy of each file, or of each file under a directory, into `out`; originals stay as they are. Fails only when no path yields a file, unless `allow_empty`."""
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for path in expand(paths):
        if not path.exists():
            continue
        files = sorted(item for item in path.rglob('*') if item.is_file()) if path.is_dir() else [path]
        for item in files:
            target = out / (item.relative_to(path) if path.is_dir() else Path(item.name))
            target = target.with_name(target.name + SUFFIX)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(seal(item.read_bytes()))
            count += 1
    if not count and not allow_empty:
        raise ValueError('nothing to seal')


def unseal_tree(directory):
    """Replace every sealed file under `directory` with its plaintext; files that were never sealed stay as they are."""
    for item in sorted(directory.rglob('*' + SUFFIX)):
        if item.is_file():
            item.with_name(item.name.removesuffix(SUFFIX)).write_bytes(unseal(item.read_bytes()))
            item.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    sealing = commands.add_parser('seal', help='write sealed copies of files or directories into --out')
    sealing.add_argument('--out', type=Path, required=True)
    sealing.add_argument('--allow-empty', action='store_true', help='succeed when no file matches')
    sealing.add_argument('paths', nargs='+', type=Path)
    text = commands.add_parser('text', help='print a sealed copy of a file as one line of base64')
    text.add_argument('file', type=Path)
    opening = commands.add_parser('unseal', help='replace sealed files under a directory with plaintext')
    opening.add_argument('directory', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == 'text':
            print(seal_text(args.file.read_bytes()))
        elif args.command == 'seal':
            seal_files(args.paths, args.out, args.allow_empty)
        else:
            unseal_tree(args.directory)
    except (OSError, ValueError) as error:
        print(f'seal.py {args.command}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
