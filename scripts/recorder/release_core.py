"""Pure contracts for recorder releases. No credentials or provider calls here."""

import hashlib
import json
import re

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
    allowed = PIN_KEYS | {"CHALK_RECORDER_CAPTURE_PROFILE_EVIDENCE_SHA256", "CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST"}
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


def validate_config(config, environment="production"):
    require(re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", environment) and len(environment) <= 32, "invalid deployment environment")
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
    require(config["runtime"]["parameter_prefix"].startswith(f"/chalk/{environment}/"), "runtime prefix outside selected environment")
    require(config["bootstrap_ca_parameter"].startswith(f"/chalk/{environment}/"), "bootstrap CA outside selected environment")
    if environment == "nightly":
        require(isinstance(config["do_context"], str) and config["do_context"].strip(), "invalid nightly DigitalOcean context")
        require(config["runtime"]["parameter_prefix"] == "/chalk/nightly/managed-episode", "invalid nightly runtime prefix")
        require(config["runtime"]["document_name"] == "chalk-nightly-managed-episode-release", "invalid nightly document")
        require(config["runtime"]["log_group"] == "/chalk/nightly/managed-episode", "invalid nightly log group")
        require(config["bootstrap_server_name"] == "nightly-recording-control.chalkmeet.com", "invalid nightly bootstrap hostname")
        require(config["bootstrap_ca_parameter"].startswith("/chalk/nightly/"), "bootstrap CA outside nightly")
        require(config["dispatcher"]["function_name"] == "chalk-nightly-transcription-dispatcher", "invalid nightly function")
        require(config["dispatcher"]["scheduler_name"] == "chalk-nightly-transcription-reconcile", "invalid nightly schedule")
        require(config["dispatcher"]["scheduler_group"] == "chalk-nightly", "invalid nightly schedule group")
        require(re.fullmatch(r"chalk-nightly-state-[0-9]{12}", config["dispatcher"]["state_bucket"]), "invalid nightly state bucket")
        require(config["dispatcher"]["state_key"] == "transcription/terraform.tfstate", "invalid nightly state key")
    require(re.fullmatch(r"[A-Za-z0-9.-]+", config["bootstrap_server_name"]), "invalid bootstrap server name")
    require(isinstance(config["runtime"]["user_id"], int) and config["runtime"]["user_id"] > 0, "invalid runtime user")
    return config


def check_image(image, worker):
    require(image["status"] == "available", "snapshot is not available")
    require(worker["region"] in image["regions"], "snapshot is unavailable in fleet region")
    require(image["min_disk_size"] <= worker["disk_gb"], "snapshot exceeds fleet minimum disk")


def check_qualification(receipt, state):
    for key in ("role", "source_commit", "release_id", "image_id", "image_digest", "region", "size"):
        require(receipt.get(key) == state.get(key), "qualification identity mismatch: " + key)
    require(receipt.get("result") == "PASS" and receipt.get("fleet_equivalent_signed_boot") is True,
            "BOOTDIAG signed-boot qualification is required before publishing")
