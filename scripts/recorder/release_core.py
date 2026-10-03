"""Pure contracts for recorder releases. No credentials or provider calls here."""

import base64
import hashlib
import json
import re
from pathlib import Path

PHASES = ("plan", "build", "qualify", "snapshot", "publish-pins", "deploy", "verify")
PREFIX = "/chalk/production/release/"
PIN_KEYS = {"CHALK_RECORDER_FLEET_" + key for key in ("IMAGE_ID", "RELEASE_ID", "IMAGE_DIGEST")}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def env_values(text):
    values = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        require("=" in line, "malformed environment input")
        key, value = line.split("=", 1)
        require(re.fullmatch(r"[A-Z][A-Z0-9_]*", key), "invalid environment key")
        require(key not in values, "duplicate environment key: " + key)
        values[key] = value
    return values


def replace_pins(text, updates):
    before = env_values(text)
    allowed = PIN_KEYS | {"CHALK_RECORDER_CAPTURE_PROFILE_EVIDENCE_SHA256"}
    require(set(updates) <= allowed and set(updates) <= set(before), "pin update exceeds allowlist")
    lines = []
    for line in text.splitlines(keepends=True):
        key = line.split("=", 1)[0]
        if key in updates:
            ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            line = key + "=" + updates[key] + ending
        lines.append(line)
    result = "".join(lines)
    require({k for k, v in env_values(result).items() if before[k] != v} <= set(updates), "unrelated input changed")
    return result


def check_fresh(parameter, receipt):
    require(parameter["Version"] == receipt["before_version"] and digest(parameter["Value"]) == receipt["before_sha256"],
            "SSM inputs changed since plan; start a fresh plan")


def validate_config(config):
    require(config["schema_version"] == 1, "unsupported release configuration")
    sections = {
        "builder": {"region", "size", "image", "ttl_seconds", "ssh_cidr"},
        "worker": {"region", "size", "disk_gb"},
        "runtime": {"instance_id", "parameter_prefix", "document_name", "log_group", "user_id"},
        "dispatcher": {"state_bucket", "state_key", "function_name", "scheduler_name", "scheduler_group"},
    }
    require(set(config) == {"schema_version", "do_context", "bootstrap_ca_parameter", "bootstrap_server_name", *sections},
            "unknown or missing release configuration field (secrets do not belong here)")
    for section, keys in sections.items():
        require(set(config[section]) == keys, "invalid " + section + " configuration fields")
    require(600 <= config["builder"]["ttl_seconds"] <= 7200, "builder lifetime must be 600–7200 seconds")
    require(config["worker"]["disk_gb"] > 0, "worker disk must be positive")
    import ipaddress
    ipaddress.ip_network(config["builder"]["ssh_cidr"], strict=True)
    require(re.fullmatch(r"i-[0-9a-f]{8,17}", config["runtime"]["instance_id"]), "invalid runtime instance")
    require(config["runtime"]["parameter_prefix"].startswith("/chalk/production/"), "runtime prefix outside production")
    require(re.fullmatch(r"[A-Za-z0-9.-]+", config["bootstrap_server_name"]), "invalid bootstrap server name")
    require(isinstance(config["runtime"]["user_id"], int) and config["runtime"]["user_id"] > 0, "invalid runtime user")
    return config


def check_image(image, worker):
    require(image["status"] == "available", "snapshot is not available")
    require(worker["region"] in image["regions"], "snapshot is unavailable in fleet region")
    require(image["min_disk_size"] <= worker["disk_gb"], "snapshot exceeds fleet minimum disk")


def check_qualification(receipt, state):
    for key in ("role", "source_commit", "release_id", "image_id", "image_digest"):
        require(receipt.get(key) == state.get(key), "qualification identity mismatch: " + key)
    require(receipt.get("result") == "PASS" and receipt.get("fleet_equivalent_signed_boot") is True,
            "BOOTDIAG signed-boot qualification is required before publishing")


def builder_identity(droplet, identity):
    require(str(droplet["id"]) == str(identity["id"]) and droplet["name"] == identity["name"]
            and droplet["created_at"] == identity["created_at"], "refusing to touch an unowned Droplet")


def sealed_result(output, source, release, role):
    require("SEALED_READONLY_VERIFICATION_PASS" in output.splitlines(), "builder did not finish sealing")
    manifests = [line.removeprefix("CHALK_RELEASE_MANIFEST ") for line in output.splitlines()
                 if line.startswith("CHALK_RELEASE_MANIFEST ")]
    require(len(manifests) == 1, "missing or ambiguous sealed manifest")
    raw = base64.b64decode(manifests[0], validate=True)
    manifest = json.loads(raw)
    require(manifest["source_commit"] == source and manifest["release_id"] == release, "sealed source identity mismatch")
    require(manifest["profile"] == ("capture-minimal-v1" if role == "capture" else "cpu-libx264-frame2"), "sealed profile mismatch")
    return raw, "sha256:" + digest(raw)


