#!/usr/bin/env python3
"""EOF on the owner's pipe reclaims only the capture's recorded resources."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

state = Path(sys.argv[1])
sys.stdin.buffer.read()
owned = json.loads(state.read_text())
for pid in owned['groups']:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
if owned['device']:
    # Maestro's xcodebuild can outlive its JVM. Only reclaim automation for this leased UDID.
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True)
    processes = [line.strip().split(None, 2) for line in rows.splitlines() if line.strip()]
    automation = {int(pid) for pid, _, command in processes if 'xcodebuild test-without-building -xctestrun' in command and f"id={owned['device']}" in command}
    while True:
        children = {int(pid) for pid, parent, _ in processes if int(parent) in automation}
        expanded = automation | children
        if expanded == automation:
            break
        automation = expanded
    for pid in automation:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if automation:
        time.sleep(1)
        for pid in automation:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    subprocess.run(['xcrun', 'simctl', 'shutdown', owned['device']], capture_output=True, timeout=120)
    if not owned.get('retain_device'):
        subprocess.run(['xcrun', 'simctl', 'delete', owned['device']], capture_output=True, timeout=30)
if owned['avd'] and not owned.get('retain_device'):
    subprocess.run([owned['manager'], 'delete', 'avd', '-n', owned['avd']], capture_output=True, timeout=30)
state.unlink(missing_ok=True)
