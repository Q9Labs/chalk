#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
# Let OSV discover every supported input in the tracked snapshot. No filename list.
# --no-resolve avoids the Python transitive resolver crash, not input discovery.
args=(scan source --recursive --no-ignore --no-resolve --all-packages --experimental-exclude 'r:(^|/)(node_modules|\.git|\.worktrees)$')

osv_scanner() {
  if command -v osv-scanner >/dev/null 2>&1; then
    osv-scanner "$@"
  elif command -v go >/dev/null 2>&1; then
    # Releases before 2.6.0 read only the first document of pnpm-lock.yaml.
    go run github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.6.0 "$@"
  else
    echo "OSV-Scanner is required. Install osv-scanner or Go, then rerun pnpm run security:osv." >&2
    return 127
  fi
}

report_directory="$(mktemp -d "${TMPDIR:-/tmp}/chalk-osv.XXXXXX")"
report_directory="$(cd "${report_directory}" && pwd -P)"
trap 'find "${report_directory}" -depth -delete' EXIT
snapshot() {
  mkdir "$2"
  GIT_INDEX_FILE="${2}.index" git read-tree "$1"
  GIT_INDEX_FILE="${2}.index" git -c core.symlinks=true checkout-index --all --prefix="$2/"
  node "${script_directory}/osv-snapshot.mjs" "$2"
}
scan_report() {
  local directory="$1" report="$2" status=0
  shift 2
  osv_scanner "${args[@]}" "$@" --format json --output-file "${report}" "${directory}" || status=$?
  ((status <= 1)) || return "${status}"
}

mkdir "${report_directory}/head"
node "${script_directory}/osv-snapshot.mjs" "${report_directory}/head" --working-tree
# Validate zod without any policy that could hide a new consumer.
scan_report "${report_directory}/head" "${report_directory}/raw.json" --config /dev/null
(cd "${report_directory}/head" && node "${script_directory}/zod-exception.mjs" pnpm-lock.yaml "${report_directory}/raw.json")
# Other advisories retain OSV's normal per-directory policy, including the API's.
scan_report "${report_directory}/head" "${report_directory}/head.json"
(cd "${report_directory}/head" && node "${script_directory}/zod-exception.mjs" pnpm-lock.yaml "${report_directory}/head.json")

# Branch creation has no previous tip, so it must fail on all findings.
push_base="${GATE_OSV_BASE_COMMIT:-}"
if [[ "$push_base" == 0000000000000000000000000000000000000000 ]]; then
  push_base=""
fi
if [[ -z "$push_base" && -z "${GATE_VULN_BASE_REF:-}" ]]; then
  node "${script_directory}/new-vulnerabilities.mjs" osv "${report_directory}/head.json"
  exit 0
fi

# Discover the base's tracked tree too, with the same symlink handling.
if [[ -n "$push_base" ]]; then
  [[ "$push_base" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid push baseline' >&2; exit 2; }
  # Force pushes can remove the old tip from checkout's fetched history. Fail closed if unavailable.
  git cat-file -e "${push_base}^{commit}" 2>/dev/null || git fetch --no-tags origin "$push_base"
  base="$push_base"
else
  base="$(git merge-base "${GATE_VULN_BASE_REF}" HEAD)"
fi
snapshot "${base}" "${report_directory}/base"
scan_report "${report_directory}/base" "${report_directory}/base.json"
node "${script_directory}/new-vulnerabilities.mjs" osv "${report_directory}/head.json" "${report_directory}/base.json"
