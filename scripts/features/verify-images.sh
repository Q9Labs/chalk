#!/usr/bin/env bash
# Run on Instabox. Uses the same root named contexts and per-app Dockerfiles as release CI.
set -euo pipefail
cd "$(dirname "$0")/../.."
revision="$(git rev-parse HEAD)"
for component in api sync; do
  docker buildx build --load --platform linux/amd64 \
    --build-context "${component}_source=." \
    --build-arg "SOURCE_REVISION=${revision}" \
    --build-arg RELEASE_ID=whiteboard-colocation-proof \
    --file "infrastructure/managed-episode/images/${component}.Dockerfile" \
    --tag "chalk-whiteboard-proof-${component}:${revision}" \
    infrastructure/managed-episode
  docker image inspect "chalk-whiteboard-proof-${component}:${revision}" --format '{{json .Config.Entrypoint}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
  docker image rm "chalk-whiteboard-proof-${component}:${revision}"
done
