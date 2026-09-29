#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: build-release.sh --source <chalk-checkout> --release-id <id> --output <absolute-tar-path>" >&2
  exit 2
}

source_root=""
release_id=""
output_path=""
while (($# > 0)); do
  case "$1" in
    --source) source_root="${2:-}"; shift 2 ;;
    --release-id) release_id="${2:-}"; shift 2 ;;
    --output) output_path="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$source_root" == /* && -f "$source_root/apps/api/go.mod" ]] || usage
[[ "$output_path" == /* && ! -e "$output_path" ]] || usage
[[ "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || usage

source_commit="$(git -C "$source_root" rev-parse HEAD)"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || usage
source_tree_sha256="$(
  git -C "$source_root" ls-files -z --cached --others --exclude-standard |
    tar -C "$source_root" --null --files-from=- --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - |
    sha256sum | cut -d' ' -f1
)"

stage_root="$(mktemp -d)"
trap 'rm -rf -- "$stage_root"' EXIT
install -d -m 0755 "$stage_root/release/bin"
(
  cd "$source_root/apps/api"
  export CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOENV=off
  go build -trimpath -ldflags='-s -w' -o "$stage_root/release/bin/recorder-capture" ./cmd/recorder-capture
  go build -trimpath -ldflags='-s -w' -o "$stage_root/release/bin/chalk-recorder-bootstrap" ./cmd/recorder-node-bootstrap
)
jq -cS -n --arg release_id "$release_id" --arg source_commit "$source_commit" \
  --arg source_tree_sha256 "$source_tree_sha256" --arg go_version "$(go version)" \
  '{schema_version:"chalk_recorder_capture_build.v1",release_id:$release_id,source_commit:$source_commit,source_tree_sha256:$source_tree_sha256,go_version:$go_version}' \
  >"$stage_root/release/build-info.json"

install -d "$(dirname -- "$output_path")"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf "$output_path" -C "$stage_root" release
bundle_sha256="$(sha256sum "$output_path" | cut -d' ' -f1)"
printf '%s  %s\n' "$bundle_sha256" "$(basename -- "$output_path")" >"$output_path.sha256"
printf 'release_id=%s\nsource_commit=%s\nsource_tree_sha256=sha256:%s\nbundle_sha256=sha256:%s\n' \
  "$release_id" "$source_commit" "$source_tree_sha256" "$bundle_sha256"
