"""Which proof records vouch for a cut: the passed record of a task covers a cut when no path the proof exercises changed since."""

import json
import re
import subprocess
from pathlib import Path

from github_release import payload, require
from latency_paths import latency_paths

ROOT = Path(__file__).resolve().parents[2]

# Release tooling that builds or ships the recorder, beside the `recording` paths in features.json.
RECORDING_EXTRA_PATHS = ('scripts/releases/media.py', '.github/workflows/real-call-proof.yml')


def recording_paths():
    features = json.loads((ROOT / 'features.json').read_text())['features']
    return tuple(next(item for item in features if item['name'] == 'recording')['paths']) + RECORDING_EXTRA_PATHS


def paths_changed(previous, target, prefixes):
    # With no baseline or an unreadable diff the answer is yes: a proof that might be needed runs.
    if not previous:
        return True
    diff = subprocess.run(['git', 'diff', '--name-only', f'{previous}..{target}'], capture_output=True, text=True)
    if diff.returncode != 0:
        return True
    return any(path == prefix or path.startswith(prefix + '/') for path in diff.stdout.splitlines() for prefix in prefixes)


def recording_changed(previous, target):
    # The call-artifacts proof boots recorder droplets, which fetch the recorder archives from S3 and cost real money,
    # so a cut runs it when it changed a recording path.
    return paths_changed(previous, target, recording_paths())


def descends(sha, target):
    return subprocess.run(['git', 'merge-base', '--is-ancestor', sha, target]).returncode == 0


# What the on-demand host proof exercises: the host controller and runtime, the host bootstrap, command delivery, the recorder
# plane the host runs, and the proof's own script and workflow.
HOST_EXTRA_PATHS = ('infrastructure/managed-episode', 'infrastructure/nightly', 'infrastructure/recorder', 'scripts/deploy',
                    'scripts/nightly-host-proof', '.github/workflows/nightly-host-proof.yml')


def host_paths():
    return HOST_EXTRA_PATHS + recording_paths()


# How many passed records back a cut may look for one that covers it: a newer cut that never became held can have its own record in front.
LOOKBACK = 20


def covering_record(github, target, task, paths):
    """The passed record of this task that vouches for target: its SHA is target or an ancestor, and none of paths changed since."""
    for item in github.deployments('nightly', task, limit=LOOKBACK):
        info = payload(item)
        sha = info.get('target_sha', '')
        if info.get('result') != 'passed' or not re.fullmatch('[0-9a-f]{40}', sha):
            continue
        if descends(sha, target) and not paths_changed(sha, target, paths):
            return info
    return None


def covering_latency(github, target):
    return covering_record(github, target, 'nightly-latency', latency_paths())


def measured_other_images(covering, info):
    """A latency record of this very SHA that measured another release's images says nothing about the images Promote ships."""
    return covering['target_sha'] == info['target_sha'] and covering.get('release_id') not in (None, '', info.get('release_id'))


def covering_host_proof(github, target):
    return covering_record(github, target, 'nightly-host-proof', host_paths())


def with_host_proof(github, info, production_sha):
    """A cut whose changes since production touch a host path needs a passed host proof; without one it is a failed or missing
    proof, never a pass. A cut that touches none needs no host proof."""
    target = info['target_sha']
    merged = dict(info)
    if not paths_changed(production_sha, target, host_paths()):
        merged['host_proof_result'] = 'not-required'
    elif covering_host_proof(github, target):
        merged['host_proof_result'] = 'passed'
    else:
        exact = github.deployments('nightly', 'nightly-host-proof', sha=target)
        merged['host_proof_result'] = 'failed' if exact else 'host-proof-missing'
    return merged


def require_host_proof(info):
    result = info.get('host_proof_result', 'missing')
    require(result in ('passed', 'not-required'),
            f"cannot promote SHA {info['target_sha']}: host_proof_result={result}; a passed on-demand host proof covering "
            'the controller, runtime and host paths changed since production is required (run Nightly host proof)')
