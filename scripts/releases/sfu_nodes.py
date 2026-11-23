"""Chalk SFU nodes at a release: bring each node to the release's SFU source before the API deploys.

The managed release deploys the API, Sync and web, never the nodes, and the wire-protocol placement guard only
protects a field someone remembered to version. So the deploy-managed job runs `deploy` here first: a node is
replaced only when its build lacks the SFU source the release ships, and the job fails, before the API deploys,
when a node cannot be reached or is still behind afterwards. Nodes move forward only: a node already past the
release (a rollback, or an older held release) stays, because an older API places on a newer node.

  sfu_nodes.py check  --environment production --target-sha SHA   reads every node, changes nothing; fails if one cannot be read
  sfu_nodes.py deploy --environment production --target-sha SHA   deploys the nodes that are behind, then requires none is

The node list is `nodes` in $CHALK_SFU_PRIVATE_DIR/<environment>: one address per line, `#` comments, in the
order to upgrade (primary first). A node reports the commit it was built from on /readyz as `revision`."""
import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SFU_DIRECTORY = Path(__file__).resolve().parents[2] / 'infrastructure' / 'sfu'
REPOSITORY = SFU_DIRECTORY.parents[1]
# What the API and the SDK talk to. Node templates in infrastructure/sfu change nothing the API sends, so they stay out:
# an edit there must not restart a node.
SFU_SOURCE = 'features/media/sfu'
# Gate scripts, tests and notes beside it are not in the node's binary either.
SFU_NOT_SOURCE = [f':(exclude){SFU_SOURCE}/scripts', ':(exclude,glob)**/*_test.go', ':(exclude,glob)**/*.md']
FLEET_SOURCE = 'apps/api/internal/adapters/chalksfu/fleet.go'
MIN_PROTOCOL = re.compile(r'^\s*minNodeProtocol\s*=\s*(\d+)\s*$', re.MULTILINE)
COMMIT = re.compile(r'[0-9a-f]{40}')
# The deploy waits for the node to drain on its own; this bounds the run, not the drain.
READYZ_SECONDS = 90


class NodeError(Exception):
    """A node could not be read or brought to the release; the message names the node."""


def git(repository, *args, check=True):
    return subprocess.run(['git', '-C', str(repository), *args], capture_output=True, text=True, check=check)


def source_commit(repository, target_sha):
    """The last commit at or before the target that changed the SFU source."""
    commit = git(repository, 'log', '-1', '--format=%H', target_sha, '--', SFU_SOURCE, *SFU_NOT_SOURCE).stdout.strip()
    if not commit:
        raise NodeError(f'{target_sha} has no commit that touches {SFU_SOURCE}')
    return commit


def minimum_protocol(repository, target_sha):
    """The lowest wire protocol the API at the target sends to."""
    text = git(repository, 'show', f'{target_sha}:{FLEET_SOURCE}').stdout
    found = MIN_PROTOCOL.search(text)
    if not found:
        raise NodeError(f'{FLEET_SOURCE} at {target_sha} states no minNodeProtocol')
    return int(found[1])


@dataclass(frozen=True)
class Verdict:
    current: bool
    why: str


def assess(repository, source, minimum, ready):
    """Whether a node's /readyz shows a build that already has the release's SFU source and speaks its protocol.

    A build that is not in this checkout (a local build, a branch nobody merged, "dev") cannot be shown to have the
    source, so it counts as behind."""
    revision = ready.get('revision', '')
    protocol = ready.get('protocol', 0)
    if protocol < minimum:
        return Verdict(False, f'wire protocol {protocol} is below the release minimum {minimum}')
    if not COMMIT.fullmatch(revision):
        return Verdict(False, f'build {revision or "(none)"} is not a commit')
    known = git(repository, 'cat-file', '-e', f'{revision}^{{commit}}', check=False)
    if known.returncode != 0:
        return Verdict(False, f'build {revision[:12]} is not in this repository')
    ancestor = git(repository, 'merge-base', '--is-ancestor', source, revision, check=False)
    if ancestor.returncode == 0:
        return Verdict(True, f'build {revision[:12]} has {source[:12]}')
    return Verdict(False, f'build {revision[:12]} predates SFU source {source[:12]}')


