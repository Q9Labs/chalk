#!/usr/bin/env bash
# Reproduce the config-only move in a disposable checkout, not the caller's tree.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
probe="$(mktemp -d)"
rmdir "$probe"
git -C "$repo" worktree add --quiet --detach "$probe" HEAD
cleanup() { git -C "$repo" worktree remove --force "$probe"; }
trap cleanup EXIT
cd "$probe"
export GOWORK=off GOMAXPROCS=1

git mv apps/api/go.mod go.mod
git mv apps/api/go.sum go.sum
go mod edit -module=github.com/q9labs/chalk
printf '%s\n' '$ go build -o /tmp/chalk-api ./apps/api/cmd (root module, original packages)'
go build -o "$probe/chalk-api" ./apps/api/cmd
printf '%s\n' 'PASS: the API builds with a root module before moving whiteboard'

mkdir -p features/whiteboard/api
git mv apps/api/internal/whiteboardfiles features/whiteboard/api/whiteboardfiles
printf '%s\n' '$ go list ./features/whiteboard/api/whiteboardfiles'
if go list ./features/whiteboard/api/whiteboardfiles > "$probe/package.log" 2>&1; then
  cat "$probe/package.log"
  echo 'Unexpected success: reassess the blocker.' >&2
  exit 1
fi
cat "$probe/package.log"
if ! grep -q 'use of internal package github.com/q9labs/chalk/apps/api/internal/.* not allowed' "$probe/package.log"; then
  echo 'The move failed for a different reason, not the expected internal boundary.' >&2
  exit 1
fi
printf '%s\n' '$ go build -o /tmp/chalk-api ./apps/api/cmd (whiteboard moved, imports unchanged)'
if go build -o "$probe/chalk-api" ./apps/api/cmd > "$probe/build.log" 2>&1; then
  echo 'Unexpected success: reassess the blocker.' >&2
  exit 1
fi
cat "$probe/build.log"
if ! grep -q 'no required module provides package github.com/q9labs/chalk/apps/api/internal/whiteboardfiles' "$probe/build.log"; then
  echo 'The API failed for a different reason, not the expected missing package.' >&2
  exit 1
fi
printf '%s\n' 'REPRODUCED: config alone cannot relocate the existing Go package'
