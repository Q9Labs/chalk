#!/usr/bin/env bash
set -eu

status=0
git -C "$(dirname "$0")/../.." grep -InE '^(<{7,}|[|]{7,}|={7}|>{7,})([[:space:]]|$)' -- . || status=$?
case "$status" in
  0) echo "Remove the merge conflict markers listed above." >&2; exit 1 ;;
  1) exit 0 ;;
  *) exit "$status" ;;
esac
