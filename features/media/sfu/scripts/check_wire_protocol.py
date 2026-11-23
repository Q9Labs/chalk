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
RAISED = re.compile(r'^\+const WireProtocol = ', re.MULTILINE)
DECISION = re.compile(r'^Wire-Protocol: unchanged because \S', re.MULTILINE)


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


def verdict(changed, protocol_diff, messages):
    """None when the change needs no decision or carries one, else the reason it is refused."""
    code = [path for path in changed if not TEST.search(path)]
    node = [path for path in code if NODE.match(path)]
    callers = [path for path in code if CALLER.match(path)]
    if not node or not callers:
        return None
    if RAISED.search(protocol_diff) or DECISION.search(messages):
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
    problem = verdict(changed, git('diff', f'{merge_base}..HEAD', '--', PROTOCOL_FILE), git('log', f'{merge_base}..HEAD', '--format=%B'))
    if problem:
        print(problem, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
