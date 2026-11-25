#!/bin/sh
set -eu
cd /workspace/apps/api
go build -buildvcs=false -o /tmp/chalk-api ./cmd
python3 /workspace/scripts/dev/artifact-server.py "$CHALK_DEV_ARTIFACT_PORT" /dashboard-artifacts &
if [ -n "${CHALK_PRESENTING_RENDERER_ENDPOINT:-}" ]; then
  /workspace/scripts/dev/start-document-renderer.sh &
fi
exec /tmp/chalk-api
