"""Validate the immutable release boundary. Never infer missing runtime members."""

import hashlib
import json
from datetime import datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "scripts/releases/release-set.schema.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(value):
    schema = json.loads(SCHEMA.read_text())
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(value))
    require(not errors, "invalid release-set schema" + (": " + ".".join(map(str, errors[0].absolute_path)) if errors else ""))
    require(datetime.fromisoformat(value["created_at"].replace("Z", "+00:00")).tzinfo is not None, "creation time must have timezone")
    require(value["web"]["nightly"]["config"]["environment"] == "nightly", "nightly web config mismatch")
    require(value["web"]["production"]["config"]["environment"] == "production", "production web config mismatch")
    for member in value["web"].values():
        require(member["config"]["commit"] == value["target_sha"], "web commit mismatch")
        require(member["config_sha256"] == digest(canonical(member["config"])), "web config fingerprint mismatch")
    return value


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_manifest(release_set, data):
    require(digest(data) == release_set["backend"]["sha256"], "backend manifest checksum mismatch")
    manifest = json.loads(data)
    require(manifest["source_revision"] == release_set["target_sha"], "backend source mismatch")
    require(manifest["release_id"] == release_set["release_id"], "backend release mismatch")
    require(manifest["component_releases"] == release_set["backend"]["components"], "component identities mismatch")
    require(manifest["source_tree_state"] == "clean", "dirty backend manifest")
    return manifest
