#!/usr/bin/env python3
"""Run tiny queue proof on the M4 without touching its shared heavy-job admission."""
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid

host = sys.argv[1] if len(sys.argv) > 1 else 'agents-macmini'
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', host]
home = subprocess.check_output([*ssh, 'printf %s "$HOME"'], text=True)
lane = home + '/lanes/remote-queue-' + uuid.uuid4().hex
helper = lane + '/remote-queue.py'
root = lane + '/state'
command = f'python3 {shlex.quote(helper)} --root {shlex.quote(root)} --isolated'
client = None


def call(action, data=None):
    return subprocess.check_output([*ssh, command + ' ' + action], input=data)


def payload(script):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, data in {'repo.bundle': b'fake', 'request.json': b'["fake"]',
                           'runner.sh': ('set -eu\ncd "$1"\n' + script + '\n').encode()}.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


def wait(name, state):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        row = json.loads(call('status ' + name))
        if row['state'] == state:
            return row
        time.sleep(0.1)
    raise AssertionError(f'{name} never reached {state}: {row}')


try:
    subprocess.run([*ssh, 'mkdir -p ' + shlex.quote(lane)], check=True)
    subprocess.run([*ssh, 'cat > ' + shlex.quote(helper)], input=Path(__file__).with_name('remote-queue.py').read_bytes(), check=True)
    first = json.loads(call('submit first', payload('sleep 4; echo first')))
    wait('first', 'running')
    # Simulate an attached SSH client after registration. Killing the Air SSH must not kill the ticket.
    client = subprocess.Popen([*ssh, command + ' submit queued; sleep 8'], stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    client.stdin.write(payload('echo detached; exit 23'))
    client.stdin.close()
    queued = json.loads(client.stdout.readline())
    assert queued['state'] == 'queued', queued
    assert queued['ticket'] > first['ticket']
    client.kill()
    client.wait()
    assert wait('queued', 'done')['result'] == 23
    output = call('read queued 0').decode()
    assert 'detached' in output and 'REMOTE_QUEUE_RESULT=23' in output, output
    assert wait('first', 'done')['result'] == 0
    print('PASS: FIFO tickets; killed queued client SSH; detached job ran; reattach returned exit 23.')
    # Drive the actual shell client's attach/retry path against this isolated service.
    with tempfile.TemporaryDirectory(prefix='chalk-queue-client-') as local:
        local = Path(local)
        scripts = local / 'scripts/gates'
        scripts.mkdir(parents=True)
        source = Path(__file__).parent
        (scripts / 'remote.sh').write_bytes((source / 'remote.sh').read_bytes())
        helper_text = (source / 'remote-queue.py').read_text().replace(
            "DEFAULT_ROOT = Path.home() / '.local/share/chalk-remote/v1'", f'DEFAULT_ROOT = Path({root!r})')
        helper_text = helper_text.replace("parser.add_argument('--isolated', action='store_true',", "parser.add_argument('--isolated', action='store_true', default=True,")
        (scripts / 'remote-queue.py').write_text(helper_text)
        wrapper = local / 'ssh'
        marker = local / 'dropped-once'
        wrapper.write_text('#!/usr/bin/env python3\nimport os,pathlib,sys\n'
                           f'p=pathlib.Path({str(marker)!r})\n'
                           'if " read " in sys.argv[-1] and not p.exists():\n'
                           ' p.touch(); print("PARTIAL_FAILED_READ"); sys.exit(255)\n'
                           'os.execv("/usr/bin/ssh", ["ssh", *sys.argv[1:]])\n')
        wrapper.chmod(0o700)
        environment = {**os.environ, 'PATH': str(local) + ':' + os.environ['PATH'],
                       'CHALK_REMOTE_HOST': host, 'CHALK_REMOTE_REPO': str(source.parent.parent),
                       'CHALK_REMOTE_LOG_DIR': str(local / 'logs')}
        attached = subprocess.run(['bash', str(scripts / 'remote.sh'), '--attach', 'queued'],
                                  env=environment, capture_output=True, text=True, timeout=30)
        assert attached.returncode == 23, attached.stdout + attached.stderr
        assert marker.exists() and 'connection lost' in attached.stderr, attached.stderr
        assert 'PARTIAL_FAILED_READ' not in (local / 'logs/queued.log').read_text()
        print('PASS: real remote.sh reattached, discarded a partial failed read, retried, and exited 23.')
        import hashlib
        installed = home + '/.local/share/chalk-remote/helpers/' + hashlib.sha256(helper_text.encode()).hexdigest() + '.py'
        subprocess.run([*ssh, 'rm -f ' + shlex.quote(installed)], check=True)
    call('submit crash', payload('sleep 3 &\nkill -KILL $$'))
    call('submit after-crash', payload('exit 7'))
    assert wait('crash', 'done')['result'] == 137
    assert wait('after-crash', 'done')['result'] == 7
    print('PASS: crashed worker released admission; following fake job returned exit 7.')
finally:
    if client and client.poll() is None:
        client.kill()
        client.wait()
    # All fake workloads are bounded. Let a disconnected remote sleep and dispatchers exit first.
    cleanup = 'import pathlib,shutil,sys,time; time.sleep(8); p=pathlib.Path(sys.argv[1]); assert p.name.startswith("remote-queue-"); shutil.rmtree(p)'
    subprocess.run([*ssh, 'python3 -c ' + shlex.quote(cleanup) + ' ' + shlex.quote(lane)], check=True)
