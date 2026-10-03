#!/usr/bin/env python3
"""Carry the approved API binding forward without rebuilding dispatcher code."""

import argparse
import copy
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import quote

from release_core import PREFIX, digest, rebuild_dispatcher, require
from release_io import Provider, private_json

MODULE = Path(__file__).resolve().parents[2] / "infrastructure/opentofu/modules/aws-transcription-dispatcher"


def binding_target(manifest):
    release = manifest["component_releases"]["api"]["release_id"]
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{7,127}", release) and "latest" not in release.lower(), "invalid API release binding")
    return release


def check_binding(function, release, code_hash):
    require(function["State"] == "Active" and function["LastUpdateStatus"] == "Successful", "dispatcher update is not healthy")
    require(function["Environment"]["Variables"]["CHALK_RELEASE_ID"] == release, "dispatcher runtime release binding mismatch")
    require(function["CodeSha256"] == code_hash, "dispatcher ZIP digest changed")


def has_unknown(value):
    if isinstance(value, dict):
        return any(has_unknown(child) for child in value.values())
    if isinstance(value, list):
        return any(has_unknown(child) for child in value)
    return value is True


def check_binding_plan(plan, release, key, version):
    for item in plan.get("resource_changes", []):
        change = item["change"]
        if change["actions"] in (["no-op"], ["read"]):
            continue
        require(change["actions"] == ["update"], "binding plan must not create, delete or replace resources")
        expected = copy.deepcopy(change["before"])
        address = item["address"]
        require(address in ("module.dispatcher.aws_lambda_function.dispatcher", "module.dispatcher.aws_cloudwatch_log_group.dispatcher"),
                "binding plan exceeds resource allowlist")
        for tag in ("tags", "tags_all"):
            expected[tag]["chalk_release_id"] = release
        if address.endswith("aws_lambda_function.dispatcher"):
            expected["environment"][0]["variables"]["CHALK_RELEASE_ID"] = release
            expected.update(s3_key=key, s3_object_version=version, description=f"Track-aware transcription dispatcher ({release})")
        # These provider-computed fields change when identical code is selected under a new key.
        computed = {"last_modified", "qualified_arn", "qualified_invoke_arn", "version"}
        unknown = change.get("after_unknown", {})
        require(all(name in computed or not has_unknown(value) for name, value in unknown.items()), "unexpected unknown binding plan field")
        actual = copy.deepcopy(change["after"])
        for name in computed:
            expected.pop(name, None)
            actual.pop(name, None)
        require(expected == actual, "binding plan changes more than release identity")


def dispatcher_root(provider, config):
    root = rebuild_dispatcher(provider.state(config), MODULE, config, provider.region, provider.profile)
    if not provider.profile:
        root["provider"]["aws"].pop("profile", None)
        root["terraform"]["backend"]["s3"].pop("profile", None)
    inputs = root["module"]["dispatcher"]
    require(inputs["function_name"] == config["function_name"], "dispatcher state identity mismatch")
    return root


def verify_dispatcher(provider, config, release):
    root = dispatcher_root(provider, config)
    inputs = root["module"]["dispatcher"]
    require(inputs["release_id"] == release, "dispatcher state release binding mismatch")
    function = provider.aws("lambda", "get-function-configuration", "--function-name", config["function_name"])
    check_binding(function, release, inputs["artifact_sha256_base64"])
    return {"release_id": release, "verified": True}


def bind(provider, config, manifest, dry_run):
    release = binding_target(manifest)
    root = dispatcher_root(provider, config)
    inputs = root["module"]["dispatcher"]
    function = provider.aws("lambda", "get-function-configuration", "--function-name", config["function_name"])
    check_binding(function, inputs["release_id"], inputs["artifact_sha256_base64"])
    proof = {"action": "already-bound" if inputs["release_id"] == release else "rebind", "release_id": release,
             "previous_release_id": inputs["release_id"], "artifact_sha256": inputs["artifact_sha256"],
             "artifact_action": "copy unchanged ZIP to versioned release key", "verified": False}
    if dry_run:
        return proof
    with tempfile.TemporaryDirectory(prefix="chalk-dispatcher-binding-") as directory:
        directory = Path(directory)
        path = directory / "main.tf.json"
        private_json(path, root)
        (directory / ".terraform.lock.hcl").write_bytes((MODULE / ".terraform.lock.hcl").read_bytes())

        def tofu(*arguments):
            return provider.command(["tofu", "-chdir=" + str(directory), *arguments], timeout=600)

        tofu("init", "-input=false", "-upgrade=false")
        tofu("plan", "-input=false", "-detailed-exitcode", "-no-color")
        if inputs["release_id"] != release:
            bucket = inputs["artifact_s3_bucket"]
            old_key, old_version = inputs["artifact_s3_key"], inputs["artifact_s3_object_version"]
            require(old_version and old_version != "null", "dispatcher ZIP must be version-pinned")
            archive = directory / "dispatcher.zip"
            provider.aws("s3api", "get-object", "--bucket", bucket, "--key", old_key, "--version-id", old_version, archive)
            require(digest(archive.read_bytes()) == inputs["artifact_sha256"], "source dispatcher ZIP digest mismatch")
            key = f"transcription-dispatcher/{release}/{inputs['artifact_sha256']}.zip"
            source = quote(bucket + "/" + old_key, safe="/") + "?versionId=" + quote(old_version, safe="")
            copied = provider.aws("s3api", "copy-object", "--bucket", bucket, "--key", key, "--copy-source", source)
            version = copied.get("VersionId")
            require(version and version != "null", "dispatcher destination bucket must have versioning enabled")
            inputs.update(release_id=release, artifact_s3_key=key, artifact_s3_object_version=version)
            private_json(path, root)
            tofu("plan", "-input=false", "-no-color", "-out=binding.plan")
            check_binding_plan(json.loads(tofu("show", "-json", "binding.plan")), release, key, version)
            tofu("apply", "-input=false", "-no-color", "binding.plan")
        proof.update(verify_dispatcher(provider, config, release))
    return proof


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--parameter-prefix", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    provider = Provider(args.region, os.environ.get("AWS_PROFILE"), args.dry_run)
    config = json.loads(provider.parameter(PREFIX + "recorder.json")["Value"])
    require(config["runtime"]["instance_id"] == args.instance_id and config["runtime"]["parameter_prefix"] == args.parameter_prefix,
            "dispatcher configuration does not belong to the target managed runtime")
    print(json.dumps(bind(provider, config["dispatcher"], json.loads(Path(args.manifest).read_text()), args.dry_run)))


if __name__ == "__main__":
    main()
