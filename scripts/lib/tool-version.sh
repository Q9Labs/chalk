#!/usr/bin/env bash
# Prints the version .tool-versions pins for the tool named in the first argument.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="$(awk -v tool="${1:?usage: tool-version.sh <name>}" '$1 == tool { print $2 }' "${root}/.tool-versions")"
if [[ -z "${version}" ]]; then
  echo "No ${1} line in .tool-versions" >&2
  exit 1
fi
printf '%s\n' "${version}"
