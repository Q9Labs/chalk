#!/usr/bin/env bash
# Testbox owns snapshots, transport, time limits, receipts, and Droplet cleanup.
set -euo pipefail

usage() {
  cat <<'HELP'
Run a Chalk gate on a disposable Linux testbox (never the M4).

Usage:
  scripts/gates/remote.sh [--dry-run] <root|api|sync|recorder> [gate args...]
  scripts/gates/remote.sh [--dry-run] -- <command> [args...]

Stage new files first: testbox ships tracked working-tree changes, not untracked files.
Requires the testbox skill at ~/.agents/skills/testbox/testbox.py.
Provisioning prints live. Job headers and a tail print after collection;
testbox currently saves job output without streaming it to stdout.
Full logs and receipts remain in ~/.local/state/testbox/<task>/.

Environment:
  CHALK_REMOTE_BASE_REF    root base (default origin/master; only testbox's
                          origin/HEAD merge-base history is available)
  CHALK_REMOTE_TAIL_LINES  final log tail length (default 60)
  CHALK_REMOTE_VERBOSE=1   print the full collected job log
  CHALK_REMOTE_LOG_DIR     local combined log (default ${TMPDIR}/chalk-remote-logs)

TTL includes setup: root/custom 3600s, api/sync 2700s, recorder 1200s.
Each run uses the default testbox $0.50 ceiling.
Exit status comes from testbox (gate status when reached; otherwise setup failure).
HELP
}

dry_run=0
if [[ "${1:-}" == --dry-run ]]; then dry_run=1; shift; fi
if (($# == 0)); then usage >&2; exit 2; fi
gate="$1"
shift
case "$gate" in
  root) ttl=3600; size=s-4vcpu-8gb ;;
  api | sync) ttl=2700; size=s-4vcpu-8gb ;;
  recorder) ttl=1200; size=s-2vcpu-4gb ;;
  --)
    if (($# == 0)); then echo 'remote.sh -- requires a command' >&2; exit 2; fi
    ttl=3600; size=s-4vcpu-8gb ;;
  help | -h | --help) usage; exit 0 ;;
  *) echo "Unknown gate: $gate" >&2; usage >&2; exit 2 ;;
esac
repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repository_root"
tail_lines="${CHALK_REMOTE_TAIL_LINES:-60}"
if [[ ! "$tail_lines" =~ ^[1-9][0-9]*$ ]]; then
  echo 'CHALK_REMOTE_TAIL_LINES must be a positive integer' >&2; exit 2
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo 'Untracked files are not shipped by testbox. Stage wanted files (git add <path>), or remove/move them before running.' >&2
  git ls-files --others --exclude-standard >&2
  exit 2
fi
printf -v command '%q ' bash scripts/gates/testbox-run.sh "$gate" "$@"
printf -v base '%q' "${CHALK_REMOTE_BASE_REF:-origin/master}"
command="CHALK_REMOTE_BASE_REF=$base $command"
args=(python3 "$HOME/.agents/skills/testbox/testbox.py" run --repo "$repository_root" --command "$command" --ttl "$ttl" --size "$size" --budget 0.50)
if ((dry_run)); then
  printf 'remote.sh dry run (no box, no files written)\n  source: %s\n  tracked changes included; no untracked inputs\n  ' "$(git rev-parse HEAD)"
  printf '%q ' "${args[@]}"
  printf '\n'
  exit 0
fi
log_dir="${CHALK_REMOTE_LOG_DIR:-${TMPDIR:-/tmp}/chalk-remote-logs}"
mkdir -p "$log_dir"
log_file="$(mktemp "$log_dir/$(date -u +%Y%m%dT%H%M%SZ)-${gate/--/command}.XXXXXX")"
echo "==> testbox $gate; full local log: $log_file"
set +e
"${args[@]}" 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e
# Read the receipt path printed by testbox; do not duplicate its transport.
job_log="$(python3 - "$log_file" <<'PYLOG'
import json
import pathlib
import sys
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    try:
        receipt = json.loads(line)
    except ValueError:
        continue
    if isinstance(receipt, dict) and 'output' in receipt:
        print(pathlib.Path(receipt['output']) / 'job.log')
        break
PYLOG
)"
if [[ -n "$job_log" && -f "$job_log" ]]; then
  cat "$job_log" >> "$log_file"
  if [[ "${CHALK_REMOTE_VERBOSE:-0}" == 1 ]]; then
    cat "$job_log"
  else
    awk '/^==> |^TIMEOUT/ { print }' "$job_log"
    echo "---- last $tail_lines lines ----"
    tail -n "$tail_lines" "$job_log"
  fi
fi
echo "[local] testbox exit $status; full log: $log_file"
exit "$status"
