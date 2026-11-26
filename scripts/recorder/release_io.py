"""Provider boundary. Dry runs have an explicit, closed read-only allowlist."""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from release_core import require

AWS_READS = {("ssm", "get-parameter"), ("ssm", "describe-parameters"), ("ssm", "get-document"),
             ("ec2", "describe-instances"), ("ec2", "describe-addresses"), ("scheduler", "get-schedule"),
             ("lambda", "get-function-configuration"), ("s3api", "get-object"), ("s3api", "head-object"),
             ("sts", "get-caller-identity"), ("dynamodb", "get-item")}
DO_READS = {("compute", "image", "get"), ("compute", "size", "list"),
            ("compute", "region", "list"), ("compute", "droplet", "get")}


def private_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
        json.dump(value, output, indent=2)
        output.write("\n")
    temporary.replace(path)


def infrastructure_error_class(stderr):
    # Only fixed labels leave this boundary; diagnostics can contain credentials and IDs.
    text = stderr.lower()
    for label, markers in (
        ("state-lock", ("error acquiring the state lock", "error releasing the state lock", "lease is held", "conditionalcheckfailedexception")),
        ("authentication", ("no valid credential sources", "expiredtoken", "invalidclienttokenid")),
        ("authorization", ("accessdenied", "access denied", "not authorized")),
        ("configuration", ("unsupported argument", "missing required argument", "invalid value for")),
        ("provider-download", ("failed to install provider", "failed to query available provider packages",
                               "could not query provider registry", "could not retrieve the list of available versions")),
        ("network", ("connection refused", "no such host", "tls handshake timeout", "i/o timeout")),
    ):
        if any(marker in text for marker in markers):
            return label
    return "unclassified"


class Provider:
    def __init__(self, region, profile, dry_run=False):
        self.region, self.profile, self.dry_run = region, profile, dry_run
        self.context = None
        self.do_token = None
        self.reads = []

    def command(self, arguments, *, timeout=120, input_text=None, read_only=False, environment=None):
        if self.dry_run:
            require(read_only, "dry-run refused a non-read operation")
        try:
            result = subprocess.run(arguments, input=input_text, text=True, capture_output=True, timeout=timeout,
                                    env={**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off", **(environment or {})})
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"{arguments[0]} operation timed out after {timeout} seconds; no command arguments or payload logged") from None
        if result.returncode:
            # Provider errors can quote secret payloads. Never echo stdout/stderr here.
            error_class = f"; error class: {infrastructure_error_class(result.stderr)}" if arguments[0] in ("tofu", "pnpm") else ""
            raise RuntimeError(f"{arguments[0]} operation failed (exit {result.returncode}){error_class}; no payload logged")
        return result.stdout

    def aws(self, service, operation, *arguments, payload=None, timeout=120):
        read_only = (service, operation) in AWS_READS and payload is None
        command = ["aws", *(["--profile", self.profile] if self.profile else []), "--region", self.region, service, operation, *map(str, arguments)]
        if read_only:
            self.reads.append(service + ":" + operation)
        if payload is None:
            # AWS prints nothing for an empty result, such as a missing DynamoDB item.
            return json.loads(self.command(command + ["--output", "json"], timeout=timeout, read_only=read_only) or "{}")
        with tempfile.TemporaryDirectory(prefix="chalk-release-payload-") as directory:
            path = Path(directory, "payload.json")
            private_json(path, payload)
            return json.loads(self.command(command + ["--cli-input-json", "file://" + str(path), "--output", "json"], timeout=timeout))

    def do(self, *arguments, timeout=120):
        require(self.context, "DigitalOcean context is not configured")
        read_only = tuple(arguments[:3]) in DO_READS
        if read_only:
            self.reads.append("do:" + ":".join(arguments[:3]))
        token = self.do_token or os.environ.get("DIGITALOCEAN_ACCESS_TOKEN")
        return json.loads(self.command(["doctl", *([] if token else ["--context", self.context]), *map(str, arguments), "--output", "json"],
                                       timeout=timeout, read_only=read_only, environment={"DIGITALOCEAN_ACCESS_TOKEN": token} if token else None) or "null")

    def parameter(self, name):
        return self.aws("ssm", "get-parameter", "--name", name, "--with-decryption")["Parameter"]
