#!/usr/bin/env bash
set -euo pipefail

# Build the arm64 container-image renderer as a single-manifest OCI archive. Run on Linux/arm64 with Docker buildx.
# RENDERER_IMAGE_PLATFORM=linux/amd64 builds a native x86 image to prove the Dockerfile on a machine without arm64.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/document-renderer"
OUT="$ROOT/releases/document-renderer"
PLATFORM="${RENDERER_IMAGE_PLATFORM:-linux/arm64}"
ARCHIVE="$OUT/document-renderer-image-linux-arm64.oci.tar"
mkdir -p "$OUT"
if [[ "$(uname -s)" != Linux ]]; then
  echo "document renderer image build must run on Linux" >&2
  exit 2
fi
rm -f "$ARCHIVE"
# One platform, no provenance or SBOM attestations: Lambda rejects image indexes. SOURCE_DATE_EPOCH pins layer timestamps.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct)}" \
  docker buildx build --platform "$PLATFORM" --provenance=false --sbom=false \
  --output "type=oci,dest=$ARCHIVE,rewrite-timestamp=true,name=chalk-document-renderer" \
  -f "$APP/image/Dockerfile" "$APP"
cd "$ROOT"
python3 - "$ARCHIVE" "$OUT/image-manifest.json" "$PLATFORM" <<'PY'
import hashlib, json, re, sys, tarfile
archive, target, platform = sys.argv[1:4]
with tarfile.open(archive) as tar:
    index = json.load(tar.extractfile('index.json'))
    manifests = index['manifests']
    assert len(manifests) == 1, 'expected one image manifest'
    digest = manifests[0]['digest']
    blob = tar.extractfile('blobs/sha256/' + digest.split(':')[1]).read()
    layers = json.loads(blob)['layers']
assert hashlib.sha256(blob).hexdigest() == digest.split(':')[1], 'manifest digest mismatch'
dockerfile = open('apps/document-renderer/image/Dockerfile').read()
pdfium = re.search(r'ARG PDFIUM_VERSION=(\S+)', dockerfile).group(1)
json.dump({'schemaVersion': 1, 'artifact': 'document-renderer-image-linux-arm64.oci.tar', 'digest': digest, 'platform': platform,
           'layerBytes': [layer['size'] for layer in layers], 'pdfiumVersion': pdfium}, open(target, 'w'))
print('digest', digest)
PY
printf 'archive %s\n' "$ARCHIVE"
