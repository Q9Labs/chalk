#!/usr/bin/env python3
"""EOF on the owner's pipe reclaims only the capture's recorded resources."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

state = Path(sys.argv[1])
sys.stdin.buffer.read()
try:
    owned = json.loads(state.read_text())
    for pid in owned['groups']:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if owned['device']:
        subprocess.run(['xcrun', 'simctl', 'shutdown', owned['device']], capture_output=True)
        subprocess.run(['xcrun', 'simctl', 'delete', owned['device']], capture_output=True)
    if owned['avd']:
        subprocess.run([owned['manager'], 'delete', 'avd', '-n', owned['avd']], capture_output=True)
finally:
    state.unlink(missing_ok=True)
