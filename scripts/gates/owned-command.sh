# shellcheck shell=bash
# Sourced by gate wrappers. Each command runs in its own process group, so a stopped gate can stop the
# command and everything it started, even when the command ignores the signal.
owned_pid=""
stop_signal="TERM"

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

stop_owned() {
  [[ -n "${owned_pid}" ]] || return 0
  local tenths=$((${CHALK_GATE_STOP_GRACE_SECONDS:-10} * 10))
  kill "-${stop_signal}" -- "-${owned_pid}" 2>/dev/null || true
  while ((tenths > 0)) && kill -0 -- "-${owned_pid}" 2>/dev/null; do
    sleep 0.1
    tenths=$((tenths - 1))
  done
  kill -KILL -- "-${owned_pid}" 2>/dev/null || true
  wait "${owned_pid}" 2>/dev/null || true
  owned_pid=""
}

trap 'stop_signal=INT; exit 130' INT
trap 'stop_signal=TERM; exit 143' TERM
