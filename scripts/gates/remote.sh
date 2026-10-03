#!/usr/bin/env bash
# Runs a gate on the M4 Mac mini from the exact local commit plus uncommitted work, then cleans up.
set -euo pipefail

usage() {
  cat <<'EOF'
Run a Chalk gate on the M4 (ssh agents-macmini) in a throwaway checkout.

Usage:
  scripts/gates/remote.sh [--dry-run] <gate> [gate args...]
  scripts/gates/remote.sh [--dry-run] -- <command> [args...]

Gates:
  root      pnpm run gate -- --base origin/master   (extra args are passed to q9gate)
  api       apps/api/scripts/gate.sh
  sync      scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh
  recorder  scripts/recorder/gate.sh
  --        any command, run from the checkout root

What it does:
  1. Snapshots the local commit and any staged, unstaged, and untracked work as a tiny two-commit
     history: origin/master (the merge base tree) and the branch tip, so branch-scoped gates and
     Fallow see the same diff the pull request will have.
  2. Refuses to start when the M4 has too little free disk, after deleting stale /tmp/chalk-*
     checkouts and chalk-gate-postgres-* containers that no live process uses.
  3. Checks out the snapshot under /tmp, installs with shared pnpm, Go, Hex, and Mix caches (plus Playwright Chromium for root), and runs
     the gate under a time limit with GOFLAGS=-buildvcs=false.
  4. Prints step headers live and the last lines at the end, saves the full log locally, and always
     deletes the remote checkout (also when SSH drops or you press Ctrl-C).

Environment:
  CHALK_REMOTE_HOST                  SSH host (default agents-macmini)
  CHALK_REMOTE_BASE_REF              base ref for branch scope (default origin/master)
  CHALK_REMOTE_MIN_FREE_GIB          refuse to start below this much free disk (default 8)
  CHALK_REMOTE_STALE_HOURS           reap /tmp/chalk-* older than this (default 4)
  CHALK_REMOTE_GATE_TIMEOUT_SECONDS  limit for the gate itself (default 3600)
  CHALK_REMOTE_TAIL_LINES            lines printed at the end (default 60)
  CHALK_REMOTE_VERBOSE=1             stream the whole log instead of step headers
  CHALK_REMOTE_LOG_DIR               local log directory (default ${TMPDIR:-/tmp}/chalk-remote-logs)

Exit codes: the gate's own status; 75 when the M4 is too full; 3 when the connection dropped before
the gate reported a result (the checkout is still cleaned up).
EOF
}

dry_run=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=1
  shift
