#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: install.sh --bundle <absolute-tar-path> --bundle-sha256 <sha256> --bootstrap-ca <pem> --bootstrap-server-name <name>" >&2
  exit 2
}

bundle_path=""
bundle_sha256=""
bootstrap_ca=""
bootstrap_server_name=""
while (($# > 0)); do
  case "$1" in
    --bundle) bundle_path="${2:-}"; shift 2 ;;
    --bundle-sha256) bundle_sha256="${2:-}"; shift 2 ;;
    --bootstrap-ca) bootstrap_ca="${2:-}"; shift 2 ;;
    --bootstrap-server-name) bootstrap_server_name="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$(id -u)" == "0" ]] || { echo "install must run as root" >&2; exit 1; }
[[ "$bundle_path" == /* && -f "$bundle_path" ]] || usage
[[ "$bootstrap_ca" == /* && -f "$bootstrap_ca" ]] || usage
bundle_sha256="${bundle_sha256#sha256:}"
[[ "$bundle_sha256" =~ ^[0-9a-f]{64}$ ]] || usage
[[ "$bootstrap_server_name" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || usage
printf '%s  %s\n' "$bundle_sha256" "$bundle_path" | sha256sum --check --strict

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_root/prepare-builder.sh"
stage_root="$(mktemp -d)"
trap 'rm -rf -- "$stage_root"' EXIT
while IFS= read -r entry; do
  [[ "$entry" == release || "$entry" == release/* ]] || { echo "release bundle contains an out-of-root path" >&2; exit 1; }
  [[ "$entry" != *'/../'* && "$entry" != '../'* ]] || { echo "release bundle contains path traversal" >&2; exit 1; }
done < <(tar -tzf "$bundle_path")
tar -xzf "$bundle_path" -C "$stage_root"

bundle_root="$stage_root/release"
release_id="$(jq -er '.release_id | select(test("^[a-z0-9][a-z0-9._-]{0,127}$"))' "$bundle_root/build-info.json")"
source_commit="$(jq -er '.source_commit | select(test("^[0-9a-f]{40}$"))' "$bundle_root/build-info.json")"
source_tree_sha256="$(jq -er '.source_tree_sha256 | select(test("^[0-9a-f]{64}$"))' "$bundle_root/build-info.json")"
ui_build_sha256="$(jq -er '.ui_build_sha256 | select(test("^[0-9a-f]{64}$"))' "$bundle_root/build-info.json")"
[[ "$(jq -er '.schema_version' "$bundle_root/build-info.json")" == "chalk_recorder_cpu_build.v1" ]] || { echo "release bundle schema is unsupported" >&2; exit 1; }
[[ ! -e "/opt/chalk-recorder/releases/$release_id" ]] || { echo "release $release_id is already installed" >&2; exit 1; }
for binary in recorder-capture recorder-render chalk-recorder-bootstrap; do
  [[ -x "$bundle_root/bin/$binary" ]] || { echo "release bundle is missing $binary" >&2; exit 1; }
done
[[ -f "$bundle_root/renderer/dist/client/recording-ui-build.json" && -f "$bundle_root/renderer/dist/recording-ui-builds.json" && -f "$bundle_root/renderer/dist/node/ui-build-registry-cli.js" && -x "$bundle_root/renderer/node_modules/.bin/playwright" ]] || { echo "release bundle is missing renderer runtime artifacts" >&2; exit 1; }

/opt/chalk-recorder/toolchains/node-22.23.2/bin/node "$bundle_root/renderer/dist/node/ui-build-registry-cli.js" verify "$bundle_root/renderer/dist" >/dev/null

export PLAYWRIGHT_BROWSERS_PATH="$bundle_root/ms-playwright"
"$bundle_root/renderer/node_modules/.bin/playwright" install-deps chromium
(
  cd "$bundle_root/renderer"
  /opt/chalk-recorder/toolchains/node-22.23.2/bin/node --input-type=module -e 'import { chromium } from "playwright"; const browser = await chromium.launch({headless:true}); await browser.close();'
)
ffmpeg_encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
grep -Fq 'libx264 ' <<<"$ffmpeg_encoders" || { echo "installed FFmpeg does not expose libx264" >&2; exit 1; }

image_root="$stage_root/image-root"
release_root="$image_root/opt/chalk-recorder/releases/$release_id"
install -d -m 0755 "$image_root/etc/chalk-recorder" "$image_root/etc/systemd/system" "$image_root/opt/chalk-recorder/releases" "$image_root/opt/chalk-recorder/toolchains" "$image_root/usr/local/sbin"
mv "$bundle_root" "$release_root"
cp -a /opt/chalk-recorder/toolchains/node-22.23.2 "$image_root/opt/chalk-recorder/toolchains/node-22.23.2"
ln -s "releases/$release_id" "$image_root/opt/chalk-recorder/current"
ln -s /opt/chalk-recorder/current/bin/chalk-recorder-bootstrap "$image_root/usr/local/sbin/chalk-recorder-bootstrap"
install -m 0644 "$bootstrap_ca" "$image_root/etc/chalk-recorder/bootstrap-ca.pem"
for unit in chalk-recorder-capture.service chalk-recorder-render.service chalk-recorder-renew.service chalk-recorder-renew.timer; do
  install -m 0644 "$script_root/systemd/$unit" "$image_root/etc/systemd/system/$unit"
done

cat >"$image_root/etc/chalk-recorder/render.env" <<EOF
CHALK_RECORDING_RENDER_WORK_ROOT=/var/lib/chalk-recorder/render
CHALK_RECORDING_NODE_PATH=/opt/chalk-recorder/toolchains/node-22.23.2/bin/node
CHALK_RECORDING_RENDERER_SCRIPT=/opt/chalk-recorder/current/renderer/dist/node/cli.js
CHALK_RECORDING_UI_BUILD_REGISTRY=/opt/chalk-recorder/current/renderer/dist/recording-ui-builds.json
CHALK_RECORDING_FFMPEG_PATH=/usr/bin/ffmpeg
CHALK_RECORDING_FFPROBE_PATH=/usr/bin/ffprobe
CHALK_RECORDING_VIDEO_ENCODER=libx264
PLAYWRIGHT_BROWSERS_PATH=/opt/chalk-recorder/current/ms-playwright
EOF

file_entries="$stage_root/file-entries.ndjson"
: >"$file_entries"
while IFS= read -r -d '' staged_file; do
  installed_path="${staged_file#"$image_root"}"
  if [[ -L "$staged_file" ]]; then
    path_type="symlink"
    file_digest="$(readlink -n -- "$staged_file" | sha256sum | cut -d' ' -f1)"
  else
    path_type="file"
    file_digest="$(sha256sum "$staged_file" | cut -d' ' -f1)"
  fi
  jq -cn --arg path "$installed_path" --arg type "$path_type" --arg sha256 "$file_digest" '{path:$path,type:$type,sha256:$sha256}' >>"$file_entries"
done < <(find "$image_root/etc" "$image_root/opt" "$image_root/usr" \( -type f -o -type l \) -print0 | sort -z)

jq -cS -s \
  --arg release_id "$release_id" \
  --arg source_commit "$source_commit" \
  --arg source_tree_sha256 "$source_tree_sha256" \
  '{schema_version:"chalk_recorder_cpu_image.v1",release_id:$release_id,source_commit:$source_commit,source_tree_sha256:$source_tree_sha256,profile:"cpu-libx264-frame2",files:.}' \
  "$file_entries" >"$image_root/opt/chalk-recorder/image-manifest.json"
image_digest="sha256:$(sha256sum "$image_root/opt/chalk-recorder/image-manifest.json" | cut -d' ' -f1)"

cat >"$image_root/etc/chalk-recorder/image.env" <<EOF
CHALK_RECORDER_IMAGE_GPU=false
CHALK_RECORDER_INSTALLED_RELEASE_ID=$release_id
CHALK_RECORDER_INSTALLED_IMAGE_DIGEST=$image_digest
CHALK_RECORDER_IMAGE_MANIFEST=/opt/chalk-recorder/image-manifest.json
CHALK_RECORDER_BOOTSTRAP_CA_FILE=/etc/chalk-recorder/bootstrap-ca.pem
CHALK_RECORDER_BOOTSTRAP_SERVER_NAME=$bootstrap_server_name
CHALK_RECORDER_IDENTITY_DIRECTORY=/etc/chalk-recorder/identity
CHALK_RECORDER_WORKER_ENV_FILE=/etc/chalk-recorder/worker.env
CHALK_RECORDER_NODE_ENV_FILE=/etc/chalk-recorder/node.env
EOF

getent group chalk-recorder >/dev/null || groupadd --system chalk-recorder
id chalk-recorder >/dev/null 2>&1 || useradd --system --gid chalk-recorder --home-dir /var/lib/chalk-recorder --shell /usr/sbin/nologin chalk-recorder
cp -a "$image_root/." /
install -d -o root -g chalk-recorder -m 2750 /etc/chalk-recorder/identity
install -d -o chalk-recorder -g chalk-recorder -m 0700 /var/lib/chalk-recorder /var/lib/chalk-recorder/render /run/chalk-recorder
chown root:chalk-recorder /etc/chalk-recorder /etc/chalk-recorder/image.env /etc/chalk-recorder/render.env
chmod 0750 /etc/chalk-recorder
chmod 0440 /etc/chalk-recorder/image.env /etc/chalk-recorder/render.env
chown -R root:root "/opt/chalk-recorder/releases/$release_id" /opt/chalk-recorder/image-manifest.json
chmod 0755 "/opt/chalk-recorder/releases/$release_id/bin/recorder-capture" "/opt/chalk-recorder/releases/$release_id/bin/recorder-render" "/opt/chalk-recorder/releases/$release_id/bin/chalk-recorder-bootstrap"

systemctl daemon-reload
systemctl disable chalk-recorder-capture.service chalk-recorder-render.service chalk-recorder-renew.timer >/dev/null 2>&1 || true
printf 'release_id=%s\nsource_commit=%s\nsource_tree_sha256=sha256:%s\nbundle_sha256=sha256:%s\nimage_manifest_digest=%s\nui_build_sha256=%s\n' "$release_id" "$source_commit" "$source_tree_sha256" "$bundle_sha256" "$image_digest" "$ui_build_sha256"
