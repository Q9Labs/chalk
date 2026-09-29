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
[[ "$(id -u)" == "0" ]] || usage
[[ "$bundle_path" == /* && -f "$bundle_path" && "$bootstrap_ca" == /* && -f "$bootstrap_ca" ]] || usage
bundle_sha256="${bundle_sha256#sha256:}"
[[ "$bundle_sha256" =~ ^[0-9a-f]{64}$ && "$bootstrap_server_name" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || usage
source /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "13" && "$(uname -m)" == "x86_64" ]] || {
  echo "capture image requires Debian 13 x86_64" >&2; exit 1;
}
printf '%s  %s\n' "$bundle_sha256" "$bundle_path" | sha256sum --check --strict

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
stage_root="$(mktemp -d)"
trap 'rm -rf -- "$stage_root"' EXIT
while IFS= read -r entry; do
  [[ "$entry" == release || "$entry" == release/* ]] || { echo "out-of-root bundle path" >&2; exit 1; }
  [[ "$entry" != *'/../'* && "$entry" != '../'* && "$entry" != */.. ]] || { echo "bundle path traversal" >&2; exit 1; }
done < <(tar -tzf "$bundle_path")
tar -xzf "$bundle_path" --no-same-owner --no-same-permissions -C "$stage_root"
release_root="$stage_root/release"
for binary in recorder-capture chalk-recorder-bootstrap; do
  [[ -f "$release_root/bin/$binary" && ! -L "$release_root/bin/$binary" ]] || { echo "missing capture binary" >&2; exit 1; }
done
if find "$release_root" \( -type l -o ! -type f -a ! -type d \) -print -quit | grep -q .; then
  echo "unsupported bundle entry" >&2; exit 1
fi

read -r release_id source_commit source_tree_sha256 < <(
  python3 - "$release_root/build-info.json" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
assert data['schema_version'] == 'chalk_recorder_capture_build.v1'
assert re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,127}', data['release_id'])
assert re.fullmatch(r'[0-9a-f]{40}', data['source_commit'])
assert re.fullmatch(r'[0-9a-f]{64}', data['source_tree_sha256'])
print(data['release_id'], data['source_commit'], data['source_tree_sha256'])
PY
)
image_root="$stage_root/image"
install -d -m 0755 "$image_root/etc/chalk-recorder" "$image_root/etc/systemd/system" \
  "$image_root/opt/chalk-recorder/releases" "$image_root/usr/local/sbin"
mv "$release_root" "$image_root/opt/chalk-recorder/releases/$release_id"
ln -s "releases/$release_id" "$image_root/opt/chalk-recorder/current"
ln -s /opt/chalk-recorder/current/bin/chalk-recorder-bootstrap "$image_root/usr/local/sbin/chalk-recorder-bootstrap"
install -m 0644 "$bootstrap_ca" "$image_root/etc/chalk-recorder/bootstrap-ca.pem"
for unit in chalk-recorder-capture.service chalk-recorder-renew.service chalk-recorder-renew.timer; do
  install -m 0644 "$script_root/../cpu/systemd/$unit" "$image_root/etc/systemd/system/$unit"
done
printf 'CHALK_RECORDER_KEYFRAME_INTERVAL=10s\n' >"$image_root/etc/chalk-recorder/capture.env"

python3 - "$image_root" "$release_id" "$source_commit" "$source_tree_sha256" <<'PY'
import hashlib, json, os, pathlib, sys
root, release_id, commit, tree = sys.argv[1:]
files = []
for directory in ('etc', 'opt', 'usr'):
    for path in pathlib.Path(root, directory).rglob('*'):
        if path.is_symlink():
            content = os.readlink(path).encode()
            kind = 'symlink'
        elif path.is_file():
            content = path.read_bytes()
            kind = 'file'
        else:
            continue
        files.append({'path': str(path)[len(root):], 'type': kind, 'sha256': hashlib.sha256(content).hexdigest()})
manifest = {'schema_version': 'chalk_recorder_cpu_image.v1', 'release_id': release_id,
            'source_commit': commit, 'source_tree_sha256': tree,
            'profile': 'capture-minimal-v1', 'files': sorted(files, key=lambda item: item['path'])}
pathlib.Path(root, 'opt/chalk-recorder/image-manifest.json').write_text(
    json.dumps(manifest, separators=(',', ':'), sort_keys=True) + '\n', encoding='utf-8')
PY
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
install -d -o chalk-recorder -g chalk-recorder -m 0700 /var/lib/chalk-recorder /run/chalk-recorder
chown root:chalk-recorder /etc/chalk-recorder /etc/chalk-recorder/image.env
chmod 0750 /etc/chalk-recorder
chmod 0440 /etc/chalk-recorder/image.env
chown -R root:root "/opt/chalk-recorder/releases/$release_id" /opt/chalk-recorder/image-manifest.json
chmod 0755 "/opt/chalk-recorder/releases/$release_id/bin/recorder-capture" "/opt/chalk-recorder/releases/$release_id/bin/chalk-recorder-bootstrap"
systemctl daemon-reload
systemctl disable chalk-recorder-capture.service chalk-recorder-renew.timer >/dev/null 2>&1 || true
printf 'release_id=%s\nsource_commit=%s\nsource_tree_sha256=sha256:%s\nbundle_sha256=sha256:%s\nimage_manifest_digest=%s\n' \
  "$release_id" "$source_commit" "$source_tree_sha256" "$bundle_sha256" "$image_digest"
