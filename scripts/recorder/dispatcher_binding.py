#!/usr/bin/env python3
"""Carry the approved API binding forward without rebuilding dispatcher code."""

import argparse
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import quote

from release_core import digest, require, validate_config
from alchemy_dispatcher import read_inputs, run_plan, check_plan as check_alchemy_plan
from release_io import Provider


def binding_target(manifest):
    release = manifest["component_releases"]["api"]["release_id"]
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{7,127}", release) and "latest" not in release.lower(), "invalid API release binding")
    return release


def check_binding(function, release, code_hash):
    require(function["State"] == "Active" and function["LastUpdateStatus"] == "Successful", "dispatcher update is not healthy")
    require(function["Environment"]["Variables"]["CHALK_RELEASE_ID"] == release, "dispatcher runtime release binding mismatch")
    require(function["CodeSha256"] == code_hash, "dispatcher ZIP digest changed")


def check_binding_plan(plan, release, key, version, config_digest=None):
    def logs(before):
        before['tags']['chalk_release_id'] = release
    def function(before):
        logs(before)
        before['environment']['CHALK_RELEASE_ID'] = release
        if config_digest:
            before['environment']['CHALK_CONFIG_DIGEST'] = config_digest
            before['tags']['chalk_config_digest'] = config_digest
        before['code'].update(key=key, version=version)
        before['description'] = f'Track-aware transcription dispatcher ({release})'
    check_alchemy_plan(plan, {'Function': function, 'Logs': logs}, {'artifact_identity', 'release_identity'})


def dispatcher_inputs(provider, config):
    inputs = read_inputs(provider, config)
    if config['function_name'] == 'chalk-nightly-transcription-dispatcher':
        require(inputs['environment_name'] == 'nightly', 'nightly dispatcher state environment mismatch')
        require(inputs['control_api_url'] == 'https://nightly-api.chalkmeet.com', 'nightly dispatcher API mismatch')
        require(inputs['control_api_audience'] == 'chalk-nightly-control-api', 'nightly dispatcher audience mismatch')
        require(inputs['scheduler_name'] == 'chalk-nightly-transcription-reconcile' and inputs['scheduler_group_name'] == 'chalk-nightly', 'nightly dispatcher scheduler mismatch')
    return inputs


def verify_dispatcher(provider, config, release):
    inputs = dispatcher_inputs(provider, config)
    # Legacy recorder states have no API identity. The host verifier still
    # compares this observed binding to its loaded API and approved manifest.
    release = release or inputs["release_id"]
    require(inputs["release_id"] == release, "dispatcher state release binding mismatch")
    function = provider.aws("lambda", "get-function-configuration", "--function-name", config["function_name"])
    check_binding(function, release, inputs["artifact_sha256_base64"])
    return {"release_id": release, "verified": True}


def bind(provider, config, manifest, dry_run):
    release = binding_target(manifest)
    inputs = dispatcher_inputs(provider, config)
    function = provider.aws("lambda", "get-function-configuration", "--function-name", config["function_name"])
    check_binding(function, inputs["release_id"], inputs["artifact_sha256_base64"])
    proof = {"action": "already-bound" if inputs["release_id"] == release else "rebind", "release_id": release,
             "previous_release_id": inputs["release_id"], "artifact_sha256": inputs["artifact_sha256"],
             "artifact_action": "retain current versioned ZIP" if inputs["release_id"] == release else "copy unchanged ZIP to versioned release key",
             "verified": False}
    if dry_run:
        run_plan(provider, inputs, lambda plan: check_binding_plan(plan, inputs['release_id'], inputs['artifact_s3_key'], inputs['artifact_s3_object_version']))
        return proof
    with tempfile.TemporaryDirectory(prefix="chalk-dispatcher-binding-") as directory:
        directory = Path(directory)
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
            environment = {**function["Environment"]["Variables"], "CHALK_RELEASE_ID": release}
            environment.pop("CHALK_CONFIG_DIGEST", None)
            config_digest = "sha256:" + digest(json.dumps(environment, sort_keys=True, separators=(",", ":")))
            inputs.update(release_id=release, artifact_s3_key=key, artifact_s3_object_version=version, config_digest=config_digest)
            run_plan(provider, inputs, lambda plan: check_binding_plan(plan, release, key, version, config_digest), apply=True,
                     allowed_inputs={'release_id', 'artifact_s3_key', 'artifact_s3_object_version', 'config_digest'})
        proof.update(verify_dispatcher(provider, config, release))
    return proof


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--parameter-prefix", required=True)
    parser.add_argument("--configuration-parameter", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    provider = Provider(args.region, os.environ.get("AWS_PROFILE"), args.dry_run)
    match = re.fullmatch(r"/chalk/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/release/[A-Za-z0-9_.-]+", args.configuration_parameter)
    require(match, "configuration parameter must select a deployment environment")
    config = validate_config(json.loads(provider.parameter(args.configuration_parameter)["Value"]), match[1])
    require(config["runtime"]["instance_id"] == args.instance_id and config["runtime"]["parameter_prefix"] == args.parameter_prefix,
            "dispatcher configuration does not belong to the target managed runtime")
    print(json.dumps(bind(provider, config["dispatcher"], json.loads(Path(args.manifest).read_text()), args.dry_run)))


if __name__ == "__main__":
    main()
