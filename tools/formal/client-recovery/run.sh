#!/usr/bin/env bash
# Model-checks the client connection and recovery lifecycle (ClientRecovery.tla).
# Usage: tools/formal/client-recovery/run.sh [row ...]
#   row  names from `runs`; without any, every row runs.
# Needs Java 11 or later and curl. The TLA+ tools pin is in ../tla2tools.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=../tla2tools.sh
source "$here/../tla2tools.sh"
jar="$(tla2tools_jar)"
out="${FORMAL_OUT:-$(mktemp -d)}"
failures=0

fail() { echo "FAIL $*"; failures=$((failures + 1)); }
squash() { tr -s '[:space:]' ' '; }

echo "== Code anchors"
while IFS=$'\t' read -r action path fragment; do
  [[ -z "$action" || "$action" == \#* ]] && continue
  if [[ ! -f "$repo/$path" ]]; then
    fail "$action: $path is gone"
  elif ! squash <"$repo/$path" | grep -qF -- "$(printf '%s' "$fragment" | squash)"; then
    fail "$action: $path no longer contains: $fragment"
  fi
done <"$here/anchors"
((failures == 0)) && echo "ok   every fragment in anchors is present"

# tlc NAME "SYNC MEDIA TERMINAL REFRESH LEAVES" DIE RQ LEAVE BREAK RULE prints TLC's verdict line and keeps the full log.
tlc() {
  local dir="$out/$1" faults rule="$7"
  read -ra faults <<<"$2"
  mkdir -p "$dir"
  cp "$here/ClientRecovery.tla" "$dir/"
  sed -e "s/MaxSyncFaults = [0-9]*/MaxSyncFaults = ${faults[0]}/" -e "s/MaxMediaFaults = [0-9]*/MaxMediaFaults = ${faults[1]}/" \
    -e "s/MaxTerminal = [0-9]*/MaxTerminal = ${faults[2]}/" -e "s/MaxRefreshFaults = [0-9]*/MaxRefreshFaults = ${faults[3]}/" \
    -e "s/MaxLeaves = [0-9]*/MaxLeaves = ${faults[4]}/" -e "s/SyncMayDie = [A-Z]*/SyncMayDie = $3/" \
    -e "s/RqRule = \"[a-zA-Z]*\"/RqRule = \"$4\"/" -e "s/LeaveRule = \"[a-zA-Z]*\"/LeaveRule = \"$5\"/" \
    -e "s/Break = \"[a-z_]*\"/Break = \"$6\"/" "$here/ClientRecovery.cfg" >"$dir/ClientRecovery.cfg"
  if [[ "$rule" != safety ]]; then
    sed -i.all -e '/^INVARIANTS/,$d' "$dir/ClientRecovery.cfg"
    if [[ "$rule" == RecoveryEnds ]]; then
      sed -i.spec -e 's/^SPECIFICATION.*/SPECIFICATION LiveSpec/' "$dir/ClientRecovery.cfg"
      echo "PROPERTY $rule" >>"$dir/ClientRecovery.cfg"
    else
      echo "INVARIANT $rule" >>"$dir/ClientRecovery.cfg"
    fi
  fi
  (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -metadir "$dir/states" \
    -config ClientRecovery.cfg ClientRecovery.tla >"$dir/tlc.out" 2>&1 </dev/null) || true
  grep -E "No error has been found|Invariant [A-Za-z]+ is violated|Temporal properties were violated|Deadlock reached|^Error:" \
    "$dir/tlc.out" | head -1 || true
}

echo "== Runs"
while IFS='|' read -r name faults die rq leave break rule expect; do
  name="$(echo "$name" | xargs)"
  [[ -z "$name" || "$name" == \#* ]] && continue
  if (($# > 0)); then printf '%s\n' "$@" | grep -qx -- "$name" || continue; fi
  faults="$(echo "$faults" | xargs)"
  die="$(echo "$die" | xargs)"
  rq="$(echo "$rq" | xargs)"
  leave="$(echo "$leave" | xargs)"
  break="$(echo "$break" | xargs)"
  rule="$(echo "$rule" | xargs)"
  expect="$(echo "$expect" | xargs)"
  verdict="$(tlc "$name" "$faults" "$die" "$rq" "$leave" "$break" "$rule")"
  if [[ "$expect" == pass ]]; then
    want="No error has been found"
  elif [[ "$rule" == RecoveryEnds ]]; then
    want="Temporal properties were violated"
  else
    want="Invariant $rule is violated"
  fi
  if [[ "$verdict" == *"$want"* ]]; then
    echo "ok   $name ($expect, $rule): $(grep -E 'distinct states found' "$out/$name/tlc.out" | tail -1)"
  else
    fail "$name should be $expect for $rule, TLC said: ${verdict:-nothing} (see $out/$name/tlc.out)"
  fi
done <"$here/runs"

echo "TLC logs: $out"
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
