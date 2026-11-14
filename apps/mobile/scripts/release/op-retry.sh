#!/usr/bin/env bash
# Sourced by the release scripts. The 1Password service account is shared by every release job and has an hourly request limit,
# so a rate-limited `op` call waits and tries again; any other failure stops at once.
op_retry() {
  local attempt err
  err=$(mktemp)
  for attempt in $(seq 1 16); do
    if op "$@" 2>"$err"; then
      rm -f "$err"
      return 0
    fi
    if ! grep -q 'rate-limited' "$err"; then
      cat "$err" >&2
      rm -f "$err"
      return 1
    fi
    [[ $attempt -lt 16 ]] || break
    echo "1Password rate limit; try $attempt of 16, waiting 4 minutes." >&2
    sleep 240
  done
  rm -f "$err"
  echo '1Password stayed rate-limited for an hour.' >&2
  return 1
}
