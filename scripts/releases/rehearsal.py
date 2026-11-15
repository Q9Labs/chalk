#!/usr/bin/env python3
"""Pick the two newest passed nightly cuts for the rollback rehearsal."""

import argparse
import sys

from github_release import GitHub, outputs, payload, require
from release import manifest_bytes

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


def plan(github, args):
    cuts = passed_cuts(github, 2)
    require(len(cuts) == 2, 'the rehearsal needs two nightly cuts that passed their proof; cut another nightly first')
    current, previous = cuts
    require(current['release_id'] != previous['release_id'] and current['target_sha'] != previous['target_sha'],
            'the two newest passed cuts are the same release; there is nothing to roll back to')
    for info in cuts:
        manifest_bytes(github, info)
    outputs({'current': {key: current[key] for key in KEYS} | {'media_sha256': current.get('media_sha256', '')},
             'previous': {key: previous[key] for key in KEYS} | {'media_sha256': previous.get('media_sha256', '')}})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan',))
    args = parser.parse_args()
    try:
        globals()[args.command](GitHub(), args)
    except (ValueError, KeyError) as error:
        sys.exit(f'Rehearsal refused: {error}')
