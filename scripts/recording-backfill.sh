#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
exec go run ./cmd/recording-backfill "$@"
