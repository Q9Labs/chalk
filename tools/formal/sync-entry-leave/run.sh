#!/usr/bin/env bash
# Model-checks Sync entry admission and Leave ordering (EntryLeave.tla).
# Usage: tools/formal/sync-entry-leave/run.sh [--deep]
#   --deep  also checks 5 entries and 3 consumer nodes.
# Needs Java 11 or later and curl. Downloads the pinned TLA+ tools once.
set -euo pipefail

# v1.7.4 is the latest stable release. Pre-release assets such as v1.8.0 get
# re-published, which breaks a checksum pin.
TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
model="$here"
jar="${TLA2TOOLS_JAR:-${XDG_CACHE_HOME:-$HOME/.cache}/chalk-tla/tla2tools-${TLA_SHA256:0:12}.jar}"
out="${FORMAL_OUT:-$(mktemp -d)}"
failures=0

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
fail() { echo "FAIL $*"; failures=$((failures + 1)); }
squash() { tr -s '[:space:]' ' '; }

if [[ ! -f "$jar" ]] || [[ "$(sha256 "$jar")" != "$TLA_SHA256" ]]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.tmp" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  [[ "$(sha256 "$jar.tmp")" == "$TLA_SHA256" ]] || { echo "tla2tools.jar checksum mismatch"; exit 2; }
  mv "$jar.tmp" "$jar"
fi

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
