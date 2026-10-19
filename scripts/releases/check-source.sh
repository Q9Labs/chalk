#!/usr/bin/env bash
set -euo pipefail
if [[ ! "${TARGET_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "target_sha must be a full lowercase commit SHA" >&2
  exit 1
fi
if [[ "$(git rev-parse HEAD)" != "$TARGET_SHA" ]]; then
  echo "checkout does not match target_sha" >&2
  exit 1
fi
if [[ "${DEPLOY_MANAGED:-false}" == true && "${RELEASE_MANAGED:-false}" != true ]]; then
  echo "deploy_managed requires release_managed" >&2
  exit 1
fi