def read_nodes(path):
    if not path.is_file():
        raise NodeError(f'no node list at {path}; it holds one SFU node address per line')
    nodes = [line.split('#')[0].strip() for line in path.read_text().splitlines()]
    nodes = [node for node in nodes if node]
    if not nodes:
        raise NodeError(f'{path} lists no node')
    return nodes


def read_ready(readyz, environment, address, label):
    """Messages name the node by its position in the list: the run's log is public and the address is not."""
    try:
        result = subprocess.run([readyz, environment, address], capture_output=True, text=True, timeout=READYZ_SECONDS)
    except subprocess.TimeoutExpired:
        raise NodeError(f'{label}: /readyz did not answer in {READYZ_SECONDS}s') from None
    if result.returncode != 0:
        detail = result.stderr.replace(address, label).strip()[-300:] or f'exit {result.returncode}'
        raise NodeError(f'{label}: cannot read /readyz ({detail})')
    try:
        ready = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise NodeError(f'{label}: /readyz is not JSON') from None
    if not isinstance(ready, dict):
        raise NodeError(f'{label}: /readyz is not an object')
    return ready


def check_certificates(directory, openssl='openssl'):
    """Fails while the node deploy would still work, so an expiring certificate is a Promote refusal and not an outage."""
    for name, days in (('operator.crt', 3), ('server.crt', 14)):
        certificate = directory / name
        if not certificate.is_file():
            raise NodeError(f'missing {certificate}; run infrastructure/sfu/ci-secret publish production')
        if subprocess.run([openssl, 'x509', '-checkend', str(days * 86400), '-noout', '-in', str(certificate)], capture_output=True).returncode != 0:
            raise NodeError(f'{name} expires within {days} days or is unreadable; run infrastructure/sfu/ci-secret publish production')


def run(command, environment, target_sha, repository=REPOSITORY, directory=None, readyz=None, deploy=None, force=False):
    """Returns the lines to print. Raises NodeError at the first node that cannot be read or left behind."""
    directory = directory or Path(os.environ.get('CHALK_SFU_PRIVATE_DIR', Path.home() / '.config' / 'chalk-sfu')) / environment
    readyz = readyz or str(SFU_DIRECTORY / 'readyz')
    deploy = deploy or str(SFU_DIRECTORY / 'deploy')
    nodes = read_nodes(directory / 'nodes')
    source = source_commit(repository, target_sha)
    minimum = minimum_protocol(repository, target_sha)
    lines = [f'release {target_sha[:12]} ships SFU source {source[:12]}, wire protocol at least {minimum}']
    if os.environ.get('GITHUB_ACTIONS'):
        for address in nodes:
            print(f'::add-mask::{address}', flush=True)
    for position, address in enumerate(nodes, 1):
        label = f'node {position}'
        verdict = assess(repository, source, minimum, read_ready(readyz, environment, address, label))
        lines.append(f'{label}: {"current" if verdict.current else "behind"}: {verdict.why}')
        if verdict.current or command == 'check':
            continue
        lines.append(f'{label}: deploying {source[:12]}')
        result = subprocess.run([deploy, environment, address, *(['--force'] if force else [])])
        if result.returncode != 0:
            raise NodeError(f'{label}: deploy failed ({result.returncode}); the API was not deployed')
        verdict = assess(repository, source, minimum, read_ready(readyz, environment, address, label))
        if not verdict.current:
            raise NodeError(f'{label}: still behind after the deploy: {verdict.why}')
        lines.append(f'{label}: current: {verdict.why}')
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('command', choices=['check', 'deploy'])
    parser.add_argument('--environment', required=True, choices=['staging', 'production'])
    parser.add_argument('--target-sha', required=True)
    parser.add_argument('--repository', type=Path, default=REPOSITORY, help='a checkout with full history that holds the target; the release job passes its checkout of the target')
    parser.add_argument('--force', action='store_true', help='restart a node that is behind without waiting for its calls to end')
    parser.add_argument('--require-certificates', action='store_true', help='refuse when the operator or server certificate is close to expiry')
    args = parser.parse_args(argv)
    try:
        if args.require_certificates:
            check_certificates(Path(os.environ.get('CHALK_SFU_PRIVATE_DIR', Path.home() / '.config' / 'chalk-sfu')) / args.environment)
        for line in run(args.command, args.environment, args.target_sha, repository=args.repository, force=args.force):
            print(line, flush=True)
    except NodeError as error:
        print(f'::error::{error}' if os.environ.get('GITHUB_ACTIONS') else f'error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
