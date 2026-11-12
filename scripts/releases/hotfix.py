#!/usr/bin/env python3
"""Hotfix decisions: plan the SHA against master, the Gate and the rollback baseline; judge the outcome; time the stages."""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from github_release import GitHub, held_candidates, outputs, payload, require
from release import ancestor, env, manifest_bytes, previous_production

BASELINE_KEYS = ('run_id', 'target_sha', 'release_id', 'manifest_artifact_id', 'manifest_sha256', 'media_sha256')


def baseline_for(github, environment):
    """The release now running: what a failed hotfix returns to, and the stable manifest the hotfix builds on."""
    if environment == 'production':
        info = previous_production(github)
    else:
        held = held_candidates(github.deployments('nightly'))
        require(held, 'no held nightly to use as the rollback baseline')
        info = payload(held[0])
    manifest_bytes(github, info)
    return {key: info.get(key, '') or '' for key in BASELINE_KEYS}


def plan(github, args):
    sha = env('HOTFIX_SHA')
    environment = env('HOTFIX_ENVIRONMENT')
    require(re.fullmatch('[0-9a-f]{40}', sha), 'sha must be a full lowercase commit SHA')
    require(environment in ('nightly', 'production'), 'environment must be nightly or production')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/ops/hotfix-proof', 'run the hotfix workflow from master')
    require(os.environ.get('FORCE_SMOKE_FAILURE') != 'true' or environment == 'nightly',
            'a forced smoke failure is a rehearsal and runs only on nightly')
    require(github.is_on_master(sha), f'{sha} is not on master; merge the fix first')
    github.wait_for_gate(sha, push_only=True)
    require(github.has_green_gate(sha, push_only=True),
            f'{sha} has no successful push Gate run on master. Wait for its Gate or fix it; pull request Gate runs do not count.')
    baseline = baseline_for(github, environment)
    require(baseline['target_sha'] != sha, f'{environment} already runs {sha}')
    try:
        github.artifact(baseline['run_id'], baseline['manifest_artifact_id'], baseline['release_id'] + '.json', baseline['manifest_sha256'] or None)
    except ValueError as error:
        raise ValueError(f"the build baseline artifact of {baseline['release_id']} is gone, so the hotfix cannot build on it: {error}") from error
    outputs({'baseline': baseline})
    with open(env('GITHUB_STEP_SUMMARY'), 'a') as summary:
        summary.write(f"## Hotfix plan\n\nShip `{sha}` to {environment}. Rollback baseline `{baseline['release_id']}` "
                      f"(source `{baseline['target_sha']}`).\n")


def verdict(github, args):
    baseline = json.loads(env('BASELINE'))
    rollback = json.loads(os.environ.get('ROLLBACK') or '{}')
    smoke_passed = os.environ.get('SMOKE_RESULT') == 'success' and os.environ.get('SMOKE_OUTCOME') == 'passed'
    shipped = os.environ.get('RELEASE_RESULT') == 'success' and smoke_passed
    pages_id = os.environ.get('PAGES_ID', '')
    recovered = (os.environ.get('ROLLBACK_RESULT') == 'success'
                 and rollback.get('restored_source_release_id') == baseline['release_id']
                 and bool(rollback.get('release_id')) and rollback.get('applied_release_id') == rollback['release_id']
                 and bool(pages_id) and rollback.get('pages_deployment_id') == pages_id)
    with open(env('GITHUB_STEP_SUMMARY'), 'a') as summary:
        if shipped:
            summary.write(f"HOTFIX LIVE: {env('HOTFIX_SHA')} passed the real-call smoke.\n\n")
        elif not os.environ.get('APPLIED_RELEASE') and os.environ.get('ROLLBACK_RESULT') == 'skipped':
            summary.write('HOTFIX NOT DEPLOYED: the release failed before the host took it, or the host controller restored the baseline itself. '
                          'Check service health, then fix the cause and run the hotfix again.\n\n')
        elif recovered:
            summary.write(f"ROLLBACK VERIFIED: the hotfix did not pass; {baseline['release_id']} is live again, Pages {pages_id}.\n\n")
        else:
            manual = dict(target_sha=baseline['target_sha'], release_managed=False, deploy_managed=True,
                          managed_environment=env('HOTFIX_ENVIRONMENT'), deploy_web=True, manifest_run_id=baseline['run_id'],
                          manifest_artifact_id=baseline['manifest_artifact_id'], manifest_sha256=baseline['manifest_sha256'],
                          reuse_release_id=baseline['release_id'], pages_rollback_id=pages_id, media_sha256=baseline['media_sha256'],
                          rollback_media=os.environ.get('ROLLBACK_MEDIA', ''))
            summary.write('ROLLBACK NOT VERIFIED: restore by hand, see docs/operators/incident.md. Run the Release workflow from master with:\n\n```json\n'
                          + json.dumps(manual, indent=2) + '\n```\n')
    if not shipped:
        sys.exit('hotfix did not ship; the run stays red until someone confirms service')


STAGES = (('plan', 'plan'), ('retain', 'retain'), ('require gate', 'release / Require'), ('build', 'release / Build'),
          ('build', 'release / Plan'), ('build', 'release / Validate'), ('build', 'release / Publish'),
          ('build', 'release / Verify'), ('build', 'release / prepare'), ('deploy backend', 'release / Deploy managed'),
          ('deploy web', 'release / Deploy selected'), ('smoke', 'smoke /'), ('rollback backend', 'rollback / Deploy managed'),
          ('rollback web', 'rollback / Deploy selected'))


def minutes(start, end):
    parse = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
    return (parse(end) - parse(start)).total_seconds() / 60


def timings(github, args):
    run_id = env('GITHUB_RUN_ID')
    run = github.request(f'actions/runs/{run_id}')
    jobs = [job for job in github.pages(f'actions/runs/{run_id}/jobs?filter=latest', 'jobs')
            if job['conclusion'] in ('success', 'failure') and job.get('started_at') and job.get('completed_at')]
    by_stage = {}
    for job in jobs:
        stage = next((name for name, prefix in STAGES if job['name'].startswith(prefix)), None)
        if stage:
            first, last = by_stage.get(stage, (job['started_at'], job['completed_at']))
            by_stage[stage] = (min(first, job['started_at']), max(last, job['completed_at']))
    ends = [job['completed_at'] for job in jobs]
    lines = ['## Stage minutes (wall clock, queue time included in total)', '', '| Stage | Minutes |', '| --- | --- |']
    lines += [f'| {stage} | {minutes(first, last):.1f} |' for stage, (first, last) in sorted(by_stage.items(), key=lambda item: item[1][0])]
    lines.append(f'| total so far | {minutes(run["run_started_at"], max(ends)):.1f} |')
    text = '\n'.join(lines) + '\n'
    print(text)
    with open(env('GITHUB_STEP_SUMMARY'), 'a') as summary:
        summary.write(text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'verdict', 'timings'))
    args = parser.parse_args()
    try:
        globals()[args.command](GitHub(), args)
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(f'Hotfix refused: {error}')
