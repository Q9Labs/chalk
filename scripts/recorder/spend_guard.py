#!/usr/bin/env python3
"""Detached deadline guard: one immutable ID/name/creation time, never a tag sweep."""

import argparse
import json
import subprocess
import time
from pathlib import Path

from release_core import builder_identity


def expire(identity, context, deadline, stop_file):
    base = ["doctl", "--context", context, "compute", "droplet"]
    while time.time() < deadline:
        if Path(stop_file).exists():
            try:
                read = subprocess.run(base + ["get", str(identity["id"]), "--output", "json"], capture_output=True, text=True, timeout=60)
            except subprocess.TimeoutExpired:
                continue
            if read.returncode and "404" in read.stderr:
                print("GUARD_CLEANUP_ABSENCE_VERIFIED", flush=True)
                return
        time.sleep(min(5, max(0, deadline - time.time())))
    # Bounded retries tolerate provider lag; a 404 is success, never a reason to broaden deletion.
    for attempt in range(3):
        try:
            read = subprocess.run(base + ["get", str(identity["id"]), "--output", "json"], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            if attempt == 2:
                raise RuntimeError("guard could not read exact builder after three provider timeouts") from None
            continue
        if read.returncode:
            if "404" in read.stderr:
                print("GUARD_ALREADY_ABSENT", flush=True)
                return
            if attempt == 2:
                raise RuntimeError("guard could not read exact builder identity")
        else:
            builder_identity(json.loads(read.stdout)[0], identity)
            try:
                delete = subprocess.run(base + ["delete", str(identity["id"]), "--force"], capture_output=True, text=True, timeout=60)
            except subprocess.TimeoutExpired:
                if attempt == 2:
                    raise RuntimeError("guard exact-builder deletion timed out after three attempts") from None
                continue
            if delete.returncode == 0 or "404" in delete.stderr:
                print("GUARD_EXACT_BUILDER_DELETE_ACCEPTED", flush=True)
                return
        time.sleep(5)
    raise RuntimeError("guard deletion failed; exact builder still needs cleanup")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True, type=int)
    parser.add_argument("--name", required=True)
    parser.add_argument("--created-at", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--deadline", required=True, type=float)
    parser.add_argument("--stop-file", required=True)
    args = parser.parse_args()
    expire({"id": args.id, "name": args.name, "created_at": args.created_at}, args.context, args.deadline, args.stop_file)
