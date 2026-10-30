#!/usr/bin/env bash
# Run on Instabox. Uses the same root named contexts and per-app Dockerfiles as release CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
revision="$(git rev-parse HEAD)"
for component in api sync recorder-control; do
  source_context=api_source
  if [[ "$component" == sync ]]; then source_context=sync_source; fi
  docker buildx build --load --platform linux/amd64 \
    --build-context "${source_context}=." \
    --build-arg "SOURCE_REVISION=${revision}" \
    --build-arg RELEASE_ID=whiteboard-colocation-proof \
    --file "infrastructure/managed-episode/images/${component}.Dockerfile" \
    --tag "chalk-whiteboard-proof-${component}:${revision}" \
    infrastructure/managed-episode
  docker image inspect "chalk-whiteboard-proof-${component}:${revision}" --format '{{json .Config.Entrypoint}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
  docker image rm "chalk-whiteboard-proof-${component}:${revision}"
done
