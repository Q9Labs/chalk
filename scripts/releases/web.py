#!/usr/bin/env python3
"""Build target-specific static archives; upload verified bytes or restore Pages."""

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlsplit

from github_release import GitHub, outputs, require

ROOT = Path(__file__).resolve().parents[2]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def public_config(target, sha):
    nightly = target == 'nightly'
    return {'CHALK_ENVIRONMENT': target, 'CHALK_COMMIT_SHA': sha,
            'VITE_API_URL': 'https://nightly-api.chalkmeet.com' if nightly else 'https://api.chalkmeet.com',
            'VITE_CHALK_SYNC_URL': 'wss://nightly-sync.chalkmeet.com/v1/sync' if nightly else 'wss://sync.chalkmeet.com/v1/sync',
            'VITE_PUBLIC_APP_URL': 'https://nightly.chalkmeet.com' if nightly else 'https://chalkmeet.com'}


def read_marker(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        require(all(not Path(item.name).is_absolute() and '..' not in Path(item.name).parts
                    and (item.isfile() or item.isdir()) for item in members), 'unsafe web archive')
        require(sum(item.size for item in members) <= 1024 ** 3, 'web archive exceeds 1 GiB')
        require(len(members) == len({item.name for item in members}), 'duplicate archive member')
        return json.load(archive.extractfile('dist/client/release.json'))


def build(target, sha, output, source_root):
    require(re.fullmatch('[0-9a-f]{40}', sha or ''), 'expected full source SHA')
    checked_out = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source_root, text=True).strip()
    require(checked_out == sha, 'web source checkout does not match requested SHA')
    subprocess.run(['pnpm', 'exec', 'turbo', 'run', 'build', '--filter=web...', '--force', '--env-mode=loose'],
                   cwd=source_root, env={**os.environ, **public_config(target, sha)}, check=True)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        shutil.copytree(source_root / 'apps/web/dist/client', stage / 'dist/client')
        (stage / 'dist/client/release.json').write_text(json.dumps({'environment': target, 'commit': sha}))
        (stage / 'wrangler.toml').write_text((source_root / 'apps/web/wrangler.toml').read_text().split('[vars]', 1)[0])
        with tarfile.open(output / f'web-{target}.tar.gz', 'w:gz') as archive:
            archive.add(stage / 'dist', arcname='dist')
            archive.add(stage / 'wrangler.toml', arcname='wrangler.toml')


def pages(project, route='', method='GET'):
    require(project, 'missing explicit Pages project')
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    base_url = os.environ.get('CLOUDFLARE_API_BASE_URL', 'https://api.cloudflare.com/client/v4').rstrip('/')
    require('CLOUDFLARE_API_BASE_URL' not in os.environ or urlsplit(base_url).hostname in ('127.0.0.1', '::1', 'localhost'),
            'Pages API override must use a loopback host')
    url = f'{base_url}/accounts/{account}/pages/projects/{quote(project, safe="")}{route}'
    request = urllib.request.Request(url, method=method, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']})
    open_url = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open if 'CLOUDFLARE_API_BASE_URL' in os.environ else urllib.request.urlopen
    try:
        with open_url(request, timeout=60) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise ValueError(f'Pages API {method} {route or "/"} returned {error.code}: {error.read(500).decode(errors="replace")}') from error
    require(result['success'], 'Pages API request failed')
    return result['result']


def current(project):
    deployment = pages(project)['canonical_deployment']
    require(deployment and deployment['environment'] == 'production'
            and deployment['latest_stage']['status'] == 'success', 'no successful current Pages production deployment')
    return deployment['id']


def rollback(project, deployment_id, target='production'):
    subprocess.run(['node', str(ROOT / 'scripts/deploy/verify-vendor-store.mjs'), '--target', target], check=True)
    if current(project) != deployment_id:
        deployment = pages(project, f'/deployments/{quote(deployment_id, safe="")}/rollback', 'POST')
        require(deployment['id'] == deployment_id, 'Pages rollback returned a different deployment')
    require(current(project) == deployment_id, 'Pages rollback verification failed: saved deployment is not live')
    outputs({'pages_deployment_id': deployment_id})


def deploy(target, sha, run, member, project):
    require(len(member['sha256']) == 64, 'web artifact requires a SHA256 hash')
    require(project and os.environ.get('CLOUDFLARE_ACCOUNT_ID'), 'missing Pages destination')
    data = GitHub().artifact(run, member['artifact_id'], f'web-{target}.tar.gz', member['sha256'])
    require(read_marker(data) == {'environment': target, 'commit': sha}, 'web identity mismatch')
    with tempfile.TemporaryDirectory() as directory:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            archive.extractall(directory, filter='data')
        subprocess.run([str(ROOT / 'node_modules/.bin/tsx'), str(ROOT / 'apps/web/scripts/prepare-vendor-store.ts'),
                        '--directory', str(Path(directory) / 'dist/client'), '--target', target,
                        *(['--verify-only'] if os.environ.get('CLOUDFLARE_VENDOR_WORKER_VERIFY_ONLY') == 'true' else [])], check=True)
        subprocess.run([str(ROOT / 'node_modules/.bin/wrangler'), 'pages', 'deploy', 'dist/client',
                        '--project-name', project, '--branch', 'master', '--commit-hash', sha,
                        '--commit-dirty=false'], cwd=directory, check=True)
    config = public_config(target, sha)
    subprocess.run(['node', str(ROOT / 'scripts/deploy/verify-web-deploy.mjs'), config['VITE_PUBLIC_APP_URL'], sha,
                    '--api-base-url', config['VITE_API_URL'], '--environment', target], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('build', 'deploy', 'current', 'rollback'))
    parser.add_argument('--target', choices=('nightly', 'production'))
    parser.add_argument('--sha')
    parser.add_argument('--output', type=Path, default=Path('web-output'))
    parser.add_argument('--source-root', type=Path)
    args = parser.parse_args()
    if args.command == 'build':
        require(args.source_root is not None, 'build requires explicit --source-root')
        build(args.target, args.sha, args.output, args.source_root)
    elif args.command == 'current':
        outputs({'pages_deployment_id': current(os.environ['PAGES_PROJECT'])})
    elif args.command == 'rollback':
        rollback(os.environ['PAGES_PROJECT'], os.environ['PAGES_ROLLBACK_ID'], args.target)
    else:
        deploy(args.target, args.sha, os.environ['ARTIFACT_RUN_ID'], json.loads(os.environ['WEB_ARTIFACT']), os.environ['PAGES_PROJECT'])
