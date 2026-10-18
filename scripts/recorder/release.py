#!/usr/bin/env python3
"""Resumable recorder release phases; production identities come from SSM."""

import argparse
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

from release_core import (PHASES, builder_identity, check_image, digest, env_values, require, sealed_result, validate_config)
from release_io import Provider, private_json

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent.parent


def parse_args(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=PHASES)
    parser.add_argument("--region", default=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"))
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE"))
    parser.add_argument("--environment", choices=("production", "nightly"), default="production")
    parser.add_argument("--config-parameter")
    parser.add_argument("--role", choices=("capture", "render"), default="render")
    parser.add_argument("--source", help="exact 40-character public Git commit; defaults to this checkout HEAD")
    parser.add_argument("--state", help="private release directory outside the checkout; required for real phases")
    parser.add_argument("--build-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(arguments)
    require(args.region, "set AWS_REGION (or pass --region)")
    prefix = f"/chalk/{args.environment}/release/"
    args.config_parameter = args.config_parameter or prefix + "recorder.json"
    require(args.config_parameter.startswith(prefix) and ".." not in args.config_parameter, "configuration must be under " + prefix)
    require(args.state, "pipeline image builds require --state outside the checkout")
    if args.source:
        require(re.fullmatch(r"[0-9a-f]{40}", args.source), "--source must be an exact 40-character commit")
    return args


class Release:
    def __init__(self, args):
        self.args = args
        self.provider = Provider(args.region, args.profile)
        os.environ["CHALK_RECORDER_RELEASE_CONFIG_PARAMETER"] = args.config_parameter
        parameter = self.provider.parameter(args.config_parameter)
        require(parameter["Type"] == "String", "release configuration must be a non-secret String")
        self.config = validate_config(json.loads(parameter["Value"]), args.environment)
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
                self.config["worker"] = self.state.get("worker", self.config["worker"])
                self.config["builder"]["ssh_cidr"] = self.state.get("ssh_cidr", self.config["builder"]["ssh_cidr"])
                self.config["builder"]["region"] = self.config["worker"]["region"]
                require(self.state["role"] == args.role, "release role differs from saved plan")
                require(not args.source or self.state["source_commit"] == args.source, "source differs from saved plan")

    def save(self):
        private_json(self.directory / "release.json", self.state)

    def identity(self):
        source = self.args.source or subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()
        require(re.fullmatch(r"[0-9a-f]{40}", source), "source is not an exact Git commit")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return {"role": self.args.role, "source_commit": source,
                "release_id": f"recorder-{self.args.role}-{stamp.lower()}-{source[:8]}-{uuid.uuid4().hex[:8]}",
                "config_sha256": self.config_digest, "config_version": self.config_version}

    def parameter_name(self, role):
        return self.config["runtime"]["parameter_prefix"] + "/recorder/" + role + ".env"

    def plan(self):
        require(not self.state, "release directory already has a plan")
        require(not self.directory.exists(), "plan requires a new private state directory")
        values = env_values(self.provider.parameter(self.parameter_name(self.args.role))["Value"])
        sizes = self.provider.do("compute", "size", "list")
        selected = next((size for size in sizes if size["slug"] == values["CHALK_RECORDER_FLEET_SIZE"]), None)
        require(selected and selected["available"] and values["CHALK_RECORDER_FLEET_REGION"] in selected["regions"], "fleet size unavailable")
        self.config["worker"] = dict(region=values["CHALK_RECORDER_FLEET_REGION"], size=selected["slug"], disk_gb=selected["disk"])
        self.config["builder"]["region"] = self.config["worker"]["region"]
        self.directory.mkdir(mode=0o700, parents=True)
        import ipaddress
        address = self.provider.command(["curl", "-fsS", "--max-time", "15", "https://api.ipify.org"]).strip()
        require(ipaddress.ip_address(address).version == 4, "builder needs an operator IPv4")
        self.config["builder"]["ssh_cidr"] = address + "/32"
        self.state = {**self.identity(), "worker": self.config["worker"], "ssh_cidr": address + "/32", "planned": True}
        self.save()
        return {"result": "PASS", "phase": "plan", "source_commit": self.state["source_commit"]}

    def detach_guard(self, droplet, label):
        identity = {key: droplet[key] for key in ("id", "name", "created_at")}
        deadline = time.time() + self.config["builder"]["ttl_seconds"]
        log_path = self.directory / (label + "-guard.log")
        with open(log_path, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as log:
            process = subprocess.Popen([sys.executable, str(SCRIPTS / "spend_guard.py"), "--id", str(identity["id"]),
                                        "--name", identity["name"], "--created-at", identity["created_at"],
                                        "--context", self.config["do_context"], "--deadline", str(deadline),
                                        "--stop-file", str(self.directory / (label + "-guard.stop"))],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, preexec_fn=os.setsid, close_fds=True)
        return {**identity, "guard_pid": process.pid, "deadline": deadline, "guard_log": str(log_path)}

    def create_node(self, label, image, size):
        require(label not in self.state, label + " already exists; inspect saved ownership before resuming")
        run = os.environ.get("GITHUB_RUN_ID", "local")
        require(re.fullmatch(r"[0-9]+|local", run), "invalid builder run identity")
        name = "chalk-release-" + label + "-" + run + "-" + uuid.uuid4().hex[:12]
        key_path = self.directory / (label + ".key")
        self.provider.command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key_path)])
        try:
            key = self.provider.do("compute", "ssh-key", "import", name, "--public-key-file", str(key_path) + ".pub")[0]
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
            command = ["doctl", *([] if os.environ.get("DIGITALOCEAN_ACCESS_TOKEN") else ["--context", self.config["do_context"]]), "compute", "droplet", "get", str(node["id"]), "--output", "json"]
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

    def grow_builder(self, node, size):
        # The builder starts as a fleet-size Droplet so the snapshot's minimum disk is the fleet's.
        # Without --resize-disk DigitalOcean changes CPU and memory only.
        worker = self.config["worker"]
        if size == worker["size"]:
            return
        # First boot must finish before the power cycle; its own exit status is not this step's concern.
        self.provider.command(["ssh", *self.ssh_options(node), "root@" + node["ip"], "cloud-init status --wait >/dev/null 2>&1; true"], timeout=300)
        self.provider.do("compute", "droplet-action", "shutdown", node["id"], "--wait", timeout=180)
        droplet = self.provider.do("compute", "droplet", "get", node["id"])[0]
        builder_identity(droplet, node)
        require(droplet["status"] == "off", "builder is not powered off")
        self.provider.do("compute", "droplet-action", "resize", node["id"], "--size", size, "--wait", timeout=600)
        self.provider.do("compute", "droplet-action", "power-on", node["id"], "--wait", timeout=180)
        droplet = self.provider.do("compute", "droplet", "get", node["id"])[0]
        builder_identity(droplet, node)
        require(droplet["status"] == "active" and droplet["size_slug"] == size and droplet["disk"] == worker["disk_gb"],
                "builder resize did not keep the fleet disk")
        self.await_ssh(node)

    def build(self):
        require(self.state.get("planned"), "run plan first")
        builder = self.config["builder"]
        require(builder["region"] == self.config["worker"]["region"], "builder must use the fleet region")
        node = self.create_node("builder", builder["image"], self.config["worker"]["size"])
        try:
            self.await_ssh(node)
            self.grow_builder(node, builder["size"])
            self.provider.command(["scp", *self.ssh_options(node), str(SCRIPTS / "build-and-seal.sh"), "root@" + node["ip"] + ":/root/chalk-release-build.sh"])
            command = ["bash", "/root/chalk-release-build.sh", self.state["source_commit"], self.state["release_id"], self.state["role"]]
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
        require(self.state.get("sealed"), "snapshot requires a sealed build")
        if self.state.get("image_id"):
            check_image(self.provider.do("compute", "image", "get", self.state["image_id"])[0], self.config["worker"])
            if not self.state["builder"].get("cleaned"):
                self.cleanup_node("builder")
            return {"result": "PASS", "phase": "snapshot", "min_disk_fits": True, "builder_cleaned": True}
        node = self.state["builder"]
        droplet = self.provider.do("compute", "droplet", "get", node["id"])[0]
        builder_identity(droplet, node)
        require(time.time() + 840 < node["deadline"], "insufficient time before builder deadline; do not cancel the spend guard")
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

    def inspect(self):
        require(self.state.get("image_id"), "snapshot must precede inspection")
        node = self.create_node("qualifier", self.state["image_id"], self.config["worker"]["size"])
        try:
            self.await_ssh(node)
            script = (SCRIPTS / "qualify-image.py").read_text()
            command = "python3 - " + shlex.join([self.state[key] for key in ("role", "source_commit", "release_id", "image_digest")])
            result = json.loads(self.provider.command(["ssh", *self.ssh_options(node), "root@" + node["ip"], command], input_text=script))
            require(result["result"] == "PASS" and result["portable_trust"], "image inspection failed")
            self.state["inspection_sha256"] = digest(json.dumps(result, sort_keys=True))
            self.save()
            return result
        finally:
            self.cleanup_node("qualifier")


def main():
    os.umask(0o077)
    args = parse_args()
    release = Release(args)
    if args.phase == "build" and not args.build_worker:
        require(release.state.get("planned"), "run plan first")
        log_path = release.directory / "build-worker.log"
        with open(log_path, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as log:
            process = subprocess.Popen([sys.executable, str(SCRIPTS / "release.py"), *sys.argv[1:], "--build-worker"],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, preexec_fn=os.setsid, close_fds=True)
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