fi
if (($# == 0)); then
  usage >&2
  exit 2
fi

gate="$1"
shift
needs_browser=0
case "${gate}" in
  root)
    needs_browser=1
    gate_command=(pnpm run gate -- --base "${CHALK_REMOTE_BASE_REF:-origin/master}" "$@")
    ;;
  api) gate_command=(apps/api/scripts/gate.sh "$@") ;;
  sync) gate_command=(scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh "$@") ;;
  recorder) gate_command=(bash scripts/recorder/gate.sh "$@") ;;
  --)
    if (($# == 0)); then
      echo "remote.sh -- requires a command" >&2
      exit 2
    fi
    gate_command=("$@")
    ;;
  help | -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "Unknown gate: ${gate}" >&2
    usage >&2
    exit 2
    ;;
esac

host="${CHALK_REMOTE_HOST:-agents-macmini}"
base_ref="${CHALK_REMOTE_BASE_REF:-origin/master}"
min_free_gib="${CHALK_REMOTE_MIN_FREE_GIB:-8}"
stale_hours="${CHALK_REMOTE_STALE_HOURS:-4}"
gate_timeout="${CHALK_REMOTE_GATE_TIMEOUT_SECONDS:-3600}"
tail_lines="${CHALK_REMOTE_TAIL_LINES:-60}"
log_dir="${CHALK_REMOTE_LOG_DIR:-${TMPDIR:-/tmp}/chalk-remote-logs}"

repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${repository_root}"
branch_slug="$(git rev-parse --abbrev-ref HEAD | tr -c 'A-Za-z0-9\n' '-' | cut -c1-24)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${branch_slug}-$$"
log_file="${log_dir}/${run_id}.log"
remote_work="/tmp/chalk-remote-${run_id}"

ssh_options=(
  -o BatchMode=yes
  -o ControlMaster=no
  -o ControlPath=none
  -o ConnectTimeout=20
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=8
)

dirty_count="$(git status --porcelain | wc -l | tr -d ' ')"
if ((dry_run)); then
  quoted_command="$(printf '%q ' "${gate_command[@]}")"
  cat <<EOF
remote.sh dry run (no SSH, no files written)
  host:            ${host}
  run id:          ${run_id}
  local commit:    $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)
  uncommitted:     ${dirty_count} changed or untracked path(s) will be included
  base ref:        ${base_ref} (the merge base tree becomes origin/master in the checkout)
  remote checkout: ${remote_work}/repo
  shared caches:   the M4 user's default pnpm, Go, Hex, and Mix caches
  disk threshold:  ${min_free_gib} GiB free; stale checkouts older than ${stale_hours}h are reaped first
  gate command:    ${quoted_command}
  gate timeout:    ${gate_timeout}s
  local log:       ${log_file}
Steps: preflight and reap, upload bundle, checkout, pnpm install --frozen-lockfile, Playwright Chromium (root only), run gate, delete checkout.
EOF
  exit 0
fi

# The remote side runs under a login shell so mise, Homebrew, and OrbStack paths are present.
remote() {
  local action="$1"
  shift
  ssh "${ssh_options[@]}" "${host}" "zsh -lc 'exec bash -s -- ${action} $*'" <<<"${remote_library}"
}

# Everything the M4 does lives in this library so the laptop never sends ad-hoc commands.
read -r -d '' remote_library <<'REMOTE' || true
set -euo pipefail

safe_delete() {
  local dir="$1"
  case "${dir}" in
    /tmp/chalk-*) ;;
    *) echo "refusing to delete ${dir}: not a /tmp/chalk-* path" >&2; return 1 ;;
  esac
  [[ -d "${dir}" && ! -L "${dir}" ]] || return 0
  [[ "$(dirname "$(cd "${dir}" && pwd -P)")" == "/private/tmp" ]] || { echo "refusing to delete ${dir}: not a direct child of /tmp" >&2; return 1; }
  find "${dir}" -depth -delete
}

in_use() {
  local name="${1##*/}"
  pgrep -f -- "${name}" >/dev/null 2>&1 && return 0
  lsof -d cwd -Fn 2>/dev/null | grep -qF -- "${name}" && return 0
  return 1
}

docker_binary() {
  local candidate
  for candidate in "$(command -v docker || true)" "${HOME}/.orbstack/bin/docker"; do
    [[ -x "${candidate}" ]] && "${candidate}" info >/dev/null 2>&1 && { printf '%s\n' "${candidate}"; return 0; }
  done
  return 1
}

free_gib() {
  df -k /tmp | awk 'NR == 2 { printf "%d", $4 / 1048576 }'
}

reap_stale() {
  local hours="$1" dir docker_bin cutoff name
  while IFS= read -r dir; do
    if in_use "${dir}"; then
      echo "[remote] keeping ${dir}: a live process uses it"
    else
      echo "[remote] reaping stale ${dir}"
      safe_delete "${dir}" || true
    fi
  done < <(find /tmp -maxdepth 1 -mindepth 1 -type d -name 'chalk-*' -mmin "+$((hours * 60))" 2>/dev/null)
  if docker_bin="$(docker_binary)"; then
    cutoff="$(date -u -v-"${hours}"H +%Y%m%dT%H%M%SZ)"
    while IFS= read -r name; do
      [[ "${name}" =~ ^chalk-gate-postgres-([0-9]{8}T[0-9]{6}Z)- ]] || continue
      if [[ "${BASH_REMATCH[1]}" < "${cutoff}" ]]; then
        echo "[remote] removing orphaned container ${name}"
        "${docker_bin}" rm -f --volumes "${name}" >/dev/null 2>&1 || true
      fi
    done < <("${docker_bin}" ps -a --filter name=chalk-gate-postgres --format '{{.Names}}' 2>/dev/null)
  fi
}

