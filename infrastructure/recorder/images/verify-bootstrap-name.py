#!/usr/bin/env python3
"""Verify a recorder image's baked TLS name before filling fleet runtime inputs."""

import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--image-digest", required=True)
    parser.add_argument("--bootstrap-endpoint", required=True)
    args = parser.parse_args()

    data = args.manifest.read_bytes()
    if not data or len(data) > 32 << 20:
        parser.error("image manifest is empty or too large")
    digest = "sha256:" + hashlib.sha256(data).hexdigest()
    if digest != args.image_digest:
        parser.error("image manifest digest does not match the fleet image digest")

    try:
        manifest = json.loads(data)
    except json.JSONDecodeError:
        parser.error("image manifest is not valid JSON")
    if not isinstance(manifest, dict):
        parser.error("image manifest must be a JSON object")
    name = manifest.get("bootstrap_server_name")
    ca_digest = manifest.get("bootstrap_ca_sha256")
    if (
        manifest.get("schema_version") != "chalk_recorder_cpu_image.v1"
        or not isinstance(name, str)
        or not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", name)
        or not isinstance(ca_digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", ca_digest)
    ):
        parser.error("image manifest is missing valid bootstrap TLS claims")

    try:
        endpoint = urlsplit(args.bootstrap_endpoint)
        hostname = endpoint.hostname
        endpoint.port
    except ValueError:
        parser.error("bootstrap endpoint is malformed")
    if endpoint.scheme != "https" or not hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        parser.error("bootstrap endpoint must be a plain HTTPS URL")
    if name.lower() != hostname.lower():
        parser.error(f'baked bootstrap server name "{name}" differs from endpoint host "{hostname}"')

    print(f"CHALK_RECORDER_FLEET_BOOTSTRAP_SERVER_NAME={name}")
    print(f"CHALK_RECORDER_FLEET_BOOTSTRAP_NAME_IMAGE_DIGEST={digest}")


if __name__ == "__main__":
    main()
