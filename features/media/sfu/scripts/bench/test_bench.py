import json
import os
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path


BENCH = Path(__file__).with_name('bench')
NOW = int(time.time())


def droplet(identifier, name, tags=(), hours=6, region='sgp1'):
    return dict(id=identifier, name=name, tags=list(tags), region=dict(slug=region),
                created_at=datetime.fromtimestamp(NOW - hours * 3600, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))


class BenchReaperTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = self.root / 'droplets.json'
        self.calls = self.root / 'calls.jsonl'
        doctl = self.root / 'doctl'
        doctl.write_text('''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

root = Path(os.environ['FAKE_DO_ROOT'])
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\\n')
command = ' '.join(args[:3])
if command == os.environ.get('FAIL_COMMAND'):
    sys.exit('fake DO API error: ' + command)
state = root / 'droplets.json'
droplets = json.loads(state.read_text())
if command == 'compute droplet list':
    if os.environ.get('FAIL_POLL') and (root / 'deleted').exists():
        sys.exit('fake DO API error: deletion poll')
    if '--tag-name' in args:
        tag = args[args.index('--tag-name') + 1]
        droplets = [item for item in droplets if tag in item['tags']]
    print(json.dumps(droplets))
elif command == 'compute droplet delete':
    (root / 'deleted').touch()
    if not os.environ.get('STUCK_DELETE'):
        state.write_text(json.dumps([item for item in droplets if str(item['id']) != args[3]]))
elif command == 'compute firewall list':
    print('[{"id": "bench-firewall", "name": "chalk-sfu-bench"}]')
elif command == 'compute firewall delete':
    pass
else:
    sys.exit('unexpected doctl command: ' + ' '.join(args))
''')
        doctl.chmod(0o755)
        sleep = self.root / 'sleep'
        sleep.write_text('#!/usr/bin/env bash\nexit 0\n')
        sleep.chmod(0o755)

    def run_reaper(self, droplets, *args, **environment):
        self.state.write_text(json.dumps(droplets))
        self.calls.unlink(missing_ok=True)
        (self.root / 'deleted').unlink(missing_ok=True)
        return subprocess.run(['bash', str(BENCH), 'reap', *args], text=True, capture_output=True,
                              env=dict(PATH=f'{self.root}:{os.environ["PATH"]}',
                                       HOME=str(self.root), CHALK_SFU_PRIVATE_DIR=str(self.root / 'private'),
                                       FAKE_DO_ROOT=str(self.root), **environment))

    def recorded_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_dry_run_matches_legacy_prefix_or_tag_in_every_region_but_never_other_nodes(self):
        result = self.run_reaper([
            droplet(1, 'chalk-sfu-bench-11081648', ['older-rollout-tag']),
            droplet(2, 'chalk-sfu-bench-fleet-primary', ['chalk-sfu-bench']),
            droplet(3, 'load-generator', ['chalk-sfu-bench']),
            droplet(4, 'chalk-sfu-benchlegacy', region='lon1'),
            droplet(5, 'chalk-sfu-staging', ['chalk-sfu-bench']),
            droplet(6, 'chalk-sfu-production', ['chalk-sfu-bench']),
            droplet(7, 'unrelated', ['older-rollout-tag']),
            droplet(8, 'not-chalk-sfu-bench'),
            droplet(9, 'chalk-sfu-staging-standby', ['chalk-sfu-bench']),
            droplet(10, 'chalk-sfu-production-standby', ['chalk-sfu-bench']),
        ], '4', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([int(line.split('(')[1].split(')')[0]) for line in result.stdout.splitlines()], [1, 2, 3, 4])
        self.assertTrue(all(call[:3] == ['compute', 'droplet', 'list'] for call in self.recorded_calls()))

    def test_age_threshold_default_and_repeated_exclusions(self):
        droplets = [droplet(1, 'chalk-sfu-bench-a', hours=3.5),
                    droplet(2, 'chalk-sfu-bench-b'), droplet(3, 'chalk-sfu-bench-c'),
                    droplet(4, 'chalk-sfu-bench-young', hours=1)]
        result = self.run_reaper(droplets, '--dry-run', '--exclude', '2', '--exclude', '3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('chalk-sfu-bench-a', result.stdout)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        result = self.run_reaper(droplets, '4', '--dry-run', '--exclude', '2', '--exclude', '3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')

    def test_only_future_unix_expiry_protects_a_droplet(self):
        result = self.run_reaper([
            droplet(1, 'chalk-sfu-bench-kept', [f'keep-until-{NOW + 3600}']),
            droplet(2, 'chalk-sfu-bench-expired', [f'keep-until-{NOW - 1}']),
            droplet(3, 'chalk-sfu-bench-malformed', ['keep-until-never', 'keep-until-']),
            droplet(4, 'chalk-sfu-bench-iso', ['keep-until-2026-11-08T16:00:00Z']),
            droplet(5, 'chalk-sfu-bench-multiple', ['keep-until-bad', f'keep-until-{NOW + 3600}']),
        ], '4', '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([int(line.split('(')[1].split(')')[0]) for line in result.stdout.splitlines()], [2, 3, 4])

    def test_deletion_logs_ids_and_preserves_unrelated_and_kept_nodes(self):
        result = self.run_reaper([
            droplet(1, 'chalk-sfu-bench-legacy'),
            droplet(2, 'chalk-sfu-staging'), droplet(3, 'chalk-sfu-production'),
            droplet(4, 'chalk-sfu-bench-kept', [f'keep-until-{NOW + 3600}']),
            droplet(5, 'chalk-sfu-bench-young', hours=1),
        ], '4')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('deleting Droplet chalk-sfu-bench-legacy (1)', result.stdout)
        self.assertIn('confirmed deletion of Droplets: 1', result.stdout)
        self.assertEqual([item['id'] for item in json.loads(self.state.read_text())], [2, 3, 4, 5])

    def test_api_errors_fail_loudly(self):
        for command in ('compute droplet list', 'compute droplet delete',
                        'compute firewall list', 'compute firewall delete'):
            with self.subTest(command=command):
                result = self.run_reaper([droplet(1, 'chalk-sfu-bench-legacy')], '4', FAIL_COMMAND=command)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('fake DO API error', result.stderr)

    def test_poll_error_is_not_mistaken_for_successful_deletion(self):
        result = self.run_reaper([droplet(1, 'chalk-sfu-bench-legacy')], '4', FAIL_POLL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fake DO API error: deletion poll', result.stderr)

    def test_untagged_legacy_node_must_actually_disappear(self):
        result = self.run_reaper([droplet(1, 'chalk-sfu-bench-legacy')], '4', STUCK_DELETE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('still listed', result.stderr)
        self.assertFalse(any(call[:3] == ['compute', 'firewall', 'delete'] for call in self.recorded_calls()))


if __name__ == '__main__':
    unittest.main()
