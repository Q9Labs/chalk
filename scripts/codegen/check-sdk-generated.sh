#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$tmpdir"

(
  cd apps/api
  "${GO:-/usr/local/go/bin/go}" run ./cmd/codegen > "$tmpdir/openapi.json"
)

CODEGEN_OPENAPI_PATH="$tmpdir/openapi.json" \
CODEGEN_EFFECT_OUTPUT_PATH="$tmpdir/schemas.ts" \
  node scripts/codegen/generate-effect-schemas.mjs

CODEGEN_OPENAPI_PATH="$tmpdir/openapi.json" \
CODEGEN_HTTP_API_OUTPUT_PATH="$tmpdir/http-api.ts" \
  node scripts/codegen/generate-effect-http-api.mjs

pnpm dlx openapi-typescript@latest "$tmpdir/openapi.json" --output "$tmpdir/openapi-types.d.ts"
pnpm exec oxfmt --write \
  "$tmpdir/openapi.json" \
  "$tmpdir/schemas.ts" \
  "$tmpdir/http-api.ts" \
  "$tmpdir/openapi-types.d.ts"

diff -u apps/api/openapi/openapi.json "$tmpdir/openapi.json"
diff -u packages/sdk-core/src/generated/schemas.ts "$tmpdir/schemas.ts"
diff -u packages/sdk-core/src/generated/http-api.ts "$tmpdir/http-api.ts"
diff -u packages/sdk-core/src/generated/openapi-types.d.ts "$tmpdir/openapi-types.d.ts"