def rebuild_dispatcher(state, module, backend, region, profile):
    resources = {}
    for resource in state["resources"]:
        if resource.get("mode", "managed") == "managed":
            key = resource["type"] + "." + resource["name"]
            require(key not in resources, "ambiguous dispatcher resource: " + key)
            require(len(resource["instances"]) == 1, "ambiguous dispatcher instance")
            resources[key] = resource["instances"][0]["attributes"]
    function = resources["aws_lambda_function.dispatcher"]
    environment = function["environment"][0]["variables"]
    main = Path(module, "main.tf").read_text()
    variables = Path(module, "variables.tf").read_text()
    inputs = {}
    for key, name in re.findall(r"^\s*([A-Z_]+)\s*=\s*(?:tostring\()?var\.([a-z_]+)", main, re.M):
        if key not in environment:
            continue
        value = environment[key]
        section = variables.split('variable "' + name + '" {', 1)[1].split("\nvariable ", 1)[0]
        if re.search(r"type\s*=\s*bool", section):
            require(value in ("true", "false"), "invalid dispatcher boolean")
            value = value == "true"
        elif re.search(r"type\s*=\s*number", section):
            value = int(value)
        inputs[name] = value
    schedule = resources["aws_scheduler_schedule.reconcile"]
    target = schedule["target"][0]
    retry = target["retry_policy"][0]
    invoke = resources["aws_lambda_function_event_invoke_config.dispatcher"]
    inputs.update(function_name=function["function_name"], artifact_s3_bucket=function["s3_bucket"],
                  artifact_s3_key=function["s3_key"], artifact_s3_object_version=function["s3_object_version"],
                  artifact_sha256=base64.b64decode(function["source_code_hash"]).hex(),
                  artifact_sha256_base64=function["source_code_hash"], handler=function["handler"],
                  timeout_seconds=function["timeout"], memory_size=function["memory_size"],
                  ephemeral_storage_size=function["ephemeral_storage"][0]["size"],
                  reserved_concurrency=function["reserved_concurrent_executions"], scheduler_name=schedule["name"],
                  scheduler_group_name=schedule["group_name"], scheduler_state=schedule["state"], scheduler_input_json=target["input"],
                  scheduler_max_event_age_seconds=retry["maximum_event_age_in_seconds"],
                  scheduler_maximum_retry_attempts=retry["maximum_retry_attempts"],
                  async_max_event_age_seconds=invoke["maximum_event_age_in_seconds"],
                  async_maximum_retry_attempts=invoke["maximum_retry_attempts"],
                  log_retention_days=resources["aws_cloudwatch_log_group.dispatcher"]["retention_in_days"],
                  log_kms_key_arn=resources["aws_cloudwatch_log_group.dispatcher"]["kms_key_id"] or None,
                  failure_queue_kms_key_arn=resources["aws_sqs_queue.async_failure"]["kms_master_key_id"] or None,
                  alarm_actions=resources["aws_cloudwatch_metric_alarm.errors"]["alarm_actions"])
    policy = json.loads(resources["aws_iam_role_policy.dispatcher"]["policy"])
    inputs["ssm_kms_key_arns"] = sorted({arn for statement in policy["Statement"]
                                         for arn in ([statement["Resource"]] if isinstance(statement["Resource"], str) else statement["Resource"])
                                         if ":kms:" in arn})
    return {"terraform": {"required_providers": {"aws": {"source": "hashicorp/aws", "version": "~> 5.0"}},
                          "backend": {"s3": {"bucket": backend["state_bucket"], "key": backend["state_key"],
                                             "region": region, "profile": profile, "encrypt": True, "use_lockfile": True}}},
            "provider": {"aws": {"region": region, "profile": profile}},
            "module": {"dispatcher": {"source": str(module), **inputs}},
            "output": {key: {"value": "${module.dispatcher." + key + "}", "sensitive": value.get("sensitive", False)}
                       for key, value in state["outputs"].items()}}


def scheduler_changes(plan, desired):
    changes = [item for item in plan.get("resource_changes", []) if item["change"]["actions"] not in (["no-op"], ["read"])]
    require(len(changes) == 1, "scheduler plan must change exactly one resource")
    change = changes[0]
    require(change["address"] == "module.dispatcher.aws_scheduler_schedule.reconcile"
            and change["change"]["actions"] == ["update"], "scheduler plan exceeds allowlist")
    before, after = change["change"]["before"], change["change"]["after"]
    require(after["state"] == desired and {k: v for k, v in before.items() if k != "state"}
            == {k: v for k, v in after.items() if k != "state"}, "scheduler plan changes more than state")
