#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p ../../contract/generated
"${GO:-/usr/local/go/bin/go}" run ./cmd/codegen > ../../contract/generated/openapi.json
