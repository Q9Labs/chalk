#!/usr/bin/env python3
"""Resumable recorder release phases; production identities come from SSM."""

import argparse
import base64
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from release_core import (PHASES, PREFIX, PIN_KEYS, builder_identity, check_fresh, check_image,
                          check_qualification, digest, env_values, rebuild_dispatcher, require,
                          replace_pins, scheduler_changes, sealed_result, validate_config)
from release_io import Provider, private_json

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent.parent


def parse_args(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=PHASES)
    parser.add_argument("--dry-run", action="store_true", help="read production metadata only; plan covers all phases")
    parser.add_argument("--region", default=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"))
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE"))
    parser.add_argument("--config-parameter", default=PREFIX + "recorder.json")
    parser.add_argument("--role", choices=("capture", "render"), default="render")
    parser.add_argument("--source", help="exact 40-character public Git commit; defaults to this checkout HEAD")
    parser.add_argument("--state", help="private release directory outside the checkout; required for real phases")
    parser.add_argument("--boot-check", help="BOOTDIAG executable: --request <json> --receipt <json>")
    parser.add_argument("--managed-manifest", help="canonical managed release manifest for the input reload")
    parser.add_argument("--build-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(arguments)
    require(args.region and args.profile, "set AWS_REGION and AWS_PROFILE (or pass --region and --profile)")
    require(args.config_parameter.startswith(PREFIX) and ".." not in args.config_parameter, "configuration must be under " + PREFIX)
    require(args.dry_run or args.state, "real phases require --state outside the checkout")
    if args.source:
        require(re.fullmatch(r"[0-9a-f]{40}", args.source), "--source must be an exact 40-character commit")
    return args


class Release:
    def __init__(self, args):
        self.args = args
        self.provider = Provider(args.region, args.profile, args.dry_run)
        parameter = self.provider.parameter(args.config_parameter)
        require(parameter["Type"] == "String", "release configuration must be a non-secret String")
        self.config = validate_config(json.loads(parameter["Value"]))
        self.config_version = parameter["Version"]
        self.config_digest = digest(parameter["Value"])
        self.provider.context = self.config["do_context"]
        self.directory = None
        self.state = {}
        if args.state:
            path = Path(args.state).expanduser()
            require(not path.is_symlink(), "release state cannot be a symlink")
            path = path.resolve()
            require(not path.is_relative_to(REPO), "release state must be outside the checkout")
            self.directory = path
            if (path / "release.json").exists():
                self.state = json.loads((path / "release.json").read_text())
                require(self.state["config_sha256"] == self.config_digest, "release configuration changed; start a new plan")
                require(self.state["role"] == args.role, "release role differs from saved plan")
                require(not args.source or self.state["source_commit"] == args.source, "source differs from saved plan")

    def save(self):
        require(not self.args.dry_run, "dry-run cannot persist a release")
        private_json(self.directory / "release.json", self.state)

    def identity(self):
        source = self.args.source or subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()
        require(re.fullmatch(r"[0-9a-f]{40}", source), "source is not an exact Git commit")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return {"role": self.args.role, "source_commit": source,
                "release_id": f"recorder-{self.args.role}-{stamp.lower()}-{source[:8]}-{uuid.uuid4().hex[:8]}",
                "config_sha256": self.config_digest, "config_version": self.config_version}

    def read_production(self):
        configured = {}
        pins = {}
        for role in ("capture", "render"):
            parameter = self.provider.parameter(self.parameter_name(role))
            values = env_values(parameter["Value"])
            worker = self.config["worker"]
            require(values["CHALK_RECORDER_FLEET_SIZE"] == worker["size"] and
                    values["CHALK_RECORDER_FLEET_REGION"] == worker["region"], "fleet shape differs from release configuration")
            image_id = values["CHALK_RECORDER_FLEET_IMAGE_ID"]
            require(re.fullmatch(r"[1-9][0-9]*", image_id), "invalid pinned image ID")
            image = self.provider.do("compute", "image", "get", image_id)[0]
            check_image(image, worker)
            configured[role] = parameter
            pins[role] = {"before_version": parameter["Version"], "before_sha256": digest(parameter["Value"]),
                          "image_id": image_id, "image_digest": values["CHALK_RECORDER_FLEET_IMAGE_DIGEST"]}
        sizes = self.provider.do("compute", "size", "list")
        for section in ("builder", "worker"):
            selected = next((size for size in sizes if size["slug"] == self.config[section]["size"]), None)
            require(selected and selected["available"] and self.config[section]["region"] in selected["regions"],
                    section + " size unavailable in configured region")
            if section == "worker":
                require(selected["disk"] == self.config["worker"]["disk_gb"], "configured worker disk differs from provider")
        runtime = self.config["runtime"]
        instances = self.provider.aws("ec2", "describe-instances", "--instance-ids", runtime["instance_id"])
        require(instances["Reservations"][0]["Instances"][0]["State"]["Name"] == "running", "managed runtime is not running")
        dispatcher = self.config["dispatcher"]
        schedule = self.provider.aws("scheduler", "get-schedule", "--name", dispatcher["scheduler_name"], "--group-name", dispatcher["scheduler_group"])
        require(schedule["State"] == "ENABLED", "scheduler must be enabled at plan time")
        function = self.provider.aws("lambda", "get-function-configuration", "--function-name", dispatcher["function_name"])
        require(function["State"] == "Active" and function["LastUpdateStatus"] == "Successful", "dispatcher is not healthy")
        raw_state = self.provider.state(dispatcher)
        module = REPO / "infrastructure/opentofu/modules/aws-transcription-dispatcher"
        root = rebuild_dispatcher(raw_state, module, dispatcher, self.args.region, self.args.profile)
        require(root["module"]["dispatcher"]["function_name"] == dispatcher["function_name"], "dispatcher state identity mismatch")
        require(root["module"]["dispatcher"]["scheduler_state"] == schedule["State"], "dispatcher state disagrees with live scheduler")
        self.provider.parameter(self.config["bootstrap_ca_parameter"])
        return configured, pins, root

    def parameter_name(self, role):
        return self.config["runtime"]["parameter_prefix"] + "/recorder/" + role + ".env"

    def dry_run(self):
        _, pins, root = self.read_production()
        identity = self.state or self.identity()
        phases = list(PHASES) if self.args.phase == "plan" else [self.args.phase]
        if self.directory:
            require(not self.directory.is_symlink(), "invalid release directory")
        proof = {
            "schema_version": 1, "dry_run": True, "result": "PASS", "production_mutations": 0,
            "config_version": self.config_version, "config_sha256": self.config_digest,
            "source_commit": identity["source_commit"], "role": self.args.role,
            "phases": {phase: self.phase_description(phase) for phase in phases},
            "observed": {"pinned_roles": sorted(pins), "snapshot_min_disk_fits": True, "fleet_shape_matches": True,
                         "runtime_running": True, "scheduler_enabled": True, "dispatcher_state_reconstructed": True},
            "not_executed": ["build", "image qualification", "BOOTDIAG signed boot", "OpenTofu drift plan/apply", "loaded-process verification"],
            "read_operations": self.provider.reads,
        }
        if self.args.managed_manifest:
            self.managed_deploy(dry_run=True)
            proof["canonical_managed_deploy_dry_run"] = True
        # Check the reconstructed input shape without persisting production state or root files.
        require(root["module"]["dispatcher"]["scheduler_name"] == self.config["dispatcher"]["scheduler_name"], "scheduler identity mismatch")
        return proof

    def phase_description(self, phase):
        return {
            "plan": "freeze exact source, SSM versions and current-state dispatcher root; require zero drift",
            "build": "create owned DO builder/key/firewall; detach exact-ID deadline guard; upload one build/cleanup/seal script",
            "snapshot": "no post-seal SSH; power off, snapshot, validate fleet minimum disk, delete exact builder/key/firewall",
            "qualify": "temporary fleet-size image checks plus required BOOTDIAG executable receipt; clean own resources",
            "publish-pins": "require signed qualification; re-read SSM version/hash; change only image identity and Capture evidence",
            "deploy": "guarded scheduler pause; canonical managed release input reload; loaded-runtime verify; restore scheduler",
            "verify": "health, manifest/component identities, running image digests, loaded /proc environment versus SSM",
        }[phase]

    def plan(self):
        require(not self.state, "release directory already has a plan; use another --state directory")
        require(not self.directory.exists(), "plan requires a new private state directory")
        self.directory.mkdir(mode=0o700, parents=True)
        self.state = self.identity()
        _, pins, root = self.read_production()
        self.state["pins"] = pins
        dispatcher_root = self.directory / "dispatcher"
        dispatcher_root.mkdir(mode=0o700)
        private_json(dispatcher_root / "main.tf.json", root)
        # Copy the pinned provider lock, never upgrade a production plan implicitly.
        (dispatcher_root / ".terraform.lock.hcl").write_bytes((REPO / "infrastructure/opentofu/modules/aws-transcription-dispatcher/.terraform.lock.hcl").read_bytes())
        self.tofu("init", "-input=false", "-upgrade=false")
        self.tofu("plan", "-input=false", "-detailed-exitcode", "-no-color")
        self.save()
        return {"result": "PASS", "phase": "plan", "state": str(self.directory), "source_commit": self.state["source_commit"]}

    def tofu(self, *arguments):
        return self.provider.command(["tofu", "-chdir=" + str(self.directory / "dispatcher"), *arguments], timeout=600)

    def detach_guard(self, droplet, label):
        identity = {key: droplet[key] for key in ("id", "name", "created_at")}
        deadline = time.time() + self.config["builder"]["ttl_seconds"]
        log_path = self.directory / (label + "-guard.log")
        with open(log_path, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as log:
            process = subprocess.Popen([sys.executable, str(SCRIPTS / "spend_guard.py"), "--id", str(identity["id"]),
                                        "--name", identity["name"], "--created-at", identity["created_at"],
                                        "--context", self.config["do_context"], "--deadline", str(deadline),
                                        "--stop-file", str(self.directory / (label + "-guard.stop"))],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        return {**identity, "guard_pid": process.pid, "deadline": deadline, "guard_log": str(log_path)}

    def create_node(self, label, image, size):
        require(label not in self.state, label + " already exists; inspect saved ownership before resuming")
        name = "chalk-release-" + label + "-" + uuid.uuid4().hex[:12]
        key_path = self.directory / (label + ".key")
        self.provider.command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key_path)])
        try:
            key = self.provider.do("compute", "ssh-key", "import", name, "--public-key", str(key_path) + ".pub")[0]
        except Exception:
            key_path.unlink(missing_ok=True)
            Path(str(key_path) + ".pub").unlink(missing_ok=True)
            raise
        self.state[label] = {"key_id": key["id"], "key_path": str(key_path)}
        self.save()
        try:
            droplet = self.provider.do("compute", "droplet", "create", name, "--image", image, "--size", size,
                                       "--region", self.config["worker"]["region"], "--ssh-keys", key["id"], timeout=120)[0]
            self.state[label].update({key: droplet[key] for key in ("id", "name", "created_at")})
            self.save()
            self.state[label].update(self.detach_guard(droplet, label))
            self.save()
            firewall = self.provider.do("compute", "firewall", "create", "--name", name, "--droplet-ids", droplet["id"],
                                        "--inbound-rules", "protocol:tcp,ports:22,address:" + self.config["builder"]["ssh_cidr"],
                                        "--outbound-rules", "protocol:tcp,ports:all,address:0.0.0.0/0 protocol:udp,ports:all,address:0.0.0.0/0")[0]
            self.state[label]["firewall_id"] = firewall["id"]
            deadline = time.monotonic() + 125
            while time.monotonic() < deadline:
                droplet = self.provider.do("compute", "droplet", "get", droplet["id"])[0]
                builder_identity(droplet, self.state[label])
                public = [net["ip_address"] for net in droplet["networks"]["v4"] if net["type"] == "public"]
                if droplet["status"] == "active" and public:
                    self.state[label]["ip"] = public[0]
                    break
                time.sleep(5)
            require("ip" in self.state[label], "Droplet provisioning did not complete within 125 seconds")
            self.save()
            return self.state[label]
        except Exception:
            self.cleanup_node(label)
            raise

    def ssh_options(self, node):
        return ["-i", node["key_path"], "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + str(self.directory / "known_hosts")]

    def await_ssh(self, node):
        deadline = time.monotonic() + 125
        while time.monotonic() < deadline:
            try:
                self.provider.command(["ssh", *self.ssh_options(node), "root@" + node["ip"], "true"], timeout=15)
                return
            except (RuntimeError, subprocess.TimeoutExpired):
                time.sleep(5)
        raise RuntimeError("SSH not ready within 125 seconds; exact resource ownership is in release.json")

    def cleanup_node(self, label):
        node = self.state[label]
        if "id" in node:
            # A deadline guard may have beaten cleanup. Distinguish absence from auth/network errors.
            command = ["doctl", "--context", self.config["do_context"], "compute", "droplet", "get", str(node["id"]), "--output", "json"]
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            if result.returncode == 0:
                builder_identity(json.loads(result.stdout)[0], node)
                self.provider.do("compute", "droplet", "delete", node["id"], "--force")
            else:
                require("404" in result.stderr, "cleanup could not prove exact Droplet absent")
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                observed = subprocess.run(command, capture_output=True, text=True, timeout=15)
                if observed.returncode and "404" in observed.stderr:
                    break
                require(observed.returncode == 0, "cleanup absence read failed")
                builder_identity(json.loads(observed.stdout)[0], node)
                time.sleep(3)
            else:
                raise RuntimeError("Droplet deletion has not reached 404; retain guard and owned resource receipt")
            (self.directory / (label + "-guard.stop")).touch(mode=0o600)
        if "firewall_id" in node:
            self.provider.do("compute", "firewall", "delete", node["firewall_id"], "--force")
            del node["firewall_id"]
            self.save()
        if "key_id" in node:
            self.provider.do("compute", "ssh-key", "delete", node["key_id"], "--force")
            del node["key_id"]
            self.save()
        for suffix in ("", ".pub"):
            Path(node["key_path"] + suffix).unlink(missing_ok=True)
        node["cleaned"] = True
        self.save()

    def build(self):
        require(self.state.get("pins"), "run plan first")
        builder = self.config["builder"]
        require(builder["region"] == self.config["worker"]["region"], "builder must use the fleet region")
        node = self.create_node("builder", builder["image"], builder["size"])
        try:
            self.await_ssh(node)
            ca = self.provider.parameter(self.config["bootstrap_ca_parameter"])["Value"]
            ca_path = self.directory / "bootstrap-ca.pem"
            with open(ca_path, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
                output.write(ca)
            try:
                for source, destination in ((SCRIPTS / "build-and-seal.sh", "/root/chalk-release-build.sh"), (ca_path, "/root/chalk-release-ca.pem")):
                    self.provider.command(["scp", *self.ssh_options(node), str(source), "root@" + node["ip"] + ":" + destination])
            finally:
                ca_path.unlink(missing_ok=True)
            command = ["bash", "/root/chalk-release-build.sh", self.state["source_commit"], self.state["release_id"],
                       self.state["role"], self.config["bootstrap_server_name"]]
            output = self.provider.command(["ssh", *self.ssh_options(node), "root@" + node["ip"], shlex.join(command)],
                                           timeout=max(1, node["deadline"] - time.time() - 60))
            raw, image_digest = sealed_result(output, self.state["source_commit"], self.state["release_id"], self.state["role"])
            (self.directory / "image-manifest.json").write_bytes(raw)
            (self.directory / "image-manifest.json").chmod(0o600)
            self.state.update(sealed=True, image_digest=image_digest)
            self.save()
            return {"result": "PASS", "phase": "build", "sealed": True, "guard_pid": node["guard_pid"]}
        except Exception:
            self.cleanup_node("builder")
            raise

    def snapshot(self):
        require(self.state.get("sealed") and not self.state.get("image_id"), "snapshot requires a sealed build and no prior snapshot")
        node = self.state["builder"]
        droplet = self.provider.do("compute", "droplet", "get", node["id"])[0]
        builder_identity(droplet, node)
        require(time.time() + 300 < node["deadline"], "insufficient time before builder deadline; do not cancel the spend guard")
        self.provider.do("compute", "droplet-action", "power-off", node["id"], "--wait", timeout=180)
        require(self.provider.do("compute", "droplet", "get", node["id"])[0]["status"] == "off", "builder is not powered off")
        self.provider.do("compute", "droplet-action", "snapshot", node["id"], "--snapshot-name", self.state["release_id"], "--wait", timeout=600)
        current = self.provider.do("compute", "droplet", "get", node["id"])[0]
        matches = [self.provider.do("compute", "image", "get", image_id)[0] for image_id in current["snapshot_ids"]]
        matches = [image for image in matches if image["name"] == self.state["release_id"]]
        require(len(matches) == 1, "snapshot identity is ambiguous")
        check_image(matches[0], self.config["worker"])
        self.state["image_id"] = str(matches[0]["id"])
        self.save()
        self.cleanup_node("builder")
        return {"result": "PASS", "phase": "snapshot", "min_disk_fits": True, "builder_cleaned": True}

    def qualify(self):
        require(self.state.get("image_id"), "snapshot must precede image qualification")
        require(self.args.boot_check, "--boot-check BOOTDIAG executable is required; signed boot is not implemented by RELEASEKIT")
        require(not self.state.get("qualification"), "image already qualified")
        hook = Path(self.args.boot_check).resolve()
        require(hook.is_file() and os.access(hook, os.X_OK), "BOOTDIAG executable is unavailable")
        node = self.create_node("qualifier", self.state["image_id"], self.config["worker"]["size"])
        try:
            self.await_ssh(node)
            script = (SCRIPTS / "qualify-image.py").read_text()
            command = "python3 - " + shlex.join([self.state[key] for key in ("role", "source_commit", "release_id", "image_digest")])
            result = self.provider.command(["ssh", *self.ssh_options(node), "root@" + node["ip"], command], input_text=script, timeout=180)
            require(json.loads(result)["result"] == "PASS", "static image qualification failed")
        finally:
            self.cleanup_node("qualifier")
        request = {key: self.state[key] for key in ("role", "source_commit", "release_id", "image_id", "image_digest")}
        request.update(schema_version=1, region=self.config["worker"]["region"], size=self.config["worker"]["size"])
        private_json(self.directory / "boot-request.json", request)
        receipt_path = self.directory / "boot-receipt.json"
        require(not receipt_path.exists(), "stale boot receipt; use a fresh release plan")
        self.provider.command([str(hook), "--request", str(self.directory / "boot-request.json"), "--receipt", str(receipt_path)], timeout=600)
        receipt = json.loads(receipt_path.read_text())
        check_qualification(receipt, self.state)
        receipt_path.chmod(0o600)
        self.state["qualification"] = {"receipt_sha256": digest(receipt_path.read_bytes()), "signed_boot": True}
        self.save()
        return {"result": "PASS", "phase": "qualify", "fleet_equivalent_signed_boot": True}

    def publish_pins(self):
        require(self.state.get("qualification"), "signed-boot qualification required")
        receipt_path = self.directory / "boot-receipt.json"
        require(digest(receipt_path.read_bytes()) == self.state["qualification"]["receipt_sha256"], "qualification receipt changed")
        check_qualification(json.loads(receipt_path.read_text()), self.state)
        role = self.state["role"]
        parameter = self.provider.parameter(self.parameter_name(role))
        check_fresh(parameter, self.state["pins"][role])
        updates = {"CHALK_RECORDER_FLEET_IMAGE_ID": self.state["image_id"], "CHALK_RECORDER_FLEET_RELEASE_ID": self.state["release_id"],
                   "CHALK_RECORDER_FLEET_IMAGE_DIGEST": self.state["image_digest"]}
        if role == "capture":
            updates["CHALK_RECORDER_CAPTURE_PROFILE_EVIDENCE_SHA256"] = self.state["qualification"]["receipt_sha256"]
        value = replace_pins(parameter["Value"], updates)
        metadata = self.provider.aws("ssm", "describe-parameters", "--parameter-filters", "Key=Name,Option=Equals,Values=" + parameter["Name"])["Parameters"]
        require(len(metadata) == 1, "parameter metadata unavailable")
        payload = {"Name": parameter["Name"], "Value": value, "Type": parameter["Type"], "Overwrite": True}
        for key in ("KeyId", "Tier", "DataType", "Description", "AllowedPattern"):
            if key in metadata[0]:
                payload[key] = metadata[0][key]
        # SSM has no CAS. Exclusive release ownership is required; read again immediately before put.
        check_fresh(self.provider.parameter(parameter["Name"]), self.state["pins"][role])
        response = self.provider.aws("ssm", "put-parameter", payload=payload)
        fresh = self.provider.parameter(parameter["Name"])
        require(fresh["Version"] == response["Version"] and digest(fresh["Value"]) == digest(value), "published pins readback mismatch")
        self.state["published"] = {"version": fresh["Version"], "sha256": digest(value), "updates": updates}
        self.save()
        return {"result": "PASS", "phase": "publish-pins", "changed_keys": sorted(updates), "ssm_version": fresh["Version"]}

    def managed_deploy(self, dry_run=False):
        require(self.args.managed_manifest, "--managed-manifest is required for the canonical input reload")
        runtime = self.config["runtime"]
        command = ["node", str(REPO / "scripts/deploy/deploy-managed-release.mjs"), "--manifest", str(Path(self.args.managed_manifest).resolve()),
                   "--environment", "production", "--region", self.args.region, "--instance-id", runtime["instance_id"],
                   "--document-name", runtime["document_name"], "--document", str(REPO / "infrastructure/managed-episode/ssm/chalk-managed-episode-deploy.json"),
                   "--parameter-prefix", runtime["parameter_prefix"], "--request-id", "recorder-" + uuid.uuid4().hex,
                   "--log-group-name", runtime["log_group"]]
        if dry_run:
            command.append("--dry-run")
        result = subprocess.run(command, capture_output=True, text=True, timeout=1200,
                                env={**os.environ, "AWS_PROFILE": self.args.profile, "AWS_PAGER": ""})
        require(result.returncode == 0, "canonical managed release failed; scheduler remains disabled on failure")
        return json.loads(result.stdout)

    def set_scheduler(self, desired):
        path = self.directory / "dispatcher/main.tf.json"
        root = json.loads(path.read_text())
        root["module"]["dispatcher"]["scheduler_state"] = desired
        private_json(path, root)
        self.tofu("plan", "-input=false", "-no-color", "-out=scheduler.plan")
        plan = json.loads(self.tofu("show", "-json", "scheduler.plan"))
        scheduler_changes(plan, desired)
        self.tofu("apply", "-input=false", "-no-color", "scheduler.plan")
        dispatcher = self.config["dispatcher"]
        observed = self.provider.aws("scheduler", "get-schedule", "--name", dispatcher["scheduler_name"], "--group-name", dispatcher["scheduler_group"])
        require(observed["State"] == desired, "scheduler state readback mismatch")
        self.state["scheduler_state"] = desired
        self.save()

    def deploy(self):
        require(self.state.get("published"), "publish qualified pins first")
        require(self.args.managed_manifest, "--managed-manifest is required")
        self.managed_deploy(dry_run=True)
        # Reprove baseline from fresh live state; never apply a root rebuilt only from an old scratch copy.
        self.tofu("plan", "-input=false", "-detailed-exitcode", "-no-color")
        self.set_scheduler("DISABLED")
        manifest = json.loads(Path(self.args.managed_manifest).read_text())
        self.state["managed"] = {key: manifest[key] for key in ("release_id", "source_revision")}
        self.save()
        self.managed_deploy()
        result = self.verify()
        self.set_scheduler("ENABLED")
        self.state["deployed"] = True
        self.save()
        return {"result": "PASS", "phase": "deploy", "scheduler_enabled": True, "loaded_runtime": result["result"]}

    def verify(self):
        require(self.state.get("published") and self.state.get("managed"), "verification requires published pins and managed deployment identity")
        options = {**self.state["managed"], "region": self.args.region, "user_id": self.config["runtime"]["user_id"],
                   "parameter_prefix": self.config["runtime"]["parameter_prefix"],
                   "pins": {self.state["role"]: self.state["published"]["updates"]}}
        script = (SCRIPTS / "verify-loaded-runtime.py").read_text()
        encoded = base64.b64encode(json.dumps(options).encode()).decode()
        shell = "python3 - " + shlex.quote(encoded) + " <<'CHALK_RELEASE_VERIFY'\n" + script + "\nCHALK_RELEASE_VERIFY"
        response = self.provider.aws("ssm", "send-command", payload={"DocumentName": "AWS-RunShellScript",
                                     "InstanceIds": [self.config["runtime"]["instance_id"]],
                                     "Parameters": {"commands": [shell], "executionTimeout": ["180"]}, "TimeoutSeconds": 240})
        command_id = response["Command"]["CommandId"]
        # Canonical AWS waiter is a bounded external completion monitor, not model polling.
        self.provider.command(["aws", "--profile", self.args.profile, "--region", self.args.region, "ssm", "wait", "command-executed",
                               "--command-id", command_id, "--instance-id", self.config["runtime"]["instance_id"]], timeout=300)
        invocation = self.provider.aws("ssm", "get-command-invocation", "--command-id", command_id,
                                       "--instance-id", self.config["runtime"]["instance_id"])
        require(invocation["Status"] == "Success", "loaded-runtime verifier failed")
        result = json.loads(invocation["StandardOutputContent"])
        require(result["result"] == "PASS", "loaded-runtime verification did not pass")
        self.state["verified"] = {"command_id": command_id, **result}
        self.save()
        return result


def main():
    os.umask(0o077)
    args = parse_args()
    release = Release(args)
    if args.dry_run:
        result = release.dry_run()
    elif args.phase == "build" and not args.build_worker:
        require(release.state.get("pins"), "run plan first")
        log_path = release.directory / "build-worker.log"
        with open(log_path, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as log:
            process = subprocess.Popen([sys.executable, str(SCRIPTS / "release.py"), *sys.argv[1:], "--build-worker"],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True, close_fds=True)
        print(json.dumps({"build_worker_pid": process.pid, "log": str(log_path)}), file=sys.stderr, flush=True)
        require(process.wait() == 0, "detached build failed; see " + str(log_path))
        result = json.loads(log_path.read_text())
    else:
        require(args.phase == "plan" or release.state, "run plan first")
        result = getattr(release, args.phase.replace("-", "_"))()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, KeyError, OSError) as error:
        print("recorder release stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
