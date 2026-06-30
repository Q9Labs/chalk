#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi

mapfile -t go_files < <(find . -name '*.go' -not -path './vendor/*' | sort)

if ((${#go_files[@]} == 0)); then
  echo "No Go files to format."
  exit 0
fi

gofmt -w "${go_files[@]}"
