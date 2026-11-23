#!/usr/bin/env python3
"""Fails a change that moves the SFU node and what talks to it together without a wire-protocol decision.

  check_wire_protocol.py [base ref]      (default origin/master; the Gate passes GATE_BASE_REF)

A node refuses a body it does not know, and the API places on a node only at or above its minimum protocol
(protocol.WireProtocol, the adapter's minNodeProtocol). A change that edits the node's source and its callers in
one pull request, the API's Chalk SFU adapter or the SDK's media client, may have taught the callers
something an older node rejects, as listen-only joins did in #1514. So such a change must either raise
WireProtocol or say in a commit message why it need not:

  Wire-Protocol: unchanged because <reason>

It catches the two sides changing together without a decision. It does not catch a behavior change the node
or the callers make alone, nor judge whether the stated reason is right; the release covers that case by
deploying every node whose SFU source changed before the API (scripts/releases/sfu_nodes.py)."""
import re
import subprocess
import sys
from typing import NamedTuple

NODE = re.compile(r'^features/media/sfu/(cmd|internal|protocol)/.+\.go$')
CALLER = re.compile(r'^(apps/api/internal/adapters/chalksfu/.+\.go|sdks/typescript/client/src/media/.+\.tsx?)$')
TEST = re.compile(r'(_test\.go|\.(test|spec)\.tsx?)$')
PROTOCOL_PACKAGE = 'features/media/sfu/protocol'
PROTOCOL = re.compile(r'^const WireProtocol = (\d+)\b', re.MULTILINE)
ADAPTER_PACKAGE = 'apps/api/internal/adapters/chalksfu'
MINIMUM = re.compile(r'^\s*minNodeProtocol\s*=\s*(\d+)\s*$', re.MULTILINE)
DECISION = re.compile(r'^Wire-Protocol: unchanged because \S', re.MULTILINE)


def git(*args):
    """Runs from the repository root: the Gate starts in features/media/sfu, and a path is read from the root."""
    root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
    return subprocess.run(['git', '-C', root, *args], capture_output=True, text=True, check=True).stdout


class Versions(NamedTuple):
    wire: int  # the node's WireProtocol
    minimum: int  # the lowest node protocol the API places on


class ConstantNotFound(Exception):
    """The constant is declared in no non-test file of its package at the ref, or in more than one place."""


def number_at(ref, package, pattern, name):
    """The number the pattern captures in the package's non-test Go files at ref. The constant may live in any of them, so a
    move between files changes nothing; finding it nowhere, or twice, is an error because the guard would otherwise read 0."""
    try:
        listing = git('ls-tree', '--name-only', ref, f'{package}/')
    except subprocess.CalledProcessError as error:
        raise ConstantNotFound(f'cannot list {package} at {ref}: {error.stderr.strip()}') from error
    files = [path for path in listing.splitlines() if path.endswith('.go') and not path.endswith('_test.go')]
    found = [(path, match[1]) for path in files for match in pattern.finditer(git('show', f'{ref}:{path}'))]
    if len(found) != 1:
        where = ', '.join(path for path, _ in found) or 'no file'
        raise ConstantNotFound(f'expected {name} declared once in the non-test Go files of {package} at {ref}, found {len(found)} ({where})')
    return int(found[0][1])


def versions_at(ref):
    return Versions(
        number_at(ref, PROTOCOL_PACKAGE, PROTOCOL, 'WireProtocol'),
        number_at(ref, ADAPTER_PACKAGE, MINIMUM, 'minNodeProtocol'),
    )


def raised(base, head):
    """A raise that counts raises WireProtocol and the API's minimum together: with the minimum left alone the API still places on
    nodes that reject what the callers now send."""
    return head.wire > base.wire and head.minimum > base.minimum


def verdict(changed, base, head, messages):
    """None when the change needs no decision or carries one, else the reason it is refused."""
    code = [path for path in changed if not TEST.search(path)]
    node = [path for path in code if NODE.match(path)]
    callers = [path for path in code if CALLER.match(path)]
    if not node or not callers:
        return None
    if raised(base, head) or DECISION.search(messages):
        return None
    return (
        'this change edits the SFU node and what talks to it together:\n  '
        + '\n  '.join([*node[:3], *callers[:3]])
        + f'\nRaise WireProtocol in the {PROTOCOL_PACKAGE} package and minNodeProtocol in the {ADAPTER_PACKAGE} package, or add a commit message line:\n'
        '  Wire-Protocol: unchanged because <why an older node still accepts what the callers now send>'
    )


def main(argv):
    base = argv[1] if len(argv) > 1 else 'origin/master'
    try:
        merge_base = git('merge-base', base, 'HEAD').strip()
    except subprocess.CalledProcessError:
        print(f'cannot compare with {base}: fetch it (git fetch origin) or pass another base ref', file=sys.stderr)
        return 1
    changed = git('diff', '--name-only', f'{merge_base}..HEAD').splitlines()
    try:
        base_versions, head_versions = versions_at(merge_base), versions_at('HEAD')
    except ConstantNotFound as error:
        print(f'cannot read the wire protocol versions: {error}', file=sys.stderr)
        return 1
    problem = verdict(changed, base_versions, head_versions, git('log', f'{merge_base}..HEAD', '--format=%B'))
    if problem:
        print(problem, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
