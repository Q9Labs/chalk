#!/usr/bin/env bash
# Model-checks the recording pipeline across Sync and the API (RecordingPipeline.tla).
# Usage: tools/formal/recording-pipeline/run.sh [--anchors | --tlc]
#   --anchors  only check that the code fragments in `anchors` still exist.
#   --tlc      only run TLC (real code, then each broken variant).
# Needs Java 11 or later and curl. The TLA+ tools pin is in ../tla2tools.sh.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
model="$here"
mode="${1:-all}"
out="${FORMAL_OUT:-$(mktemp -d)}"
failures=0

fail() { echo "FAIL $*"; failures=$((failures + 1)); }
squash() { tr -s '[:space:]' ' '; }

if [[ "$mode" == all || "$mode" == --anchors ]]; then
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
fi

if [[ "$mode" == all || "$mode" == --tlc ]]; then
  # shellcheck source=../tla2tools.sh
  source "$here/../tla2tools.sh"
  jar="$(tla2tools_jar)"
  temporal=" EndedEpisodeResolves EndedEpisodeLeavesNoRunningRecording "

  # tlc NAME BREAK [RULE] prints TLC's verdict line and keeps the full log.
  # With RULE, TLC checks only that rule on one worker, so a variant that breaks
  # several rules still reports the one it is listed for.
  tlc() {
    local dir="$out/$1" workers=auto
    mkdir -p "$dir"
    cp "$model/RecordingPipeline.tla" "$dir/"
    sed -e "s/Break = \"[a-z_]*\"/Break = \"$2\"/" "$model/RecordingPipeline.cfg" >"$dir/RecordingPipeline.cfg"
    if [[ -n "${3:-}" ]]; then
      workers=1
      sed -i.all -e '/^INVARIANTS/,$d' "$dir/RecordingPipeline.cfg"
      if [[ "$temporal" == *" $3 "* ]]; then echo "PROPERTY $3"; else echo "INVARIANT $3"; fi >>"$dir/RecordingPipeline.cfg"
    fi
    (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers "$workers" -metadir "$dir/states" \
      -config RecordingPipeline.cfg RecordingPipeline.tla >"$dir/tlc.out" 2>&1) || true
    grep -E "No error has been found|Invariant [A-Za-z]+ is violated|Temporal properties were violated|Deadlock reached|^Error:" \
      "$dir/tlc.out" | head -1 || true
  }

  echo "== Real code: every rule holds"
  verdict="$(tlc real none)"
  if [[ "$verdict" == *"No error has been found"* ]]; then
    echo "ok   $(grep -E 'distinct states found' "$out/real/tlc.out" | tail -1)"
  else
    fail "real code: ${verdict:-no verdict} (see $out/real/tlc.out)"
  fi

  echo "== Broken variants: each must break its rule"
  while IFS=$'\t' read -r break rule edit; do
    [[ -z "$break" || "$break" == \#* ]] && continue
    verdict="$(tlc "break-$break" "$break" "$rule")"
    expected="Invariant $rule is violated"
    [[ "$temporal" == *" $rule "* ]] && expected="Temporal properties were violated"
    if [[ "$verdict" == *"$expected"* ]]; then
      echo "ok   $break breaks $rule"
    else
      fail "$break should break $rule ($edit), TLC said: ${verdict:-nothing} (see $out/break-$break/tlc.out)"
    fi
  done <"$model/breaks"

  echo "TLC logs: $out"
fi

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
