#!/usr/bin/env python3
"""Read-only host verifier. Invoked by release.py, with non-secret expectations."""

import base64
import json
import subprocess
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def verify(options):
    manifest = json.loads(Path("/run/chalk/release/release-manifest.json").read_text())
    active = json.loads(Path("/var/lib/chalk/deployment-controller/active-release.json").read_text())
    require(active["release_id"] == manifest["release_id"], "active manifest mismatch")
    for key in ("release_id", "source_revision"):
        if key in options:
            require(manifest[key] == options[key], "unexpected managed " + key)
    uid = str(options["user_id"])
    user = ["sudo", "-u", "#" + uid, "env", "XDG_RUNTIME_DIR=/run/user/" + uid]
    subprocess.run(user + ["/usr/local/libexec/chalk-runtime-health"], check=True, stdout=subprocess.DEVNULL)

    def configured(suffix):
        parameter = json.loads(subprocess.check_output(["aws", "--region", options["region"], "ssm", "get-parameter",
                                                       "--name", options["parameter_prefix"] + "/" + suffix,
                                                       "--with-decryption", "--output", "json"]))["Parameter"]
        values = {}
        for line in parameter["Value"].splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                require(key not in values, "duplicate configured input")
                values[key] = value
        return values

    def loaded(name, image):
        inspected = json.loads(subprocess.check_output(user + ["podman", "inspect", name]))[0]
        require(inspected["State"]["Running"] and inspected["Config"]["Image"] == image, name + " image/state mismatch")
        values = {}
        for entry in Path("/proc/" + str(inspected["State"]["Pid"]) + "/environ").read_bytes().split(b"\0"):
            if b"=" in entry:
                key, value = entry.split(b"=", 1)
                values[key.decode()] = value.decode()
        return values

    api_config = configured("api.env")
    api = loaded("chalk-api", manifest["images"]["api"])
    require(api["CHALK_API_VERSION"] == manifest["component_releases"]["api"]["release_id"], "API component identity mismatch")
    require(api["CHALK_API_VERSION"] == options["dispatcher_release_id"], "dispatcher/API loaded release binding mismatch")
    for key in ("CHALK_RECORDING_UI_BUILD_SHA256", "CHALK_RECORDING_BUNDLE_V2_ENABLED"):
        require(api.get(key) == api_config.get(key), "API loaded input mismatch: " + key)
    sync = loaded("chalk-sync", manifest["images"]["sync"])
    require(sync["CHALK_SYNC_RELEASE_ID"] == manifest["component_releases"]["sync"]["release_id"], "Sync component identity mismatch")
    require(sync["CHALK_SYNC_SOURCE_COMMIT"] == manifest["component_releases"]["sync"]["source_revision"], "Sync source mismatch")
    for role in ("capture", "render", "issuer"):
        config = configured("recorder/" + role + ".env")
        actual = loaded("chalk-recorder-" + role, manifest["images"]["recorder_control"])
        for key, value in config.items():
            if key.startswith("CHALK_RECORDER_"):
                require(actual.get(key) == value, role + " loaded input mismatch: " + key)
        if role in options.get("pins", {}):
            for key, value in options["pins"][role].items():
                require(config.get(key) == value, "unexpected published pin: " + key)
    print(json.dumps({"result": "PASS", "loaded_inputs_match": True, "dispatcher_binding_matches": True, "release_id": manifest["release_id"],
                      "source_revision": manifest["source_revision"]}))


if __name__ == "__main__":
    verify(json.loads(base64.b64decode(sys.argv[1], validate=True)))
