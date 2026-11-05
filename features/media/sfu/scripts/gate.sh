#!/usr/bin/env bash
# Chalk SFU gate: format, module tidiness, vet and the race-enabled tests.
# The Chromium check needs a browser and runs on demand: tests/browser/chromium-check.mjs.
set -euo pipefail

sfu_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.26.10+auto}"
# Git worktrees break Go VCS stamping (exit 128); the gate never needs stamped binaries.
export GOFLAGS="${GOFLAGS:--buildvcs=false}"
cd "${sfu_root}"

printf '\n==> go version\n'
go version

printf '\n==> Format check\n'
unformatted="$(gofmt -l .)"
if [[ -n "${unformatted}" ]]; then
  echo "These Go files need gofmt:"
  echo "${unformatted}"
  exit 1
fi

printf '\n==> Module tidy check\n'
go mod tidy -diff

printf '\n==> go vet\n'
go vet ./...

printf '\n==> go test -race\n'
go test -race -count=1 ./...
