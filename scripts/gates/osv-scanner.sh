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
trap 'find "${report_directory}" -depth -delete' EXIT
snapshot() {
  mkdir "$2"
  git archive "$1" | tar -x -C "$2"
  node "${script_directory}/osv-snapshot.mjs" "$2"
}
scan_report() {
  local status=0
  osv_scanner "${args[@]}" --config "$3" --format json --output-file "$2" "$1" || status=$?
  ((status <= 1)) || return "${status}"
}

# Force the root policy for every discovered input; it has no zod advisory ignore.
snapshot HEAD "${report_directory}/head"
scan_report "${report_directory}/head" "${report_directory}/head.json" "${report_directory}/head/osv-scanner.toml"
# Validate every zod finding before discounting the tooling exception or a PR baseline.
(cd "${report_directory}/head" && node "${script_directory}/zod-exception.mjs" pnpm-lock.yaml "${report_directory}/head.json")

if [[ -z "${GATE_VULN_BASE_REF:-}" ]]; then
  node "${script_directory}/new-vulnerabilities.mjs" osv "${report_directory}/head.json"
  exit 0
fi

# Discover the base's tracked tree too, with the same symlink handling.
base="$(git merge-base "${GATE_VULN_BASE_REF}" HEAD)"
snapshot "${base}" "${report_directory}/base"
base_config="${report_directory}/base/osv-scanner.toml"
[[ -f "${base_config}" ]] || base_config=/dev/null
scan_report "${report_directory}/base" "${report_directory}/base.json" "${base_config}"
node "${script_directory}/new-vulnerabilities.mjs" osv "${report_directory}/head.json" "${report_directory}/base.json"
