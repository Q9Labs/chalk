#!/usr/bin/env bash
# Linux-only dependency setup, using the same version sources as Gate CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$1"
shift
export CI=true DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/go/bin:/opt/elixir/bin:/opt/otp/bin:$PATH"
export GOFLAGS=-buildvcs=false
step() { printf '\nCHALK_PHASE %s %s\n==> %s — %s\n' "$(date +%s.%N)" "$*" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
trap 'status=$?; step "end exit=$status"' EXIT
version() { awk -v tool="$1" '$1 == tool {print $2}' .tool-versions; }

step 'Box resources and background services'
nproc
free -m
grep -m1 'model name' /proc/cpuinfo
for unit in unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer fwupd.service fwupd-refresh.timer; do
  state="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  printf '%s %s\n' "$unit" "$state"
  [[ "$state" == masked ]] || { echo "Background unit is not masked: $unit" >&2; exit 1; }
done

step 'Node (CI .tool-versions)'
node_version="$(version nodejs)"
if [[ "$(node --version)" != "v$node_version" ]]; then
  curl -fsSLO "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" | grep " node-v$node_version-linux-x64.tar.xz\$" | sha256sum -c -
  tar -xJf "node-v$node_version-linux-x64.tar.xz" -C /usr/local --strip-components=1
  rm "node-v$node_version-linux-x64.tar.xz"
fi
# Resource probing uses the Node version provisioned above.
source scripts/gates/with-resources.sh
if [[ "$gate" != recorder ]]; then
  step 'Go (CI apps/api/go.mod)'
  go_version="$(awk '$1 == "go" {print $2}' apps/api/go.mod)"
  if [[ "$(go version 2>/dev/null | awk '{print $3}')" != "go$go_version" ]]; then
    curl -fsSL "https://go.dev/dl/go$go_version.linux-amd64.tar.gz" -o /tmp/go.tar.gz
    curl -fsSL 'https://go.dev/dl/?mode=json&include=all' -o /tmp/go-releases.json
    checksum="$(python3 -c 'import json,sys; print(next(f["sha256"] for r in json.load(open("/tmp/go-releases.json")) for f in r["files"] if f["filename"] == sys.argv[1]))' "go$go_version.linux-amd64.tar.gz")"
    echo "$checksum  /tmp/go.tar.gz" | sha256sum -c -
    if [[ -d /usr/local/go ]]; then mv /usr/local/go "/usr/local/go.previous.$(date +%s)"; fi
    tar -xzf /tmp/go.tar.gz -C /usr/local
  fi
  step 'Erlang (CI .tool-versions)'
  if [[ "$(cat /opt/otp/releases/*/OTP_VERSION 2>/dev/null)" != "$(version erlang)" ]]; then
    apt-get update -qq
    apt-get install -y -qq libncurses6 libtinfo6 libsctp1 libssl3 unzip
    if [[ -d /opt/otp ]]; then mv /opt/otp "/opt/otp.previous.$(date +%s)"; fi
    mkdir -p /opt/otp
    curl -fsSL "https://builds.hex.pm/builds/otp/amd64/ubuntu-24.04/OTP-$(version erlang).tar.gz" | tar -xz --strip-components=1 -C /opt/otp
    (cd /opt/otp && ./Install -minimal /opt/otp)
  fi
  step 'Elixir and Hex/Rebar (CI .tool-versions)'
  elixir_pin="$(version elixir)"
  elixir_installed="$(elixir --version 2>/dev/null || true)"
  if [[ "$elixir_installed" != *"Elixir ${elixir_pin%-otp-*} (compiled with Erlang/OTP ${elixir_pin##*-otp-})"* ]]; then
    if [[ -d /opt/elixir ]]; then mv /opt/elixir "/opt/elixir.previous.$(date +%s)"; fi
    mkdir -p /opt/elixir
    curl -fsSL "https://builds.hex.pm/builds/elixir/v$(version elixir).zip" -o /tmp/elixir.zip
    unzip -q /tmp/elixir.zip -d /opt/elixir
  fi
  if ! mix help hex >/dev/null 2>&1; then mix local.hex --force; fi
  elixir -e 'Mix.start(); unless Mix.Rebar.available?(:rebar3), do: Mix.Task.run("local.rebar", ["--force"])'
fi
if [[ "$gate" == root || "$gate" == recorder || "$gate" == -- ]]; then
  step 'OpenTofu (same version and checksum as CI setup-opentofu action)'
  tofu_version="$(version opentofu)"
  case "$tofu_version" in
    1.12.3) checksum=f87d45408dcbb963ddbe10b2f75e55b3495310556e05c35765dfd5913551f182 ;;
    *) echo "No pinned OpenTofu checksum for $tofu_version; update alongside .github/actions/setup-opentofu/action.yml" >&2; exit 2 ;;
  esac
  if ! tofu version 2>/dev/null | grep -q "^OpenTofu v$tofu_version$"; then
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v$tofu_version/tofu_${tofu_version}_linux_amd64.tar.gz" -o /tmp/tofu.tar.gz
    echo "$checksum  /tmp/tofu.tar.gz" | sha256sum -c -
    tar -xzf /tmp/tofu.tar.gz -C /usr/local/bin tofu
  fi
fi
step 'pnpm install'
pnpm install --frozen-lockfile
if [[ "$gate" == root || "$gate" == -- ]]; then
  step 'Gitleaks (same pin as scripts/gates/gitleaks.sh fallback)'
  if [[ "$(gitleaks version 2>/dev/null)" != 8.30.1 ]]; then
    GOBIN=/usr/local/bin go install github.com/zricethezav/gitleaks/v8@v8.30.1
  fi
  step 'Semgrep (CI pin)'
  if [[ "$(semgrep --version 2>/dev/null)" != 1.179.0 ]]; then
    python3 -m venv /opt/chalk-semgrep
    /opt/chalk-semgrep/bin/pip install --disable-pip-version-check semgrep==1.179.0
    export PATH="/opt/chalk-semgrep/bin:$PATH"
  fi
  step 'Playwright Chromium (repo revision)'
  if [[ "$(playwright --version 2>/dev/null)" == "$(pnpm --dir sdks/typescript/client exec playwright --version)" ]]; then
    pnpm --dir sdks/typescript/client exec playwright install chromium
  else
    pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium
  fi
fi
step "gate: $gate $*"
case "$gate" in
  # The package alias clamps Go to one CPU for local use. Keep the same script
  # and lane selection, with pnpm's binary PATH and the box's CPU allowance.
  root) pnpm exec bash scripts/gates/commit.sh --base "${CHALK_REMOTE_BASE_REF:-origin/master}" "$@" ;;
  api) apps/api/scripts/gate.sh "$@" ;;
  sync) scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh "$@" ;;
  recorder) bash scripts/recorder/gate.sh "$@" ;;
  --) "$@" ;;
esac
