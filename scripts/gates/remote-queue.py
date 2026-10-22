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
            with db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT * FROM jobs WHERE id=?', (args.id,)).fetchone()
                if row is None:
                    destination = root / 'jobs' / args.id
                    if destination.exists():
                        shutil.rmtree(destination)
                    incoming.rename(destination)
                    db.execute('INSERT INTO jobs(id,priority,submitted,wait_seconds,state) VALUES(?,?,?,?,?)',
                               (args.id, args.priority, time.time(), args.wait_seconds, 'queued'))
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
    # Descendants may create new process groups or outlive their shell. Exact checkout cwd ownership
    # also catches these after a dispatcher crash; PID start times guard against reuse.
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
        for p, start in receipts.items():
            if start and process_start(p) == start:
                try:
                    os.kill(p, sig)
                except ProcessLookupError:
                    pass
        if sig == signal.SIGTERM and receipts:
            time.sleep(0.3)


def finish(root, db, row, result, reason):
    job = root / 'jobs' / row['id']
    work = job / 'work'
    if work.is_symlink():
        target = work.resolve()
        if target.parent != Path('/tmp').resolve() or not target.name.startswith('chalk-remote-queue-'):
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


def legacy_busy():
    processes = subprocess.check_output(['ps', '-axo', 'command='], text=True)
    # Drain old queued clients before competing for the shared admission lock.
    if any(re.match(r'^bash -s -- run [A-Za-z0-9-]+ ', line.strip()) for line in processes.splitlines()):
        return True
    if re.search(r'[/]tmp/chalk-remote-\d{8}T', processes):
        return True
    result = subprocess.run(['lsof', '-d', 'cwd', '-Fn'], capture_output=True, text=True)
    return bool(re.search(r'^n(/private)?/tmp/chalk-remote-', result.stdout, re.M))


def admission(isolated):
    if isolated:
        return True
    if legacy_busy():
        return False
    return subprocess.run(['shlock', '-p', str(os.getpid()), '-f', '/tmp/chalk-remote-admission.lock']).returncode == 0


def release(isolated):
    if not isolated:
        lock = Path('/tmp/chalk-remote-admission.lock')
        if lock.exists() and lock.read_text().strip() == str(os.getpid()):
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


def daemon(root, db, isolated):
    # Blocking flock makes a wake racing an idle dispatcher's exit take over after it exits.
    with (root / 'dispatcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        (root / 'dispatcher.pid').write_text(str(os.getpid()))
        try:
            for row in db.execute("SELECT * FROM jobs WHERE state='running'").fetchall():
                stop_job(root / 'jobs' / row['id'], row['pid'], row['started'])
                finish(root, db, row, 137, 'dispatcher restarted; interrupted job reaped')
            reap(root, db)
            while True:
                now = time.time()
                rows = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY priority DESC,ticket").fetchall()
                if not rows:
                    return
                for row in rows:
                    if row['wait_seconds'] and now - row['submitted'] >= row['wait_seconds']:
                        finish(root, db, row, 76, 'queue wait limit expired')
                row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY priority DESC,ticket LIMIT 1").fetchone()
                if row is None:
                    continue
                if not admission(isolated):
                    time.sleep(2)
                    continue
                child = None
                started = None
                job = root / 'jobs' / row['id']
                try:
                    with db:
                        db.execute("UPDATE jobs SET state='running' WHERE id=?", (row['id'],))
                    # Old clients also inspect /tmp/chalk-remote-* processes/cwds. Preserve that
                    # signal if the dispatcher dies while a worker still holds the machine.
                    work = Path('/tmp') / ('chalk-remote-queue-' + hashlib.sha256(str(job).encode()).hexdigest()[:24])
                    (job / 'work').symlink_to(work)
                    work.mkdir()
                    (job / 'repo.bundle').rename(work / 'repo.bundle')
                    request = json.loads((job / 'request.json').read_text())
                    with (job / 'output.log').open('ab') as log:
                        log.write(f"[remote] ticket {row['ticket']} running: {row['id']}\n".encode())
                        log.flush()
                        # The pipe closes on dispatcher death. No job starts before its PID receipt commits.
                        login_shell = '/bin/zsh' if sys.platform == 'darwin' else '/bin/bash'
                        child = subprocess.Popen(['/bin/bash', '-ec',
                                                  'read -r ready; shell="$1"; shift; exec "$shell" -lc \'exec bash "$@"\' chalk-queue "$@"', 'chalk-queue', login_shell,
                                                  str(job / 'runner.sh'), str(work), *request],
                                                 stdin=subprocess.PIPE, stdout=log, stderr=log,
                                                 start_new_session=True, close_fds=True)
                        started = process_start(child.pid)
                        with db:
                            db.execute("UPDATE jobs SET state='running',pid=?,started=? WHERE id=?",
                                       (child.pid, started, row['id']))
                        child.stdin.write(b'run\n')
                        child.stdin.close()
                        result = child.wait()
                    stop_job(job, child.pid, started)
                    finish(root, db, row, result if result >= 0 else 128 - result, 'job finished; checkout cleaned')
                except Exception as error:
                    if child:
                        stop_job(job, child.pid, started)
                    finish(root, db, row, 70, f'queue failed: {error}')
                finally:
                    release(isolated)
        finally:
            release(isolated)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--isolated', action='store_true', help='fake workloads only; bypass shared M4 admission')
    sub = parser.add_subparsers(dest='action', required=True)
    submit_parser = sub.add_parser('submit')
    submit_parser.add_argument('id')
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
            if row['state'] == 'done':
                print(f"\nREMOTE_QUEUE_RESULT={row['result']}", flush=True)


if __name__ == '__main__':
    main()
