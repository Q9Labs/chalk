#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DIR="$ROOT/apps/native/whiteboard-web"

rm -rf "$DIR/dist"
mkdir -p "$DIR/dist"

# Bundle host (self-contained; no CDN).
cd "$DIR"
bun install --silent
bun build "$DIR/src/host.tsx" \
  --outfile "$DIR/dist/host.js" \
  --target browser

cp "$DIR/src/index.html" "$DIR/dist/index.html"
cp "$ROOT/node_modules/@excalidraw/excalidraw/dist/prod/index.css" "$DIR/dist/excalidraw.css"

echo "built: $DIR/dist"