prepare() {
  local id="$1" min_free="$2" hours="$3" work="/tmp/chalk-remote-$1" free
  reap_stale "${hours}"
  free="$(free_gib)"
  if ((free < min_free)); then
    echo "[remote] only ${free} GiB free on /tmp, below the ${min_free} GiB threshold; free disk on the M4 and retry" >&2
    du -sk /tmp/chalk-* 2>/dev/null | sort -rn | head -5 >&2 || true
    exit 75
  fi
  mkdir "${work}"
  echo "[remote] ${free} GiB free; checkout ${work}"
}

cleanup() {
  safe_delete "/tmp/chalk-remote-$1"
  [[ ! -e "/tmp/chalk-remote-$1" ]] && echo "[remote] cleaned /tmp/chalk-remote-$1"
}

# The root gate's tests lane launches Chromium. The default per-user Playwright cache is shared across
# runs, and the install is a no-op when the version this checkout pins is already there.
install_browser() {
  [[ "$1" == "1" ]] || return 0
  echo "==> playwright install chromium (shared cache)"
  pnpm --dir sdks/typescript/client exec playwright install chromium
}

run_gate() {
  local id="$1" timeout_seconds="$2" browser="$3" work="/tmp/chalk-remote-$1" status=3
  shift 3
  trap 'cleanup "${id}"' EXIT
  trap 'exit 143' HUP INT TERM
  exec </dev/null
  mkdir -p "${work}/tmp"
  # Go, Hex, Mix, and pnpm keep their default per-user caches so runs share what the M4 already has.
  export TMPDIR="${work}/tmp" CI=true GOFLAGS=-buildvcs=false

  local checkout="${work}/repo"
  git init -q "${checkout}"
  cd "${checkout}"
  git fetch -q "${work}/repo.bundle" refs/chalk-remote/base:refs/remotes/origin/master refs/chalk-remote/head:refs/heads/chalk-gate
  git checkout -q chalk-gate
  rm -f "${work}/repo.bundle"
  echo "[remote] checked out $(git rev-parse --short HEAD)"

  echo "==> pnpm install (shared store)"
  if pnpm install --frozen-lockfile --prefer-offline && install_browser "${browser}"; then
    echo "==> gate: $*"
    set +e
    "${checkout}/scripts/gates/with-timeout.sh" "${timeout_seconds}" "remote gate" -- "$@"
    status=$?
    set -e
  else
    status=$?
    echo "pnpm install failed (status ${status})"
  fi
  echo "REMOTE_GATE_EXIT=${status}"
  exit "${status}"
}

main() {
  local action="$1"
  shift
  case "${action}" in
    prepare) prepare "$@" ;;
    cleanup) cleanup "$@" ;;
    run)
      local id="$1" timeout_seconds="$2" browser="$3" encoded="$4"
      eval "set -- $(printf '%s' "${encoded}" | base64 -d)"
      run_gate "${id}" "${timeout_seconds}" "${browser}" "$@"
      ;;
    *) echo "unknown action ${action}" >&2; exit 2 ;;
  esac
}

main "$@"
REMOTE

scratch="$(mktemp -d "${TMPDIR:-/tmp}/chalk-remote-local.XXXXXX")"
remote_started=0
cleanup_local() {
  local status=$?
  trap - EXIT INT TERM
  if ((remote_started)); then
    remote cleanup "${run_id}" >/dev/null 2>&1 || remote cleanup "${run_id}" >&2 || echo "remote cleanup failed for ${remote_work}; the next remote.sh run reaps it" >&2
  fi
  find "${scratch}" -depth -delete 2>/dev/null || true
  exit "${status}"
}
trap cleanup_local EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
  echo "Base ref ${base_ref} does not exist locally; run: git fetch origin master" >&2
  exit 2
