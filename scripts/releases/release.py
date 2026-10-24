#!/usr/bin/env python3
"""Nightly decisions, artifact validation and immutable deployment envelopes."""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from github_release import GitHub, cut_decision, digest, held_candidates, outputs, payload, require

ROOT = Path(__file__).resolve().parents[2]


def env(name):
    value = os.environ.get(name, '')
    require(value, f'missing {name}')
    return value


def ancestor(sha, target='origin/master'):
    require(re.fullmatch('[0-9a-f]{40}', sha), 'expected full source SHA')
    subprocess.run(['git', 'merge-base', '--is-ancestor', sha, target], check=True)


def manifest_bytes(github, info, trusted=True):
    data = None
    if trusted and info.get('manifest_sha256'):
        for item in github.deployments('production', 'production-release', sha=info['target_sha'], manifest_sha256=info['manifest_sha256']):
            saved = payload(item)
            if saved['release_id'] == info['release_id'] and saved['manifest_sha256'] == info['manifest_sha256']:
                data = retained_manifest(saved)
    if data is None:
        run = github.request(f"actions/runs/{info['run_id']}")
        require(not trusted or (run['head_branch'] == 'master' and run['head_repository']['full_name'] == github.repository
                and run['path'].split('@')[0] in ('.github/workflows/ci.yml', '.github/workflows/nightly.yml', '.github/workflows/promote.yml')
                and run['event'] in ('schedule', 'workflow_dispatch')), 'untrusted artifact-producing run')
        data = github.artifact(info['run_id'], info['manifest_artifact_id'], info['release_id'] + '.json', info.get('manifest_sha256') or None)
    value = json.loads(data)
    require(value['release_id'] == info['release_id'] and value['source_revision'] == info['target_sha'], 'manifest identity mismatch')
    if trusted:
        ancestor(value['source_revision'])
    return data


def previous_production(github, retain_legacy=False):
    durable = github.deployments('production', 'production-release')
    if durable:
        info = dict(payload(durable[0]))
        data = retained_manifest(info)
        info['recorder_control'] = 'recorder_control' in json.loads(data).get('images', {})
        del info['manifest_base64']
        del info['channel']
        return info
    # Bootstrap an existing release once; all new production deploys retain bytes.
    # Missing legacy artifacts require a manual release, not an invented baseline.
    runs = [run for workflow in ('ci.yml', 'promote.yml') for run in
            github.pages(f'actions/workflows/{workflow}/runs?branch=master&status=completed', 'workflow_runs')]
    applications = []
    for run in runs:
        for job in github.pages(f"actions/runs/{run['id']}/jobs?filter=latest", 'jobs'):
            if job['name'].endswith('Deploy managed release to production') and job['conclusion'] == 'success':
                applications.append((job['completed_at'], int(job['id']), run))
    require(applications, 'no successful production Release manifest; manual release required')
    _, _, run = max(applications, key=lambda item: item[:2])
    artifacts = github.pages(f"actions/runs/{run['id']}/artifacts", 'artifacts')
    proofs = sorted((item for item in artifacts if item['name'].startswith('managed-deployment-')),
                    key=lambda item: int(item['id']), reverse=True)
    require(proofs, 'latest production deployment has no retained deploy result')
    proof = json.loads(github.artifact(run['id'], proofs[0]['id'], 'managed-deployment.json'))
    require(proof['status'] == 'deployed' and proof['health'] == 'passed'
            and proof['deployment_phase'] == 'complete' and not proof['rolled_back'], 'latest production deploy result is invalid')
    release = proof['release_id']
    matches = [item for item in artifacts if item['name'] == 'release-manifest-' + release]
    require(len(matches) == 1, 'latest production manifest is unavailable; manual recovery required')
    data = github.artifact(run['id'], matches[0]['id'], release + '.json')
    value = json.loads(data)
    info = dict(run_id=str(run['id']), target_sha=value['source_revision'], release_id=release,
                manifest_artifact_id=str(matches[0]['id']), manifest_sha256=digest(data),
                recorder_control='recorder_control' in value.get('images', {}))
    manifest_bytes(github, info)
    # Only the approved recheck holds the production lock. Nightly planning
    # must remain read-only to avoid adopting stale production during a deploy.
    if retain_legacy:
        saved = dict(info, channel='production-release', manifest_base64=base64.b64encode(data).decode())
        item = save_production(github, saved)
        github.request(f"deployments/{item['id']}/statuses", {'state': 'success', 'auto_inactive': False})
    return info


