#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
secret="01234567890123456789012345678901"
environment="local"
release="presenting-interop-test"
audience="chalk-control-api"
journey="00000000-0000-0000-0000-0000000000aa"
(
  cd "$ROOT/apps/document-renderer"
  go run ./cmd/signingtest "$secret" "$environment" "$release" "$audience" "$journey" >"$TMP/signed-request.json"
)
(
  cd "$ROOT/apps/api"
  go run ./cmd/workloadverifytest "$TMP/signed-request.json" "$secret" "$environment" "$release" "$audience"
)
