#!/usr/bin/env python3
"""Fails a change that moves the SFU node and what talks to it together without a wire-protocol decision.

  check_wire_protocol.py [base ref]      (default origin/master; the Gate passes GATE_BASE_REF)

A node refuses a body it does not know, and the API places on a node only at or above its minimum protocol
(protocol.WireProtocol, fleet.go minNodeProtocol). A change that edits the node's source and its callers in
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

NODE = re.compile(r'^features/media/sfu/(cmd|internal|protocol)/.+\.go$')
CALLER = re.compile(r'^(apps/api/internal/adapters/chalksfu/.+\.go|sdks/typescript/client/src/media/.+\.tsx?)$')
TEST = re.compile(r'(_test\.go|\.(test|spec)\.tsx?)$')
PROTOCOL_FILE = 'features/media/sfu/protocol/protocol.go'
PROTOCOL = re.compile(r'^const WireProtocol = (\d+)\b', re.MULTILINE)
DECISION = re.compile(r'^Wire-Protocol: unchanged because \S', re.MULTILINE)


def git(*args):
    """Runs from the repository root: the Gate starts in features/media/sfu, and a path is read from the root."""
    root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, check=True).stdout.strip()
    return subprocess.run(['git', '-C', root, *args], capture_output=True, text=True, check=True).stdout


def protocol_at(ref):
    """The WireProtocol number in the source at ref, 0 when the file or the constant is absent."""
    try:
        found = PROTOCOL.search(git('show', f'{ref}:{PROTOCOL_FILE}'))
    except subprocess.CalledProcessError:
        return 0
    return int(found[1]) if found else 0


def verdict(changed, base_protocol, head_protocol, messages):
    """None when the change needs no decision or carries one, else the reason it is refused."""
    code = [path for path in changed if not TEST.search(path)]
    node = [path for path in code if NODE.match(path)]
    callers = [path for path in code if CALLER.match(path)]
    if not node or not callers:
        return None
    if head_protocol > base_protocol or DECISION.search(messages):
        return None
    return (
        'this change edits the SFU node and what talks to it together:\n  '
        + '\n  '.join([*node[:3], *callers[:3]])
        + f'\nRaise WireProtocol in {PROTOCOL_FILE} (and minNodeProtocol in the API fleet), or add a commit message line:\n'
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
    problem = verdict(changed, protocol_at(merge_base), protocol_at('HEAD'), git('log', f'{merge_base}..HEAD', '--format=%B'))
    if problem:
        print(problem, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
