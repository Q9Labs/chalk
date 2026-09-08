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

[[ "$(id -u)" == "0" ]] || { echo "build-release must run as root" >&2; exit 1; }
[[ "$source_root" == /* && -f "$source_root/package.json" && -f "$source_root/apps/api/go.mod" ]] || usage
[[ "$output_path" == /* && ! -e "$output_path" ]] || usage
[[ "$release_id" =~ ^[a-z0-9][a-z0-9._-]{0,127}$ ]] || usage
if find "$source_root/apps/recording-renderer" -maxdepth 1 -type f -name '.env*' -print -quit | grep -q .; then
  echo "recording renderer source contains an environment file; refusing a public release build" >&2
  exit 1
fi

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_root/prepare-builder.sh"
export PATH="/opt/chalk-recorder/toolchains/go-1.25.13/bin:/opt/chalk-recorder/toolchains/node-22.23.2/bin:$PATH"
source_commit="$(git -C "$source_root" rev-parse HEAD)"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "source checkout has no full Git commit identity" >&2; exit 1; }
source_tree_sha256="$(
  git -C "$source_root" ls-files -z --cached --others --exclude-standard |
    tar -C "$source_root" --null --files-from=- --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - |
    sha256sum | cut -d' ' -f1
)"

build_cache_root="$(mktemp -d)"
trap 'rm -rf -- "$build_cache_root"' EXIT
pnpm_environment=(env -i PATH="$PATH" LANG=C.UTF-8 CI=1 COREPACK_HOME=/opt/chalk-recorder/toolchains/corepack XDG_CACHE_HOME="$build_cache_root/xdg-cache" XDG_CONFIG_HOME="$build_cache_root/xdg-config" XDG_DATA_HOME="$build_cache_root/xdg-data")
"${pnpm_environment[@]}" pnpm --dir "$source_root" install --frozen-lockfile
"${pnpm_environment[@]}" pnpm --dir "$source_root" --filter '@chalk/recording-renderer^...' build
"${pnpm_environment[@]}" pnpm --dir "$source_root/apps/recording-renderer" run build

stage_root="$(mktemp -d)"
trap 'rm -rf -- "$stage_root" "$build_cache_root"' EXIT
release_root="$stage_root/release"
install -d -m 0755 "$release_root/bin" "$release_root/renderer"
(
  cd "$source_root/apps/api"
  go_environment=(env -i PATH="$PATH" LANG=C.UTF-8 GOENV=off GOCACHE="$build_cache_root/go-build" GOMODCACHE="$build_cache_root/go-mod" GOPATH="$build_cache_root/go-path" CGO_ENABLED=0 GOOS=linux GOARCH=amd64)
  "${go_environment[@]}" go build -trimpath -ldflags='-s -w' -o "$release_root/bin/recorder-capture" ./cmd/recorder-capture
  "${go_environment[@]}" go build -trimpath -ldflags='-s -w' -o "$release_root/bin/recorder-render" ./cmd/recorder-render
  "${go_environment[@]}" go build -trimpath -ldflags='-s -w' -o "$release_root/bin/chalk-recorder-bootstrap" ./cmd/recorder-node-bootstrap
)
"${pnpm_environment[@]}" pnpm --dir "$source_root" --filter @chalk/recording-renderer deploy --prod --legacy "$release_root/renderer"
install -d "$release_root/renderer/dist"
cp -a "$source_root/apps/recording-renderer/dist/." "$release_root/renderer/dist/"

export PLAYWRIGHT_BROWSERS_PATH="$release_root/ms-playwright"
"$release_root/renderer/node_modules/.bin/playwright" install chromium
ui_build_sha256="$(jq -er '.sha256 | select(test("^[0-9a-f]{64}$"))' "$release_root/renderer/dist/client/recording-ui-build.json")"
jq -cS -n \
  --arg release_id "$release_id" \
  --arg source_commit "$source_commit" \
  --arg source_tree_sha256 "$source_tree_sha256" \
  --arg ui_build_sha256 "$ui_build_sha256" \
  '{schema_version:"chalk_recorder_cpu_build.v1",release_id:$release_id,source_commit:$source_commit,source_tree_sha256:$source_tree_sha256,go_version:"1.25.13",node_version:"22.23.2",pnpm_version:"10.26.2",ui_build_sha256:$ui_build_sha256,encoder:"libx264",render_frame_concurrency:8}' \
  >"$release_root/build-info.json"

install -d "$(dirname -- "$output_path")"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf "$output_path" -C "$stage_root" release
bundle_sha256="$(sha256sum "$output_path" | cut -d' ' -f1)"
printf '%s  %s\n' "$bundle_sha256" "$(basename -- "$output_path")" >"$output_path.sha256"
printf 'release_id=%s\nsource_commit=%s\nsource_tree_sha256=sha256:%s\nbundle_sha256=sha256:%s\nui_build_sha256=%s\n' "$release_id" "$source_commit" "$source_tree_sha256" "$bundle_sha256" "$ui_build_sha256"
