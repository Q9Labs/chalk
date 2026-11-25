#!/usr/bin/env bash
set -euo pipefail

# Build the arm64 Amazon Linux 2023 custom-runtime zip. Run on Linux/arm64 with gcc and libwebp-devel installed.
PDFIUM_VERSION="chromium/8179"
PDFIUM_SHA256="18bb6d568257b28d14f6c3b8bfb48caf73d4615b319ca4d43b424c2a03431d9f"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/document-renderer"
OUT="$ROOT/releases/document-renderer"
WORK="$OUT/work"
rm -rf "$WORK"
mkdir -p "$WORK/pdfium" "$OUT"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != aarch64 ]]; then
  echo "document renderer packaging must run on Linux/arm64" >&2
  exit 2
fi
archive="$WORK/pdfium-linux-arm64.tgz"
curl -fsSL "https://github.com/bblanchon/pdfium-binaries/releases/download/$PDFIUM_VERSION/pdfium-linux-arm64.tgz" -o "$archive"
actual="$(shasum -a256 "$archive" | awk '{print $1}')"
if [[ "$actual" != "$PDFIUM_SHA256" ]]; then
  echo "pdfium digest mismatch: got $actual" >&2
  exit 1
fi
tar -xzf "$archive" -C "$WORK/pdfium"
rm -rf "$APP/vendor/pdfium"
mkdir -p "$APP/vendor/pdfium/include" "$APP/vendor/pdfium/lib"
cp -R "$WORK/pdfium/include/." "$APP/vendor/pdfium/include/"
cp "$WORK/pdfium/lib/libpdfium.so" "$APP/vendor/pdfium/lib/"
(
  cd "$APP"
  CGO_ENABLED=1 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w -buildid=' -o "$WORK/bootstrap" ./cmd/renderer
)
mkdir -p "$WORK/package/lib" "$WORK/package/licenses/pdfium"
cp "$WORK/bootstrap" "$WORK/package/bootstrap"
cp "$WORK/pdfium/lib/libpdfium.so" "$WORK/package/lib/"
cp "$WORK/pdfium/licenses/." "$WORK/package/licenses/pdfium/" 2>/dev/null || true
# The Go binary links the system libwebp. Copy the exact runtime object and its sonames into the zip.
while read -r library; do
  [[ -n "$library" ]] || continue
  cp -L "$library" "$WORK/package/lib/$(basename "$library")"
done < <(ldd "$WORK/bootstrap" | awk '/libwebp\.so/{print $3}')
if ! compgen -G "$WORK/package/lib/libwebp.so*" >/dev/null; then
  echo "libwebp runtime object was not copied" >&2
  exit 1
fi
for notice in /usr/share/doc/libwebp*/COPYING /usr/share/doc/libwebp*/README.md /usr/share/licenses/libwebp*/LICENSE; do
  [[ -f "$notice" ]] || continue
  mkdir -p "$WORK/package/licenses/libwebp"
  cp "$notice" "$WORK/package/licenses/libwebp/$(basename "$notice")"
done
chmod 0755 "$WORK/package/bootstrap"
# Reproducible zip: sorted names, one fixed timestamp, no host metadata.
python3 - "$WORK/package" "$OUT/document-renderer-linux-arm64.zip" <<'PY'
import os, sys, zipfile
root, target = sys.argv[1:3]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for base, dirs, files in os.walk(root):
        dirs.sort(); files.sort()
        for name in files:
            path=os.path.join(base,name)
            info=zipfile.ZipInfo(os.path.relpath(path,root), (1980,1,1,0,0,0))
            info.external_attr=(0o755 if name=='bootstrap' else 0o644)<<16
            with open(path,'rb') as fh: archive.writestr(info, fh.read())
PY
sha256="$(shasum -a256 "$OUT/document-renderer-linux-arm64.zip" | awk '{print $1}')"
printf '{"schemaVersion":1,"artifact":"document-renderer-linux-arm64.zip","sha256":"%s","pdfiumVersion":"%s","pdfiumSha256":"%s"}\n' "$sha256" "$PDFIUM_VERSION" "$PDFIUM_SHA256" > "$OUT/manifest.json"
printf 'artifact %s\nsha256 %s\n' "$OUT/document-renderer-linux-arm64.zip" "$sha256"
