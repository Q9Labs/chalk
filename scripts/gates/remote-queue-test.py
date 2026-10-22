#!/usr/bin/env python3
"""Tiny real-process queue regressions. --isolated never competes for the M4 heavy lock."""
import concurrent.futures
from contextlib import closing
import fcntl
import io
import json
import os
from pathlib import Path
import signal
import shutil
import runpy
import shlex
import socket
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
        self.old_environment = dict(os.environ)
        os.environ['CHALK_REMOTE_SLOTS'] = '1'
        os.environ['PATH'] = str(self.root) + ':' + os.environ['PATH']
        vm_stat = self.root / 'vm_stat'
        vm_stat.write_text('#!/bin/sh\necho "Mach Virtual Memory Statistics: (page size of 16384 bytes)"\necho "Pages free: 524288."\necho "Pages inactive: 0."\necho "Pages speculative: 0."\n')
        vm_stat.chmod(0o700)
        self.command = [sys.executable, str(HELPER), '--root', str(self.root), '--isolated']
        self.lock = (self.root / 'dispatcher.lock').open('a')
        fcntl.flock(self.lock, fcntl.LOCK_EX)

    def tearDown(self):
        self.lock.close()
        # Wait for every detached dispatcher using this root, including pending wakes.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            commands = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True)
            active = [line for line in commands.splitlines() if ' daemon' in line and str(self.root) in line]
            if not active:
                break
            time.sleep(0.05)
        else:
            self.fail('test-owned dispatchers did not exit: ' + str(active))
        self.temp.cleanup()
        os.environ.clear()
        os.environ.update(self.old_environment)

    def invoke(self, *args, **kwargs):
        return subprocess.run([*self.command, *args], capture_output=True, check=True, **kwargs)

    def payload(self, script, request=None):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for name, data in {'repo.bundle': b'fake', 'request.json': json.dumps(request or ['fake']).encode(),
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
                           'parts=shlex.split(shlex.split(sys.argv[-1])[-1]); args=parts[parts.index("python3")+2:]\n'
                           'if os.environ.get("CHALK_TEST_FAIL_READ") and args[0]=="read": sys.exit(73)\n'
                           f'sys.exit(subprocess.run({self.command!r}+args).returncode)\n')
        wrapper.chmod(0o700)
        environment = {**os.environ, 'PATH': str(self.root) + ':' + os.environ['PATH'],
                       'CHALK_REMOTE_LOG_DIR': str(self.root / 'logs'), 'CHALK_REMOTE_REPO': str(repository)}
        if fail_read:
            environment['CHALK_TEST_FAIL_READ'] = '1'
        return subprocess.run(['bash', str(HELPER.with_name('remote.sh')), '--attach', name],
                              env=environment, capture_output=True, text=True, timeout=15)

    def test_three_slots_fifo_and_exclusive(self):
        os.environ['CHALK_REMOTE_SLOTS'] = '3'
        barrier = self.root / 'release'
        script = f'echo "$CHALK_REMOTE_SLOT"; end=$((SECONDS+6)); while [ ! -f "{barrier}" ] && ((SECONDS<end)); do sleep .05; done'
        for name in ('one', 'two', 'three'):
            self.submit(name, script)
        self.lock.close()
        for slot, name in enumerate(('one', 'two', 'three')):
            self.assertEqual(self.wait(name, 'running')['slot'], slot)
        self.submit('exclusive', 'sleep .3', '--exclusive')
        self.submit('after')
        self.assertEqual(self.status('exclusive')['state'], 'queued')
        self.assertEqual(self.status('after')['state'], 'queued')
        print('PASS FIFO tickets 1,2,3 running concurrently in slots 0,1,2; exclusive ticket 4 and ticket 5 queued', flush=True)
        barrier.touch()
        self.wait('exclusive', 'running')
        self.assertEqual(self.status('after')['state'], 'queued')
        print('PASS exclusive ticket 4 running alone; ticket 5 still queued', flush=True)
        for name in ('one', 'two', 'three', 'exclusive', 'after'):
            self.assertEqual(self.wait(name)['result'], 0)

    def shared_fixture(self, legacy_lock):
        helper = self.root / 'remote-queue.py'
        helper.write_text(HELPER.read_text().replace('/tmp/chalk-remote-admission.lock', str(legacy_lock))
                          .replace('if legacy_busy(cutover):', 'if False:')
                          .replace('return legacy_active()', 'return False')
                          .replace('                reap_legacy()', '                pass')
                          .replace("if __name__ == '__main__':", "def legacy_active():\n    return False\n\nif 'legacy_waiters' in globals():\n    actual_legacy_waiters = legacy_waiters\n    def legacy_waiters():\n        return set()\n\nif __name__ == '__main__':"))
        self.command = [sys.executable, str(helper), '--root', str(self.root)]

    def test_port_matches_never_authorize_signalling_foreign_processes(self):
        queue = runpy.run_path(str(HELPER))
        job = self.root / 'jobs' / 'ended'
        (job / 'resources').mkdir(parents=True)
        for slot in range(90, 100):
            base = 21000 + slot * 100
            found = subprocess.run(['lsof', '-nP', f'-iTCP:{base+1}-{base+18}',
                                    f'-iUDP:{base+1}-{base+18}', '-t'], capture_output=True, text=True)
            if not found.stdout:
                break
        else:
            self.fail('no unused test slot block')
        port = base + 4
        (job / 'resources/slot').write_text(str(slot))
        db = queue['database'](self.root)
        with db:
            db.execute("INSERT INTO jobs(id,priority,submitted,wait_seconds,state,slot) VALUES('ended',0,?,0,'running',?)",
                       (time.time(), slot))
        server_code = ('import socket,sys,time; s=socket.socket(); '
                       's.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(); '
                       'print("ready",flush=True); time.sleep(30)')
        children = []
        try:
            for token in (None, queue['job_token'](job)):
                environment = {key: value for key, value in os.environ.items() if not key.startswith('CHALK_REMOTE_')}
                if token:
                    environment['CHALK_REMOTE_JOB_TOKEN'] = token
                server = subprocess.Popen([sys.executable, '-c', server_code, str(port)], env=environment,
                                          stdout=subprocess.PIPE, text=True, start_new_session=True, cwd='/')
                children.append(server)
                self.assertEqual(server.stdout.readline().strip(), 'ready')
                client_code = ('import socket,sys,time; s=socket.create_connection(("127.0.0.1",int(sys.argv[1]))); '
                               'print("ready",flush=True); time.sleep(30)')
                client = subprocess.Popen([sys.executable, '-c', client_code, str(port)],
                                          env={**environment, 'CHALK_REMOTE_JOB_TOKEN': 'different-job-token'},
                                          stdout=subprocess.PIPE, text=True, start_new_session=True, cwd='/')
                children.append(client)
                self.assertEqual(client.stdout.readline().strip(), 'ready')
                queue['stop_job'](job, None, None, slot)
                self.assertIsNone(client.poll(), 'cleanup killed another job’s connected client')
                if token is None:
                    self.assertIsNone(server.poll(), 'cleanup killed an untagged foreign listener')
                else:
                    self.assertIsNotNone(server.poll(), 'the job-owned listener survived cleanup')
                row = db.execute('SELECT * FROM jobs WHERE id="ended"').fetchone()
                queue['complete'](self.root, db, row, 0, 'test cleanup', False)
                row = db.execute('SELECT * FROM jobs WHERE id="ended"').fetchone()
                if token is None:
                    self.assertEqual(row['state'], 'quarantined')
                    self.assertIn(str(server.pid), row['cleanup_error'])
                    self.assertIn(str(server.pid), (job / 'output.log').read_text())
                    self.assertIsNone(server.poll(), 'quarantine signalled the foreign port owner')
                    print(f'PASS foreign listener {server.pid} and client {client.pid} survived; slot {slot} quarantined with owner logged', flush=True)
                else:
                    self.assertEqual(row['state'], 'done', 'remote endpoints must not reserve the slot')
                    self.assertIsNone(client.poll(), 'release check signalled a foreign client')
                    print(f'PASS job listener reaped; foreign-token client {client.pid} survived; remote endpoint did not block release', flush=True)
                for child in (server, client):
                    if child.poll() is None:
                        child.kill()
                    child.wait()
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.wait()
                child.stdout.close()
            db.close()

    def test_argv_token_never_authorizes_cleanup(self):
        queue = runpy.run_path(str(HELPER))
        job = self.root / 'jobs/ended'
        job.mkdir(parents=True)
        foreign = subprocess.Popen([sys.executable, '-c', 'import time; print("ready",flush=True); time.sleep(20)',
                                    'CHALK_REMOTE_JOB_TOKEN=' + queue['job_token'](job)],
                                   env={**os.environ, 'CHALK_REMOTE_JOB_TOKEN': 'another-job-token'},
                                   stdout=subprocess.PIPE, text=True, start_new_session=True, cwd='/')
        try:
            self.assertEqual(foreign.stdout.readline().strip(), 'ready')
            queue['stop_job'](job, None, None)
            self.assertIsNone(foreign.poll(), 'an argv string authorized signalling a foreign process')
        finally:
            if foreign.poll() is None:
                foreign.kill()
            foreign.wait()
            foreign.stdout.close()

    def test_queue_wake_does_not_inherit_a_workloads_identity(self):
        queue = runpy.run_path(str(HELPER))
        job = self.root / 'jobs/origin'
        job.mkdir(parents=True)
        old = os.environ.get('CHALK_REMOTE_JOB_TOKEN')
        try:
            os.environ['CHALK_REMOTE_JOB_TOKEN'] = queue['job_token'](job)
            queue['wake'](self.root, True)
        finally:
            if old is None:
                os.environ.pop('CHALK_REMOTE_JOB_TOKEN', None)
            else:
                os.environ['CHALK_REMOTE_JOB_TOKEN'] = old
        deadline = time.monotonic() + 4
        processes = []
        while not processes and time.monotonic() < deadline:
            lines = subprocess.check_output(['ps', '-axo', 'pid=,command='], text=True).splitlines()
            processes = [int(line.split()[0]) for line in lines if str(self.root) in line and line.endswith(' daemon')]
            time.sleep(.02)
        self.assertEqual(len(processes), 1)
        queue['stop_job'](job, None, None)
        self.assertTrue(queue['process_start'](processes[0]), 'workload cleanup killed the shared dispatcher it woke')

    def test_absent_original_worker_cannot_authorize_a_later_session(self):
        queue = runpy.run_path(str(HELPER))
        job = self.root / 'jobs/old'
        job.mkdir(parents=True)
        code = ('import subprocess,sys; child=subprocess.Popen([sys.executable,"-c",'
                '"import time; print(\\\"ready\\\",flush=True); time.sleep(20)"],stdout=sys.stdout); print(child.pid,flush=True)')
        leader = subprocess.Popen([sys.executable, '-c', code], env={**os.environ, 'CHALK_REMOTE_JOB_TOKEN': 'another-job-token'},
                                  stdout=subprocess.PIPE, text=True, start_new_session=True, cwd='/')
        child = None
        try:
            lines = [leader.stdout.readline().strip(), leader.stdout.readline().strip()]
            child = int(next(value for value in lines if value.isdigit()))
            self.assertIn('ready', lines)
            leader.wait(timeout=3)
            self.assertEqual(os.getsid(child), leader.pid)
            queue['stop_job'](job, leader.pid, 'old worker birth')
            state = subprocess.run(['ps', '-p', str(child), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
            self.assertTrue(state and not state.startswith('Z'), 'stale SID authorized signalling a foreign child')
        finally:
            if leader.poll() is None:
                leader.kill()
            leader.wait()
            leader.stdout.close()
            if child:
                try:
                    os.kill(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_ownership_scan_cannot_adopt_a_replacement_birth(self):
        queue = runpy.run_path(str(HELPER))
        job = self.root / 'jobs/old'
        job.mkdir(parents=True)
        foreign = subprocess.Popen([sys.executable, '-c', 'import time; print("ready",flush=True); time.sleep(20)'],
                                   env={**os.environ, 'CHALK_REMOTE_JOB_TOKEN': 'another-job-token'},
                                   stdout=subprocess.PIPE, text=True, start_new_session=True, cwd='/')
        try:
            self.assertEqual(foreign.stdout.readline().strip(), 'ready')
            actual_start = queue['process_start']
            seen = []
            def interleaved_start(pid):
                if pid == foreign.pid and not seen:
                    seen.append('old worker birth')
                    return 'old worker birth'
                return actual_start(pid)
            queue['owned_processes'].__globals__['process_start'] = interleaved_start
            queue['stop_job'](job, foreign.pid, 'old worker birth')
            self.assertIsNone(foreign.poll(), 'cleanup adopted a replacement process birth')
        finally:
            if foreign.poll() is None:
                foreign.kill()
            foreign.wait()
            foreign.stdout.close()

    def test_quarantine_holder_evidence_is_bounded_and_connection_churn_is_quiet(self):
        queue = runpy.run_path(str(HELPER))
        db = queue['database'](self.root)
        job = self.root / 'jobs/ended'
        (job / 'resources').mkdir(parents=True)
        listener = socket.socket()
        sockets = []
        try:
            for slot in range(90, 100):
                base = 21000 + slot * 100
                found = subprocess.run(['lsof', '-nP', f'-iTCP:{base+1}-{base+18}', '-t'], capture_output=True, text=True)
                if not found.stdout:
                    listener.bind(('127.0.0.1', base + 4))
                    break
            else:
                self.fail('no unused port block')
            listener.listen()
            (job / 'resources/slot').write_text(str(slot))
            with db:
                db.execute("INSERT INTO jobs(id,priority,submitted,wait_seconds,state,slot) VALUES('ended',0,?,0,'running',?)", (time.time(), slot))
            previous = None
            for count in (30, 60):
                for _ in range(30):
                    client = socket.create_connection(listener.getsockname())
                    accepted, _ = listener.accept()
                    sockets.extend((client, accepted))
                row = db.execute('SELECT * FROM jobs WHERE id="ended"').fetchone()
                queue['complete'](self.root, db, row, 0, 'test', False)
                row = db.execute('SELECT * FROM jobs WHERE id="ended"').fetchone()
                self.assertLessEqual(len(row['cleanup_error'].encode()), 2048)
                self.assertLessEqual(row['cleanup_error'].count('pid='), 8)
                log = (job / 'output.log').read_bytes()
                if previous is not None:
                    self.assertEqual(log, previous, 'equivalent holder retries appended duplicate evidence')
                previous = log
            for offset in range(1, 11):
                if offset != 4:
                    extra = socket.socket()
                    extra.bind(('127.0.0.1', base + offset))
                    extra.listen()
                    sockets.append(extra)
            row = db.execute('SELECT * FROM jobs WHERE id="ended"').fetchone()
            queue['complete'](self.root, db, row, 0, 'test', False)
            row = db.execute('SELECT * FROM jobs WHERE id="ended"').fetchone()
            self.assertLessEqual(len(row['cleanup_error'].encode()), 2048)
            self.assertLessEqual(row['cleanup_error'].count('pid='), 8)
            self.assertIn('additional holders omitted', row['cleanup_error'])
        finally:
            for sock in sockets:
                sock.close()
            listener.close()
            db.close()

    def test_waiting_client_sees_quarantined_jobs_errors_and_retry_times(self):
        os.environ['CHALK_REMOTE_SLOTS'] = '3'
        for slot in range(3):
            self.submit(f'blocked{slot}')
            job = self.root / 'jobs' / f'blocked{slot}'
            (job / 'resources').mkdir()
            (job / 'resources/postgres').write_text('invalid\n')
            with closing(sqlite3.connect(self.root / 'queue.sqlite')) as db, db:
                db.execute("UPDATE jobs SET state='quarantined',slot=?,result=0 WHERE id=?", (slot, f'blocked{slot}'))
        self.submit('waiting', 'exit 7')
        self.lock.close()
        try:
            deadline = time.monotonic() + 5
            while not self.status('blocked2')['cleanup_error'] and time.monotonic() < deadline:
                time.sleep(.05)
            waiting = self.status('waiting')
            self.assertEqual({row['id'] for row in waiting.get('blocked_by', [])}, {'blocked0', 'blocked1', 'blocked2'})
            self.assertTrue(all(row['error'] and row['retry_at'] > time.time() for row in waiting['blocked_by']))
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(self.shell_client, 'waiting')
                time.sleep(2.5)
                self.release_quarantines()
                result = future.result(timeout=12)
            self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
            for name in ('blocked0', 'blocked1', 'blocked2'):
                self.assertIn(name, result.stdout)
            self.assertIn('invalid slot resource receipt', result.stdout)
            self.assertIn('retry', result.stdout)
            reports = [line for line in result.stdout.splitlines() if line.startswith('[remote] queue blocked:')]
            self.assertTrue(reports, result.stdout)
            self.assertEqual(len(reports), len(set(reports)), 'unchanged blockers were printed again: ' + result.stdout)
        finally:
            self.release_quarantines()

    def release_quarantines(self):
        for receipt in (self.root / 'jobs').glob('blocked*/resources/postgres'):
            receipt.unlink(missing_ok=True)
        with closing(sqlite3.connect(self.root / 'queue.sqlite')) as db, db:
            db.execute("UPDATE jobs SET cleanup_after=0 WHERE state='quarantined'")

    def test_cleanup_quarantine_does_not_interrupt_other_slots_or_recovery(self):
        os.environ['CHALK_REMOTE_SLOTS'] = '2'
        docker = self.root / 'docker'
        docker.write_text('#!/bin/sh\nexit 1\n')
        docker.chmod(0o700)
        release_bad = self.root / 'release-bad'
        release_healthy = self.root / 'release-healthy'
        healthy_ready = self.root / 'healthy-ready'
        self.submit('bad', f'while [ ! -f "{release_bad}" ]; do sleep .05; done')
        self.submit('healthy', f'touch "{healthy_ready}"; while [ ! -f "{release_healthy}" ]; do sleep .05; done; exit 17')
        self.submit('after', 'exit 9')
        job = self.root.resolve() / 'jobs/bad'
        (job / 'resources').mkdir()
        name = 'chalk-postgres-slot-0-' + runpy.run_path(str(HELPER))['job_token'](job)
        receipt = job / 'resources/postgres'
        receipt.write_text(name + '\n' + name + '\n')
        self.lock.close()
        try:
            healthy = self.wait('healthy', 'running')
            deadline = time.monotonic() + 4
            while not healthy_ready.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(healthy_ready.exists())
            release_bad.touch()
            bad = self.wait('bad', 'quarantined')
            self.assertIn('cleanup', bad['cleanup_error'])
            self.assertIn('cleanup', (job / 'output.log').read_text())
            os.kill(int((self.root / 'dispatcher.pid').read_text()), signal.SIGKILL)
            self.invoke('attach', 'healthy')
            receipt.write_text('invalid-receipt\n')
            with sqlite3.connect(self.root / 'queue.sqlite') as db:
                db.execute('UPDATE jobs SET cleanup_after=0 WHERE id="bad"')
            deadline = time.monotonic() + 5
            while 'invalid' not in self.status('bad')['cleanup_error'] and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertIn('invalid', self.status('bad')['cleanup_error'])
            self.assertEqual(self.status('healthy')['pid'], healthy['pid'])
            self.assertTrue(runpy.run_path(str(HELPER))['process_start'](healthy['pid']))
            release_healthy.touch()
            self.assertEqual(self.wait('healthy')['result'], 17)
            self.assertEqual(self.wait('after')['result'], 9)
            self.assertEqual(self.status('after')['slot'], 1, 'quarantined slot was reused')
            receipt.write_text(name + '\n' + name + '\n')
            docker.write_text('#!/bin/sh\nif [ "$1" = info ]; then exit 0; fi\necho "Error: No such $1: $3" >&2\nexit 1\n')
            with sqlite3.connect(self.root / 'queue.sqlite') as db:
                db.execute('UPDATE jobs SET cleanup_after=0 WHERE id="bad"')
            self.assertEqual(self.wait('bad')['result'], 0)
            self.assertIsNone(self.status('bad')['cleanup_error'])
            print('PASS Docker failure and invalid receipt quarantined slot 0; recovery preserved healthy exit 17; following exit 9 used slot 1; repair released slot 0', flush=True)
        finally:
            release_bad.touch()
            release_healthy.touch()
            receipt.unlink(missing_ok=True)
            with sqlite3.connect(self.root / 'queue.sqlite') as db:
                if 'cleanup_after' in {row[1] for row in db.execute('PRAGMA table_info(jobs)')}:
                    db.execute('UPDATE jobs SET cleanup_after=0')
            self.invoke('attach', 'bad')

    @unittest.skipUnless(shutil.which('shlock'), 'requires the macOS legacy shlock binary')
    def test_dead_worker_cleanup_cannot_unlink_reclaimed_legacy_lock(self):
        lock = self.root / 'legacy.lock'
        fixture = self.root / 'race.py'
        fixture.write_text(HELPER.read_text().replace('/tmp/chalk-remote-admission.lock', str(lock)))
        release = runpy.run_path(str(fixture)).get('release', lambda *args: None)
        dead = subprocess.Popen(['sleep', '0'])
        dead.wait()
        lock.write_text(str(dead.pid))
        time.sleep(1.1)
        waiter = subprocess.Popen(['sleep', '10'])
        contender = subprocess.Popen(['sleep', '10'])
        reclaimed = []
        class InterleavedPath(type(self.root)):
            def read_text(path, *args, **kwargs):
                value = super().read_text(*args, **kwargs)
                result = subprocess.run(['shlock', '-p', str(waiter.pid), '-f', str(lock)])
                reclaimed.append(result.returncode == 0)
                return value
        try:
            if hasattr(release, '__globals__'):
                release.__globals__['Path'] = InterleavedPath
            release(False, dead.pid)
            if not reclaimed:
                self.assertEqual(subprocess.run(['shlock', '-p', str(waiter.pid), '-f', str(lock)]).returncode, 0)
            else:
                self.assertTrue(reclaimed[0])
            result = subprocess.run(['shlock', '-p', str(contender.pid), '-f', str(lock)])
            self.assertNotEqual(result.returncode, 0, 'dispatcher removed a living legacy owner\'s replacement lock')
            self.assertEqual(int(lock.read_text()), waiter.pid)
        finally:
            for child in (waiter, contender):
                child.terminate()
                child.wait()

    def test_detached_changed_directory_listener_is_gone_before_slot_reuse(self):
        receipt = self.root / 'listener.json'
        detached = self.root / 'detached.py'
        detached.write_text('import os,socket,time,json,pathlib\n'
                            'os.setsid(); os.chdir("/")\n'
                            's=socket.socket(); s.bind(("127.0.0.1",0)); s.listen()\n'
                            f'pathlib.Path({str(receipt)!r}).write_text(json.dumps([os.getpid(),s.getsockname()[1]]))\n'
                            'time.sleep(20)\n')
        self.submit('crash', f'python3 "{detached}" &\n'
                    f'for i in {{1..100}}; do [ ! -f "{receipt}" ] || break; sleep .02; done\nkill -KILL $$')
        bind = 'import json,socket,sys; s=socket.socket(); s.bind(("127.0.0.1",json.load(open(sys.argv[1]))[1]))'
        self.submit('after', 'python3 -c ' + shlex.quote(bind) + ' ' + shlex.quote(str(receipt)))
        self.lock.close()
        try:
            self.assertEqual(self.wait('crash')['result'], 137)
            self.assertEqual(self.wait('after')['result'], 0, 'orphan still owns the port when its slot is reused')
            pid, port = json.loads(receipt.read_text())
            state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip()
            self.assertFalse(state and not state.startswith('Z'), 'detached job process survived cleanup')
            with socket.socket() as probe:
                self.assertNotEqual(probe.connect_ex(('127.0.0.1', port)), 0)
        finally:
            if receipt.exists():
                pid, _ = json.loads(receipt.read_text())
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_docker_disconnect_after_info_quarantines_and_retries_owned_resources(self):
        os.environ['CHALK_REMOTE_SLOTS'] = '2'
        state = self.root / 'docker-state.json'
        recovered = self.root / 'docker-recovered'
        docker = self.root / 'docker'
        docker.write_text('#!/usr/bin/env python3\n' + f'''
import json,sys,pathlib
path=pathlib.Path({str(state)!r}); data=json.loads(path.read_text()); args=sys.argv[1:]
data['calls'].append(args); result=0
if len(args)>1 and args[1]=='inspect':
    kind=args[0]
    if kind==data['failure'] and not pathlib.Path({str(recovered)!r}).exists():
        print('failed to connect to the docker API: ' + 'x'*4096, file=sys.stderr); result=1
    elif not data[kind]:
        print('Error: No such '+kind+': '+args[2], file=sys.stderr); result=1
elif args[0]=='rm': data['container']=False
elif args[:2]==['volume','rm']: data['volume']=False
path.write_text(json.dumps(data)); sys.exit(result)
''')
        docker.chmod(0o700)
        self.lock.close()
        for kind in ('container', 'volume'):
            with self.subTest(inspection=kind):
                recovered.unlink(missing_ok=True)
                state.write_text(json.dumps({'container': {'running': False}, 'volume': True, 'failure': kind, 'calls': []}))
                name = 'disconnect-' + kind
                release = self.root / ('release-' + kind)
                self.submit(name, f'while [ ! -f "{release}" ]; do sleep .05; done')
                row = self.wait(name, 'running')
                job = self.root.resolve() / 'jobs' / name
                resources = job / 'resources'
                resources.mkdir()
                owned = f'chalk-postgres-slot-{row["slot"]}-' + runpy.run_path(str(HELPER))['job_token'](job)
                receipt = resources / 'postgres'
                receipt.write_text(owned + '\n' + owned + '\n')
                (resources / 'slot').write_text(str(row['slot']))
                try:
                    release.touch()
                    blocked = self.wait(name, 'quarantined')
                    self.assertIn('failed to connect to the docker API', blocked['cleanup_error'])
                    self.assertLessEqual(len(blocked['cleanup_error'].encode()), 2048)
                    self.assertGreater(blocked['cleanup_after'], time.time())
                    calls = json.loads(state.read_text())['calls']
                    self.assertEqual(calls[0], ['info'])
                    self.assertNotIn(['volume', 'rm', owned], calls)
                    self.assertTrue(json.loads(state.read_text())[kind])
                    if kind == 'container':
                        self.assertEqual(json.loads(state.read_text())['container'], {'running': False})
                    self.submit('healthy-' + kind, 'exit 19')
                    healthy = self.wait('healthy-' + kind)
                    self.assertEqual(healthy['result'], 19)
                    self.assertNotEqual(healthy['slot'], blocked['slot'])
                    recovered.touch()
                    with sqlite3.connect(self.root / 'queue.sqlite') as db:
                        db.execute('UPDATE jobs SET cleanup_after=0 WHERE id=?', (name,))
                    self.invoke('attach', name)
                    self.assertEqual(self.wait(name)['result'], 0)
                    self.assertIsNone(self.status(name)['cleanup_error'])
                    data = json.loads(state.read_text())
                    self.assertFalse(data['container'])
                    self.assertFalse(data['volume'])
                    self.assertIn(['rm', '-f', '--volumes', owned], data['calls'])
                    self.assertIn(['volume', 'rm', owned], data['calls'])
                finally:
                    release.touch()
                    recovered.touch()
                    receipt.unlink(missing_ok=True)
                    with sqlite3.connect(self.root / 'queue.sqlite') as db:
                        db.execute('UPDATE jobs SET cleanup_after=0 WHERE id=?', (name,))
                    self.invoke('attach', name)

    def test_dev_containers_and_volumes_removed_after_finish_and_recovery(self):
        state = self.root / 'docker-state.json'
        foreign = {'containers': {'unrelated': True}, 'volumes': ['unrelated']}
        state.write_text(json.dumps(foreign))
        docker = self.root / 'docker'
        docker.write_text('#!/usr/bin/env python3\n' + f'''
import json,sys,pathlib
path=pathlib.Path({str(state)!r})
data=json.loads(path.read_text()); args=sys.argv[1:]; result=0
if args[:2]==['container','inspect']: result=0 if args[2] in data['containers'] else 1
elif args[:2]==['volume','inspect']: result=0 if args[2] in data['volumes'] else 1
elif args[0]=='run':
    name=args[args.index('--name')+1]; volume=args[args.index('-v')+1].split(':')[0]
    data['containers'][name]=True
    if volume not in data['volumes']: data['volumes'].append(volume)
elif args[0]=='stop': data['containers'][args[1]]=False
elif args[0]=='rm': data['containers'].pop(args[-1],None)
elif args[:2]==['volume','rm']:
    if args[-1] in data['volumes']: data['volumes'].remove(args[-1])
elif args[0]=='exec':
    if 'show server_version' in args: print('18.3')
    elif 'show data_checksums' in args: print('on')
    elif 'redis-server' in args: print('Redis server v=8.10.0')
    elif 'PING' in args: print('PONG')
if result: print('Error: No such '+args[0]+': '+args[2], file=sys.stderr)
path.write_text(json.dumps(data)); sys.exit(result)
''')
        docker.chmod(0o700)
        repository = Path(__file__).resolve().parents[2]
        postgres = shlex.quote(str(repository / 'apps/api/scripts/dev-postgres.sh'))
        redis = shlex.quote(str(repository / 'apps/api/scripts/dev-redis.sh'))
        slot_env = shlex.quote(str(repository / 'scripts/gates/remote-slot-env.sh'))
        startup = (f'export PATH={shlex.quote(str(self.root))}:$PATH\n'
                   f'mkdir -p "$1/tmp"; export TMPDIR="$1/tmp"\nsource {slot_env}\n'
                   f'bash {postgres} start\nbash {redis} start\n')
        self.submit('finish', startup + f'bash {postgres} stop\nbash {redis} stop')
        self.lock.close()
        self.assertEqual(self.wait('finish')['result'], 0, (self.root / 'jobs/finish/output.log').read_text())
        self.assertEqual(json.loads(state.read_text()), foreign, 'successful teardown leaked private containers or volumes')
        ready = self.root / 'resources-ready'
        self.submit('recover', startup + f'touch "{ready}"; sleep 15')
        deadline = time.monotonic() + 5
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(ready.exists())
        os.kill(int((self.root / 'dispatcher.pid').read_text()), signal.SIGKILL)
        os.kill(self.status('recover')['pid'], signal.SIGKILL)
        self.invoke('attach', 'recover')
        self.assertEqual(self.wait('recover')['result'], 137)
        self.assertEqual(json.loads(state.read_text()), foreign, 'crash recovery leaked private containers or volumes')

    @unittest.skipUnless(shutil.which('shlock'), 'requires the macOS legacy shlock binary')
    def test_legacy_thirty_second_poller_gets_handoff_before_new_exclusive(self):
        lock = self.root / 'legacy.lock'
        self.shared_fixture(lock)
        run_id = '20000101T000000Z-' + self.root.name + '-1-deadbeef'
        helper = Path(self.command[1])
        override = f"\ndef legacy_waiters():\n    return {{entry for entry in actual_legacy_waiters() if entry[1] == {run_id!r}}}\n"
        if 'actual_legacy_waiters' in helper.read_text():
            helper.write_text(helper.read_text().replace("if __name__ == '__main__':", override + "\nif __name__ == '__main__':"))
        release_first = self.root / 'release-first'
        release_new = self.root / 'release-new'
        admitted = self.root / 'admitted'
        tried = self.root / 'tried'
        self.submit('first', f'while [ ! -f "{release_first}" ]; do sleep .02; done', '--exclusive')
        self.lock.close()
        self.wait('first', 'running')
        script = '''lock="$3"; admitted="$4"; tried="$5"
started=$SECONDS
while :; do
  if shlock -p $$ -f "$lock"; then touch "$admitted"; rm "$lock"; exit 0; fi
  touch "$tried"
  if ((SECONDS-started >= 30)); then exit 76; fi
  sleep 30
done
'''
        waiter = subprocess.Popen(['bash', '-s', '--', 'run', run_id, str(lock), str(admitted), str(tried)], stdin=subprocess.PIPE)
        waiter.stdin.write(script.encode())
        waiter.stdin.close()
        try:
            deadline = time.monotonic() + 3
            while not tried.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(tried.exists())
            self.submit('newer', f'end=$((SECONDS+40)); while [ ! -f "{release_new}" ] && ((SECONDS<end)); do sleep .05; done', '--exclusive')
            release_first.touch()
            waiter.wait(timeout=35)
            self.assertEqual(waiter.returncode, 0, 'older legacy waiter expired while a newer exclusive overtook it')
            self.assertTrue(admitted.exists())
            print('PASS legacy waiter using real 30-second polling admitted before the next exclusive', flush=True)
        finally:
            release_first.touch()
            release_new.touch()
            if waiter.poll() is None:
                waiter.terminate()
                waiter.wait()
            self.wait('newer')

    def test_invalid_disk_threshold_rejected_before_ticket(self):
        for index, value in enumerate(('not-a-number', '-1', '1.5', 'NaN', '')):
            result = subprocess.run([*self.command, 'submit', f'invalid-{index}'],
                                    input=self.payload('exit 0', ['fake', 'revision', value, '60']),
                                    capture_output=True)
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn(b'disk', result.stderr)
        with sqlite3.connect(self.root / 'queue.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0], 0)
        # Tickets accepted by an older client must fail once, without killing admission.
        old_job = self.root / 'jobs' / 'old-invalid'
        old_job.mkdir()
        (old_job / 'request.json').write_text('["fake", "revision", "invalid", "60"]')
        with sqlite3.connect(self.root / 'queue.sqlite') as db:
            db.execute("INSERT INTO jobs(id,priority,submitted,wait_seconds,state) VALUES(?,0,?,0,'queued')",
                       ('old-invalid', time.time()))
        self.submit('valid')
        self.lock.close()
        self.assertEqual(self.wait('old-invalid')['result'], 64)
        self.assertEqual(self.wait('valid')['result'], 0)

    @unittest.skipUnless(shutil.which('shlock'), 'requires the macOS legacy shlock binary')
    def test_exclusive_lock_survives_dispatcher_death(self):
        legacy_lock = self.root / 'legacy.lock'
        self.shared_fixture(legacy_lock)
        ready = self.root / 'worker-ready'
        self.submit('exclusive', f'touch "{ready}"; sleep 10', '--exclusive')
        self.lock.close()
        row = self.wait('exclusive', 'running')
        deadline = time.monotonic() + 3
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(ready.exists())
        daemon_pid = int((self.root / 'dispatcher.pid').read_text())
        os.kill(daemon_pid, signal.SIGKILL)
        deadline = time.monotonic() + 3
        while subprocess.run(['ps', '-p', str(daemon_pid)], stdout=subprocess.DEVNULL).returncode == 0 and time.monotonic() < deadline:
            time.sleep(.02)
        try:
            os.kill(row['pid'], 0)
            result = subprocess.run(['shlock', '-p', str(os.getpid()), '-f', str(legacy_lock)])
            self.assertNotEqual(result.returncode, 0, 'legacy job acquired the lock while exclusive worker survived')
            self.assertEqual(int(legacy_lock.read_text()), row['pid'])
        finally:
            try:
                os.killpg(row['pid'], signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.invoke('attach', 'exclusive')
            self.wait('exclusive')

    @unittest.skipUnless(shutil.which('shlock'), 'requires the macOS legacy shlock binary')
    def test_exclusive_reserves_lock_before_cutover_guard(self):
        legacy_lock = self.root / 'legacy.lock'
        self.shared_fixture(legacy_lock)
        helper = Path(self.command[1])
        probe = self.root / 'guard-entered'
        unblock = self.root / 'guard-release'
        override = f"""
def legacy_active():
    Path({str(probe)!r}).touch()
    deadline = time.monotonic() + 5
    while not Path({str(unblock)!r}).exists() and time.monotonic() < deadline:
        time.sleep(.02)
    return False

def legacy_busy(*args):
    return legacy_active()
"""
        helper.write_text(helper.read_text().replace('if False:', 'if legacy_busy(cutover):')
                          .replace("if __name__ == '__main__':", override + "\nif __name__ == '__main__':"))
        self.submit('exclusive', 'exit 0', '--exclusive')
        self.lock.close()
        try:
            deadline = time.monotonic() + 4
            while not probe.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(probe.exists(), 'exclusive must check active legacy work')
            self.assertTrue(legacy_lock.exists(), 'cutover guard ran before reserving the legacy lock')
            contender = subprocess.Popen(['sleep', '5'])
            try:
                result = subprocess.run(['shlock', '-p', str(contender.pid), '-f', str(legacy_lock)])
                self.assertNotEqual(result.returncode, 0, 'a later legacy waiter defeated the reservation')
            finally:
                contender.terminate()
                contender.wait()
        finally:
            unblock.touch()
            self.wait('exclusive')

    @unittest.skipUnless(shutil.which("shlock"), "requires the macOS legacy shlock binary")
    def test_only_exclusive_holds_legacy_lock_and_releases_before_cleanup(self):
        legacy_lock = self.root / 'legacy.lock'
        self.shared_fixture(legacy_lock)
        os.environ['CHALK_REMOTE_SLOTS'] = '3'
        barrier = self.root / 'ordinary-release'
        script = f'end=$((SECONDS+6)); while [ ! -f "{barrier}" ] && ((SECONDS<end)); do sleep .05; done'
        for name in ('one', 'two', 'three'):
            self.submit(name, script)
        self.lock.close()
        for name in ('one', 'two', 'three'):
            self.wait(name, 'running')
        self.assertFalse(legacy_lock.exists(), 'ordinary slots must never hold the legacy lock')
        barrier.touch()
        for name in ('one', 'two', 'three'):
            self.wait(name)
        exclusive_release = self.root / 'exclusive-release'
        script = ('(trap "sleep 2; exit 0" TERM; while :; do sleep .05; done) & '
                  f'end=$((SECONDS+6)); while [ ! -f "{exclusive_release}" ] && ((SECONDS<end)); do sleep .05; done')
        self.submit('exclusive', script, '--exclusive')
        self.wait('exclusive', 'running')
        self.assertTrue(legacy_lock.exists())
        admitted = self.root / 'legacy-admitted'
        waiter = subprocess.Popen(['bash', '-c',
                                   'until shlock -p $$ -f "$1"; do sleep .02; done; echo admitted > "$2"; rm "$1"',
                                   'legacy-waiter', str(legacy_lock), str(admitted)])
        try:
            time.sleep(.1)
            self.assertFalse(admitted.exists())
            exclusive_release.touch()
            waiter.wait(timeout=1.5)
            self.assertTrue(admitted.exists(), 'legacy waiter must start before slow descendant cleanup ends')
            self.assertEqual(self.wait('exclusive')['result'], 0)
            self.assertFalse(legacy_lock.exists(), 'idle dispatcher must leave the legacy lock free')
            print('PASS legacy waiter admitted immediately after exclusive exit; ordinary slots and idle daemon never held legacy lock', flush=True)
        finally:
            if waiter.poll() is None:
                waiter.terminate()
                waiter.wait()

    @unittest.skipUnless(shutil.which("shlock"), "requires the macOS legacy shlock binary")
    def test_legacy_lock_occupies_one_slot(self):
        os.environ['CHALK_REMOTE_SLOTS'] = '3'
        legacy_lock = self.root / 'legacy.lock'
        legacy_lock.write_text(str(os.getpid()))
        self.shared_fixture(legacy_lock)
        barrier = self.root / 'release'
        script = f'end=$((SECONDS+6)); while [ ! -f "{barrier}" ] && ((SECONDS<end)); do sleep .05; done'
        for name in ('one', 'two', 'three'):
            self.submit(name, script)
        self.lock.close()
        self.wait('one', 'running')
        self.wait('two', 'running')
        self.assertEqual(self.status('three')['state'], 'queued')
        self.assertEqual(legacy_lock.read_text(), str(os.getpid()))
        legacy_lock.unlink()
        self.wait('three', 'running')
        barrier.touch()
        for name in ('one', 'two', 'three'):
            self.assertEqual(self.wait(name)['result'], 0)

    def test_low_memory_defers_admission(self):
        vm_stat = self.root / 'vm_stat'
        healthy = vm_stat.read_text()
        vm_stat.write_text(healthy.replace('524288', '1'))
        self.submit('held')
        self.lock.close()
        time.sleep(.4)
        self.assertEqual(self.status('held')['state'], 'queued')
        vm_stat.write_text(healthy)
        self.assertEqual(self.wait('held')['result'], 0)
        print('PASS memory guard: 16 KiB available held ticket queued; 8 GiB released it with exit 0', flush=True)

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
        self.submit('interrupted', 'sleep 1; exit 23')
        self.lock.close()
        self.wait('interrupted', 'running')
        os.kill(int((self.root / 'dispatcher.pid').read_text()), signal.SIGKILL)
        self.invoke('attach', 'interrupted')
        self.assertEqual(self.wait('interrupted')['result'], 23)
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
