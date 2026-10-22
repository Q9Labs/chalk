#!/usr/bin/env bash
# Runs a gate on the M4 Mac mini from the exact local commit plus uncommitted work, then cleans up.
set -euo pipefail

usage() {
  cat <<'EOF'
Run a Chalk gate on the M4 (ssh agents-macmini) in a throwaway checkout.

Usage:
  scripts/gates/remote.sh [--dry-run] [--priority] [--exclusive] [--run-id ID] <gate> [gate args...]
  scripts/gates/remote.sh [--dry-run] -- <command> [args...]
  scripts/gates/remote.sh --attach ID

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
  2. Waits on the M4 without a live client; refuses to run when the M4 has too little free disk.
  3. Checks out the snapshot under /tmp, installs with shared pnpm, Go, Hex, and Mix caches (plus Playwright Chromium for root), and runs
     the gate under a time limit with GOFLAGS=-buildvcs=false.
  4. Prints step headers live and the last lines at the end, saves the full log locally, and the M4
     deletes its checkout when the job ends. Disconnects and Ctrl-C leave the job running.
  5. Registers a durable FIFO ticket (lead --priority goes first among waiting jobs). Retries with
     --run-id ID reuse the same ticket. Reattach by ID after a client restart; network drops retry.

Environment:
  CHALK_REMOTE_REPO                  local repository root (default script repository)
  CHALK_REMOTE_NEEDS_BROWSER=1        install Chromium for custom -- commands
  CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS wait limit on the M4 (default 0: unlimited; exit 76 on timeout)
  CHALK_REMOTE_HOST                  SSH host (default agents-macmini)
  CHALK_REMOTE_BASE_REF              base ref for branch scope (default origin/master)
  CHALK_REMOTE_MIN_FREE_GIB          refuse to start below this much free disk (default 8)
  CHALK_REMOTE_SLOTS                concurrent slots (default 3); --exclusive runs alone
  CHALK_REMOTE_RUN_ID                reuse an existing run ID (also --run-id ID)
  CHALK_REMOTE_GATE_TIMEOUT_SECONDS  limit for each setup step and the gate (default 3600)
  CHALK_REMOTE_TAIL_LINES            lines printed at the end (default 60)
  CHALK_REMOTE_VERBOSE=1             stream the whole log instead of step headers
  CHALK_REMOTE_LOG_DIR               local log directory (default ${TMPDIR:-/tmp}/chalk-remote-logs)

Exit codes: the gate's status; 76 when an explicit queue wait limit expires; 75 when the M4 is
too full; 4 for an unknown job ID. Completed logs stay on the M4 for seven days; exit codes stay.
EOF
}

