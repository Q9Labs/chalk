#!/usr/bin/env python3
"""Static/runtime-user image checks. Not a substitute for BOOTDIAG signed boot."""

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def qualify(role, source, release, expected_digest, *, validate_only=False, root=Path('/')):
    require(validate_only or root == Path('/'), "alternate root is validation-only")
    raw = (root / "opt/chalk-recorder/image-manifest.json").read_bytes()
    manifest = json.loads(raw)
    require("sha256:" + hashlib.sha256(raw).hexdigest() == expected_digest, "image digest mismatch")
    require(manifest["source_commit"] == source and manifest["release_id"] == release, "image source mismatch")
    for entry in manifest["files"]:
        path = Path(entry["path"])
        require(path.is_absolute() and ".." not in path.parts and path.parts[1] in ("etc", "opt", "usr"), "invalid manifest path")
        local_path = root.joinpath(*path.parts[1:])
        content = os.readlink(local_path).encode() if entry["type"] == "symlink" else local_path.read_bytes()
        require(hashlib.sha256(content).hexdigest() == entry["sha256"], "image file digest mismatch")
    if validate_only:
        print(json.dumps({"result": "PASS", "manifest_files_verified": len(manifest["files"]), "validation_only": True,
                          "runtime_user_execution": False, "fleet_equivalent_signed_boot": False}))
        return
    user = ["setpriv", "--reuid", "chalk-recorder", "--regid", "chalk-recorder", "--clear-groups"]
    worker = "/opt/chalk-recorder/current/bin/recorder-" + role
    subprocess.run(user + ["test", "-x", worker], check=True)
    if role == "render":
        subprocess.run(user + ["test", "-r", "/opt/chalk-recorder/current/renderer/dist/node/compose.js"], check=True)
    subprocess.run(user + [worker, "--help"], check=True, stdout=subprocess.DEVNULL, timeout=20)
    print(json.dumps({"result": "PASS", "manifest_files_verified": len(manifest["files"]), "portable_trust": manifest["schema_version"] == "chalk_recorder_cpu_image.v2",
                      "runtime_user_execution": True, "fleet_equivalent_signed_boot": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('role', choices=('capture', 'render'))
    parser.add_argument('source')
    parser.add_argument('release')
    parser.add_argument('expected_digest')
    parser.add_argument('--validate', action='store_true', help='verify image bytes without running the worker')
    parser.add_argument('--root', type=Path, default=Path('/'), help='image filesystem root; validation-only when not /')
    args = parser.parse_args()
    qualify(args.role, args.source, args.release, args.expected_digest, validate_only=args.validate, root=args.root)
