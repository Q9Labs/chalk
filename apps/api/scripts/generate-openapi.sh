#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repository_root/apps/api"

mkdir -p "$repository_root/contract/generated"
output="$repository_root/contract/generated/openapi.json"
temporary_directory=$(mktemp -d "$repository_root/contract/generated/.openapi.XXXXXX")
temporary_output="$temporary_directory/openapi.json"
trap 'rm -rf "$temporary_directory"' EXIT

"${GO:-/usr/local/go/bin/go}" run ./cmd/codegen > "$temporary_output"
(
  cd "$repository_root"
  pnpm exec oxfmt --write "$temporary_output"
)
mv "$temporary_output" "$output"
