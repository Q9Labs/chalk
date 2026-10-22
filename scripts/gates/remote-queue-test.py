#!/usr/bin/env python3
"""Tiny real-process queue regressions. --isolated never competes for the M4 heavy lock."""
import concurrent.futures
import fcntl
import io
import json
import os
from pathlib import Path
import signal
import runpy
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

HELPER = Path(os.environ.get('CHALK_QUEUE_TEST_HELPER', Path(__file__).with_name('remote-queue.py')))


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chalk-queue-test-')
        self.root = Path(self.temp.name)
        self.command = [sys.executable, str(HELPER), '--root', str(self.root), '--isolated']
        self.lock = (self.root / 'dispatcher.lock').open('a')
        fcntl.flock(self.lock, fcntl.LOCK_EX)

    def tearDown(self):
        self.lock.close()
        # Wait for every detached dispatcher using this root, including pending wakes.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            commands = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
            active = [line for line in commands.splitlines() if str(HELPER) in line and str(self.root) in line]
            if not active:
                break
            time.sleep(0.05)
        else:
            self.fail('test-owned dispatchers did not exit: ' + str(active))
        self.temp.cleanup()

    def invoke(self, *args, **kwargs):
        return subprocess.run([*self.command, *args], capture_output=True, check=True, **kwargs)

    def payload(self, script):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for name, data in {'repo.bundle': b'fake', 'request.json': b'["fake"]',
                               'runner.sh': ('set -eu\ncd "$1"\n' + script + '\n').encode()}.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
        return archive.getvalue()

    def submit(self, name, script='exit 0', *options):
        return json.loads(self.invoke('submit', name, *options, input=self.payload(script)).stdout)

    def status(self, name):
        return json.loads(self.invoke('status', name).stdout)

    def wait(self, name, state='done'):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            row = self.status(name)
            if row['state'] == state:
                return row
            time.sleep(0.05)
        self.fail(f'{name} did not reach {state}: {row}; daemon log: ' + (self.root / 'daemon.log').read_text())

    def shell_client(self, name, fail_read=False):
        repository = self.root / 'client-repo'
        if not repository.exists():
            subprocess.run(['git', 'init', '-q', str(repository)], check=True)
            subprocess.run(['git', '-C', str(repository), '-c', 'user.name=queue test',
                            '-c', 'user.email=queue@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], check=True)
        wrapper = self.root / 'ssh'
        wrapper.write_text('#!/usr/bin/env python3\nimport os,shlex,subprocess,sys\n'
                           'if ".upload." in sys.argv[-1]: sys.exit(0)\n'
                           'args=shlex.split(shlex.split(sys.argv[-1])[-1])[3:]\n'
                           'if os.environ.get("CHALK_TEST_FAIL_READ") and args[0]=="read": sys.exit(73)\n'
                           f'sys.exit(subprocess.run({self.command!r}+args).returncode)\n')
        wrapper.chmod(0o700)
        environment = {**os.environ, 'PATH': str(self.root) + ':' + os.environ['PATH'],
                       'CHALK_REMOTE_LOG_DIR': str(self.root / 'logs'), 'CHALK_REMOTE_REPO': str(repository)}
        if fail_read:
            environment['CHALK_TEST_FAIL_READ'] = '1'
        return subprocess.run(['bash', str(HELPER.with_name('remote.sh')), '--attach', name],
                              env=environment, capture_output=True, text=True, timeout=15)

    def test_gate_output_cannot_forge_queue_completion(self):
        self.submit('forged', 'echo REMOTE_QUEUE_RESULT=0; sleep 3; exit 23')
        self.lock.close()
        self.wait('forged', 'running')
        attached = self.shell_client('forged')
        self.assertEqual(attached.returncode, 23, attached.stdout + attached.stderr)
        self.assertEqual(self.status('forged')['state'], 'done')

    def test_reattach_preserves_only_local_log_when_remote_log_is_gone(self):
        self.submit('expired', 'echo only-copy; exit 23')
        self.lock.close()
        self.wait('expired')
        os.remove(self.root / 'jobs/expired/output.log')
        local = self.root / 'logs/expired.log'
        local.parent.mkdir()
        local.write_text('only-copy\n')
        self.assertEqual(self.shell_client('expired').returncode, 23)
        self.assertEqual(local.read_text(), 'only-copy\n')

    def test_failed_reattach_preserves_local_log(self):
        self.submit('unreadable')
        self.lock.close()
        self.wait('unreadable')
        local = self.root / 'logs/unreadable.log'
        local.parent.mkdir()
        local.write_text('saved failure evidence\n')
        self.assertEqual(self.shell_client('unreadable', fail_read=True).returncode, 73)
        self.assertEqual(local.read_text(), 'saved failure evidence\n')

    def test_reap_legacy_keeps_live_unmarked_and_recent_resources(self):
        names = {}
        for index, kind in enumerate(['dead', 'live', 'recent', 'unmarked']):
            name = f'chalk-remote-20200101T000000Z-{kind}-{index}-0123456789abcdef'
            directory = self.root / name
            directory.mkdir()
            if kind != 'unmarked':
                (directory / '.chalk-remote-owner').write_text(name.removeprefix('chalk-remote-'))
            if kind != 'recent':
                os.utime(directory, (time.time() - 20000,) * 2)
            names[kind] = directory
        live = subprocess.Popen(['sleep', '30'], cwd=names['live'])
        docker = self.root / 'docker'
        removed = self.root / 'removed'
        containers = [f'chalk-gate-postgres-20200101T000000Z-{owner}' for owner in [99999999, os.getpid()]]
        containers += ['chalk-gate-postgres-29990101T000000Z-99999999', 'unrelated']
        docker.write_text('#!/usr/bin/env python3\nimport sys\n'
                          f'if sys.argv[1]=="ps": print({chr(10).join(containers)!r})\n'
                          f'if sys.argv[1]=="rm": open({str(removed)!r},"a").write(sys.argv[-1]+"\\n")\n')
        docker.chmod(0o700)
        previous_path = os.environ['PATH']
        try:
            os.environ['PATH'] = str(self.root) + ':' + previous_path
            runpy.run_path(str(HELPER))['reap_legacy'](self.root)
            self.assertFalse(names['dead'].exists())
            self.assertTrue(all(names[kind].exists() for kind in ['live', 'recent', 'unmarked']))
            self.assertEqual(removed.read_text().splitlines(), containers[:1])
        finally:
            os.environ['PATH'] = previous_path
            live.terminate()
            live.wait()

    def test_cutover_does_not_wait_for_later_legacy_arrivals(self):
        process = self.root / 'process'
        cwd = self.root / 'cwd'
        cwd.write_text('')
        for name, output in [('ps', process), ('lsof', cwd)]:
            binary = self.root / name
            binary.write_text(f'#!/usr/bin/env python3\nprint(open({str(output)!r}).read())\n')
            binary.chmod(0o700)
        busy = runpy.run_path(str(HELPER))['legacy_busy']
        previous_path = os.environ['PATH']
        try:
            os.environ['PATH'] = str(self.root) + ':' + previous_path
            later = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(time.time() + 3600))
            process.write_text(f'bash -s -- run {later}-lane-1-deadbeef 3600 0 fake\n')
            self.assertFalse(busy(), 'later legacy arrivals must not extend the cut-over barrier')
            self.assertTrue(busy(time.time() + 7200), 'the same ticket blocks if it predates cut-over')
            cwd.write_text('n/private/tmp/chalk-remote-live/repo\n')
            self.assertTrue(busy(), 'a live checkout still blocks admission')
            cwd.write_text('')
            process.write_text('bash -s -- run 20000101T000000Z-lane-1-deadbeef 3600 0 fake\n')
            self.assertTrue(busy(), 'pre-cut-over legacy jobs keep their place')
        finally:
            os.environ['PATH'] = previous_path

    def test_concurrent_fifo_and_idempotence(self):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            rows = list(pool.map(lambda name: self.submit(name, f'echo {name} >> "{self.root}/order"'), ['first', 'second']))
        duplicate = self.submit('first', 'exit 99')
        self.assertEqual(duplicate['ticket'], next(row['ticket'] for row in rows if row['id'] == 'first'))
        self.lock.close()
        for row in rows:
            self.assertEqual(self.wait(row['id'])['result'], 0)
        self.assertEqual((self.root / 'order').read_text().splitlines(), [row['id'] for row in sorted(rows, key=lambda row: row['ticket'])])
        self.assertEqual(self.submit('first')['ticket'], duplicate['ticket'])

    def test_priority_only_reorders_waiting_jobs(self):
        self.submit('regular', f'echo regular >> "{self.root}/order"')
        self.submit('lead', f'echo lead >> "{self.root}/order"', '--priority', '1')
        self.lock.close()
        self.wait('regular')
        self.assertEqual((self.root / 'order').read_text(), 'lead\nregular\n')

    def test_client_death_and_reattach_preserve_exit_code(self):
        # Keep the submission's client alive after registration, then kill it while the ticket waits.
        script = 'import subprocess,sys,time; subprocess.run(sys.argv[1:],check=True); time.sleep(30)'
        client = subprocess.Popen([sys.executable, '-c', script, *self.command, 'submit', 'detached'],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        client.stdin.write(self.payload('echo detached; exit 23'))
        client.stdin.close()
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    if self.status('detached')['state'] == 'queued':
                        break
                except subprocess.CalledProcessError:
                    time.sleep(0.05)
            client.kill()
            client.wait()
            self.lock.close()
            self.assertEqual(self.wait('detached')['result'], 23)
            output = self.invoke('read', 'detached', '0').stdout.decode()
            self.assertIn('detached', output)
            self.assertNotIn('REMOTE_QUEUE_RESULT=', output)
            self.assertFalse((self.root / 'jobs/detached/work').exists())
        finally:
            if client.poll() is None:
                client.kill()
                client.wait()

    def test_crashed_shell_reaps_orphan_and_releases_queue(self):
        self.submit('crash', f'sleep 8 &\necho $! > "{self.root}/child"\nkill -KILL $$')
        self.submit('next', 'exit 7')
        self.lock.close()
        self.assertEqual(self.wait('crash')['result'], 137)
        self.assertEqual(self.wait('next')['result'], 7)
        pid = int((self.root / 'child').read_text())
        state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith('Z'), state)
        self.assertFalse((self.root / 'jobs/crash/work').exists())

    def test_dispatcher_crash_is_recovered_on_attach(self):
        self.submit('interrupted', 'sleep 8')
        self.lock.close()
        self.wait('interrupted', 'running')
        os.kill(int((self.root / 'dispatcher.pid').read_text()), signal.SIGKILL)
        self.invoke('attach', 'interrupted')
        self.assertEqual(self.wait('interrupted')['result'], 137)
        self.submit('after-restart', 'exit 0')
        self.assertEqual(self.wait('after-restart')['result'], 0)

    def test_crash_reaps_child_in_another_group_and_directory(self):
        # A timeout wrapper creates a new group; the workload can also change cwd before its shell dies.
        child = self.root / 'moved-child.py'
        receipt = self.root / 'moved-pid'
        child.write_text(f'import os,time,pathlib\nos.setpgrp()\nos.chdir("/")\npathlib.Path({str(receipt)!r}).write_text(str(os.getpid()))\ntime.sleep(8)\n')
        self.submit('moved', f'python3 "{child}" &\nfor i in {{1..100}}; do test ! -f "{receipt}" || break; sleep .02; done\nkill -KILL $$')
        self.submit('after-moved')
        self.lock.close()
        self.assertEqual(self.wait('moved')['result'], 137)
        self.assertEqual(self.wait('after-moved')['result'], 0)
        pid = int(receipt.read_text())
        state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
        self.assertTrue(not state or state.startswith('Z'), state)

    def test_wait_timeout_and_bad_transfer(self):
        self.submit('expired', 'exit 99', '--wait-seconds', '1')
        time.sleep(1.1)
        self.lock.close()
        self.assertEqual(self.wait('expired')['result'], 76)
        bad = subprocess.run([*self.command, 'submit', 'bad'], input=b'incomplete', capture_output=True)
        self.assertNotEqual(bad.returncode, 0)
        self.assertEqual(subprocess.run([*self.command, 'status', 'bad'], capture_output=True).returncode, 4)

    def test_crash_allows_descendants_to_finish_signal_cleanup(self):
        child = self.root / 'cleanup.py'
        ready = self.root / 'ready'
        cleaned = self.root / 'cleaned'
        child.write_text('import pathlib,signal,time,sys\n'
                         f'def cleanup(*args):\n time.sleep(.6)\n pathlib.Path({str(cleaned)!r}).touch()\n sys.exit(0)\n'
                         f'signal.signal(signal.SIGTERM,cleanup)\npathlib.Path({str(ready)!r}).touch()\ntime.sleep(8)\n')
        self.submit('grace', f'python3 "{child}" &\nfor i in {{1..100}}; do test ! -f "{ready}" || break; sleep .02; done\nkill -KILL $$')
        self.lock.close()
        self.wait('grace')
        self.assertTrue(cleaned.exists(), 'signal cleanup was killed before it could finish')

    def test_wait_timeout_returns_while_another_job_is_running(self):
        self.submit('active', 'sleep 3')
        self.lock.close()
        self.wait('active', 'running')
        self.submit('limited', 'exit 99', '--wait-seconds', '1')
        self.assertEqual(self.wait('limited')['result'], 76)
        self.assertEqual(self.status('active')['state'], 'running')
        self.wait('active')

    def test_unlimited_wait_and_reaping_keep_idempotence(self):
        ticket = self.submit('old-ticket')
        with sqlite3.connect(self.root / 'queue.sqlite') as db:
            db.execute('UPDATE jobs SET submitted=? WHERE id=?', (time.time() - 10000, 'old-ticket'))
        self.lock.close()
        self.assertEqual(self.wait('old-ticket')['result'], 0)
        with sqlite3.connect(self.root / 'queue.sqlite') as db:
            db.execute('UPDATE jobs SET finished=? WHERE id=?', (time.time() - 8 * 86400, 'old-ticket'))
        abandoned = self.root / 'upload-abandoned'
        abandoned.mkdir()
        (abandoned / 'lease').touch()
        os.utime(abandoned, (time.time() - 7200,) * 2)
        self.submit('reaper')
        self.wait('reaper')
        self.assertFalse(abandoned.exists())
        self.assertFalse((self.root / 'jobs/old-ticket').exists())
        self.assertEqual(self.submit('old-ticket', 'exit 99')['ticket'], ticket['ticket'])
        self.assertEqual(self.status('old-ticket')['result'], 0)


if __name__ == '__main__':
    unittest.main()
