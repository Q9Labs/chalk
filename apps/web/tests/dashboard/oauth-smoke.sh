#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
: "${CHALK_API_SERVICE_SECRETS:?Run this as the final command of real-engine.sh}"
for name in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET APPLE_SERVICES_ID APPLE_TEAM_ID APPLE_KEY_ID APPLE_PRIVATE_KEY; do
  if [[ -z "${!name:-}" ]]; then echo "Missing OAuth runtime binding: $name" >&2; exit 1; fi
done
# CLI bindings are printed as plain text; .dev.vars bindings are hidden.
exec python3 - <<'PY'
import json, os, pathlib, secrets, signal, socket, subprocess, tempfile, time

port = int(os.environ.get("CHALK_OAUTH_PORT", "8788"))
api_port = int(os.environ.get("CHALK_DASHBOARD_API_PORT", "18080"))
seconds = int(os.environ.get("DASHBOARD_OAUTH_SMOKE_SECONDS", "1800"))
if seconds <= 0:
    raise SystemExit("DASHBOARD_OAUTH_SMOKE_SECONDS must be positive")
with socket.socket() as probe:
    probe.bind(("127.0.0.1", port))
web = pathlib.Path("apps/web").resolve()
if not (web / "dist/client/index.html").exists():
    raise SystemExit("Build apps/web first: pnpm exec turbo run build --filter=web...")
os.umask(0o077)
temporary = tempfile.TemporaryDirectory(prefix="chalk-oauth-smoke-", dir="/tmp", ignore_cleanup_errors=True)
sandbox = pathlib.Path(temporary.name)
pages = None
watchdog = None

def stop(*_):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    (sandbox / "public").mkdir()
    # Compile the real named Functions; do not serve a stale built worker.
    for asset in (web / "dist/client").iterdir():
        if asset.name not in ("_worker.js", "_routes.json"):
            (sandbox / "public" / asset.name).symlink_to(asset)
    (sandbox / "functions").symlink_to(web / "functions", target_is_directory=True)
    bindings = {
        "DASHBOARD_IDENTITY_PROVIDER": "oauth",
        "CHALK_ENVIRONMENT": "local",
        "DASHBOARD_ORIGIN": f"http://localhost:{port}",
        **{name: os.environ.pop(name) for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APPLE_SERVICES_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY")},
        "CHALK_API_ORIGIN": f"http://127.0.0.1:{api_port}",
        "DASHBOARD_SERVICE_TOKEN": os.environ["CHALK_API_SERVICE_SECRETS"],
        "SESSION_SECRET": os.environ.pop("SESSION_SECRET", secrets.token_urlsafe(48)),
    }
    (sandbox / ".dev.vars").write_text("".join(f"{key}={json.dumps(value)}\n" for key, value in bindings.items()))
    del bindings
    pages = subprocess.Popen([
        "pnpm", "exec", "wrangler", "pages", "dev", "public", "--cwd", str(sandbox),
        "--ip", "127.0.0.1", "--port", str(port), "--inspector-port", "0",
        "--compatibility-date", "2024-12-01", "--compatibility-flags", "nodejs_compat",
    ], cwd=web, env={**os.environ, "CI": "true", "WRANGLER_SEND_METRICS": "false"}, start_new_session=True)
    owner, upstream, group = os.getpid(), os.getppid(), pages.pid
    deadline = time.monotonic() + seconds
    print(f"OAuth smoke owner PID {owner}; Pages group {group}; deadline {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + seconds))}", flush=True)
    watchdog = os.fork()
    if watchdog == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        while time.monotonic() < deadline:
            try:
                os.kill(owner, 0)
                os.kill(upstream, 0)
            except ProcessLookupError:
                break
            time.sleep(1)
        try: os.killpg(group, signal.SIGTERM)
        except ProcessLookupError: pass
        try: os.kill(owner, signal.SIGTERM)
        except ProcessLookupError: pass
        time.sleep(3)
        try: os.killpg(group, signal.SIGKILL)
        except ProcessLookupError: pass
        temporary.cleanup()
        os._exit(0)
    raise SystemExit(pages.wait())
finally:
    if pages is not None:
        try: os.killpg(pages.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: pages.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(pages.pid, signal.SIGKILL)
            pages.wait()
    if watchdog:
        os.kill(watchdog, signal.SIGTERM)
        os.waitpid(watchdog, 0)
    temporary.cleanup()
PY
