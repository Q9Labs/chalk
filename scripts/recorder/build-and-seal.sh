#!/usr/bin/env bash
set -euo pipefail
# Uploaded once. The same connection verifies sealing; never reconnect after success.
validate=false
if [[ "${1:-}" == --validate ]]; then validate=true; shift; fi
[[ $# == 3 ]] || { echo 'usage: build-and-seal.sh [--validate] <source-commit> <release-id> <capture|render>' >&2; exit 2; }
source_commit="$1"
release_id="$2"
role="$3"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ && "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || exit 2
[[ "$role" == capture || "$role" == render ]] || exit 2
if [[ "$validate" == true ]]; then
  source_root="$(cd "$(dirname "$0")/../.." && pwd)"
  [[ "$(git -C "$source_root" rev-parse HEAD)" == "$source_commit" ]]
  profile=cpu
  [[ "$role" != capture ]] || profile=capture
  for script in "$source_root/infrastructure/recorder/images/$profile/"{build-release,install}.sh "$source_root/infrastructure/recorder/images/cpu/seal.sh"; do
    [[ -x "$script" ]]
    bash -n "$script"
  done
  [[ -f "$source_root/apps/api/go.mod" ]]
  if [[ "$role" == render ]]; then
    [[ -f "$source_root/apps/recording-renderer/package.json" ]]
    if find "$source_root/apps/recording-renderer" -maxdepth 1 -type f -name '.env*' -print -quit | grep -q .; then
      echo 'recording renderer source contains an environment file' >&2
      exit 1
    fi
  fi
  printf '{"result":"PASS","role":"%s","validation_only":true,"built":false,"sealed":false}\n' "$role"
  exit
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git ca-certificates curl jq
build_root=/opt/chalk-release-build
[[ ! -e "$build_root" ]] || { echo 'build tree already exists' >&2; exit 1; }
install -d "$build_root"
git clone --filter=blob:none --no-checkout https://github.com/Q9Labs/chalk.git "$build_root/source"
git -C "$build_root/source" checkout --detach "$source_commit"
[[ "$(git -C "$build_root/source" rev-parse HEAD)" == "$source_commit" ]]
profile=cpu
[[ "$role" != capture ]] || profile=capture
"$build_root/source/infrastructure/recorder/images/$profile/build-release.sh" \
  --source "$build_root/source" --release-id "$release_id" --output "$build_root/release.tar.gz"
"$build_root/source/infrastructure/recorder/images/$profile/install.sh" \
  --bundle "$build_root/release.tar.gz" --bundle-sha256 "$(sha256sum "$build_root/release.tar.gz" | cut -d ' ' -f1)"
setpriv --reuid chalk-recorder --regid chalk-recorder --clear-groups test -x "/opt/chalk-recorder/current/bin/recorder-$role"
setpriv --reuid chalk-recorder --regid chalk-recorder --clear-groups "/opt/chalk-recorder/current/bin/recorder-$role" --help >/dev/null
if [[ "$role" == render ]]; then
  setpriv --reuid chalk-recorder --regid chalk-recorder --clear-groups test -r /opt/chalk-recorder/current/renderer/dist/node/compose.js
fi
printf 'CHALK_RELEASE_MANIFEST '
base64 -w0 /opt/chalk-recorder/image-manifest.json
printf '\n'
install -m 0700 "$build_root/source/infrastructure/recorder/images/cpu/seal.sh" /root/chalk-release-seal.sh
find "$build_root" -depth -delete
unlink /root/chalk-release-build.sh
bash /root/chalk-release-seal.sh
unlink /root/chalk-release-seal.sh
test ! -e "$build_root"
test ! -e /root/chalk-release-ca.pem
test ! -e /root/chalk-release-build.sh
test ! -e /root/chalk-release-seal.sh
test ! -s /etc/machine-id
test -f /opt/chalk-recorder/image-manifest.json
test ! -e /etc/chalk-recorder/worker.env
test ! -e /etc/chalk-recorder/bootstrap.env
test -z "$(find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*' -print -quit)"
printf 'SEALED_READONLY_VERIFICATION_PASS\n'
