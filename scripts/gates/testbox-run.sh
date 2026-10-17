#!/usr/bin/env bash
# Linux-only dependency setup, using the same version sources as Gate CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
gate="$1"
shift
export CI=true DEBIAN_FRONTEND=noninteractive
export GOFLAGS=-buildvcs=false GOMAXPROCS=2 VITEST_MAX_WORKERS=2
export ERL_FLAGS='+S 2:2'
step() { printf '\n==> %s\n' "$*"; }
version() { awk -v tool="$1" '$1 == tool {print $2}' .tool-versions; }

step 'Node (CI .tool-versions)'
node_version="$(version nodejs)"
if [[ "$(node --version)" != "v$node_version" ]]; then
  curl -fsSLO "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" | grep " node-v$node_version-linux-x64.tar.xz\$" | sha256sum -c -
  tar -xJf "node-v$node_version-linux-x64.tar.xz" -C /usr/local --strip-components=1
  rm "node-v$node_version-linux-x64.tar.xz"
fi
if [[ "$gate" != recorder ]]; then
  step 'Go (CI apps/api/go.mod)'
  go_version="$(awk '$1 == "go" {print $2}' apps/api/go.mod)"
  curl -fsSL "https://go.dev/dl/go$go_version.linux-amd64.tar.gz" -o /tmp/go.tar.gz
  curl -fsSL 'https://go.dev/dl/?mode=json&include=all' -o /tmp/go-releases.json
  checksum="$(python3 -c 'import json,sys; print(next(f["sha256"] for r in json.load(open("/tmp/go-releases.json")) for f in r["files"] if f["filename"] == sys.argv[1]))' "go$go_version.linux-amd64.tar.gz")"
  echo "$checksum  /tmp/go.tar.gz" | sha256sum -c -
  tar -xzf /tmp/go.tar.gz -C /usr/local
  export PATH="/usr/local/go/bin:$PATH"
  step 'Erlang and Elixir (CI .tool-versions)'
  apt-get update -qq
  apt-get install -y -qq libncurses6 libtinfo6 libsctp1 libssl3 unzip
  mkdir -p /opt/otp /opt/elixir
  curl -fsSL "https://builds.hex.pm/builds/otp/amd64/ubuntu-24.04/OTP-$(version erlang).tar.gz" | tar -xz --strip-components=1 -C /opt/otp
  (cd /opt/otp && ./Install -minimal /opt/otp)
  curl -fsSL "https://builds.hex.pm/builds/elixir/v$(version elixir).zip" -o /tmp/elixir.zip
  unzip -q /tmp/elixir.zip -d /opt/elixir
  export PATH="/opt/elixir/bin:/opt/otp/bin:$PATH"
  mix local.hex --force
  mix local.rebar --force
fi
if [[ "$gate" == root || "$gate" == recorder || "$gate" == -- ]]; then
  step 'OpenTofu (same version and checksum as CI setup-opentofu action)'
  tofu_version="$(version opentofu)"
  case "$tofu_version" in
    1.12.3) checksum=f87d45408dcbb963ddbe10b2f75e55b3495310556e05c35765dfd5913551f182 ;;
    *) echo "No pinned OpenTofu checksum for $tofu_version; update alongside .github/actions/setup-opentofu/action.yml" >&2; exit 2 ;;
  esac
  curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v$tofu_version/tofu_${tofu_version}_linux_amd64.tar.gz" -o /tmp/tofu.tar.gz
  echo "$checksum  /tmp/tofu.tar.gz" | sha256sum -c -
  tar -xzf /tmp/tofu.tar.gz -C /usr/local/bin tofu
fi
step 'pnpm install'
pnpm install --frozen-lockfile
if [[ "$gate" == root || "$gate" == -- ]]; then
  step 'Gitleaks (same pin as scripts/gates/gitleaks.sh fallback)'
  GOBIN=/usr/local/bin go install github.com/zricethezav/gitleaks/v8@v8.30.1
  step 'Semgrep (CI pin)'
  python3 -m venv /opt/chalk-semgrep
  /opt/chalk-semgrep/bin/pip install --disable-pip-version-check semgrep==1.179.0
  export PATH="/opt/chalk-semgrep/bin:$PATH"
  step 'Playwright Chromium (repo revision)'
  pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium
fi
step "gate: $gate $*"
case "$gate" in
  root) pnpm run gate -- --base "${CHALK_REMOTE_BASE_REF:-origin/master}" "$@" ;;
  api) apps/api/scripts/gate.sh "$@" ;;
  sync) scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh "$@" ;;
  recorder) bash scripts/recorder/gate.sh "$@" ;;
  --) "$@" ;;
esac
