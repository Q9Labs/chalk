#!/usr/bin/env bash
# Print the path of a verified download of a pinned tool archive.
#
# Usage: install-pinned-tool.sh <sha256>=<file name>=<url> [<sha256>=<file name>=<url> ...]
#
# A candidate that is already in the cache and matches its checksum is used without any network
# call. Otherwise each URL is tried in order, and a download counts only if it matches its pinned
# checksum. Deploy and rollback jobs use this so a github.com release outage does not stop them.
set -euo pipefail

cache="${CHALK_TOOL_CACHE:-${HOME}/.cache/chalk-tools}"
mkdir -p "${cache}"

split() {
  sha="${1%%=*}"
  rest="${1#*=}"
  name="${rest%%=*}"
  url="${rest#*=}"
  file="${cache}/${sha}-${name}"
}

matches() {
  [[ -f "$1" ]] && [[ "$(sha256sum "$1" | cut -d' ' -f1)" == "$2" ]]
}

for candidate in "$@"; do
  split "${candidate}"
  if matches "${file}" "${sha}"; then
    echo "${file}"
    exit 0
  fi
done

for candidate in "$@"; do
  split "${candidate}"
  partial="${file}.partial"
  rm -f "${partial}"
  if curl --fail --silent --show-error --location --retry 3 --retry-all-errors --max-time 300 "${url}" --output "${partial}" \
    && matches "${partial}" "${sha}"; then
    cp "${partial}" "${file}"
    rm -f "${partial}"
    echo "${file}"
    exit 0
  fi
  rm -f "${partial}"
  echo "Could not fetch ${name} from ${url%%\?*}; trying the next source" >&2
done

echo "No source produced a download that matches its pinned checksum" >&2
exit 1