dry_run=0
priority=0
exclusive=0
attach=0
run_id="${CHALK_REMOTE_RUN_ID:-}"
while (($#)); do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --exclusive) exclusive=1; shift ;;
    --priority) priority=1; shift ;;
    --run-id|--attach)
      option="$1"
      [[ $# -ge 2 ]] || { echo "$option requires a job ID" >&2; exit 2; }
      run_id="$2"
      [[ "$option" != --attach ]] || attach=1
      shift 2
      ;;
    *) break ;;
  esac
done
if [[ -n "$run_id" && ! "$run_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ ]]; then
  echo "Invalid run ID (use 1-128 letters, digits, underscores or hyphens)" >&2
  exit 2
fi
if ((attach)); then
  set -- -- true
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
[[ "$min_free_gib" =~ ^[0-9]{1,9}$ ]] || { echo "CHALK_REMOTE_MIN_FREE_GIB must be a nonnegative integer of at most 9 digits" >&2; exit 2; }
gate_timeout="${CHALK_REMOTE_GATE_TIMEOUT_SECONDS:-3600}"
tail_lines="${CHALK_REMOTE_TAIL_LINES:-60}"
queue_timeout="${CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS:-0}"
slots="${CHALK_REMOTE_SLOTS:-3}"
[[ "$slots" =~ ^[1-9][0-9]?$|^100$ ]] || { echo "CHALK_REMOTE_SLOTS must be 1..100" >&2; exit 2; }
if [[ ! "$tail_lines" =~ ^[1-9][0-9]*$ ]]; then
  echo "CHALK_REMOTE_TAIL_LINES must be a positive integer" >&2
  exit 2
fi
if [[ ! "$queue_timeout" =~ ^[0-9]+$ ]]; then
  echo "CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS must be a nonnegative integer" >&2
  exit 2
fi
log_dir="${CHALK_REMOTE_LOG_DIR:-${TMPDIR:-/tmp}/chalk-remote-logs}"

script_directory="$(cd "$(dirname "$0")" && pwd)"
repository_root="${CHALK_REMOTE_REPO:-$(cd "${script_directory}/../.." && pwd)}"
cd "${repository_root}"
branch_slug="$(git rev-parse --abbrev-ref HEAD | tr -c 'A-Za-z0-9\n' '-' | cut -c1-24)"
run_nonce="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
run_id="${run_id:-$(date -u +%Y%m%dT%H%M%SZ)-${branch_slug}-$$-${run_nonce}}"
log_file="${log_dir}/${run_id}.log"
remote_work="~/.local/share/chalk-remote/v1/jobs/${run_id}/work"

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
  disk threshold:  ${min_free_gib} GiB free
  gate command:    ${quoted_command}
  browser:         ${needs_browser} (1 installs Chromium)
  queue timeout:   ${queue_timeout}s
  gate timeout:    ${gate_timeout}s
  local log:       ${log_file}
Steps: upload bundle, detached queue, preflight, checkout, pnpm install --frozen-lockfile, Playwright Chromium (when requested), run gate, delete checkout.
EOF
  exit 0
fi

# Content-addressed deployment never rewrites a helper used by an existing dispatcher.
helper_hash="$(shasum -a 256 "${script_directory}/remote-queue.py" | cut -d ' ' -f1)"
remote_helper=".local/share/chalk-remote/helpers/${helper_hash}.py"
while :; do
  if ssh "${ssh_options[@]}" "${host}" "set -e; mkdir -p .local/share/chalk-remote/helpers; umask 077; trap 'rm -f ${remote_helper}.upload.\$\$' EXIT; cat > ${remote_helper}.upload.\$\$; test \"\$(shasum -a 256 ${remote_helper}.upload.\$\$ | cut -d ' ' -f1)\" = ${helper_hash}; mv ${remote_helper}.upload.\$\$ ${remote_helper}" <"${script_directory}/remote-queue.py"; then
    break
  else
    install_status=$?
    if ((install_status != 255)); then
      echo "[local] helper installation failed with status ${install_status}; job state stays on the M4" >&2
      exit "$install_status"
    fi
  fi
  echo "[local] connection lost while installing helper; retrying" >&2
  sleep 2
done
remote() {
  ssh "${ssh_options[@]}" "${host}" "zsh -lc 'exec env CHALK_REMOTE_SLOTS=${slots} python3 ${remote_helper} $*'"
}

mkdir -p "${log_dir}"
echo "[local] job ID: ${run_id}; reattach: scripts/gates/remote.sh --attach ${run_id}"
echo "[local] full log: ${log_file}"

follow() {
  local offset=0 result chunk status response
  chunk="$(mktemp "${log_dir}/.read.XXXXXX")"
  trap 'rm -f "$chunk"' RETURN
  # A failed transfer is discarded and retried from its last confirmed byte offset.
  remote attach "$run_id" >/dev/null || true
  while :; do
    # Read status first: a completed receipt guarantees all final output is ready to read.
    if response="$(remote status "$run_id")" && remote read "$run_id" "$offset" >"${chunk}"; then
      if [[ -s "$chunk" ]]; then
        ((offset != 0)) || : >"${log_file}"
        cat "${chunk}" >>"${log_file}"
      fi
      offset=$((offset + $(wc -c <"${chunk}")))
      if [[ "${CHALK_REMOTE_VERBOSE:-0}" == 1 ]]; then
        cat "${chunk}"
      else
        sed -n '/^==> /p; /^\[remote\]/p; /^REMOTE_GATE_EXIT/p; /^TIMEOUT/p' "${chunk}"
      fi
      result="$(python3 -c 'import json,sys; row=json.load(sys.stdin); print(row["result"] if row["state"]=="done" else "")' <<<"$response")"
      if [[ -n "$result" ]]; then
        [[ "${CHALK_REMOTE_VERBOSE:-0}" == 1 || ! -f "$log_file" ]] || tail -n "${tail_lines}" "${log_file}"
        rm -f "$chunk"
        trap - RETURN
        return "$result"
      fi
    else
      status=$?
      if ((status == 4)); then
        echo "[local] no registered job ${run_id} on ${host}" >&2
        rm -f "$chunk"
        trap - RETURN
        return 4
      fi
      if ((status != 255)); then
        echo "[local] remote read failed with status ${status}; reattach by job ID after fixing it" >&2
        rm -f "$chunk"
        trap - RETURN
        return "$status"
      fi
      echo "[local] connection lost; job stays on M4; retrying ${run_id}" >&2
    fi
    sleep 2
  done
}

if ((attach)); then
  follow
  exit $?
fi
scratch="$(mktemp -d "${TMPDIR:-/tmp}/chalk-remote-local.XXXXXX")"
cleanup_local() {
  local status=$?
  trap - EXIT INT TERM
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

cp "${script_directory}/remote-worker.sh" "${scratch}/runner.sh"
python3 - "$gate_timeout" "$needs_browser" "$min_free_gib" "${gate_command[@]}" >"${scratch}/request.json" <<'PYTHON'
import json, sys
json.dump(sys.argv[1:], sys.stdout)
PYTHON
tar -cf "${scratch}/submission.tar" -C "${scratch}" repo.bundle runner.sh request.json
# Retrying an ambiguous SSH result with this ID reuses its original ticket.
while :; do
  submit_options=(--priority "$priority" --wait-seconds "$queue_timeout")
  ((exclusive == 0)) || submit_options+=(--exclusive)
  if remote submit "$run_id" "${submit_options[@]}" <"${scratch}/submission.tar"; then
    break
  else
    status=$?
    [[ "$status" == 255 ]] || exit "$status"
  fi
  echo "[local] submission interrupted; retrying the same run ID ${run_id}" >&2
  sleep 2
done
follow
