#!/usr/bin/env python3
"""Build target-specific static archives; upload verified bytes or restore Pages."""

import argparse
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import quote

from github_release import GitHub, digest, outputs, require

ROOT = Path(__file__).resolve().parents[2]


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


def build(target, sha, output):
    subprocess.run(['pnpm', 'exec', 'turbo', 'run', 'build', '--filter=web...', '--force', '--env-mode=loose'],
                   cwd=ROOT, env={**os.environ, **public_config(target, sha)}, check=True)
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        stage = Path(directory)
        shutil.copytree(ROOT / 'apps/web/dist/client', stage / 'dist/client')
        (stage / 'dist/client/release.json').write_text(json.dumps({'environment': target, 'commit': sha}))
        shutil.copyfile(ROOT / 'apps/web/wrangler.toml', stage / 'wrangler.toml')
        with tarfile.open(output / f'web-{target}.tar.gz', 'w:gz') as archive:
            archive.add(stage / 'dist', arcname='dist')
            archive.add(stage / 'wrangler.toml', arcname='wrangler.toml')


def pages(project, route='', method='GET'):
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    url = f'https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects/{quote(project, safe="")}{route}'
    request = urllib.request.Request(url, method=method, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']})
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.load(response)
    require(result['success'], 'Pages API request failed')
    return result['result']


def current(project):
    deployment = pages(project)['canonical_deployment']
    require(deployment and deployment['environment'] == 'production'
            and deployment['latest_stage']['status'] == 'success', 'no successful current Pages production deployment')
    return deployment['id']


def rollback(project, deployment_id):
    deployment = pages(project, f'/deployments/{quote(deployment_id, safe="")}/rollback', 'POST')
    require(deployment['id'] == deployment_id and current(project) == deployment_id, 'Pages rollback did not restore the saved deployment')


def deploy(target, sha, run, member, project):
    require(len(member['sha256']) == 64, 'web artifact requires a SHA256 hash')
    require(project and os.environ.get('CLOUDFLARE_ACCOUNT_ID'), 'missing Pages destination')
    data = GitHub().artifact(run, member['artifact_id'], f'web-{target}.tar.gz', member['sha256'])
    require(read_marker(data) == {'environment': target, 'commit': sha}, 'web identity mismatch')
    with tempfile.TemporaryDirectory() as directory:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            archive.extractall(directory, filter='data')
        subprocess.run([str(ROOT / 'node_modules/.bin/wrangler'), 'pages', 'deploy', 'dist/client',
                        '--project-name', project, '--branch', 'master', '--commit-hash', sha,
                        '--commit-dirty=false'], cwd=directory, check=True)
    url = public_config(target, sha)['VITE_PUBLIC_APP_URL'] + '/release.json'
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=30) as response:
        require(json.load(response) == {'environment': target, 'commit': sha}, 'served web release mismatch')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('build', 'deploy', 'current', 'rollback'))
    parser.add_argument('--target', choices=('nightly', 'production'))
    parser.add_argument('--sha')
    parser.add_argument('--output', type=Path, default=Path('web-output'))
    args = parser.parse_args()
    project = os.environ.get('PAGES_PROJECT', 'chalk-web')
    if args.command == 'build':
        build(args.target, args.sha, args.output)
    elif args.command == 'current':
        outputs({'pages_deployment_id': current(project)})
    elif args.command == 'rollback':
        rollback(project, os.environ['PAGES_ROLLBACK_ID'])
    else:
        deploy(args.target, args.sha, os.environ['ARTIFACT_RUN_ID'], json.loads(os.environ['WEB_ARTIFACT']), project)