def retained_manifest(info):
    data = base64.b64decode(info['manifest_base64'], validate=True)
    require(digest(data) == info['manifest_sha256'], 'retained production manifest checksum mismatch')
    value = json.loads(data)
    require(value['release_id'] == info['release_id'] and value['source_revision'] == info['target_sha'],
            'retained production manifest identity mismatch')
    return data


def save_production(github, info):
    return github.request('deployments', dict(ref=info['target_sha'], environment='production',
                          task='production-release', auto_merge=False, required_contexts=[], payload=info))


def retain_production(github, args):
    source = args.directory / (env('RELEASE_ID') + '.json')
    data = source.read_bytes()
    require(digest(data) == env('MANIFEST_SHA256'), 'production manifest checksum mismatch')
    value = json.loads(data)
    require(value['release_id'] == env('RELEASE_ID') and value['source_revision'] == env('TARGET_SHA'),
            'production manifest identity mismatch')
    info = dict(channel='production-release', run_id=env('GITHUB_RUN_ID'), target_sha=value['source_revision'],
                release_id=value['release_id'], manifest_artifact_id=env('MANIFEST_ARTIFACT_ID'),
                manifest_sha256=digest(data), manifest_base64=base64.b64encode(data).decode())
    media = source.with_suffix('.media.json')
    if media.exists():
        info.update(media_sha256=digest(media.read_bytes()), media_base64=base64.b64encode(media.read_bytes()).decode())
    item = save_production(github, info)
    outputs({'deployment_id': item['id']})


def complete_production(github, args):
    proof = json.loads(Path(env('DEPLOYMENT_RESULT')).read_bytes())
    require(proof['release_id'] == env('RELEASE_ID') and proof['status'] == 'deployed'
            and proof['health'] == 'passed' and proof['deployment_phase'] == 'complete' and not proof['rolled_back'],
            'production deployment proof is invalid')
    github.request(f"deployments/{env('DEPLOYMENT_ID')}/statuses", {'state': 'success', 'auto_inactive': False})


def defer_cut(github, target, reason, *, manual):
    print(f'Nightly: {reason}')
    if manual:
        github.dispatch_nightly()
        print('Nightly: manual request requeued on master with fresh orchestration')
    outputs(dict(should_cut=False, target_sha=target))


def plan(github, args):
    target = github.request('git/ref/heads/master')['object']['sha']
    if target != env('GITHUB_SHA'):
        defer_cut(github, target, 'workflow revision is not the current master tip', manual=args.manual)
        return
    records = github.deployments('nightly') + github.deployments('nightly', 'nightly-attempt')
    cut, reason = cut_decision(target, records, datetime.now(timezone.utc), args.manual)
    print(f'Nightly: {reason}; target {target}')
    if cut and not github.has_green_gate(target, push_only=not args.manual):
        require(not args.manual, f'latest master Gate for {target} is not successful')
        cut = False
        print('Nightly: current master tip has no successful push Gate; skipping')
    result = dict(should_cut=cut, target_sha=target)
    if cut:
        held = held_candidates(records, held=False)
        baseline = payload(held[0]) if held else previous_production(github)
        # Rebuilding all components is safe when an old baseline cannot be read;
        # do not forward dead artifact IDs and wedge every future cut.
        recorder_control = baseline['recorder_control']
        try:
            data = manifest_bytes(github, baseline)
            recorder_control = 'recorder_control' in json.loads(data).get('images', {})
            github.artifact(baseline['run_id'], baseline['manifest_artifact_id'], baseline['release_id'] + '.json', baseline['manifest_sha256'])
        except (ValueError, subprocess.CalledProcessError) as error:
            print(f'Build baseline unavailable; rebuilding all enabled components: {error}')
        else:
            result.update(baseline_run_id=baseline['run_id'], baseline_artifact_id=baseline['manifest_artifact_id'])
        result['recorder_control'] = True
        if github.request('git/ref/heads/master')['object']['sha'] != target:
            defer_cut(github, target, 'master moved during planning', manual=args.manual)
            return
        github.reserve_cut(target)
    outputs(result)


