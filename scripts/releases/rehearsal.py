#!/usr/bin/env python3
"""Pick the two newest passed nightly cuts for the rollback rehearsal and judge its three deploys."""

import argparse
import json
import os
import sys

from github_release import GitHub, outputs, payload, require
from release import deployed_cut, env, manifest_bytes

KEYS = ('run_id', 'target_sha', 'release_id', 'manifest_artifact_id', 'manifest_sha256')


def passed_cuts(github, count):
    """Newest first. A newer held cut marks the older ones inactive, so a passed cut counts when it was ever recorded as success.
    The GitHub boundary returns only the first match, so this walks the pages itself."""
    found = []
    page = 1
    while len(found) < count:
        items = github.request(f'deployments?environment=nightly&task=nightly-cut&per_page=100&page={page}')
        for item in items:
            info = payload(item)
            if info.get('channel') != 'nightly-cut' or info.get('proof_result') != 'passed':
                continue
            if any(status['state'] == 'success' for status in github.request(f"deployments/{item['id']}/statuses?per_page=10")):
                found.append(info)
                if len(found) == count:
                    break
        if len(items) < 100:
            break
        page += 1
    return found


def baseline_needed(github, current):
    """The first leg only puts nightly on the current cut. When staging already runs that cut, from a finished nightly deploy, the
    rollback starts from the real state and the leg would redeploy the same source."""
    try:
        return deployed_cut(github) != current['target_sha']
    except ValueError:
        return True


def plan(github, args):
    cuts = passed_cuts(github, 2)
    require(len(cuts) == 2, 'the rehearsal needs two nightly cuts that passed their proof; cut another nightly first')
    current, previous = cuts
    require(current['release_id'] != previous['release_id'] and current['target_sha'] != previous['target_sha'],
            'the two newest passed cuts are the same release; there is nothing to roll back to')
    for info in cuts:
        manifest_bytes(github, info)
    outputs({'current': {key: current[key] for key in KEYS} | {'media_sha256': current.get('media_sha256', '')},
             'previous': {key: previous[key] for key in KEYS} | {'media_sha256': previous.get('media_sha256', '')},
             'baseline': baseline_needed(github, current)})


def verdict(github, args):
    """Each leg must have applied its own source release. A rollback that fails shows which leg and why in the deploy job log."""
    current, previous = json.loads(env('CURRENT')), json.loads(env('PREVIOUS'))
    legs = (('deploy current', 'BASELINE', current), ('roll back', 'ROLLBACK', previous), ('roll forward', 'FORWARD', current))
    if env('BASELINE_NEEDED') != 'true':
        legs = legs[1:]
    problems = []
    for name, variable, source in legs:
        result = json.loads(env(variable))
        if result.get('restored_source_release_id') != source['release_id'] or not result.get('release_id') or result.get('applied_release_id') != result['release_id']:
            problems.append(f"{name}: expected source {source['release_id']}, got {result.get('restored_source_release_id') or 'nothing'}")
    with open(env('GITHUB_STEP_SUMMARY'), 'a') as summary:
        if problems:
            summary.write('## Rollback rehearsal FAILED\n\n' + '\n'.join(f'- {line}' for line in problems) + '\n')
        else:
            summary.write(f"## Rollback rehearsal passed\n\n{current['release_id']} -> {previous['release_id']} -> {current['release_id']}\n")
            if env('BASELINE_NEEDED') != 'true':
                summary.write('\nNightly already ran the current cut, so the first leg was skipped.\n')
    if problems:
        sys.exit('rollback rehearsal failed: ' + '; '.join(problems))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'verdict'))
    args = parser.parse_args()
    try:
        globals()[args.command](GitHub(), args)
    except (ValueError, KeyError) as error:
        sys.exit(f'Rehearsal refused: {error}')
