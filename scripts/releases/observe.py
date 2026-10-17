#!/usr/bin/env python3
"""Read only the served release tuple; never print runtime environment values."""

import argparse
import base64
import json
import os
import subprocess
from pathlib import Path

from github_release import outputs
from release_set import require, validate
from web import verify


def aws(*args, data=None):
    command = ["aws", "--region", os.environ["CHALK_MANAGED_AWS_REGION"], *args, "--output", "json"]
    if data is not None:
        command += ["--cli-input-json", json.dumps(data)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    require(result.returncode == 0, f"AWS read/check failed: {' '.join(args[:2])}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def parameter(name):
    return aws("ssm", "get-parameter", "--name", name, "--with-decryption")["Parameter"]


def values(text):
    return dict(line.split("=", 1) for line in text.splitlines() if line and not line.startswith("#"))


def runtime_check(release_set, target):
    prefix = os.environ["CHALK_MANAGED_PARAMETER_PREFIX"]
    require(prefix == f"/chalk/{target}/managed-episode", "runtime prefix does not match environment")
    expected = release_set["runtime"][target]
    versions = {}
    for role in ("capture", "render"):
        source = parameter(prefix + f"/recorder/{role}.env")
        observed = values(source["Value"])
        member = expected[role]
        pins = {"CHALK_RECORDER_FLEET_IMAGE_ID": member["image_id"], "CHALK_RECORDER_FLEET_RELEASE_ID": member["release_id"],
                "CHALK_RECORDER_FLEET_IMAGE_DIGEST": member["content_sha256"]}
        # Existing worker pins use sha256:<hex>; accept only that equivalent spelling.
        actual_digest = observed.get("CHALK_RECORDER_FLEET_IMAGE_DIGEST", "").removeprefix("sha256:")
        require(actual_digest == member["content_sha256"], f"{role} content differs from frozen member")
        pins.pop("CHALK_RECORDER_FLEET_IMAGE_DIGEST")
        require(all(observed.get(key) == value for key, value in pins.items()), f"{role} pins differ from frozen member")
        if role == "capture":
            require(observed.get("CHALK_RECORDER_CAPTURE_PROFILE_EVIDENCE_SHA256") == member["qualification_sha256"],
                    "capture qualification differs from frozen member")
        versions[role] = source["Version"]
    config = json.loads(parameter(os.environ.get("CHALK_MANAGED_RECORDER_CONFIG_PARAMETER")
                                  or f"/chalk/{target}/release/recorder.json")["Value"])
    require(all(member["bootstrap_server_name"] == config["bootstrap_server_name"]
                for member in (expected["capture"], expected["render"])), "worker bootstrap authority differs")
    function = aws("lambda", "get-function-configuration", "--function-name", config["dispatcher"]["function_name"])
    dispatcher = expected["dispatcher"]
    require(function["CodeSha256"] == base64.b64encode(bytes.fromhex(dispatcher["zip_sha256"])).decode(), "dispatcher code differs")
    require(function["Handler"] == dispatcher["handler"] and function["Runtime"] == dispatcher["runtime"], "dispatcher runtime differs")
    require(function["Environment"]["Variables"].get("CHALK_CONFIG_DIGEST") == dispatcher["config_sha256"], "dispatcher config differs")
    return versions


def host_check(release_set):
    name = os.environ["CHALK_RELEASE_OBSERVER_DOCUMENT_NAME"]
    version = os.environ["CHALK_RELEASE_OBSERVER_DOCUMENT_VERSION"]
    content = aws("ssm", "get-document", "--name", name, "--document-version", version)["Content"]
    expected_document = json.loads((Path(__file__).parent / "observe-document.json").read_text())
    require(json.loads(content) == expected_document, "observer document bytes differ from reviewed contract")
    target = os.environ["RELEASE_TARGET"]
    expected = {"manifest_sha256": release_set["backend"]["sha256"],
                **{role: release_set["runtime"][target][role] for role in ("capture", "render")}}
    command = aws("ssm", "send-command", data={"DocumentName": name, "DocumentVersion": version,
        "InstanceIds": [os.environ["CHALK_MANAGED_INSTANCE_ID"]], "TimeoutSeconds": 120,
        "Parameters": {"ExpectedTupleBase64": [base64.b64encode(json.dumps(expected).encode()).decode()]}})["Command"]["CommandId"]
    result = subprocess.run(["aws", "--region", os.environ["CHALK_MANAGED_AWS_REGION"], "ssm", "wait", "command-executed",
                             "--command-id", command, "--instance-id", os.environ["CHALK_MANAGED_INSTANCE_ID"]],
                            capture_output=True, timeout=150)
    require(result.returncode == 0, "served release observer failed or timed out")
    observed = aws("ssm", "get-command-invocation", "--command-id", command, "--instance-id", os.environ["CHALK_MANAGED_INSTANCE_ID"])
    require(observed["Status"] == "Success" and observed["StandardOutputContent"].strip() == "CHALK_RELEASE_MATCH", "served backend differs")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--target", required=True, choices=("nightly", "production"))
    parser.add_argument("--release-set", type=Path, required=True)
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    os.environ["RELEASE_TARGET"] = args.target
    release_set = validate(json.loads(args.release_set.read_text()))
    versions = runtime_check(release_set, args.target)
    if not args.preflight:
        host_check(release_set)
        verify(args.target, args.release_set)
        outputs({"served_matches": True})
    print(json.dumps({"runtime_parameter_versions": versions, "preflight": args.preflight}))
