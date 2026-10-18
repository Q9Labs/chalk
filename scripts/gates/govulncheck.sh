#!/usr/bin/env bash
# Runs govulncheck for the Go module in the current directory.
set -euo pipefail

if [[ -z "${GATE_VULN_BASE_REF:-}" ]]; then
  exec go tool govulncheck ./...
fi

# A pull request fails only on findings that the same scan of the base branch does not report.
compare="$(cd "$(dirname "$0")" && pwd)/new-vulnerabilities.mjs"
report_directory="$(mktemp -d "${TMPDIR:-/tmp}/chalk-govulncheck.XXXXXX")"
trap 'find "${report_directory}" -depth -delete' EXIT
go tool govulncheck -format json ./... > "${report_directory}/head.json"
if node "${compare}" govulncheck "${report_directory}/head.json" >/dev/null; then
  exit 0
fi

module_path="$(git rev-parse --show-prefix)"
base="$(git merge-base "${GATE_VULN_BASE_REF}" HEAD)"
if ! git cat-file -e "${base}:${module_path}go.mod" 2>/dev/null; then
  node "${compare}" govulncheck "${report_directory}/head.json"
  exit
fi
mkdir "${report_directory}/base"
git -C "$(git rev-parse --show-toplevel)" archive "${base}" ${module_path:+"${module_path}"} | tar -x -C "${report_directory}/base"
(cd "${report_directory}/base/${module_path}" && go tool govulncheck -format json ./...) > "${report_directory}/base.json"
node "${compare}" govulncheck "${report_directory}/head.json" "${report_directory}/base.json"
