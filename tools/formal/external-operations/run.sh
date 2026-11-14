#!/usr/bin/env bash
# Model-checks the Sync external-operation queue (ExternalOperations.tla).
# Usage: tools/formal/external-operations/run.sh [--deep]
#   --deep  also checks three attempts and five control revisions.
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
attempts=2
revisions=4
[[ "${1:-}" == "--deep" ]] && { attempts=3; revisions=5; }

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

# tlc NAME OPS NODES RESEND REFUSE GIVEUP BREAK CHECKS prints TLC's verdict line and keeps the full log.
#   OPS     one of rt, rem or end (the operations in the run; the model has no run with all three)
#   NODES   n1 or n1,n2
#   RESEND, REFUSE, GIVEUP  TRUE or FALSE: the ResendsExpired, GrantRefusals and GiveUp settings
#   CHECKS  comma-separated rules, or LIVE for the OperationsSettle property
# Environment: ORDERED=FALSE removes the provider's revision ordering (the Cloudflare path),
# CRASHES=FALSE stops nodes from failing in the middle of an operation (the liveness runs).
# A run with two nodes folds the nodes into one symmetry class, which needs no liveness check.
tlc() {
  local name="$1" ops="$2" nodes="${3//,/, }" dir="$out/$1" workers=auto
  mkdir -p "$dir"
  cp "$model/ExternalOperations.tla" "$dir/"
  sed -e "s/Nodes = {[^}]*}/Nodes = {$nodes}/" -e "s/Ops = {[^}]*}/Ops = {\"$ops\"}/" \
    -e "s/MaxAttempts = [0-9]*/MaxAttempts = $attempts/" -e "s/MaxRev = [0-9]*/MaxRev = $revisions/" \
    -e "s/ResendsExpired = [A-Z]*/ResendsExpired = $4/" -e "s/GrantRefusals = [A-Z]*/GrantRefusals = $5/" \
    -e "s/GiveUp = [A-Z]*/GiveUp = $6/" -e "s/Ordered = [A-Z]*/Ordered = ${ORDERED:-TRUE}/" \
    -e "s/Crashes = [A-Z]*/Crashes = ${CRASHES:-TRUE}/" -e "s/Break = \"[a-z_]*\"/Break = \"$7\"/" \
    -e '/^INVARIANTS/,$d' "$model/ExternalOperations.cfg" >"$dir/ExternalOperations.cfg"
  if [[ "$8" == LIVE ]]; then
    echo "PROPERTY OperationsSettle" >>"$dir/ExternalOperations.cfg"
  else
    { echo "INVARIANTS"; echo "    TypeOK"; echo "$8" | tr ',' '\n' | sed 's/^/    /'; } >>"$dir/ExternalOperations.cfg"
    [[ "$nodes" == *,* ]] && echo "SYMMETRY NodeSymmetry" >>"$dir/ExternalOperations.cfg"
  fi
  (cd "$dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers "$workers" -metadir "$dir/states" \
    -config ExternalOperations.cfg ExternalOperations.tla >"$dir/tlc.out" 2>&1) || true
  grep -E "No error has been found|Invariant [A-Za-z]+ is violated|Temporal properties were violated|Deadlock reached|^Error:" \
    "$dir/tlc.out" | head -1 || true
}

# expect_holds NAME LABEL <tlc arguments after NAME>
expect_holds() {
  local name="$1" label="$2" verdict
  shift 2
  verdict="$(tlc "$name" "$@")"
  if [[ "$verdict" == *"No error has been found"* ]]; then
    echo "ok   $label: $(grep -E 'distinct states found' "$out/$name/tlc.out" | tail -1 | sed 's/.*generated, //')"
  else
    fail "$label: ${verdict:-no verdict} (see $out/$name/tlc.out)"
  fi
}

# expect_breaks NAME LABEL RULE <tlc arguments after NAME>
expect_breaks() {
  local name="$1" label="$2" rule="$3" verdict expected
  shift 3
  verdict="$(tlc "$name" "$@")"
  expected="Invariant $rule is violated"
  [[ "$rule" == OperationsSettle ]] && expected="Temporal properties were violated"
  if [[ "$verdict" == *"$expected"* ]]; then
    echo "ok   $label"
  else
    fail "$label should break $rule, TLC said: ${verdict:-nothing} (see $out/$name/tlc.out)"
  fi
}

echo "== Real code: every rule the code keeps holds"
expect_holds real-rem "remove_participant, two nodes" rem n1,n2 TRUE TRUE TRUE none RemovedNeverPublishes,AppliedOnce
expect_holds real-end "end Episode, two nodes" end n1,n2 TRUE TRUE TRUE none EndedNeverPublishes,AppliedOnce
expect_holds real-rt "role-transition source stop, two nodes" rt n1,n2 TRUE TRUE TRUE none AppliedOnce
for ops in rem end rt; do
  CRASHES=FALSE expect_holds "live-$ops" "$ops settles, one node" "$ops" n1 TRUE TRUE TRUE none LIVE
done

echo "== Findings: each rule the code breaks must keep failing"
while IFS=$'\t' read -r id cause rule text; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  resend=FALSE refuse=FALSE giveup=FALSE
  case "$cause" in
    ResendsExpired) resend=TRUE ;;
    GrantRefusals) refuse=TRUE ;;
    GiveUp) giveup=TRUE ;;
    *) fail "$id: unknown cause $cause" ;;
  esac
  expect_breaks "finding-$id" "$id breaks $rule: $text" "$rule" rt n1 "$resend" "$refuse" "$giveup" none "$rule"
done <"$model/findings"

echo "== Idealized settings (no finding's cause): every rule holds"
for ops in rem end rt; do
  expect_holds "ideal-$ops" "$ops, one node" "$ops" n1 FALSE FALSE FALSE none \
    RemovedNeverPublishes,DemotedPublishesOnlyWhileCleanupRuns,GivingUpLeavesNothingLive,EndedNeverPublishes,AppliedOnce
done

echo "== Idealized settings without provider ordering: every rule holds"
for ops in rem end rt; do
  ORDERED=FALSE expect_holds "unordered-$ops" "$ops, one node" "$ops" n1 FALSE FALSE FALSE none \
    RemovedNeverPublishes,DemotedPublishesOnlyWhileCleanupRuns,GivingUpLeavesNothingLive,EndedNeverPublishes,AppliedOnce
done

echo "== Broken variants: each must break its rule"
while IFS=$'\t' read -r break ops nodes ordered rule edit; do
  [[ -z "$break" || "$break" == \#* ]] && continue
  if [[ "$rule" == OperationsSettle ]]; then
    CRASHES=FALSE ORDERED="$ordered" expect_breaks "break-$break" "$break breaks $rule" "$rule" "$ops" "$nodes" TRUE TRUE TRUE "$break" LIVE
  else
    ORDERED="$ordered" expect_breaks "break-$break" "$break breaks $rule" "$rule" "$ops" "$nodes" FALSE FALSE FALSE "$break" "$rule"
  fi
done <"$model/breaks"

echo "TLC logs: $out"
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
