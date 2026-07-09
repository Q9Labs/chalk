#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p openapi
"${GO:-/usr/local/go/bin/go}" run ./cmd/codegen > openapi/openapi.json
