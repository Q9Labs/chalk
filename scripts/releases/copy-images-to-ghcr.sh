#!/usr/bin/env bash
# Copy release images that live in ECR to the public GHCR packages, by digest, so a rollback to an older
# release no longer needs an ECR login. Usage: copy-images-to-ghcr.sh <ecr-image@sha256:...>...
# Needs `crane` logged in to both registries. The copy keeps the digest, and the script proves it.
set -euo pipefail

owner="${GITHUB_REPOSITORY_OWNER:-q9labs}"
registry="ghcr.io/${owner,,}"

(( $# > 0 )) || { echo "usage: $0 <ecr-image@sha256:...>..." >&2; exit 2; }

for source in "$@"; do
  [[ "$source" =~ ^[^@]+/(chalk-api|chalk-sync)@(sha256:[0-9a-f]{64})$ ]] || {
    echo "not a chalk-api or chalk-sync digest reference: $source" >&2
    exit 1
  }
  repository="${BASH_REMATCH[1]}"
  digest="${BASH_REMATCH[2]}"
  target="${registry}/${repository}@${digest}"
  crane copy "$source" "$target"
  copied="$(crane digest "$target")"
  [[ "$copied" == "$digest" ]] || {
    echo "copy of $source changed the digest: $copied" >&2
    exit 1
  }
  echo "$target"
done
