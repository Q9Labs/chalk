#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

bash apps/api/scripts/generate-openapi.sh
node tools/contract-codegen/src/emitters/effect-schemas.mjs
node tools/contract-codegen/src/emitters/effect-http-api.mjs
node tools/contract-codegen/src/emitters/sync-typescript.mjs
node tools/contract-codegen/src/emitters/sync-elixir.mjs
pnpm exec openapi-typescript contract/generated/openapi.json --output sdks/typescript/client/src/generated/openapi-types.d.ts
pnpm exec oxfmt --write \
  contract/generated/openapi.json \
  sdks/typescript/client/src/generated/schemas.ts \
  sdks/typescript/client/src/generated/http-api.ts \
  sdks/typescript/client/src/generated/sync.ts \
  sdks/typescript/client/src/generated/openapi-types.d.ts
