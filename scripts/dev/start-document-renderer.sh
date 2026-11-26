#!/bin/sh
set -eu

PDFIUM_VERSION="chromium/8179"
APP=/workspace/apps/document-renderer
NATIVE="$APP/native/pdfium"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) PDFIUM_ARCH=arm64; PDFIUM_SHA256=18bb6d568257b28d14f6c3b8bfb48caf73d4615b319ca4d43b424c2a03431d9f ;;
  x86_64|amd64) PDFIUM_ARCH=x64; PDFIUM_SHA256=b4766a6bf2856efbcc6c3cc7d6ae9022bdc6bb36ddc1acdd92d1f1873f773f4b ;;
  *) echo "unsupported document renderer architecture $ARCH" >&2; exit 1 ;;
esac
if [ ! -f "$NATIVE/lib/libpdfium.so" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL "https://github.com/bblanchon/pdfium-binaries/releases/download/$PDFIUM_VERSION/pdfium-linux-$PDFIUM_ARCH.tgz" -o "$TMP/pdfium.tgz"
  ACTUAL=$(sha256sum "$TMP/pdfium.tgz" | awk '{print $1}')
  [ "$ACTUAL" = "$PDFIUM_SHA256" ] || { echo "pdfium digest mismatch: $ACTUAL" >&2; exit 1; }
  mkdir -p "$TMP/extract"
  tar -xzf "$TMP/pdfium.tgz" -C "$TMP/extract"
  mkdir -p "$NATIVE/include" "$NATIVE/lib"
  cp -R "$TMP/extract/include/." "$NATIVE/include/"
  cp "$TMP/extract/lib/libpdfium.so" "$NATIVE/lib/"
fi
cd "$APP"
CGO_ENABLED=1 go build -buildvcs=false -o /tmp/chalk-document-renderer ./cmd/renderer
API_PORT="${CHALK_API_ADDR##*:}"
export LD_LIBRARY_PATH="$NATIVE/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CONTROL_API_BASE_URL="http://127.0.0.1:$API_PORT"
export RENDERER_LOCAL_ADDR=127.0.0.1:8093
exec /tmp/chalk-document-renderer
