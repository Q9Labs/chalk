#!/usr/bin/env python3
"""Durable M4 queue. Standard library only; helpers are installed by content hash."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

DEFAULT_ROOT = Path.home() / '.local/share/chalk-remote/v1'


def database(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'jobs').mkdir(exist_ok=True)
    db = sqlite3.connect(root / 'queue.sqlite', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('''CREATE TABLE IF NOT EXISTS jobs (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        priority INTEGER NOT NULL, submitted REAL NOT NULL, wait_seconds INTEGER NOT NULL,
        state TEXT NOT NULL, pid INTEGER, started TEXT, result INTEGER, finished REAL)''')
    db.execute('BEGIN IMMEDIATE')
    columns = {row[1] for row in db.execute('PRAGMA table_info(jobs)')}
    for name, definition in [('exclusive', 'INTEGER NOT NULL DEFAULT 0'), ('slot', 'INTEGER')]:
        if name not in columns:
            db.execute(f'ALTER TABLE jobs ADD COLUMN {name} {definition}')
    db.commit()
    return db


def wake(root, isolated=False):
    with (root / 'daemon.log').open('ab') as log:
        command = [sys.executable, str(Path(__file__).resolve()), '--root', str(root)]
        if isolated:
            command.append('--isolated')
        subprocess.Popen([*command, 'daemon'], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True, close_fds=True)


def submit(root, db, args):
    # An incomplete transfer never becomes a ticket; retries cannot replace a published job's input.
    incoming = Path(tempfile.mkdtemp(prefix='upload-', dir=root))
    try:
        with (incoming / 'lease').open('w') as lease:
            fcntl.flock(lease, fcntl.LOCK_EX)
            with tarfile.open(fileobj=sys.stdin.buffer, mode='r|') as archive:
                names = set()
                for entry in archive:
                    if entry.name not in ('repo.bundle', 'runner.sh', 'request.json') or not entry.isfile() or entry.name in names:
                        raise ValueError('invalid submission archive entry: ' + entry.name)
                    names.add(entry.name)
                    with archive.extractfile(entry) as source, (incoming / entry.name).open('wb') as target:
                        shutil.copyfileobj(source, target)
                if names != {'repo.bundle', 'runner.sh', 'request.json'}:
                    raise ValueError('incomplete submission archive')
            request = json.loads((incoming / 'request.json').read_text())
            if not isinstance(request, list) or not request or not all(isinstance(x, str) for x in request):
                raise ValueError('request must be an argument list')
            disk_threshold(request)
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT * FROM jobs WHERE id=?', (args.id,)).fetchone()
                if row is None:
                    destination = root / 'jobs' / args.id
                    if destination.exists():
                        shutil.rmtree(destination)
                    incoming.rename(destination)
                    db.execute('INSERT INTO jobs(id,priority,submitted,wait_seconds,state,exclusive) VALUES(?,?,?,?,?,?)',
                               (args.id, args.priority, time.time(), args.wait_seconds, 'queued', int(args.exclusive or exclusive_request(request))))
                    row = db.execute('SELECT * FROM jobs WHERE id=?', (args.id,)).fetchone()
        wake(root, args.isolated)
        print(json.dumps(dict(row)), flush=True)
    finally:
        if incoming.exists():
            shutil.rmtree(incoming)


def process_start(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True)
    return result.stdout.strip()


def stop_job(job, pid, started):
    # setpgrp (including with-timeout.sh) changes process group but preserves the job's session.
    # Session membership survives reparenting and cwd changes; start times protect PID reuse.
    owned = set()
    processes = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True)
    parents = {}
    for line in processes.splitlines():
        p, parent, *command = line.split(maxsplit=2)
        parents[int(p)] = int(parent)
        if command and str(job / 'runner.sh') in command[0]:
            owned.add(int(p))
    if pid and process_start(pid) == started:
        owned.add(pid)
    if pid and process_start(pid) in ('', started):
        for p in parents:
            try:
                if os.getsid(p) == pid:
                    owned.add(p)
            except ProcessLookupError:
                pass
    changed = True
    while changed:
        children = {p for p, parent in parents.items() if parent in owned}
        changed = not children.issubset(owned)
        owned.update(children)
    result = subprocess.run(['lsof', '-d', 'cwd', '-Fpn'], capture_output=True, text=True)
    current = None
    work = str((job / 'work').resolve())
    for line in result.stdout.splitlines():
        if line.startswith('p'):
            current = int(line[1:])
        elif line.startswith('n') and current:
            path = os.path.realpath(line[1:])
            if path == work or path.startswith(work + '/'):
                owned.add(current)
    receipts = {p: process_start(p) for p in owned if p != os.getpid()}
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if sig == signal.SIGKILL and pid and process_start(pid) in ('', started):
            # Include children started by a TERM handler after the first process snapshot.
            for value in subprocess.check_output(['ps', '-axo', 'pid='], text=True).split():
                p = int(value)
                try:
                    if os.getsid(p) == pid:
                        receipts[p] = process_start(p)
                except ProcessLookupError:
                    pass
        for p, start in receipts.items():
            if start and process_start(p) == start:
                try:
                    os.kill(p, sig)
                except ProcessLookupError:
                    pass
        if sig == signal.SIGTERM and receipts:
            # Give gate traps (notably temporary database cleanup) the old runner's ten-second grace.
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                states = subprocess.run(['ps', '-p', ','.join(str(p) for p in receipts), '-o', 'pid=,stat='],
                                        capture_output=True, text=True).stdout.splitlines()
                if not any(not line.split()[1].startswith('Z') for line in states):
                    break
                time.sleep(0.05)


def finish(root, db, row, result, reason):
    job = root / 'jobs' / row['id']
    work = job / 'work'
    if work.is_symlink():
        target = work.resolve()
        if target.parent != Path('/tmp').resolve() or not target.name.startswith(('chalk-remote-queue-', 'chalk-queue-work-')):
            raise ValueError('refusing unexpected checkout path: ' + str(target))
        if target.exists():
            shutil.rmtree(target)
        work.unlink()
    (job / 'repo.bundle').unlink(missing_ok=True)
    with (job / 'output.log').open('ab') as log:
        log.write(f'\n[remote] {reason}\nREMOTE_GATE_EXIT={result}\n'.encode())
    with db:
        db.execute("UPDATE jobs SET state='done',result=?,finished=? WHERE id=?",
                   (result, time.time(), row['id']))


def exclusive_request(request):
    return any(value in ('gate', '--full') or re.search(r'gate:full|call-performance|performance[-:]|perf[-:]budget|check-call-performance', value)
               for value in request)


def disk_threshold(request):
    value = request[2] if len(request) >= 4 else '8'
    if not re.fullmatch(r'[0-9]{1,9}', value):
        raise ValueError('minimum free disk GiB must be a nonnegative integer of at most 9 digits')
    return int(value)


def resources_available(root, request):
    minimum_disk = disk_threshold(request)
    if shutil.disk_usage(root).free < minimum_disk * 1024 ** 3:
        return False
    try:
        stats = subprocess.check_output(['vm_stat'], text=True)
        page_size = int(re.search(r'page size of (\d+) bytes', stats)[1])
        pages = sum(int(re.search(r'^' + label + r':\s+(\d+)', stats, re.M)[1])
                    for label in ('Pages free', 'Pages inactive', 'Pages speculative'))
        return pages * page_size >= 3 * 1024 ** 3
    except (OSError, subprocess.SubprocessError, TypeError, ValueError):
        return False


def legacy_occupied():
    lock = Path('/tmp/chalk-remote-admission.lock')
    try:
        owner = int(lock.read_text().strip())
        if owner != os.getpid() and process_start(owner):
            return True
    except (FileNotFoundError, ValueError):
        pass
    return legacy_active()


def legacy_active():
    processes = subprocess.check_output(['ps', '-axo', 'command='], text=True)
    if re.search(r'[/]tmp/chalk-remote-\d{8}T', processes):
        return True
    cwd = subprocess.run(['lsof', '-d', 'cwd', '-Fn'], capture_output=True, text=True).stdout
    return bool(re.search(r'^n(/private)?/tmp/chalk-remote-\d{8}T', cwd, re.M))


def admission(isolated, owner):
    if isolated:
        return True
    lock = Path('/tmp/chalk-remote-admission.lock')
    if lock.exists() and lock.read_text().strip() == str(owner):
        return True
    return subprocess.run(['shlock', '-p', str(owner), '-f', str(lock)]).returncode == 0



def release(isolated, owner=None):
    if not isolated:
        owner = owner if owner is not None else os.getpid()
        lock = Path('/tmp/chalk-remote-admission.lock')
        if lock.exists() and lock.read_text().strip() == str(owner):
            lock.unlink()


def reap(root, db):
    now = time.time()
    for upload in root.glob('upload-*'):
        try:
            with (upload / 'lease').open('a') as lease:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if now - upload.stat().st_mtime > 3600:
                    shutil.rmtree(upload)
        except (BlockingIOError, FileNotFoundError):
            pass
    for job in (root / 'jobs').iterdir():
        if now - job.stat().st_mtime > 3600 and db.execute('SELECT 1 FROM jobs WHERE id=?', (job.name,)).fetchone() is None:
            shutil.rmtree(job)
    for row in db.execute("SELECT * FROM jobs WHERE state='done' AND finished<?", (now - 7 * 86400,)).fetchall():
        shutil.rmtree(root / 'jobs' / row['id'], ignore_errors=True)
        # Keep the small tombstone so a run ID can never execute twice.


def reap_legacy(temp_root=Path('/tmp')):
    cutoff = time.time() - 4 * 3600
    processes = subprocess.check_output(['ps', '-axo', 'command='], text=True)
    cwd = subprocess.run(['lsof', '-d', 'cwd', '-Fn'], capture_output=True, text=True).stdout
    for directory in temp_root.glob('chalk-remote-*'):
        marker = directory / '.chalk-remote-owner'
        if (not re.fullmatch(r'chalk-remote-\d{8}T\d{6}Z-[A-Za-z0-9-]{1,24}-\d+-[0-9a-f]{16}', directory.name)
                or directory.is_symlink() or not directory.is_dir() or directory.stat().st_mtime >= cutoff
                or marker.is_symlink() or not marker.is_file()
                or marker.read_text().strip() != directory.name.removeprefix('chalk-remote-')):
            continue
        if directory.name not in processes and directory.name not in cwd:
            shutil.rmtree(directory)
    for docker in dict.fromkeys([shutil.which('docker'), str(Path.home() / '.orbstack/bin/docker')]):
        if not docker or not os.access(docker, os.X_OK):
            continue
        try:
            if subprocess.run([docker, 'info'], capture_output=True, timeout=10).returncode:
                continue
            names = subprocess.check_output([docker, 'ps', '-a', '--filter', 'name=chalk-gate-postgres',
                                             '--format', '{{.Names}}'], text=True, timeout=10)
            stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(cutoff))
            for name in names.splitlines():
                match = re.fullmatch(r'chalk-gate-postgres-(\d{8}T\d{6}Z)-(\d+)', name)
                if match and match[1] < stamp and not process_start(int(match[2])):
                    subprocess.run([docker, 'rm', '-f', '--volumes', name], capture_output=True, timeout=10)
            break
        except (subprocess.SubprocessError, OSError) as error:
            print(f'legacy container cleanup deferred: {error}', flush=True)


def expire_waiters(root, db):
    rows = db.execute("SELECT * FROM jobs WHERE state='queued' AND wait_seconds>0 AND submitted+wait_seconds<=?", (time.time(),)).fetchall()
    for row in rows:
        finish(root, db, row, 76, 'queue wait limit expired')


def daemon(root, db, isolated):
    slots = int(os.environ.get('CHALK_REMOTE_SLOTS', '3'))
    if not 1 <= slots <= 100:
        raise ValueError('CHALK_REMOTE_SLOTS must be between 1 and 100')
    # Only this process writes admissions. Additional wakes take over after its idle exit.
    with (root / 'dispatcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        (root / 'dispatcher.pid').write_text(str(os.getpid()))
        running = {}
        try:
            for row in db.execute("SELECT * FROM jobs WHERE state='running'").fetchall():
                stop_job(root / 'jobs' / row['id'], row['pid'], row['started'])
                if row['exclusive']:
                    release(isolated, row['pid'])
                finish(root, db, row, 137, 'dispatcher restarted; interrupted job reaped')
            reap(root, db)
            if not isolated:
                reap_legacy()
            while True:
                for ticket, (row, child, started) in list(running.items()):
                    result = child.poll()
                    if result is not None:
                        if row['exclusive']:
                            release(isolated, child.pid)
                        stop_job(root / 'jobs' / row['id'], child.pid, started)
                        finish(root, db, row, result if result >= 0 else 128 - result, 'job finished; checkout cleaned')
                        del running[ticket]
                if not any(row['exclusive'] for row, _, _ in running.values()):
                    release(isolated)
                expire_waiters(root, db)
                row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY priority DESC,ticket LIMIT 1").fetchone()
                if row is None and not running:
                    return
                if row is None or len(running) >= slots or any(r['exclusive'] for r, _, _ in running.values()):
                    time.sleep(0.2)
                    continue
                job = root / 'jobs' / row['id']
                request = json.loads((job / 'request.json').read_text())
                try:
                    disk_threshold(request)
                except ValueError as error:
                    finish(root, db, row, 64, str(error))
                    continue
                exclusive = bool(row['exclusive'] or exclusive_request(request))
                # Ordinary jobs never acquire the legacy lock. A live legacy job occupies
                # one slot; existing slot jobs keep their isolated ports and continue running.
                occupied = int(not isolated and legacy_occupied())
                if (len(running) + occupied >= slots or (exclusive and running)
                        or not resources_available(root, request)):
                    time.sleep(0.2)
                    continue
                slot = next(i for i in range(slots) if i not in {r['slot'] for r, _, _ in running.values()})
                child = None
                started = None
                try:
                    work = Path('/tmp') / ('chalk-queue-work-' + hashlib.sha256(str(job).encode()).hexdigest()[:24])
                    with (job / 'output.log').open('ab') as log:
                        login_shell = '/bin/zsh' if sys.platform == 'darwin' else '/bin/bash'
                        child = subprocess.Popen(['/bin/bash', '-ec',
                                                  'read -r ready; shell="$1"; shift; exec "$shell" -lc \'exec bash "$@"\' chalk-queue "$@"', 'chalk-queue', login_shell,
                                                  str(job / 'runner.sh'), str(work), *request],
                                                 env={**os.environ, 'CHALK_REMOTE_SLOT': str(slot)},
                                                 stdin=subprocess.PIPE, stdout=log, stderr=log,
                                                 start_new_session=True, close_fds=True)
                        started = process_start(child.pid)
                        # The blocked worker owns the reservation, then keeps the same PID
                        # through exec. Dispatcher death cannot invalidate an exclusive lock.
                        if exclusive and not admission(isolated, child.pid):
                            child.stdin.close()
                            child.wait()
                            time.sleep(.2)
                            continue
                        with db:
                            db.execute("UPDATE jobs SET state='running',slot=?,exclusive=?,pid=?,started=? WHERE id=?",
                                       (slot, int(exclusive), child.pid, started, row['id']))
                        row = db.execute('SELECT * FROM jobs WHERE id=?', (row['id'],)).fetchone()
                        # Reserve before inspecting orphaned legacy work. Bare legacy waiters
                        # cannot run while we own shlock and must not extend this guard.
                        deadline = time.monotonic() + 30
                        while exclusive and not isolated and legacy_active():
                            if time.monotonic() >= deadline:
                                raise RuntimeError('legacy checkout still active after 30-second admission guard')
                            time.sleep(.2)
                        (job / 'work').symlink_to(work)
                        work.mkdir()
                        (job / 'repo.bundle').rename(work / 'repo.bundle')
                        log.write(f"[remote] ticket {row['ticket']} running: {row['id']} slot={slot} exclusive={exclusive}\n".encode())
                        log.flush()
                        child.stdin.write(b'run\n')
                        child.stdin.close()
                    running[row['ticket']] = (row, child, started)
                except Exception as error:
                    if child:
                        stop_job(job, child.pid, started)
                        child.stdin.close()
                        child.wait()
                        if exclusive:
                            release(isolated, child.pid)
                    finish(root, db, row, 70, f'queue failed: {error}')
        finally:
            release(isolated)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--isolated', action='store_true', help='fake workloads only; bypass shared M4 admission')
    sub = parser.add_subparsers(dest='action', required=True)
    submit_parser = sub.add_parser('submit')
    submit_parser.add_argument('id')
    submit_parser.add_argument('--exclusive', action='store_true')
    submit_parser.add_argument('--priority', type=int, choices=(0, 1), default=0)
    submit_parser.add_argument('--wait-seconds', type=int, default=0)
    for action in ('read', 'status', 'attach'):
        command = sub.add_parser(action)
        command.add_argument('id')
        if action == 'read':
            command.add_argument('offset', type=int, default=0, nargs='?')
    sub.add_parser('daemon')
    args = parser.parse_args()
    if hasattr(args, 'id') and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', args.id):
        parser.error('run ID must contain 1-128 letters, digits, underscores or hyphens')
    root = args.root.resolve()
    db = database(root)
    if args.action == 'submit':
        submit(root, db, args)
    elif args.action == 'daemon':
        daemon(root, db, args.isolated)
    else:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (args.id,)).fetchone()
        if row is None:
            sys.exit(4)
        if args.action == 'attach' and row['state'] != 'done':
            wake(root, args.isolated)
        if args.action == 'read' and row['state'] != 'done':
            with (root / 'dispatcher.lock').open('a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    wake(root, args.isolated)
        if args.action != 'read':
            print(json.dumps(dict(row)))
        else:
            log = root / 'jobs' / args.id / 'output.log'
            if log.exists():
                with log.open('rb') as source:
                    source.seek(args.offset)
                    shutil.copyfileobj(source, sys.stdout.buffer)


if __name__ == '__main__':
    main()
