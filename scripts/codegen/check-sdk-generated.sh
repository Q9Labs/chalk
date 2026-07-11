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
  node tools/contract-codegen/src/emitters/effect-schemas.mjs

CODEGEN_OPENAPI_PATH="$tmpdir/openapi.json" \
CODEGEN_HTTP_API_OUTPUT_PATH="$tmpdir/http-api.ts" \
  node tools/contract-codegen/src/emitters/effect-http-api.mjs

CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH="$tmpdir/sync.ts" \
  node tools/contract-codegen/src/emitters/sync-typescript.mjs

CODEGEN_SYNC_ELIXIR_OUTPUT_PATH="$tmpdir/generated.ex" \
  node tools/contract-codegen/src/emitters/sync-elixir.mjs

pnpm exec openapi-typescript "$tmpdir/openapi.json" --output "$tmpdir/openapi-types.d.ts"
pnpm exec oxfmt --write \
  "$tmpdir/openapi.json" \
  "$tmpdir/schemas.ts" \
  "$tmpdir/http-api.ts" \
  "$tmpdir/sync.ts" \
  "$tmpdir/openapi-types.d.ts"

diff -u contract/generated/openapi.json "$tmpdir/openapi.json"
diff -u sdks/typescript/client/src/generated/schemas.ts "$tmpdir/schemas.ts"
diff -u sdks/typescript/client/src/generated/http-api.ts "$tmpdir/http-api.ts"
diff -u sdks/typescript/client/src/generated/sync.ts "$tmpdir/sync.ts"
diff -u sdks/typescript/client/src/generated/openapi-types.d.ts "$tmpdir/openapi-types.d.ts"
diff -u apps/sync/lib/chalk_sync/contract/generated.ex "$tmpdir/generated.ex"