def builds_fresh_artifacts():
    # Mirrors the plan-managed and build-web conditions in ci.yml. Reuse deploys artifacts that an earlier, gated run
    # built; a Pages rollback input alone does not stop either build.
    flag = lambda name: os.environ.get(name) == 'true'
    return not os.environ.get('MANIFEST_RUN_ID') and (flag('RELEASE_MANAGED') or flag('DEPLOY_MANAGED') or flag('DEPLOY_WEB'))


def require_gate(github, args):
    if os.environ.get('ENFORCE_ENTRY_OWNERSHIP') == 'true':
        require(os.environ.get('RELEASE_MANAGED') == 'true' and not os.environ.get('MANIFEST_RUN_ID'),
                'entry enforcement requires a fresh managed manifest, not reuse of an existing artifact')
    if not builds_fresh_artifacts():
        print('Release builds nothing new; it deploys earlier artifacts without a new Gate check')
        return
    target = env('TARGET_SHA')
    require(re.fullmatch('[0-9a-f]{40}', target), 'target_sha must be a full lowercase commit SHA')
    # A called workflow sees its caller's event. Scheduled nightly plans its cut on the latest push Gate, so its child
    # applies the same rule; an unfinished 01:17 scheduled Gate must not fail a cut that the plan already accepted.
    push_only = os.environ.get('GITHUB_EVENT_NAME') == 'schedule'
    require(github.has_green_gate(target, push_only=push_only),
            f'{target} has no successful {"push " if push_only else ""}Gate run on master. Pull request Gate runs do not count: '
            'merge the change, wait for its master Gate to pass, then release that commit.')
    print(f'Release: latest master {"push " if push_only else ""}Gate for {target} passed')


def validate_choice(github, item):
    info = payload(item)
    require(re.fullmatch('[0-9a-f]{64}', info['manifest_sha256']), 'missing manifest hash')
    manifest_bytes(github, info)
    require(media_bytes(github, info), 'held nightly has no immutable media members')
    require(github.has_green_gate(info['target_sha']), f"latest master Gate for {info['target_sha']} is not successful")
    for target in ('nightly', 'production'):
        member = info['web'][target]
        require(re.fullmatch('[0-9a-f]{64}', member['sha256']), 'missing web hash')
        data = github.artifact(info['run_id'], member['artifact_id'], f'web-{target}.tar.gz', member['sha256'])
        from web import read_marker
        require(read_marker(data) == {'environment': target, 'commit': info['target_sha']}, 'web identity mismatch')
    require(info.get('applied_release_id') == info['release_id'], 'held applied identity mismatch')
    return info


def select(github, args):
    records = github.deployments('nightly')
    held = held_candidates(records)
    require(held, 'no held nightly')
    selected = held[0]  # Never fall back when the newest held record is invalid.
    info = validate_choice(github, selected)
    previous = previous_production(github)
    result = dict(deployment_id=selected['id'], selection=info, previous=previous)
    outputs({'selection': result})
    with open(env('GITHUB_STEP_SUMMARY'), 'a') as summary:
        summary.write('## Exact promotion choice and rollback source\n\n```json\n' + json.dumps(result, indent=2) + '\n```\n')


def recheck(github, args):
    selection = json.loads(env('SELECTION'))
    item = github.request(f"deployments/{selection['deployment_id']}")
    status = github.request(f"deployments/{item['id']}/statuses?per_page=1")
    item['latest_status'] = status[0]['state'] if status else 'pending'
    require(held_candidates([item]) and payload(item) == selection['selection'], 'selected nightly changed or is no longer held')
    newest = held_candidates(github.deployments('nightly'))
    require(newest and newest[0]['id'] == item['id'], 'a newer held nightly replaced the selection')
    validate_choice(github, item)
    manifest_bytes(github, selection['previous'])
    require(previous_production(github, retain_legacy=True) == selection['previous'], 'production rollback baseline changed')


