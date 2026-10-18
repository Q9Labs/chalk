#!/usr/bin/env python3
"""Install a verified recorder archive before identity bootstrap. No build tools."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request


def install(config):
    release_id = config['release_id']
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,127}', release_id):
        raise ValueError('invalid recorder release ID')
    if not re.fullmatch(r'[0-9a-f]{64}', config['sha256']):
        raise ValueError('invalid recorder archive digest')
    root = Path('/opt/chalk-recorder')
    releases = root / 'releases'
    releases.mkdir(exist_ok=True)
    target = releases / release_id
    with tempfile.TemporaryDirectory(prefix='.archive-', dir=releases) as temporary:
        stage = Path(temporary)
        bundle = stage / 'archive.tar.gz'
        digest = hashlib.sha256()
        deadline = time.monotonic() + 240
        size = 0
        # Keep the bearer URL out of exception messages and cloud-init logs.
        try:
            with urllib.request.urlopen(config['url'], timeout=30) as response, bundle.open('xb') as output:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 2 * 1024**3 or time.monotonic() > deadline:
                        raise ValueError('archive download exceeded its limit')
                    digest.update(chunk)
                    output.write(chunk)
        except Exception:
            raise RuntimeError('recorder archive download failed') from None
        if digest.hexdigest() != config['sha256']:
            raise ValueError('recorder archive SHA256 mismatch')
        with tarfile.open(bundle) as archive:
            if any(member.name != 'release' and not member.name.startswith('release/') for member in archive):
                raise ValueError('archive contains an out-of-root path')
            archive.extractall(stage, filter='data')
        release = stage / 'release'
        manifest = (release / 'image-manifest.json').read_bytes()
        if 'sha256:' + hashlib.sha256(manifest).hexdigest() != config['manifest_digest']:
            raise ValueError('recorder manifest digest mismatch')
        if json.loads(manifest)['release_id'] != release_id:
            raise ValueError('recorder manifest release mismatch')
        links = json.loads((release / 'install-links.json').read_text())
        # These archives come from the trusted runner, but never permit arbitrary host paths.
        allowed = {'/usr/local/sbin/chalk-recorder-bootstrap', '/opt/chalk-recorder/current',
                   '/opt/chalk-recorder/image-manifest.json', '/etc/chalk-recorder/image.env',
                   '/etc/chalk-recorder/capture.env', '/etc/chalk-recorder/render.env'}
        allowed.update('/etc/systemd/system/chalk-recorder-' + name for name in
                       ('capture.service', 'render.service', 'renew.service', 'renew.timer'))
        if set(links) - allowed:
            raise ValueError('archive contains an unsupported installed path')
        for path, value in links.items():
            resolved = os.path.normpath(os.path.join(os.path.dirname(path), value))
            if not resolved.startswith('/opt/chalk-recorder/'):
                raise ValueError('archive symlink escapes recorder root')
        receipt = release / '.archive-sha256'
        receipt.write_text(config['sha256'])
        if target.exists():
            if (target / '.archive-sha256').read_text() != config['sha256']:
                raise ValueError('recorder release already exists with different bytes')
        else:
            release.rename(target)
        # Alias changes precede one atomic current switch. Workers are not started here.
        for path, value in sorted(links.items(), key=lambda item: item[0] == str(root / 'current')):
            path = Path(path)
            temporary_link = path.with_name(path.name + '.archive-new')
            temporary_link.unlink(missing_ok=True)
            temporary_link.symlink_to(value)
            temporary_link.replace(path)
        image_env = Path('/etc/chalk-recorder/image.env.archive-new')
        image_env.write_bytes((target / 'config/image.env').read_bytes())
        image_env.chmod(0o440)
        os.chown(image_env, 0, pwd.getpwnam('chalk-recorder').pw_gid)
        image_env.replace('/etc/chalk-recorder/image.env')
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        print('recorder archive installed and selected', flush=True)


if __name__ == '__main__':
    config_path = Path(sys.argv[1])
    try:
        install(json.loads(config_path.read_text()))
    finally:
        config_path.unlink(missing_ok=True)
