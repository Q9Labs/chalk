"""Runs via SSM on the managed host; credentials stay in existing runtime mounts."""
import json
import pathlib
import re
import socket
import subprocess
import time
from urllib.parse import urlsplit


def runtime(name):
    command = ["sudo", "-u", "#1001", "env", "XDG_RUNTIME_DIR=/run/user/1001", "podman"]
    container = json.loads(subprocess.check_output(command + ["inspect", name], text=True))[0]
    environment = dict(value.split("=", 1) for value in container["Config"]["Env"] if "=" in value)
    return container, environment, "/proc/" + str(container["State"]["Pid"]) + "/root"


def control(environment, root, body, operation):
    endpoint = urlsplit(environment["CHALK_RECORDER_FLEET_CONTROL_PLANE_URL"])
    server = environment["CHALK_RECORDER_FLEET_SERVER_NAME"]
    port = endpoint.port or 443
    path = "/internal/v1/recorder/fleet/nodes/" + body["provider_id"] + "/bootstrap"
    if operation == "abandon":
        path += "/abandon"
    payload = {**body, "schema_version": "recorder_fleet_bootstrap_abandon.v1" if operation == "abandon" else "recorder_fleet_bootstrap.v1"}
    command = ["curl", "--silent", "--show-error", "--max-time", "20", "--noproxy", "*",
               "--cert", root + environment["CHALK_RECORDER_FLEET_CONTROLLER_CERT"],
               "--key", root + environment["CHALK_RECORDER_FLEET_CONTROLLER_KEY"],
               "--cacert", root + environment["CHALK_RECORDER_FLEET_SERVER_CA"],
               "--connect-to", f"{server}:{port}:{endpoint.hostname}:{port}",
               "-H", "Content-Type: application/json", "--data-binary", "@-", "-w", "\n%{http_code}",
               f"https://{server}:{port}{path}"]
    result = subprocess.run(command, input=json.dumps(payload), text=True, capture_output=True, timeout=25)
    if result.returncode:
        raise RuntimeError("controller transport failed; credential paths and response suppressed")
    raw, status = result.stdout.rsplit("\n", 1)
    return {"status": int(status), "body": json.loads(raw) if raw else None}


def registration(issuer, root, provider_id):
    state = json.loads(pathlib.Path(root + issuer["CHALK_RECORDER_FLEET_ISSUER_STATE_PATH"]).read_text())
    record = state["registrations"].get(provider_id)
    ca = pathlib.Path(root + issuer["CHALK_RECORDER_FLEET_ISSUER_WORKER_CA_CERT"]).read_text()
    return {"record": record, "ca_pem": ca, "trust_domain": issuer["CHALK_RECORDER_FLEET_ISSUER_SPIFFE_TRUST_DOMAIN"]}


def bootstrap_pending(result):
    # The controller translates the issuer's 202 into this typed 409 response.
    return result["status"] == 409 and (result.get("body") or {}).get("error", {}).get("code") == "recorder_fleet.bootstrap_pending"


def duration_seconds(value):
    value = value.strip().removeprefix("+")
    units = {"ns": 1e-9, "us": 1e-6, "µs": 1e-6, "μs": 1e-6, "ms": 1e-3, "s": 1, "m": 60, "h": 3600}
    parts = re.findall(r"(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)", value)
    if not parts or "".join(number + unit for number, unit in parts) != value:
        raise ValueError("invalid fleet reconciliation duration")
    seconds = sum(float(number) * units[unit] for number, unit in parts)
    if seconds <= 0:
        raise ValueError("fleet reconciliation duration must be positive")
    return seconds


def execute(task):
    role = task["role"]
    container, environment, root = runtime("chalk-recorder-" + role)
    _, issuer, issuer_root = runtime("chalk-recorder-issuer")
    if task["action"] == "summary":
        keys = ("ENVIRONMENT", "ROLE", "OWNER_TAG", "DIGITALOCEAN_PROJECT_ID", "DIGITALOCEAN_VPC_UUID",
                "SSH_KEY_IDS", "REGION", "SIZE", "FIREWALL_ID", "BOOTSTRAP_ENDPOINT", "IMAGE_ID", "IMAGE_DIGEST",
                "RELEASE_ID", "JOURNAL_PATH", "RECONCILE_INTERVAL", "CONTROL_PLANE_URL", "SERVER_NAME")
        values = {key: environment.get("CHALK_RECORDER_FLEET_" + key, "") for key in keys}
        journal = json.loads(pathlib.Path(root + environment["CHALK_RECORDER_FLEET_JOURNAL_PATH"]).read_text())
        hostname = urlsplit(values["BOOTSTRAP_ENDPOINT"]).hostname
        return {"image": container["ImageName"], "env": values, "journal": journal,
                "dns": sorted({answer[4][0] for answer in socket.getaddrinfo(hostname, 8444)}),
                "issuer_control_plane_url": issuer["CHALK_RECORDER_FLEET_ISSUER_CONTROL_PLANE_URL"]}
    if task["action"] == "abandon":
        result = control(environment, root, task["bootstrap"], "abandon")
        return {**result, **registration(issuer, issuer_root, task["bootstrap"]["provider_id"])}
    deadline = time.monotonic() + task["timeout"]
    interval = duration_seconds(environment.get("CHALK_RECORDER_FLEET_RECONCILE_INTERVAL", "5s"))
    history = []
    while time.monotonic() < deadline:
        result = control(environment, root, task["bootstrap"], "register")
        history.append({"time": time.time(), "status": result["status"]})
        history = history[-50:]
        evidence = registration(issuer, issuer_root, task["bootstrap"]["provider_id"])
        if result["status"] == 200 and evidence["record"] and evidence["record"]["certificates"]:
            return {"history": history, "controller_response": result, "controller_request": {**task["bootstrap"], "schema_version": "recorder_fleet_bootstrap.v1"}, **evidence}
        if result["status"] != 202 and not bootstrap_pending(result):
            return {"history": history, "controller_response": result, "controller_request": {**task["bootstrap"], "schema_version": "recorder_fleet_bootstrap.v1"}, **evidence}
        time.sleep(min(interval, max(0, deadline - time.monotonic())))
    return {"history": history, **registration(issuer, issuer_root, task["bootstrap"]["provider_id"])}
