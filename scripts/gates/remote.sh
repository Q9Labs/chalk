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
  1. Snapshots the merge base tree, each branch commit tree, and any staged, unstaged, and
     untracked work. Branch-scoped gates see the pull request diff, while secret scans also
     see content added and removed between branch commits.
  2. Refuses to start when the M4 has too little free disk, after deleting stale /tmp/chalk-*
     runner-owned checkouts and chalk-gate-postgres-* containers that no live process uses.
  3. Checks out the snapshot under /tmp, installs with shared pnpm, Go, Hex, and Mix caches (plus Playwright Chromium for root), and runs
     the gate under a time limit with GOFLAGS=-buildvcs=false.
  4. Prints step headers live and the last lines at the end, saves the full log locally, and always
     deletes the remote checkout (also when SSH drops or you press Ctrl-C).

Environment:
  CHALK_REMOTE_REPO                  local repository root (default script repository)
  CHALK_REMOTE_NEEDS_BROWSER=1        install Chromium for custom -- commands
  CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS wait for the M4 (default 5400; exit 76 on timeout)
  CHALK_REMOTE_HOST                  SSH host (default agents-macmini)
  CHALK_REMOTE_BASE_REF              base ref for branch scope (default origin/master)
  CHALK_REMOTE_MIN_FREE_GIB          refuse to start below this much free disk (default 8)
  CHALK_REMOTE_STALE_HOURS           reap /tmp/chalk-* older than this (default 4)
  CHALK_REMOTE_GATE_TIMEOUT_SECONDS  limit for each setup step and the gate (default 3600)
  CHALK_REMOTE_TAIL_LINES            lines printed at the end (default 60)
  CHALK_REMOTE_VERBOSE=1             stream the whole log instead of step headers
  CHALK_REMOTE_LOG_DIR               local log directory (default ${TMPDIR:-/tmp}/chalk-remote-logs)

