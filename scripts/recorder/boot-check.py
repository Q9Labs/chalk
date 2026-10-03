#!/usr/bin/env python3
"""Cold signed fleet bootstrap qualification; never publishes pins or demand."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent.parent
IDENTITIES = ("schema_version", "role", "source_commit", "release_id", "image_id", "image_digest", "region", "size")
_upload_spec = importlib.util.spec_from_file_location("boot_check_upload", SCRIPTS / "boot-check-upload.py")
upload = importlib.util.module_from_spec(_upload_spec)
_upload_spec.loader.exec_module(upload)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, *, text=None, timeout=60, env=None):
    result = subprocess.run(args, input=text, text=True, capture_output=True, timeout=timeout,
                            env={**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off", **(env or {})})
    require(result.returncode == 0, f"{Path(args[0]).name} failed with exit {result.returncode}; payload suppressed")
    return result.stdout


def private_json(path, value):
    with path.open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")
    path.chmod(0o600)


def append(directory, event):
    with (directory / "ledger.jsonl").open("a") as file:
        file.write(json.dumps({"time": time.time(), **event}) + "\n")
        file.flush()
        os.fsync(file.fileno())


def ledger(directory):
    state = {}
    for line in (directory / "ledger.jsonl").read_text().splitlines():
        state.update(json.loads(line))
    return state


def validate_request(request):
    require(set(request) == set(IDENTITIES), "boot request fields do not match qualification contract")
    require(request["schema_version"] == 1 and request["role"] in ("capture", "render"), "invalid boot request schema/role")
    require(type(request["image_id"]) is int and request["image_id"] > 0, "invalid image ID")
    require(re.fullmatch(r"[0-9a-f]{40}", request["source_commit"]), "invalid source commit")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", request["image_digest"]), "invalid image digest")
    require(re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", request["release_id"]), "invalid release ID")
    require(all(re.fullmatch(r"[a-z0-9-]{1,64}", request[k]) for k in ("region", "size")), "invalid region/size")


def isolated_rules(rules, api_url, bootstrap_url):
    from urllib.parse import urlsplit
    api_port = urlsplit(api_url).port or 443
    bootstrap_port = urlsplit(bootstrap_url).port or 443
    require(api_port != bootstrap_port, "cannot isolate worker and bootstrap on the same port")
    output = []
    for original in rules:
        rule = dict(original)
        if rule["protocol"] == "tcp":
            ports = rule["ports"]
            require(ports != "all", "unbounded TCP egress cannot isolate worker route")
            parts = ports.split("-")
            low, high = int(parts[0]), int(parts[-1])
            if low <= api_port <= high:
                for start, end in ((low, api_port - 1), (api_port + 1, high)):
                    if start <= end:
                        output.append({**rule, "ports": str(start) if start == end else f"{start}-{end}"})
                continue
        output.append(rule)
    require(any(r["protocol"] == "tcp" and int(r["ports"].split("-")[0]) <= bootstrap_port <= int(r["ports"].split("-")[-1]) for r in output), "bootstrap egress missing")
    return output


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class Services:
    def __init__(self):
        self.profile = os.environ.get("CHALK_BOOT_CHECK_AWS_PROFILE", os.environ.get("AWS_PROFILE", ""))
        self.region = os.environ.get("CHALK_BOOT_CHECK_AWS_REGION", os.environ.get("AWS_REGION", ""))
        self.context = os.environ.get("CHALK_BOOT_CHECK_DO_CONTEXT", "")
        require(self.profile and self.region and self.context, "configure BOOT_CHECK AWS profile/region and DigitalOcean context")
        self.token = command(["doctl", "--context", self.context, "auth", "token"]).strip()
        require(self.token, "DigitalOcean context has no token")
        self.instance = os.environ.get("CHALK_BOOT_CHECK_INSTANCE_ID", "")
        self.http = urllib.request.build_opener(NoRedirect())
        self.mutation_deadline = None
        self.cleanup_marker = None

    def do(self, method, path, body=None):
        if method == "POST" and self.mutation_deadline is not None:
            require(time.time() < self.mutation_deadline and not self.cleanup_marker.exists(), "provider create cutoff reached")
        request = urllib.request.Request("https://api.digitalocean.com/v2" + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with self.http.open(request, timeout=25) as response:
                raw = response.read(2 << 20)
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise RuntimeError(f"DigitalOcean {method} failed HTTP {error.code}; payload suppressed") from None

    def aws(self, service, operation, *args, timeout=60):
        raw = command(["aws", "--profile", self.profile, "--region", self.region, service, operation,
                       *map(str, args), "--output", "json"], timeout=timeout)
        return json.loads(raw) if raw.strip() else {}

    def host(self, task, directory, *, timeout=60, output_name=None):
        if not self.instance:
            instances = self.aws("ssm", "describe-instance-information")["InstanceInformationList"]
            online = [item["InstanceId"] for item in instances if item["PingStatus"] == "Online"]
            require(len(online) == 1, "select the exact managed instance with CHALK_BOOT_CHECK_INSTANCE_ID")
            self.instance = online[0]
        payload = base64.b64encode(json.dumps(task).encode()).decode()
        script = (SCRIPTS / "boot-check-host.py").read_text()
        script += "\nimport base64\nprint(json.dumps(execute(json.loads(base64.b64decode('" + payload + "')))))\n"
        parameters = {"commands": ["python3 - <<'PYBOOTCHECK'\n" + script + "\nPYBOOTCHECK"], "executionTimeout": [str(max(60, timeout))]}
        with tempfile.TemporaryDirectory(prefix="chalk-boot-check-ssm-") as temp:
            path = Path(temp, "parameters.json")
            private_json(path, parameters)
            sent = self.aws("ssm", "send-command", "--instance-ids", self.instance, "--document-name", "AWS-RunShellScript",
                            "--comment", "BOOT_CHECK scoped " + task["action"], "--parameters", "file://" + str(path))
        identifier = sent["Command"]["CommandId"]
        append(directory, {"ssm_command": identifier, "ssm_action": task["action"]})
        deadline = time.monotonic() + timeout + 20
        while time.monotonic() < deadline:
            try:
                result = self.aws("ssm", "get-command-invocation", "--command-id", identifier, "--instance-id", self.instance)
            except RuntimeError:
                time.sleep(2)
                continue
            if result["Status"] in ("Pending", "InProgress", "Delayed"):
                time.sleep(2)
                continue
            require(result["Status"] == "Success", "managed host action failed: " + result["Status"])
            value = json.loads(result["StandardOutputContent"])
            if output_name:
                private_json(directory / output_name, value)
            return value
        self.aws("ssm", "cancel-command", "--command-id", identifier, "--instance-ids", self.instance)
        raise RuntimeError("managed host action exceeded its bounded deadline")

    def provider(self, task):
        helper = os.environ.get("CHALK_BOOT_CHECK_PROVIDER")
        args = [helper] if helper else ["go", "run", "./cmd/recorder-boot-probe"]
        result = subprocess.run(args, cwd=ROOT / "apps/api", input=json.dumps(task), text=True, capture_output=True,
                                timeout=120, env={**os.environ, "DIGITALOCEAN_TOKEN": self.token, "GOFLAGS": "-buildvcs=false"})
        if result.returncode:
            if task.get("evidence_path"):
                with (Path(task["evidence_path"]).parent / "provider-errors.log").open("a") as file:
                    file.write(result.stderr)
            raise RuntimeError("fleet provider adapter failed; see private provider response evidence")
        return json.loads(result.stdout)


def ensure_node(services, base, directory, deadline):
    # Reconcile the same immutable intent after a lost response or a transient
    # project assignment, as the fleet does. Never change the node name.
    while time.time() < deadline and not (directory / "cleanup-requested").exists():
        try:
            return services.provider({**base, "operation": "create"})
        except RuntimeError as error:
            append(directory, {"create_retry": str(error)})
            time.sleep(5)
    raise RuntimeError("fleet create intent did not converge before the cleanup deadline")


def expected_tags(environment, owner, request, generation, unique):
    release_hash = hashlib.sha256(request["release_id"].encode()).hexdigest()[:16]
    return sorted([owner, "chalk-environment-" + environment, "chalk-recorder-" + request["role"],
                   "chalk-release-" + release_hash, "chalk-image-" + request["image_digest"][7:],
                   "chalk-boot-" + str(generation), "chalk-recorder-diagnostic", unique])


def owned_resource(services, state, path, collection):
    matches = []
    for page in range(1, 21):
        response = services.do("GET", path + "?per_page=200&page=" + str(page))
        for item in response[collection]:
            if item["name"] == state["name"]:
                if collection != "ssh_keys" or item["public_key"].strip() == state["public_key"].strip():
                    matches.append(item)
        if not response.get("links", {}).get("pages", {}).get("next"):
            require(len(matches) <= 1, "diagnostic resource name is ambiguous")
            return matches[0]["id"] if matches else None
    raise RuntimeError("diagnostic inventory recovery exceeded its page bound")


def recover_resources(services, state, directory):
    errors = []
    # A captured accepted create response is stronger than a eventually
    # consistent name listing after the main process loses its result.
    audit = directory / "provider.jsonl"
    if not state.get("node_id") and audit.exists():
        for line in audit.read_text().splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue  # A killed writer may leave one incomplete final line.
            if entry["path"] == "/v2/droplets" and entry["method"] == "POST" and entry["status"] == 202:
                node = entry["response"]["droplet"]
                require(node["name"] == state["name"], "create evidence ownership mismatch")
                state["node_id"] = node["id"]
    for key, intent, path, collection in (("node_id", "create_intent", "/droplets", "droplets"),
                                         ("firewall_id", "firewall_intent", "/firewalls", "firewalls"),
                                         ("key_id", "key_intent", "/account/keys", "ssh_keys")):
        if state.get(key) or not state.get(intent):
            continue
        try:
            identifier = owned_resource(services, state, path, collection)
            if identifier:
                state[key] = identifier
        except Exception as error:
            errors.append("recover " + key + ": " + str(error))
    return state, errors


def delete_node(services, state):
    if not state.get("node_id"):
        return
    path = "/droplets/" + str(state["node_id"])
    value = services.do("GET", path)
    if value:
        node = value["droplet"]
        require(node["name"] == state["name"] and set(state["tags"]) <= set(node["tags"]), "cleanup node ownership mismatch")
        require(datetime.fromisoformat(node["created_at"].replace("Z", "+00:00")).timestamp() >= state["started_at"] - 5, "cleanup node creation time mismatch")
        services.do("DELETE", path)
    for _ in range(10):
        if services.do("GET", path) is None:
            return
        time.sleep(2)
    raise RuntimeError("diagnostic Droplet deletion has not reached 404")


def confirm_absent(services, resource):
    for _ in range(10):
        if services.do("GET", resource) is None:
            return
        time.sleep(2)
    raise RuntimeError("diagnostic resource deletion not confirmed")


def cleanup(services, directory):
    state, errors = recover_resources(services, ledger(directory), directory)
    append(directory, {key: state[key] for key in ("node_id", "firewall_id", "key_id") if key in state})
    if state.get("bootstrap"):
        try:
            revoked = services.host({"action": "abandon", "role": state["role"], "bootstrap": state["bootstrap"]}, directory, timeout=30)
            record = revoked["record"]
            require(revoked["status"] == 204 and (record is None or record.get("revoked_at")), "diagnostic registration revocation unproved")
            if not (directory / "revocation.json").exists():
                private_json(directory / "revocation.json", revoked)
        except Exception as error:
            errors.append(str(error))
    # Revocation failure must not prevent compute deletion or key cleanup.
    try:
        delete_node(services, state)
    except Exception as error:
        errors.append(str(error))
    for kind, path in (("firewall_id", "/firewalls/"), ("key_id", "/account/keys/")):
        try:
            if state.get(kind):
                resource = path + str(state[kind])
                value = services.do("GET", resource)
                if value:
                    item = value["firewall" if kind == "firewall_id" else "ssh_key"]
                    require(item["name"] == state["name"], "cleanup resource ownership mismatch")
                    if kind == "key_id":
                        require(item["public_key"].strip() == state["public_key"], "cleanup SSH key mismatch")
                    services.do("DELETE", resource)
                confirm_absent(services, resource)
        except Exception as error:
            errors.append(str(error))
    try:
        if state.get("tag_intent") or state.get("tag_created"):
            services.do("DELETE", "/tags/" + state["unique_tag"])
            confirm_absent(services, "/tags/" + state["unique_tag"])
    except Exception as error:
        errors.append(str(error))
    for name in ("ssh-key", "ssh-key.pub", "known-hosts"):
        (directory / name).unlink(missing_ok=True)
    if state.get("evidence_bucket"):
        try:
            upload.clean_objects(services, state)
        except Exception as error:
            errors.append(str(error))
    require(not errors, "; ".join(errors))
    private_json(directory / "cleanup.json", {"result": "PASS", "cleaned_at": time.time(), "node_id": state.get("node_id")})


def watchdog(directory):
    services = Services()
    state = ledger(directory)
    private_json(directory / "watchdog-started.json", {"pid": os.getpid(), "deadline": state["deadline"]})
    while time.time() < state["deadline"] - 150 and not (directory / "cleanup-requested").exists():
        time.sleep(1)
    (directory / "cleanup-requested").touch()
    # No dependency on the main process, SSH connection, or successful boot.
    for attempt in range(3):
        try:
            cleanup(services, directory)
            return
        except Exception as error:
            append(directory, {"cleanup_error": str(error), "cleanup_attempt": attempt + 1})
    private_json(directory / "cleanup-failed.json", {"result": "FAIL", "pid": os.getpid()})
    raise RuntimeError("cleanup unproved; see private watchdog ledger")


def certificate_der(pem):
    leaf = re.search(r"-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----", pem)
    require(leaf is not None, "certificate PEM missing")
    return base64.b64decode("".join(leaf[1].split()), validate=True)


def installed_boot(installed):
    status = installed.get("commands", {}).get("cloud_init", {})
    files = installed["files"]
    return (status.get("status") == 0 and "status: done" in status.get("stdout", "").splitlines()
            and all(path in files for path in ("/etc/chalk-recorder/worker.env", "/etc/chalk-recorder/node.env")))


def assert_certificate_binding(request, bootstrap, evidence, installed):
    require(installed_boot(installed), "cold cloud-init/bootstrap installation did not complete")
    require(evidence.get("controller_response", {}).get("status") == 200, "controller did not confirm certificate delivery")
    record = evidence["record"]
    require(record and record["request"] == bootstrap and not record.get("revoked_at"), "issuer request binding mismatch")
    identity = record["identity"]
    require(identity["provider_id"] == bootstrap["provider_id"] and identity["role"] == request["role"] and identity["boot_generation"] == bootstrap["boot_generation"], "issuer node identity mismatch")
    node_env = dict(line.split("=", 1) for line in installed["files"]["/etc/chalk-recorder/node.env"]["content"].splitlines() if "=" in line)
    require(node_env.get("CHALK_RECORDER_POOL") == request["role"] and node_env.get("CHALK_RECORDER_RELEASE") == request["release_id"]
            and node_env.get("CHALK_RECORDER_IMAGE_DIGEST") == request["image_digest"]
            and node_env.get("CHALK_RECORDER_BOOT_GENERATION") == str(bootstrap["boot_generation"]), "installed bootstrap configuration mismatch")
    manifest_file = installed["files"].get("/opt/chalk-recorder/image-manifest.json")
    require(manifest_file and "sha256:" + manifest_file["sha256"] == request["image_digest"], "installed image manifest digest mismatch")
    manifest = json.loads(manifest_file["content"])
    require(manifest["source_commit"] == request["source_commit"] and manifest["release_id"] == request["release_id"], "installed image source/release mismatch")
    certificate = installed["files"].get("/etc/chalk-recorder/identity/client-cert.pem")
    require(certificate and record["certificates"], "no installed matching certificate receipt")
    matching = {serial: item for serial, item in record["certificates"].items()
                if item["serial_number"] == serial and certificate_der(item["pem"]) == certificate_der(certificate["content"])}
    require(matching, "installed certificate is absent from issuer receipt")
    return identity, certificate["content"], matching


def provisioning_receipt(directory, request, inspected, tags):
    node = inspected["node"]
    require(node["image_id"] == request["image_id"] and node["region"] == request["region"] and node["size"] == request["size"]
            and set(node["tags"]) == set(tags), "provider inventory differs from the cold create intent")
    creates = [json.loads(line) for line in (directory / "provider.jsonl").read_text().splitlines()
               if json.loads(line)["path"] == "/v2/droplets" and json.loads(line)["method"] == "POST" and json.loads(line)["status"] == 202]
    require(len(creates) == 1 and creates[0]["status"] == 202, "cold create receipt is missing or ambiguous")
    payload = creates[0]["body"]
    require(payload["image"] == request["image_id"] and payload["name"] == node["name"], "create payload candidate mismatch")
    return {"create_payload_sha256": creates[0]["body_sha256"],
            "user_data_sha256": hashlib.sha256(payload["user_data"].encode()).hexdigest(),
            "fleet_user_data_sha256": hashlib.sha256(creates[0]["original_body"]["user_data"].encode()).hexdigest(),
            "vpc_uuid": payload.get("vpc_uuid", "")}


def guest_evidence(services, directory):
    state = ledger(directory)
    require(state.get("evidence_bucket"), "private guest evidence transport was not provisioned")
    target = directory / "guest-latest.json"
    services.aws("s3api", "get-object", "--bucket", state["evidence_bucket"], "--key", state["evidence_key"], target)
    require(target.stat().st_size <= 20 << 20, "guest evidence exceeds bounded size")
    evidence = json.loads(target.read_text())
    require(evidence.get("binding") == {"name": state["name"], "boot_generation": state["generation"]}, "guest evidence boot binding mismatch")
    require(state["started_at"] <= evidence["collected_at"] <= state["deadline"], "guest evidence timestamp outside cold boot")
    return evidence


def run(request_path, receipt_path):
    invocation_started = time.time()
    os.umask(0o077)
    request = json.loads(request_path.read_text())
    validate_request(request)
    require(not receipt_path.exists() and receipt_path.parent.is_dir(), "receipt must be a fresh path in a private directory")
    directory = Path(tempfile.mkdtemp(prefix="boot-check-", dir=receipt_path.parent))
    services = Services()
    summary = services.host({"action": "summary", "role": request["role"]}, directory, output_name="live-summary.json")
    live = summary["env"]
    require(request["region"] == live["REGION"] and request["size"] == live["SIZE"], "candidate region/size differs from fleet")
    require(summary["issuer_control_plane_url"].endswith(":8443"), "unrecognized worker control-plane route")
    size = next((size for size in services.do("GET", "/sizes?per_page=200")["sizes"] if size["slug"] == request["size"]), None)
    require(size and request["region"] in size["regions"], "fleet size is unavailable")
    hard_seconds = int(os.environ.get("CHALK_BOOT_CHECK_DEADLINE_SECONDS", "480"))
    require(420 <= hard_seconds <= 2700 and max(0.01, size["price_hourly"] * hard_seconds / 3600) <= 0.05, "boot check exceeds time/cost cap")
    started = invocation_started
    name = "chalk-recorder-diagnostic-" + request["role"] + "-" + str(int(started)) + "-" + os.urandom(3).hex()
    generation = int(started)
    unique = name
    tags = expected_tags(live["ENVIRONMENT"], live["OWNER_TAG"], request, generation, unique)
    require(not services.do("GET", "/droplets?name=" + name)["droplets"], "diagnostic name already exists")
    require(not any(n.get("boot_generation") == generation for n in summary["journal"]["journal"]["nodes"].values()), "diagnostic generation already managed")
    append(directory, {"name": name, "role": request["role"], "tags": tags, "unique_tag": unique, "started_at": started,
                       "deadline": started + hard_seconds, "request": request, "generation": generation})
    services.mutation_deadline = started + hard_seconds - 300
    services.cleanup_marker = directory / "cleanup-requested"
    log = (directory / "watchdog.log").open("x")
    # Launch before any threads; setsid detaches cleanup from terminal hangups.
    guard = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--watchdog", str(directory)], stdout=log, stderr=log, preexec_fn=os.setsid)
    log.close()
    append(directory, {"watchdog_pid": guard.pid})
    for _ in range(50):
        if (directory / "watchdog-started.json").exists():
            break
        require(guard.poll() is None, "cleanup watchdog died before provisioning")
        time.sleep(0.1)
    else:
        raise RuntimeError("cleanup watchdog did not confirm liveness")
    result = {**request, "result": "FAIL", "fleet_equivalent_signed_boot": False, "evidence_directory": str(directory)}
    try:
        evidence_command = None
        bucket = os.environ.get("CHALK_BOOT_CHECK_EVIDENCE_BUCKET")
        if not bucket:
            config = services.aws("ssm", "get-parameter", "--name", "/chalk/production/release/recorder.json")
            bucket = json.loads(config["Parameter"]["Value"])["dispatcher"]["state_bucket"]
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket), "private evidence bucket must be a DNS-compatible name without dots")
        if bucket:
            public = services.aws("s3api", "get-public-access-block", "--bucket", bucket)["PublicAccessBlockConfiguration"]
            require(all(public.get(k) for k in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")), "guest evidence bucket must block public access")
            services.aws("s3api", "get-bucket-encryption", "--bucket", bucket)
            credentials = json.loads(command(["aws", "--profile", services.profile, "configure", "export-credentials", "--format", "process"]))
            if credentials.get("Expiration"):
                require(datetime.fromisoformat(credentials["Expiration"].replace("Z", "+00:00")).timestamp() > started + hard_seconds, "upload credentials expire before diagnostic deadline")
            key = "bootdiag/" + name + "/guest.json"
            append(directory, {"evidence_bucket": bucket, "evidence_key": key})
            url = upload.presigned_put(bucket, key, services.region, credentials, max(1, int(started + hard_seconds - time.time())))
            evidence_command = upload.boot_command((SCRIPTS / "boot-check-node.py").read_text(), url, started + hard_seconds,
                                                  {"name": name, "boot_generation": generation})
        command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", str(directory / "ssh-key")])
        public = (directory / "ssh-key.pub").read_text().strip()
        append(directory, {"key_intent": True, "public_key": public})
        key = services.do("POST", "/account/keys", {"name": name, "public_key": public})["ssh_key"]
        append(directory, {"key_id": key["id"]})
        append(directory, {"tag_intent": True})
        services.do("POST", "/tags", {"name": unique})
        append(directory, {"tag_created": True})
        firewall = services.do("GET", "/firewalls/" + live["FIREWALL_ID"])["firewall"]
        private_json(directory / "live-firewall.json", firewall)
        operator_ip = command(["curl", "-fsS", "--max-time", "15", "https://api.ipify.org"]).strip()
        import ipaddress
        require(ipaddress.ip_address(operator_ip).version == 4, "SSH operator IPv4 unavailable")
        outbound = isolated_rules(firewall["outbound_rules"], summary["issuer_control_plane_url"], live["BOOTSTRAP_ENDPOINT"])
        append(directory, {"firewall_intent": True})
        created = services.do("POST", "/firewalls", {"name": name, "tags": [unique],
                             "inbound_rules": [{"protocol": "tcp", "ports": "22", "sources": {"addresses": [operator_ip + "/32"]}}],
                             "outbound_rules": outbound})["firewall"]
        append(directory, {"firewall_id": created["id"]})
        base = {"environment": live["ENVIRONMENT"], "role": request["role"], "owner_tag": live["OWNER_TAG"],
                "project_id": live["DIGITALOCEAN_PROJECT_ID"], "vpc_uuid": live["DIGITALOCEAN_VPC_UUID"],
                "ssh_key_ids": [int(value) for value in live["SSH_KEY_IDS"].split(",") if value],
                "diagnostic_ssh_key_id": key["id"],
                "mutation_deadline": datetime.fromtimestamp(started + hard_seconds - 180, timezone.utc).isoformat(),
                "evidence_path": str(directory / "provider.jsonl"),
                "request": {"key": {"environment": live["ENVIRONMENT"], "role": request["role"]}, "name": name,
                            "owner_tag": live["OWNER_TAG"], "boot_generation": generation, "required_tags": tags,
                            "release": {"release_id": request["release_id"], "image_id": request["image_id"], "image_digest": request["image_digest"],
                                        "region": request["region"], "size": request["size"], "firewall_id": created["id"],
                                        "bootstrap_endpoint": live["BOOTSTRAP_ENDPOINT"], "gpu": False}}}
        if evidence_command:
            base["evidence_boot_command"] = evidence_command
        all_firewalls = services.do("GET", "/firewalls?per_page=200")["firewalls"]
        require(not any(fw["id"] != created["id"] and set(fw.get("tags", [])) & set(tags) for fw in all_firewalls), "a shared tag firewall would alter bootstrap/worker isolation")
        append(directory, {"create_intent": True})
        provider = ensure_node(services, base, directory, started + hard_seconds - 300)
        node_id = provider["node"]["provider_id"]
        append(directory, {"node_id": node_id})
        print(json.dumps({"stage": "created", "provider_id": node_id, "watchdog_pid": guard.pid, "deadline": started + hard_seconds, "evidence_directory": str(directory)}), flush=True)
        until = min(started + hard_seconds - 180, time.time() + int(os.environ.get("CHALK_BOOT_CHECK_BOOT_TIMEOUT", "360")))
        inspected = None
        while time.time() < until:
            try:
                candidate = services.provider({**base, "operation": "inspect", "provider_id": node_id})
                if candidate["node"]["status"] == "active":
                    inspected = candidate
                    break
                time.sleep(5)
            except RuntimeError:
                time.sleep(5)
        require(inspected is not None, "node inventory never became bootstrap-ready")
        require(inspected["node"]["firewall_ids"] == [created["id"]], "unexpected firewall association can admit worker traffic")
        provisioning = provisioning_receipt(directory, request, inspected, tags)
        bootstrap = inspected["bootstrap"]
        append(directory, {"bootstrap": bootstrap, "ip": inspected["public_ip"]})
        private_json(directory / "inspection.json", inspected)
        # Registration and guest evidence run independently; uploads need no inbound SSH.
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(services.host, {"action": "register", "role": request["role"], "bootstrap": bootstrap,
                                                "timeout": max(1, int(until - time.time()))}, directory,
                                  timeout=max(1, int(until - time.time())) + 30, output_name="issuer.json")
            installed = None
            while time.time() < until and not pending.done():
                try:
                    installed = guest_evidence(services, directory)
                    private_json(directory / ("node-" + str(time.time_ns()) + ".json"), installed)
                except (RuntimeError, subprocess.TimeoutExpired):
                    pass
                time.sleep(10)
            evidence = pending.result()
        while True:
            installed = guest_evidence(services, directory)
            if installed_boot(installed) or time.time() >= until or installed.get("commands", {}).get("cloud_init", {}).get("status") not in (0, 2):
                break
            time.sleep(2)
        private_json(directory / "node-final.json", installed)
        cached = installed["files"].get("/var/lib/cloud/instance/user-data.txt")
        require(cached and cached["sha256"] == provisioning["user_data_sha256"], "node did not run the transmitted cloud-init payload")
        identity, certificate, records = assert_certificate_binding(request, bootstrap, evidence, installed)
        verified = None
        for serial in records:
            try:
                verified = services.provider({"operation": "certificate", "environment": live["ENVIRONMENT"], "role": request["role"],
                                              "certificate_pem": certificate, "ca_pem": evidence["ca_pem"], "serial": serial,
                                              "identity": identity, "trust_domain": evidence["trust_domain"]})
                break
            except RuntimeError:
                continue
        require(verified is not None, "installed certificate does not match signed issuer receipt")
        result.update(provider_id=node_id, boot_generation=generation, inventory_digest=bootstrap["inventory_digest"],
                      certificate_sha256=verified["certificate_sha256"], certificate_serial=verified["certificate_serial"], identity=identity,
                      certificate_issued_at=records[verified["certificate_serial"]]["issued_at"], **provisioning)
    except Exception as error:
        result["reason"] = str(error)
    finally:
        (directory / "cleanup-requested").touch()
        try:
            guard.wait(timeout=150)
        except subprocess.TimeoutExpired:
            result["reason"] = "cleanup watchdog has not completed; retains resource ownership"
        cleaned = (directory / "cleanup.json").exists()
        result["cleanup_confirmed"] = cleaned and guard.returncode == 0
        if result["cleanup_confirmed"] and "reason" not in result and result.get("certificate_sha256"):
            result.update(result="PASS", fleet_equivalent_signed_boot=True)
        private_json(receipt_path, result)
    print(json.dumps(result), flush=True)
    return 0 if result["result"] == "PASS" else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--watchdog", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.watchdog:
        watchdog(args.watchdog.resolve())
    else:
        require(args.request and args.receipt, "--request and --receipt are required")
        sys.exit(run(args.request.resolve(), args.receipt.resolve()))
