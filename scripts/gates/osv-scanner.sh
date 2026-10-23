#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
lockfiles=()
while IFS= read -r file; do
  case "${file}" in
    go.mod | */go.mod | pnpm-lock.yaml | */pnpm-lock.yaml | package-lock.json | */package-lock.json | yarn.lock | */yarn.lock | mix.lock | */mix.lock)
      lockfiles+=("$file")
      ;;
  esac
done < <(git ls-files)

# Enforce the importer scope that OSV's advisory-wide zod ignore cannot express.
# Run before both the scan and the PR baseline filter: an old runtime copy fails too.
for file in "${lockfiles[@]}"; do
  case "${file}" in
    pnpm-lock.yaml | */pnpm-lock.yaml) node "${script_directory}/zod-exception.mjs" "$file" ;;
  esac
done

# The transitive resolver currently crashes on the Python requirements file.
args=(scan source --no-resolve)
for file in "${lockfiles[@]}"; do
  args+=(--lockfile "$file")
done
if [ "${#lockfiles[@]}" -eq 0 ]; then
  args=(scan source --recursive --no-resolve --allow-no-lockfiles .)
fi

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

if [[ -z "${GATE_VULN_BASE_REF:-}" ]]; then
  osv_scanner "${args[@]}"
  exit 0
fi

# A pull request fails only on findings in package versions that the base branch does not have.
report_directory="$(mktemp -d "${TMPDIR:-/tmp}/chalk-osv.XXXXXX")"
trap 'find "${report_directory}" -depth -delete' EXIT
status=0
osv_scanner "${args[@]}" --format json --output-file "${report_directory}/head.json" || status=$?
if ((status == 0)); then
  exit 0
elif ((status != 1)); then
  exit "${status}"
fi

base="$(git merge-base "${GATE_VULN_BASE_REF}" HEAD)"
copy_from_base() {
  git cat-file -e "${base}:$1" 2>/dev/null || return 1
  mkdir -p "${report_directory}/base/$(dirname "$1")"
  git show "${base}:$1" > "${report_directory}/base/$1"
}
# The base scan uses the base's ignore lists, so it reports what the base branch reported.
while IFS= read -r config; do
  copy_from_base "${config}"
done < <(git ls-tree -r --name-only "${base}" | grep -E '(^|/)osv-scanner\.toml$' || true)
base_args=(scan source --no-resolve)
for file in "${lockfiles[@]}"; do
  copy_from_base "${file}" && base_args+=(--lockfile "${report_directory}/base/${file}")
done

printf '{"results":[]}\n' > "${report_directory}/base.json"
if [ "${#base_args[@]}" -gt 3 ]; then
  base_status=0
  osv_scanner "${base_args[@]}" --format json --output-file "${report_directory}/base.json" >/dev/null || base_status=$?
  ((base_status <= 1)) || exit "${base_status}"
fi
node "${script_directory}/new-vulnerabilities.mjs" osv "${report_directory}/head.json" "${report_directory}/base.json"
