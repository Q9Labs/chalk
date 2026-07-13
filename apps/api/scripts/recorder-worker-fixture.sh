#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/chalk-recorder-worker.XXXXXX")"
trap 'rm -rf "$fixture_dir"' EXIT

go run ./cmd/recorder-capture --fixture --dir "$fixture_dir"
go run ./cmd/recorder-render --fixture --dir "$fixture_dir"
ffprobe -v error -show_entries stream=codec_name,codec_type,width,height -show_entries format=format_name,duration -of default=nw=1 "$fixture_dir/recording.mp4"
echo "recorder worker fixture passed: $fixture_dir"
