#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

bash apps/api/scripts/generate-openapi.sh
node scripts/codegen/generate-effect-schemas.mjs
node scripts/codegen/generate-effect-http-api.mjs
pnpm dlx openapi-typescript@latest apps/api/openapi/openapi.json --output packages/sdk-core/src/generated/openapi-types.d.ts
pnpm exec oxfmt --write \
  apps/api/openapi/openapi.json \
  packages/sdk-core/src/generated/schemas.ts \
  packages/sdk-core/src/generated/http-api.ts \
  packages/sdk-core/src/generated/openapi-types.d.ts
