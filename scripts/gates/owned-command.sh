# shellcheck shell=bash
# Sourced by gate wrappers. Each command runs in its own process group, so a stopped gate can stop the
# command and everything it started, even when the command ignores the signal.
owned_pid=""
stop_signal="TERM"
gate_label="${0##*/}${*:+ $*}"

run_owned() {
  local status=0
  # Job control gives the command its own process group and keeps INT deliverable to it.
  set -m
  "$@" </dev/null &
  owned_pid="$!"
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
  [[ -n "${owned_pid}" ]] || return 0
  local grace="${CHALK_GATE_STOP_GRACE_SECONDS:-10}"
  local tenths=$((grace * 10))
  kill "-${stop_signal}" -- "-${owned_pid}" 2>/dev/null || true
  while ((tenths > 0)) && group_alive "${owned_pid}"; do
    sleep 0.1
    tenths=$((tenths - 1))
  done
  if group_alive "${owned_pid}"; then
    printf '%s: still running %ss after %s, so it gets KILL\n' "${gate_label}" "${grace}" "${stop_signal}" >&2
  fi
  kill -KILL -- "-${owned_pid}" 2>/dev/null || true
  wait "${owned_pid}" 2>/dev/null || true
  owned_pid=""
}

# SECONDS counts from the wrapper's start, so the line says how long the gate ran before the stop.
stopped() {
  stop_signal="$1"
  printf '%s: stopped by %s after %ss; it cleans up and exits %s\n' "${gate_label}" "$1" "${SECONDS}" "$2" >&2
  exit "$2"
}

trap 'stopped INT 130' INT
trap 'stopped TERM 143' TERM
