#!/usr/bin/env bash
# Model-checks Sync entry admission and Leave ordering (EntryLeave.tla).
# Usage: tools/formal/sync-entry-leave/run.sh [--deep]
#   --deep  also checks 5 entries and 3 consumer nodes.
# Needs Java 11 or later and curl. The TLA+ tools pin is in ../tla2tools.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
model="$here"
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
done <"$model/anchors"
((failures == 0)) && echo "ok   every fragment in anchors is present"

# tlc NAME MAX_ENTRY CONSUMERS BREAK [RULE] prints TLC's verdict line and keeps the full log.
# With RULE, TLC checks only that rule on one worker, so a variant that breaks
# several rules still reports the one it is listed for.
tlc() {
  local dir="$out/$1" workers=auto
  mkdir -p "$dir"
  cp "$model/EntryLeave.tla" "$dir/"
  sed -e "s/MaxEntry = [0-9]*/MaxEntry = $2/" -e "s/Consumers = {[^}]*}/Consumers = {$3}/" \
    -e "s/Break = \"[a-z_]*\"/Break = \"$4\"/" "$model/EntryLeave.cfg" >"$dir/EntryLeave.cfg"
  if [[ -n "${5:-}" ]]; then
    workers=1
    sed -i.all -e '/^INVARIANTS/,$d' "$dir/EntryLeave.cfg"
    if [[ "$5" == LeaveEnds ]]; then echo "PROPERTY LeaveEnds"; else echo "INVARIANT $5"; fi >>"$dir/EntryLeave.cfg"
  fi
  (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers "$workers" -metadir "$dir/states" \
    -config EntryLeave.cfg EntryLeave.tla >"$dir/tlc.out" 2>&1) || true
  grep -E "No error has been found|Invariant [A-Za-z]+ is violated|Temporal properties were violated|Deadlock reached|^Error:" \
    "$dir/tlc.out" | head -1 || true
}

echo "== Real code: every rule holds"
bounds=("3|c1, c2")
[[ "${1:-}" == "--deep" ]] && bounds+=("5|c1, c2, c3")
for bound in "${bounds[@]}"; do
  max="${bound%%|*}"
  consumers="${bound#*|}"
  verdict="$(tlc "real-$max" "$max" "$consumers" none)"
  if [[ "$verdict" == *"No error has been found"* ]]; then
    echo "ok   MaxEntry=$max Consumers={$consumers}: $(grep -E 'distinct states found' "$out/real-$max/tlc.out" | tail -1)"
  else
    fail "MaxEntry=$max Consumers={$consumers}: ${verdict:-no verdict} (see $out/real-$max/tlc.out)"
  fi
done

echo "== Broken variants: each must break its rule"
while IFS=$'\t' read -r break rule edit; do
  [[ -z "$break" || "$break" == \#* ]] && continue
  verdict="$(tlc "break-$break" 3 "c1, c2" "$break" "$rule")"
  expected="Invariant $rule is violated"
  [[ "$rule" == LeaveEnds ]] && expected="Temporal properties were violated"
  if [[ "$verdict" == *"$expected"* ]]; then
    echo "ok   $break breaks $rule"
  else
    fail "$break should break $rule ($edit), TLC said: ${verdict:-nothing} (see $out/break-$break/tlc.out)"
  fi
done <"$model/breaks"

echo "TLC logs: $out"
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
