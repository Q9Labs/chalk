#!/usr/bin/env bash
# Model-checks the CloudflareSFUClient local publication lifecycle: pending,
# confirmed, held, retiring and retired across reconnect, replacement and
# stop() (SfuPublicationLifecycle.tla).
# Usage: tools/formal/sfu-publication-lifecycle/run.sh
# Needs Java 11 or later and curl. The TLA+ tools pin is in ../tla2tools.sh.
set -euo pipefail

# An isolated TMPDIR per run keeps parallel TLC executions (matrix workflow,
# local runs beside CI) from ever sharing temp or fingerprint state.
export TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/sfu-publication-lifecycle.XXXXXX")"
trap 'rm -rf "$TMPDIR"' EXIT

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
model="$here"
# shellcheck source=../tla2tools.sh
source "$here/../tla2tools.sh"
jar="$(tla2tools_jar)"
out="${FORMAL_OUT:-$(mktemp -d "$TMPDIR/out.XXXXXX")}"
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

# tlc NAME BREAK [RULE] prints TLC's verdict line and keeps the full log.
# With RULE, TLC checks only that rule on one worker, so a variant that breaks
# several rules still reports the one it is listed for.
tlc() {
  local dir="$out/$1" workers=auto
  mkdir -p "$dir"
  cp "$model/SfuPublicationLifecycle.tla" "$dir/"
  sed -e "s/Break = \"[a-z_]*\"/Break = \"$2\"/" "$model/SfuPublicationLifecycle.cfg" >"$dir/SfuPublicationLifecycle.cfg"
  if [[ -n "${3:-}" ]]; then
    workers=1
    sed -i.all -e '/^INVARIANTS/,$d' "$dir/SfuPublicationLifecycle.cfg"
    echo "INVARIANT $3" >>"$dir/SfuPublicationLifecycle.cfg"
  fi
  (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers "$workers" -metadir "$dir/states" \
    -config SfuPublicationLifecycle.cfg SfuPublicationLifecycle.tla >"$dir/tlc.out" 2>&1) || true
  grep -E "No error has been found|Invariant [A-Za-z]+ is violated|Deadlock reached|^Error:" \
    "$dir/tlc.out" | head -1 || true
}

echo "== Real code: every rule holds"
verdict="$(tlc real none)"
if [[ "$verdict" == *"No error has been found"* ]]; then
  echo "ok   $(grep -E 'distinct states found' "$out/real/tlc.out" | tail -1)"
else
  fail "${verdict:-no verdict} (see $out/real/tlc.out)"
fi

echo "== Findings: rules the real code breaks today"
while IFS=$'\t' read -r rule finding; do
  [[ -z "$rule" || "$rule" == \#* ]] && continue
  verdict="$(tlc "finding-$rule" none "$rule")"
  if [[ "$verdict" == *"Invariant $rule is violated"* ]]; then
    echo "known $rule: $finding"
  else
    fail "$rule no longer breaks ($finding): move it into SfuPublicationLifecycle.cfg and delete it from findings (TLC said: ${verdict:-nothing})"
  fi
done <"$model/findings"

echo "== Broken variants: each must break its rule"
while IFS=$'\t' read -r break rule edit; do
  [[ -z "$break" || "$break" == \#* ]] && continue
  verdict="$(tlc "break-$break" "$break" "$rule")"
  if [[ "$verdict" == *"Invariant $rule is violated"* ]]; then
    echo "ok   $break breaks $rule"
  else
    fail "$break should break $rule ($edit), TLC said: ${verdict:-nothing} (see $out/break-$break/tlc.out)"
  fi
done <"$model/breaks"

echo "TLC logs: $out"
exit "$failures"
