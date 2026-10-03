#!/usr/bin/env python3
"""Static/runtime-user image checks. Not a substitute for BOOTDIAG signed boot."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def qualify(role, source, release, expected_digest):
    raw = Path("/opt/chalk-recorder/image-manifest.json").read_bytes()
    manifest = json.loads(raw)
    require("sha256:" + hashlib.sha256(raw).hexdigest() == expected_digest, "image digest mismatch")
    require(manifest["source_commit"] == source and manifest["release_id"] == release, "image source mismatch")
    for entry in manifest["files"]:
        path = Path(entry["path"])
        require(path.is_absolute() and ".." not in path.parts and path.parts[1] in ("etc", "opt", "usr"), "invalid manifest path")
        content = os.readlink(path).encode() if entry["type"] == "symlink" else path.read_bytes()
        require(hashlib.sha256(content).hexdigest() == entry["sha256"], "image file digest mismatch")
    name = manifest["bootstrap_server_name"]
    tls = subprocess.run(["openssl", "s_client", "-connect", name + ":8444", "-servername", name,
                          "-verify_hostname", name, "-CAfile", "/etc/chalk-recorder/bootstrap-ca.pem"],
                         input="", capture_output=True, text=True, timeout=40)
    require("Verify return code: 0 (ok)" in tls.stdout + tls.stderr, "bootstrap TLS validation failed")
    user = ["setpriv", "--reuid", "chalk-recorder", "--regid", "chalk-recorder", "--clear-groups"]
    worker = "/opt/chalk-recorder/current/bin/recorder-" + role
    subprocess.run(user + ["test", "-x", worker], check=True)
    if role == "render":
        subprocess.run(user + ["test", "-r", "/opt/chalk-recorder/current/renderer/dist/node/compose.js"], check=True)
    subprocess.run(user + [worker, "--help"], check=True, stdout=subprocess.DEVNULL, timeout=20)
    print(json.dumps({"result": "PASS", "manifest_files_verified": len(manifest["files"]), "tls_verified": True,
                      "runtime_user_execution": True, "fleet_equivalent_signed_boot": False}))


if __name__ == "__main__":
    qualify(*sys.argv[1:])