Exit codes: the gate's own status; 76 when the queue wait expires; 75 when the M4 is too full; 3 when the connection dropped before
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
needs_browser="${CHALK_REMOTE_NEEDS_BROWSER:-0}"
case "${gate}" in
  root)
    needs_browser=1
    # The selected local base is always published as origin/master in the snapshot.
    gate_command=(pnpm run gate -- --base origin/master "$@")
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
queue_timeout="${CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS:-5400}"
if [[ ! "$tail_lines" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHALK_REMOTE_TAIL_LINES must be a positive integer" >&2
  exit 2
fi
if [[ ! "$queue_timeout" =~ ^[0-9]+$ ]]; then
  echo "CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS must be a nonnegative integer" >&2
  exit 2
fi
log_dir="${CHALK_REMOTE_LOG_DIR:-${TMPDIR:-/tmp}/chalk-remote-logs}"

repository_root="${CHALK_REMOTE_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "${repository_root}"
branch_slug="$(git rev-parse --abbrev-ref HEAD | tr -c 'A-Za-z0-9\n' '-' | cut -c1-24)"
run_nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-${branch_slug}-$$-${run_nonce}"
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
  browser:         ${needs_browser} (1 installs Chromium)
  queue timeout:   ${queue_timeout}s
  gate timeout:    ${gate_timeout}s
  local log:       ${log_file}
Steps: upload bundle, queue, preflight and reap, checkout, pnpm install --frozen-lockfile, Playwright Chromium (when requested), run gate, delete checkout.
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

owned_checkout() {
  local dir="$1" name="${1##*/}" marker="$1/.chalk-remote-owner"
  [[ "$dir" == "/tmp/${name}" && "$name" =~ ^chalk-remote-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9-]{1,24}-[0-9]+-[0-9a-f]{16}$ ]] || return 1
  [[ -d "$dir" && ! -L "$dir" && -f "$marker" && ! -L "$marker" ]] || return 1
  [[ "$(cat "$marker")" == "${name#chalk-remote-}" ]]
}

safe_delete() {
  local dir="$1"
  [[ -e "$dir" || -L "$dir" ]] || return 0
  owned_checkout "$dir" || { echo "refusing to delete ${dir}: not a marked runner checkout" >&2; return 1; }
  [[ "$(dirname "$(cd "${dir}" && pwd -P)")" == "/private/tmp" ]] || { echo "refusing to delete ${dir}: not a direct child of /tmp" >&2; return 1; }
  find "${dir}" -depth -delete
}

in_use() {
  local name="${1##*/}"
  pgrep -f -- "${name}" >/dev/null 2>&1 && return 0
  { lsof -d cwd -Fn 2>/dev/null || true; } | grep -F -- "${name}" >/dev/null && return 0
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
  local hours="$1" dir docker_bin cutoff name owner
  while IFS= read -r dir; do
    owned_checkout "${dir}" || continue
    if in_use "${dir}"; then
      echo "[remote] keeping ${dir}: a live process uses it"
    else
      echo "[remote] reaping stale ${dir}"
      safe_delete "${dir}" || true
    fi
  done < <(find /tmp/ -maxdepth 1 -mindepth 1 -type d -name 'chalk-remote-*' -mmin "+$((hours * 60))" 2>/dev/null)
  if docker_bin="$(docker_binary)"; then
    cutoff="$(date -u -v-"${hours}"H +%Y%m%dT%H%M%SZ)"
    while IFS= read -r name; do
      [[ "${name}" =~ ^chalk-gate-postgres-([0-9]{8}T[0-9]{6}Z)-([0-9]+)$ ]] || continue
      owner="${BASH_REMATCH[2]}"
      if [[ "${BASH_REMATCH[1]}" < "${cutoff}" ]]; then
        if ps -p "${owner}" -o pid= >/dev/null 2>&1; then
          echo "[remote] keeping container ${name}: its owner PID is alive"
          continue
        fi
        echo "[remote] removing orphaned container ${name}"
        "${docker_bin}" rm -f --volumes "${name}" >/dev/null 2>&1 || true
      fi
    done < <("${docker_bin}" ps -a --filter name=chalk-gate-postgres --format '{{.Names}}' 2>/dev/null)
  fi
}

# macOS shlock reclaims the lock after its owning PID dies; no daemon is needed.
wait_for_turn() {
  local timeout="$1" started=$SECONDS announced=0 remaining
  while :; do
    if shlock -p "$$" -f /tmp/chalk-remote-admission.lock; then
      # Include processes whose checkout has already been unlinked, not just
      # directories that still exist. Queued runners do not enter a checkout.
      if ! pgrep -f '[/]tmp/chalk-remote-' >/dev/null 2>&1 &&
        ! { lsof -d cwd -Fn 2>/dev/null || true; } | grep -E '^n(/private)?/tmp/chalk-remote-' >/dev/null; then
        return 0
      fi
      rm -f /tmp/chalk-remote-admission.lock
    fi
    if ((announced == 0)); then
      echo "[remote] another live chalk-remote gate is running; waiting for the M4"
      announced=1
    fi
    if ((SECONDS - started >= timeout)); then
      echo "[remote] queue timed out after ${timeout}s" >&2
      exit 76
    fi
    remaining=$((timeout - (SECONDS - started)))
    if ((remaining > 30)); then remaining=30; fi
    sleep "$remaining"
  done
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
  printf '%s\n' "${id}" >"${work}/.chalk-remote-owner"
  echo "[remote] ${free} GiB free; checkout ${work}"
}

# Keep a PID receipt outside the checkout so cancellation can stop the remote
# process tree before removing files. Start times protect against PID reuse.
stop_run() {
  local id="$1" owner pid index alive attempt
  local pids=() starts=()
  owner="$(cat "/tmp/chalk-owner-${id}.pid" 2>/dev/null || true)"
  while read -r pid; do
    [[ "$pid" != "$$" ]] || continue
    pids+=("$pid")
    starts+=("$(ps -p "$pid" -o lstart= || true)")
  done < <({
    if [[ "$owner" =~ ^[0-9]+$ ]] && { [[ "$owner" == "$$" ]] || ps -p "$owner" -o command= | grep -F -- "$id" >/dev/null; }; then
      ps -axo pid=,ppid= | awk -v root="$owner" '
        function visit(pid, child) {
          for (child in parent) if (parent[child] == pid) visit(child)
          print pid
        }
        { parent[$1] = $2 }
        END { visit(root) }'
    fi
    # Children can outlive their parent (for example after Go's test timeout).
    # Their exact checkout reference still proves ownership after reparenting.
    pgrep -f "[/]tmp/chalk-remote-${id}(/|$)" || true
    { lsof -d cwd -Fpn 2>/dev/null || true; } | awk -v work="/tmp/chalk-remote-${id}" '
      /^p/ { pid = substr($0, 2) }
      /^n/ {
        path = substr($0, 2); sub(/^\/private/, "", path)
        if (path == work || index(path, work "/") == 1) print pid
      }'
  } | sort -nu)
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for attempt in {1..10}; do
    alive=0
    for ((index=0; index<${#pids[@]}; index++)); do
      pid="${pids[index]}"
      if [[ -n "${starts[index]}" && "$(ps -p "$pid" -o lstart=)" == "${starts[index]}" ]]; then
        alive=1
      fi
    done
    ((alive)) || return 0
    sleep 1
  done
  for ((index=0; index<${#pids[@]}; index++)); do
    pid="${pids[index]}"
    if [[ -n "${starts[index]}" && "$(ps -p "$pid" -o lstart=)" == "${starts[index]}" ]]; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

cleanup() {
  stop_run "$1"
  rm -f "/tmp/chalk-owner-$1.pid"
  rm -f "/tmp/chalk-upload-$1.bundle"
  safe_delete "/tmp/chalk-remote-$1"
  [[ ! -e "/tmp/chalk-remote-$1" ]] && echo "[remote] cleaned /tmp/chalk-remote-$1"
}

# The root gate's tests lane launches Chromium. The default per-user Playwright cache is shared across
# runs, and the install is a no-op when the version this checkout pins is already there.
install_browser() {
  [[ "$1" == "1" ]] || return 0
  echo "==> playwright install chromium (shared cache)"
  scripts/gates/with-timeout.sh "$2" "Chromium setup" -- pnpm --dir sdks/typescript/client exec playwright install chromium
}

run_gate() {
  local id="$1" timeout_seconds="$2" browser="$3" work="/tmp/chalk-remote-$1" status=3
  local queue_timeout="$4" min_free="$5" hours="$6"
  shift 6
  trap 'cleanup "${id}"; if [[ "$(cat /tmp/chalk-remote-admission.lock 2>/dev/null | tr -d "[:space:]")" == "$$" ]]; then rm -f /tmp/chalk-remote-admission.lock; fi' EXIT
  trap 'exit 143' HUP INT TERM
  printf '%s\n' "$$" >"/tmp/chalk-owner-${id}.pid"
  exec </dev/null
  wait_for_turn "${queue_timeout}"
  prepare "${id}" "${min_free}" "${hours}"
  mv "/tmp/chalk-upload-${id}.bundle" "${work}/repo.bundle"
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
  if scripts/gates/with-timeout.sh "${timeout_seconds}" "dependency setup" -- pnpm install --frozen-lockfile --prefer-offline; then
    if install_browser "${browser}" "${timeout_seconds}"; then
      status=0
    else
      status=$?
      echo "Chromium installation failed (status ${status})"
    fi
  else
    status=$?
    echo "pnpm install failed (status ${status})"
  fi
  if ((status == 0)); then
    echo "==> gate: $*"
    set +e
    "${checkout}/scripts/gates/with-timeout.sh" "${timeout_seconds}" "remote gate" -- "$@"
    status=$?
    set -e
  fi
  printf '\nREMOTE_GATE_EXIT=%s\n' "${status}"
  exit "${status}"
}

main() {
  local action="$1"
  shift
  case "${action}" in
    prepare) prepare "$@" ;;
    cleanup) cleanup "$@" ;;
    run)
      local id="$1" timeout_seconds="$2" browser="$3" encoded="$4" queue_timeout="$5" min_free="$6" hours="$7"
      eval "set -- $(printf '%s' "${encoded}" | base64 -d)"
      run_gate "${id}" "${timeout_seconds}" "${browser}" "${queue_timeout}" "${min_free}" "${hours}" "$@"
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

# Keep old base history out of the bundle, but preserve every branch tree so secret scans can
# find content that an intermediate commit added and a later commit removed.
commit_as_gate() {
  git -c user.name="remote gate" -c user.email="remote-gate@example.invalid" commit-tree "$@"
}
merge_base="$(git merge-base "${base_ref}" HEAD)"
base_commit="$(commit_as_gate "$(git rev-parse "${merge_base}^{tree}")" -m "origin/master snapshot")"
head_commit="${base_commit}"
while IFS= read -r branch_commit; do
  head_commit="$(commit_as_gate "$(git rev-parse "${branch_commit}^{tree}")" -p "${head_commit}" -m "branch tree ${branch_commit}")"
done < <(git rev-list --reverse --topo-order "${merge_base}..HEAD")
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
ssh "${ssh_options[@]}" "${host}" "cat > /tmp/chalk-upload-${run_id}.bundle" <"${scratch}/repo.bundle"

encoded_command="$(printf '%q ' "${gate_command[@]}" | base64 | tr -d '\n')"
echo "[local] running on ${host}; full log: ${log_file}"
set +e
if [[ "${CHALK_REMOTE_VERBOSE:-0}" == "1" ]]; then
  remote run "${run_id}" "${gate_timeout}" "${needs_browser}" "${encoded_command}" "${queue_timeout}" "${min_free_gib}" "${stale_hours}" 2>&1 | tee "${log_file}"
else
  remote run "${run_id}" "${gate_timeout}" "${needs_browser}" "${encoded_command}" "${queue_timeout}" "${min_free_gib}" "${stale_hours}" 2>&1 | tee "${log_file}" |
    awk -v keep="${tail_lines}" '
      /^==> |^\[remote\]|^REMOTE_GATE_EXIT|^TIMEOUT/ { print; fflush() }
      { ring[NR % keep] = $0 }
      END {
        print "---- last " keep " lines ----"
        for (i = (NR > keep ? NR - keep + 1 : 1); i <= NR; i++) print ring[i % keep]
      }'
fi
remote_status=${PIPESTATUS[0]}
set -e

gate_status="$(sed -n 's/^REMOTE_GATE_EXIT=//p' "${log_file}" | tail -n 1)"
echo "[local] full log: ${log_file}"
if [[ -z "${gate_status}" && ( "$remote_status" == 75 || "$remote_status" == 76 ) ]]; then
  exit "$remote_status"
fi
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
