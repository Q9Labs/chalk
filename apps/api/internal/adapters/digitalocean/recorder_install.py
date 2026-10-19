#!/usr/bin/env python3
"""Install a verified recorder archive before identity bootstrap. No build tools."""
import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import urllib.parse


class ArchiveInstallError(Exception):
    pass


def select_release(release, target, digest):
    receipt = target / '.archive-sha256'
    if target.is_symlink():
        raise ValueError('recorder release target is a symlink')
    if receipt.exists():
        if receipt.read_text() != digest:
            raise ValueError('recorder release already exists with different bytes')
        return
    if not target.exists():
        release.rename(target)
        return
    # A legacy baked release has no receipt. Replace it only after verification,
    # retaining its directory until the new release occupies the selected path.
    previous = release.parent / 'previous'
    target.rename(previous)
    try:
        release.rename(target)
    except Exception:
        previous.rename(target)
        raise


def signed_diagnostic(config, provider_id, reason, directory):
    def openssl(*arguments):
        return subprocess.run(['openssl', *arguments], check=True, capture_output=True, timeout=5).stdout

    key = directory / 'key.pem'
    csr = directory / 'csr.pem'
    openssl('genpkey', '-algorithm', 'ED25519', '-out', str(key))
    openssl('req', '-new', '-key', str(key), '-subj', '/CN=recorder-archive-diagnostic', '-out', str(csr))
    csr_der = openssl('req', '-in', str(csr), '-outform', 'DER')
    request = dict(schema_version='recorder_fleet_node_bootstrap_diagnostic.v1', provider_id=provider_id,
                   release_id=config['release_id'], image_digest=config['manifest_digest'],
                   boot_generation=config['boot_generation'], csr_pem=csr.read_text(),
                   diagnostic=dict(schema_version='recorder_fleet_bootstrap_diagnostic.v1', step='install',
                                   attempt_count=1, last_reason_code=reason, last_http_status=0))
    proof = '\n'.join([
        'chalk.recorder_fleet.node_bootstrap_diagnostic.v1', 'provider_id=' + provider_id,
        'release_id=' + config['release_id'], 'image_digest=' + config['manifest_digest'],
        'boot_generation=' + str(config['boot_generation']), 'csr_sha256=' + hashlib.sha256(csr_der).hexdigest(),
        'step=install', 'attempt_count=1', 'last_reason_code=' + reason, 'last_http_status=0', ''])
    message = directory / 'proof'
    message.write_text(proof)
    signature = openssl('pkeyutl', '-sign', '-rawin', '-inkey', str(key), '-in', str(message))
    request['signature'] = base64.urlsafe_b64encode(signature).decode().rstrip('=')
    return request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def report_failure(config, reason, metadata_url='http://169.254.169.254/metadata/v1/id',
                   ca_file='/etc/chalk-recorder/bootstrap-ca.pem'):
    # This path must work with today's base binary, before the new one installs.
    # It uses the existing CSR proof and inventory-bound diagnostic endpoint only.
    with urllib.request.urlopen(metadata_url, timeout=5) as response:
        provider_id = response.read(129).decode().strip()
    if not re.fullmatch(r'[0-9]{1,128}', provider_id):
        raise ValueError('invalid provider ID')
    with tempfile.TemporaryDirectory(prefix='chalk-archive-diagnostic-') as temporary:
        request = signed_diagnostic(config, provider_id, reason, Path(temporary))
    context = ssl.create_default_context(cafile=ca_file)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), NoRedirect())
    endpoint = urllib.parse.urljoin(config['endpoint'], '/v1/recorder-fleet/node-bootstrap/diagnostic')
    payload = json.dumps(request).encode()
    deadline = time.monotonic() + 60
    while True:
        try:
            with opener.open(urllib.request.Request(endpoint, data=payload,
                             headers={'Content-Type': 'application/json'}), timeout=5) as response:
                if response.status == 204:
                    print('recorder archive failure diagnostic retained', flush=True)
                    return
        except Exception:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('recorder archive diagnostic unavailable')
        time.sleep(2)


def install(config, root=Path('/opt/chalk-recorder')):
    release_id = config['release_id']
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,127}', release_id):
        raise ValueError('invalid recorder release ID')
    if not re.fullmatch(r'[0-9a-f]{64}', config['sha256']):
        raise ValueError('invalid recorder archive digest')
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
            raise ArchiveInstallError('archive_download_failed') from None
        if digest.hexdigest() != config['sha256']:
            raise ArchiveInstallError('archive_verification_failed')
        try:
            with tarfile.open(bundle) as archive:
                if any(member.name != 'release' and not member.name.startswith('release/') for member in archive):
                    raise ValueError('archive contains an out-of-root path')
                archive.extractall(stage, filter='data')
        except Exception:
            raise ArchiveInstallError('archive_extraction_failed') from None
        release = stage / 'release'
        manifest = (release / 'image-manifest.json').read_bytes()
        if 'sha256:' + hashlib.sha256(manifest).hexdigest() != config['manifest_digest']:
            raise ArchiveInstallError('archive_verification_failed')
        if json.loads(manifest)['release_id'] != release_id:
            raise ArchiveInstallError('archive_verification_failed')
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
        select_release(release, target, config['sha256'])
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


def main(config_path):
    config = None
    try:
        config = json.loads(config_path.read_text())
        install(config)
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ArchiveInstallError) else 'archive_install_failed'
        print('recorder archive installation failed: ' + reason, flush=True)
        if config is not None:
            try:
                report_failure(config, reason)
            except Exception:
                print('recorder archive failure diagnostic unavailable', flush=True)
        return 1
    finally:
        config_path.unlink(missing_ok=True)


if __name__ == '__main__':
    sys.exit(main(Path(sys.argv[1])))