def fresh_envelope(source, output):
    value = json.loads(source.read_bytes())
    subprocess.run([str(ROOT / 'infrastructure/managed-episode/scripts/generate-release-manifest'),
                    '--stable-manifest', str(source), '--affected-components', 'none', '--reuse-envelope',
                    '--source-revision', value['source_revision'], '--output', str(output)], check=True)
    applied = json.loads(output.read_bytes())
    require(applied['release_id'] != value['release_id'], 'reuse requires a fresh envelope')
    require(applied['images'] == value['images'] and applied['component_releases'] == value['component_releases'],
            'envelope must preserve images and component source identities')
    require(applied['runtime_artifacts'] == value['runtime_artifacts'], 'envelope must preserve source runtime artifacts')
    require(applied['database_compatibility'] == value['database_compatibility'], 'envelope must preserve source migration requirements')
    return applied


def media_bytes(github, info):
    checksum = info.get('media_sha256')
    if not checksum:
        return None
    require(re.fullmatch('[0-9a-f]{64}', checksum), 'invalid media checksum')
    for item in github.deployments('production', 'production-release', sha=info['target_sha'], manifest_sha256=info.get('manifest_sha256')):
        saved = payload(item)
        if saved.get('media_sha256') == checksum and saved.get('media_base64'):
            data = base64.b64decode(saved['media_base64'], validate=True)
            require(digest(data) == checksum, 'retained media checksum mismatch')
            return data
    return github.artifact(info['run_id'], info['manifest_artifact_id'], info['release_id'] + '.media.json', checksum)


def prepare(github, args):
    environment = env('MANAGED_ENVIRONMENT')
    require(environment in ('nightly', 'production'), 'unsupported managed environment; expected nightly or production')
    info = dict(run_id=env('SOURCE_RUN_ID'), release_id=env('SOURCE_RELEASE_ID'),
                manifest_artifact_id=env('SOURCE_ARTIFACT_ID'), manifest_sha256=os.environ.get('SOURCE_SHA256'), target_sha=env('TARGET_SHA'),
                media_sha256=os.environ.get('SOURCE_MEDIA_SHA256'))
    require(not args.reuse or re.fullmatch('[0-9a-f]{64}', info['manifest_sha256']), 'reuse requires source hash')
    data = manifest_bytes(github, info, trusted=args.reuse)
    media = media_bytes(github, info)
    if os.environ.get('ROLLBACK_MEDIA'):
        require(args.reuse and not media, 'rollback snapshot is only for a legacy source')
        media = os.environ['ROLLBACK_MEDIA'].encode()
    if environment == 'production':
        require('recorder_control' in json.loads(data).get('images', {}), 'production requires recorder control')
    if media:
        from media import validate_members
        validate_members(json.loads(media))
    args.directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'source.json'
        source.write_bytes(data)
        output = Path(directory) / 'applied.json'
        value = fresh_envelope(source, output) if args.reuse else json.loads(data)
        applied = args.directory / (value['release_id'] + '.json')
        applied.write_bytes(output.read_bytes() if args.reuse else data)
    if media:
        (args.directory / (value['release_id'] + '.media.json')).write_bytes(media)
    outputs(dict(release_id=value['release_id'], manifest_sha256=digest(applied.read_bytes()), media_sha256=digest(media) if media else ''))


def webrefs(github, args):
    artifacts = github.pages(f"actions/runs/{env('GITHUB_RUN_ID')}/artifacts", 'artifacts')
    result = {}
    for target in ('nightly', 'production'):
        matches = [item for item in artifacts if item['name'] == f"web-{target}-{env('GITHUB_RUN_ATTEMPT')}"]
        if matches:
            require(len(matches) == 1, 'ambiguous web artifact')
            item = matches[0]
            data = github.artifact(env('GITHUB_RUN_ID'), item['id'], f'web-{target}.tar.gz')
            result[target] = dict(artifact_id=str(item['id']), sha256=digest(data))
    outputs({'web': result})


