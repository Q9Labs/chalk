"""Read-only node evidence collection. Never read identity private keys."""
import hashlib
import json
import pathlib
import subprocess


def collect():
    files = {}
    paths = ["/etc/chalk-recorder/image.env", "/etc/chalk-recorder/diagnostic-bootstrap.env",
             "/etc/chalk-recorder/bootstrap.env", "/etc/chalk-recorder/node.env", "/etc/chalk-recorder/worker.env",
             "/opt/chalk-recorder/image-manifest.json", "/opt/chalk-recorder/current/build-info.json",
             "/var/lib/cloud/instance/user-data.txt", "/var/lib/cloud/instance/scripts/runcmd",
             "/var/log/cloud-init.log", "/var/log/cloud-init-output.log", "/etc/hosts", "/etc/resolv.conf",
             "/etc/cloud/cloud.cfg", "/etc/cloud/templates/hosts.debian.tmpl",
             "/etc/chalk-recorder/identity/client-cert.pem"]
    paths += [str(p) for p in pathlib.Path("/etc/cloud/cloud.cfg.d").glob("*.cfg")]
    for name in paths:
        path = pathlib.Path(name)
        if path.is_file():
            raw = path.read_bytes()
            if name == "/opt/chalk-recorder/image-manifest.json":
                manifest = json.loads(raw)
                fields = {key: manifest[key] for key in ("source_commit", "release_id", "source_tree_sha256")}
                files[name] = {"content": json.dumps(fields), "sha256": hashlib.sha256(raw).hexdigest(), "summary_only": True}
            elif len(raw) <= 2 << 20:
                files[name] = {"content": raw.decode(errors="replace"), "sha256": hashlib.sha256(raw).hexdigest()}
    commands = {"cloud_init": ["cloud-init", "status", "--long"], "addresses": ["ip", "address"],
                "routes": ["ip", "route"], "clock": ["timedatectl"],
                "resolver": ["resolvectl", "status"], "network_units": ["systemctl", "status", "networking", "systemd-networkd", "ssh", "--no-pager"],
                "units": ["systemctl", "status", "chalk-recorder-capture.service", "chalk-recorder-render.service", "--no-pager"],
                "journal": ["journalctl", "-b", "--no-pager", "-n", "1000"]}
    results = {}
    for name, command in commands.items():
        try:
            result = subprocess.run(command, text=True, capture_output=True, timeout=8)
            results[name] = {"status": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
        except subprocess.TimeoutExpired:
            results[name] = {"status": "TIMEOUT"}
        except FileNotFoundError:
            results[name] = {"status": "UNAVAILABLE"}
    process = []
    for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
        try:
            raw = path.read_bytes()
            if raw.startswith(b"/usr/local/sbin/chalk-recorder-bootstrap\x00"):
                env = (path.parent / "environ").read_bytes().split(b"\x00")
                process.append({"pid": path.parent.name, "cmdline": raw.decode().split("\x00"),
                                "environment": [v.decode() for v in env if v.startswith(b"CHALK_RECORDER_")]})
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return {"files": files, "commands": results, "bootstrap_processes": process}
