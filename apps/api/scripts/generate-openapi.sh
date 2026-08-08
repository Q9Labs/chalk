#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$repository_root/apps/api"

go_command="${GO:-go}"
if ! command -v "$go_command" >/dev/null 2>&1; then
  echo "Go command not found: $go_command" >&2
  exit 1
fi

mkdir -p "$repository_root/contract/generated"
output="$repository_root/contract/generated/openapi.json"
temporary_directory=$(mktemp -d "$repository_root/contract/generated/.openapi.XXXXXX")
temporary_output="$temporary_directory/openapi.json"
trap 'rm -rf "$temporary_directory"' EXIT

"$go_command" run ./cmd/codegen > "$temporary_output"
(
  cd "$repository_root"
  pnpm exec oxfmt --write "$temporary_output"
)
mv "$temporary_output" "$output"
