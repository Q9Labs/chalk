"""Provider boundary. Dry runs have an explicit, closed read-only allowlist."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from release_core import require

AWS_READS = {("ssm", "get-parameter"), ("ssm", "describe-parameters"), ("ssm", "get-document"),
             ("ec2", "describe-instances"), ("scheduler", "get-schedule"),
             ("lambda", "get-function-configuration"), ("s3api", "get-object"),
             ("sts", "get-caller-identity")}
DO_READS = {("compute", "image", "get"), ("compute", "size", "list"),
            ("compute", "region", "list"), ("compute", "droplet", "get")}


def private_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        json.dump(value, output, indent=2)
        output.write("\n")
    temporary.replace(path)


class Provider:
    def __init__(self, region, profile, dry_run=False):
        self.region, self.profile, self.dry_run = region, profile, dry_run
        self.context = None
        self.reads = []

    def command(self, arguments, *, timeout=120, input_text=None, read_only=False):
        if self.dry_run:
            require(read_only, "dry-run refused a non-read operation")
        result = subprocess.run(arguments, input=input_text, text=True, capture_output=True, timeout=timeout,
                                env={**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"})
        if result.returncode:
            # Provider errors can quote secret payloads. Never echo stdout/stderr here.
            raise RuntimeError(f"{arguments[0]} operation failed (exit {result.returncode}); no payload logged")
        return result.stdout

    def aws(self, service, operation, *arguments, payload=None, timeout=120):
        read_only = (service, operation) in AWS_READS and payload is None
        command = ["aws", "--profile", self.profile, "--region", self.region, service, operation, *map(str, arguments)]
        if read_only:
            self.reads.append(service + ":" + operation)
        if payload is None:
            return json.loads(self.command(command + ["--output", "json"], timeout=timeout, read_only=read_only))
        with tempfile.TemporaryDirectory(prefix="chalk-release-payload-") as directory:
            path = Path(directory, "payload.json")
            private_json(path, payload)
            return json.loads(self.command(command + ["--cli-input-json", "file://" + str(path), "--output", "json"], timeout=timeout))

    def do(self, *arguments, timeout=120):
        require(self.context, "DigitalOcean context is not configured")
        read_only = tuple(arguments[:3]) in DO_READS
        if read_only:
            self.reads.append("do:" + ":".join(arguments[:3]))
        return json.loads(self.command(["doctl", "--context", self.context, *map(str, arguments), "--output", "json"],
                                       timeout=timeout, read_only=read_only) or "null")

    def parameter(self, name):
        return self.aws("ssm", "get-parameter", "--name", name, "--with-decryption")["Parameter"]

    def state(self, config):
        with tempfile.TemporaryDirectory(prefix="chalk-release-state-") as directory:
            path = Path(directory, "state.json")
            self.aws("s3api", "get-object", "--bucket", config["state_bucket"], "--key", config["state_key"], path)
            path.chmod(0o600)
            return json.loads(path.read_text())