fi

# A two-commit history keeps the bundle small: the merge base tree stands in for origin/master, and the
# branch tip (plus any uncommitted work, as a third commit) sits on top, so branch scope sees the real diff.
commit_as_gate() {
  git -c user.name="remote gate" -c user.email="remote-gate@example.invalid" commit-tree "$@"
}
base_commit="$(commit_as_gate "$(git rev-parse "$(git merge-base "${base_ref}" HEAD)^{tree}")" -m "origin/master snapshot")"
head_commit="$(commit_as_gate "$(git rev-parse 'HEAD^{tree}')" -p "${base_commit}" -m "branch tip $(git rev-parse --short HEAD)")"
if ((dirty_count > 0)); then
  export GIT_INDEX_FILE="${scratch}/index"
  git read-tree HEAD
  git add -A
  work_tree="$(git write-tree)"
  unset GIT_INDEX_FILE
  head_commit="$(commit_as_gate "${work_tree}" -p "${head_commit}" -m "uncommitted work")"
fi
# The refs live in a scratch bare repository that borrows this repository's objects, so deleting the
# scratch directory removes them and this repository gains no refs.
snapshot_repo="${scratch}/snapshot.git"
git init -q --bare "${snapshot_repo}"
git rev-parse --path-format=absolute --git-path objects >"${snapshot_repo}/objects/info/alternates"
git --git-dir="${snapshot_repo}" update-ref refs/chalk-remote/base "${base_commit}"
git --git-dir="${snapshot_repo}" update-ref refs/chalk-remote/head "${head_commit}"
git --git-dir="${snapshot_repo}" bundle create "${scratch}/repo.bundle" refs/chalk-remote/base refs/chalk-remote/head >/dev/null 2>&1
echo "[local] snapshot of $(git rev-parse --short HEAD) plus ${dirty_count} uncommitted path(s): $(du -h "${scratch}/repo.bundle" | cut -f1)"

mkdir -p "${log_dir}"
remote_started=1
remote prepare "${run_id}" "${min_free_gib}" "${stale_hours}"
ssh "${ssh_options[@]}" "${host}" "cat > ${remote_work}/repo.bundle" <"${scratch}/repo.bundle"

encoded_command="$(printf '%q ' "${gate_command[@]}" | base64 | tr -d '\n')"
echo "[local] running on ${host}; full log: ${log_file}"
set +e
if [[ "${CHALK_REMOTE_VERBOSE:-0}" == "1" ]]; then
  remote run "${run_id}" "${gate_timeout}" "${needs_browser}" "${encoded_command}" 2>&1 | tee "${log_file}"
else
  remote run "${run_id}" "${gate_timeout}" "${needs_browser}" "${encoded_command}" 2>&1 | tee "${log_file}" |
    awk -v keep="${tail_lines}" '
      /^==> |^\[remote\]|^REMOTE_GATE_EXIT|^TIMEOUT/ { print; fflush() }
      { ring[NR % keep] = $0 }
      END {
        print "---- last " keep " lines ----"
        for (i = (NR > keep ? NR - keep + 1 : 1); i <= NR; i++) print ring[i % keep]
      }'
fi
set -e

gate_status="$(sed -n 's/^REMOTE_GATE_EXIT=//p' "${log_file}" | tail -n 1)"
echo "[local] full log: ${log_file}"
if [[ -z "${gate_status}" ]]; then
  echo "[local] connection ended before the gate reported a result; the result is unknown and the checkout is being cleaned up" >&2
  exit 3
fi
if [[ "${gate_status}" == "0" ]]; then
  echo "[local] gate passed"
else
  echo "[local] gate failed with status ${gate_status}" >&2
fi
exit "${gate_status}"