def record(github, args):
    info = json.loads(env('RELEASE'))
    info['target_sha'] = env('TARGET_SHA')
    info['web'] = json.loads(info.get('web') or '{}')
    real_call = os.environ.get('PROOF_RESULT', 'failed')
    web_e2e = os.environ.get('WEB_E2E_RESULT', 'failed')
    passed = os.environ.get('DEPLOY_RESULT') == 'success' and real_call == 'passed' and web_e2e == 'passed'
    info.update(channel='nightly-cut', proof_result='passed' if passed else 'failed',
                real_call_proof_result=real_call, web_e2e_result=web_e2e, proof_run_id=env('GITHUB_RUN_ID'))
    if passed:
        require(info['release_id'] == info['applied_release_id'], 'deploy result identity mismatch')
        require_current_write(github.deployments('nightly', 'nightly-write'), info)
        validate_choice(github, {'payload': info})
        data = manifest_bytes(github, info)
        info['recorder_control'] = 'recorder_control' in json.loads(data).get('images', {})
    outputs({'deployment_id': github.record(info['target_sha'], info, passed)})


def require_current_write(records, info, message='a newer nightly write replaced this run; refusing stale held evidence'):
    markers = [item for item in records if payload(item).get('channel') == 'nightly-write']
    latest = max(markers, key=lambda item: (item['created_at'], int(item['id'])), default=None)
    require(latest and payload(latest).get('run_id') == info['run_id']
            and payload(latest).get('release_id') == info['applied_release_id'],
            message)


def invalidate(github, args):
    # All callers hold chalk-environment-nightly, including record-only retries.
    backend = os.environ.get('EXPECTED_BACKEND_RELEASE_ID', '')
    if backend:
        require_current_write(github.deployments('nightly', 'nightly-write'),
                              dict(run_id=env('GITHUB_RUN_ID'), applied_release_id=backend),
                              "a newer nightly write replaced this run's backend; refusing stale web write")
    # Track live writes for proof ownership, not promotion of saved held bytes.
    github.request('deployments', {'ref': env('TARGET_SHA'), 'environment': 'nightly', 'task': 'nightly-write', 'auto_merge': False,
                   'required_contexts': [], 'payload': dict(channel='nightly-write', run_id=env('GITHUB_RUN_ID'),
                                                          release_id=backend or os.environ.get('RELEASE_ID', ''))})


def verify_images(github, args):
    require(args.manifest, 'image check requires --manifest')
    images = json.loads(args.manifest.read_bytes())['images']
    require(images, 'release has no container images')
    for component, image in images.items():
        match = re.fullmatch(r'([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?/([a-z0-9._/-]+)@(sha256:[0-9a-f]{64})', image)
        require(match, f'{component}: expected a digest-addressed ECR image')
        registry, region, repository, checksum = match.groups()
        try:
            result = subprocess.run(['aws', 'ecr', 'describe-images', '--registry-id', registry,
                                     '--region', region, '--repository-name', repository,
                                     '--image-ids', 'imageDigest=' + checksum, '--output', 'json'],
                                    capture_output=True, text=True, timeout=60,
                                    env={**os.environ, 'AWS_PAGER': ''})
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError(f'{component}: ECR image check failed; refusing deployment') from error
        if result.returncode:
            require('ImageNotFoundException' not in result.stderr,
                    f'{component}: held container image is missing from ECR; cut a new nightly')
            raise ValueError(f'{component}: ECR image check failed; refusing deployment')
        details = json.loads(result.stdout).get('imageDetails', [])
        require(any(item['imageDigest'] == checksum for item in details),
                f'{component}: held container image is missing from ECR; cut a new nightly')
    print('All release container digests exist in ECR')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'select', 'recheck', 'require_gate', 'prepare', 'webrefs', 'record', 'invalidate', 'retain_production', 'complete_production', 'verify_images'))
    parser.add_argument('--directory', type=Path, default=Path('release-input'))
    parser.add_argument('--manual', action='store_true')
    parser.add_argument('--reuse', action='store_true')
    parser.add_argument('--manifest', type=Path)
    args = parser.parse_args()
    globals()[args.command](GitHub(), args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(f'Release refused: {error}')
