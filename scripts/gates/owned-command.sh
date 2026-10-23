# shellcheck shell=bash
# Sourced by gate wrappers. Each command runs in its own process group, so a stopped gate can stop the
# command and everything it started, even when the command ignores the signal. The group is not the
# terminal's foreground group, so a wrapped command must not prompt: a read from the terminal stops it.
owned_pid=""
owned_starting=0
owned_before=""
stop_signal="TERM"
gate_label="${0##*/}${*:+ $*}"
owned_grace="${CHALK_GATE_STOP_GRACE_SECONDS:-10}"
if [[ ! "${owned_grace}" =~ ^[0-9]+$ ]]; then
  echo "${gate_label}: CHALK_GATE_STOP_GRACE_SECONDS must be a whole number of seconds" >&2
  exit 2
fi

# $! is unset until a first background job, and set -u would reject it.
last_job() { (set +u; printf '%s' "$!"); }

run_owned() {
  local status=0
  # A stop that lands after the fork but before owned_pid is set still finds the command through $!.
  owned_before="$(last_job)"
  owned_starting=1
  # Job control gives the command its own process group and keeps INT deliverable to it.
  set -m
  "$@" </dev/null &
  owned_pid="$!"
  owned_starting=0
  set +m
  # Unlike a foreground command, wait returns as soon as a trapped signal arrives.
  wait "${owned_pid}" || status="$?"
  owned_pid=""
  return "${status}"
}

# A zombie still belongs to its group, and kill -0 counts it on Linux, so only live members count.
group_alive() {
  ps -A -o pgid= -o stat= | awk -v group="$1" '$1 == group && $2 !~ /^Z/ { live = 1 } END { exit !live }'
}

stop_owned() {
  if [[ -z "${owned_pid}" && "${owned_starting}" == 1 && "$(last_job)" != "${owned_before}" ]]; then
    owned_pid="$(last_job)"
  fi
  [[ -n "${owned_pid}" ]] || return 0
  # The deadline comes from the clock, so a slow process-table scan cannot stretch the grace. SECONDS
  # counts whole seconds, so the command gets between the grace less one second and the grace.
  local deadline=$((SECONDS + owned_grace))
  kill "-${stop_signal}" -- "-${owned_pid}" 2>/dev/null || true
  while sleep 0.1 && group_alive "${owned_pid}"; do
    if ((SECONDS >= deadline)); then
      printf '%s: still running %ss after %s, so it gets KILL\n' "${gate_label}" "${owned_grace}" "${stop_signal}" >&2
      break
    fi
  done
  kill -KILL -- "-${owned_pid}" 2>/dev/null || true
  wait "${owned_pid}" 2>/dev/null || true
  owned_pid=""
}

# SECONDS counts from the wrapper's start, so the line says how long the gate ran before the stop.
# A second INT or TERM, such as a CI cancel that follows INT with TERM, must not cut cleanup short.
stopped() {
  trap '' INT TERM
  stop_signal="$1"
  printf '%s: stopped by %s after %ss; it cleans up and exits %s\n' "${gate_label}" "$1" "${SECONDS}" "$2" >&2
  exit "$2"
}

trap 'stopped INT 130' INT
trap 'stopped TERM 143' TERM
