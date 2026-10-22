#!/usr/bin/env python3
"""Tiny real-process queue regressions. --isolated never competes for the M4 heavy lock."""
import concurrent.futures
import fcntl
import io
import json
import os
from pathlib import Path
import signal
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
            self.assertIn('REMOTE_QUEUE_RESULT=23', output)
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
