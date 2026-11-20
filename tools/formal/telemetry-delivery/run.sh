#!/usr/bin/env bash
# Model-checks client telemetry delivery (TelemetryDelivery.tla), and replays traces of the
# real outbox against the model.
# Usage: tools/formal/telemetry-delivery/run.sh [--anchors | --tlc | --trace DIR]
#   --anchors    only check that the code fragments in `anchors` still exist.
#   --tlc        only run TLC (real code for safety and for liveness, then each broken variant).
#   --trace DIR  replay every *.ndjson trace in DIR (written by the outbox.delivery tests when
#                TELEMETRY_TRACE_DIR is set) and fail on the first line the model can't take.
# Needs Java 11 or later, Node and curl. The TLA+ tools pin is in ../tla2tools.sh.
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

if [[ "$mode" == all || "$mode" == --tlc || "$mode" == --trace ]]; then
  # shellcheck source=../tla2tools.sh
  source "$here/../tla2tools.sh"
  jar="$(tla2tools_jar)"
fi

# verdict DIR prints TLC's verdict line from DIR/tlc.out.
verdict() {
  grep -E "No error has been found|Invariant [A-Za-z]+ is violated|Temporal properties were violated|Deadlock reached|^Error:" \
    "$1/tlc.out" | head -1 || true
}

# run_tlc DIR MODULE WORKERS runs TLC on DIR/MODULE.tla with DIR/MODULE.cfg.
run_tlc() {
  (cd "$1" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers "$3" -deadlock -metadir "$1/states" \
    -config "$2.cfg" "$2.tla" >"$1/tlc.out" 2>&1) || true
}

if [[ "$mode" == all || "$mode" == --tlc ]]; then
  temporal=" DurableDelivered EndsReported "

  # tlc NAME CFG BREAK [RULE] prints TLC's verdict line and keeps the full log. With RULE,
  # TLC checks only that rule on one worker, so a variant that breaks several rules still
  # reports the one it is listed for.
  tlc() {
    local dir="$out/$1" workers=auto
    mkdir -p "$dir"
    cp "$model/TelemetryDelivery.tla" "$dir/"
    sed -e "s/Break = \"[a-z0-9_]*\"/Break = \"$3\"/" "$model/$2" >"$dir/TelemetryDelivery.cfg"
    if [[ -n "${4:-}" ]]; then
      workers=1
      sed -i.all -e '/^INVARIANTS/,$d' -e '/^PROPERTIES/,$d' "$dir/TelemetryDelivery.cfg"
      if [[ "$temporal" == *" $4 "* ]]; then echo "PROPERTY $4"; else echo "INVARIANT $4"; fi >>"$dir/TelemetryDelivery.cfg"
    fi
    run_tlc "$dir" TelemetryDelivery "$workers"
    verdict "$dir"
  }

  for real in "safety TelemetryDelivery.cfg" "join-safety TelemetryDeliveryJoin.cfg" "liveness TelemetryDeliveryLive.cfg" "join-liveness TelemetryDeliveryLiveJoin.cfg"; do
    read -r name cfg <<<"$real"
    echo "== Real code: every $name rule holds"
    result="$(tlc "real-$name" "$cfg" none)"
    if [[ "$result" == *"No error has been found"* ]]; then
      echo "ok   $(grep -E 'distinct states found' "$out/real-$name/tlc.out" | tail -1)"
    else
      fail "real code ($name): ${result:-no verdict} (see $out/real-$name/tlc.out)"
    fi
  done

  echo "== Broken variants: each must break its rule"
  while IFS=$'\t' read -r break rule bounds edit; do
    [[ -z "$break" || "$break" == \#* ]] && continue
    expected="Invariant $rule is violated"
    [[ "$temporal" == *" $rule "* ]] && expected="Temporal properties were violated"
    cfg="TelemetryDelivery${bounds#main}.cfg"
    result="$(tlc "break-$break" "$cfg" "$break" "$rule")"
    if [[ "$result" == *"$expected"* ]]; then
      echo "ok   $break breaks $rule"
    else
      fail "$break should break $rule ($edit), TLC said: ${result:-nothing} (see $out/break-$break/tlc.out)"
    fi
  done <"$model/breaks"

  echo "TLC logs: $out"
fi

if [[ "$mode" == --trace ]]; then
  traces="${2:?usage: run.sh --trace DIR}"
  echo "== Traces of the real outbox replayed against the model"
  shopt -s nullglob
  files=("$traces"/*.ndjson)
  ((${#files[@]} > 0)) || fail "no *.ndjson traces in $traces"

  # replays DIR K succeeds when some replay of the trace takes its first K lines.
  replays() {
    sed -e "s/^    Upto = .*/    Upto = $2/" "$1/base.cfg" >"$1/TelemetryDeliveryTrace.cfg"
    run_tlc "$1" TelemetryDeliveryTrace auto
    [[ "$(verdict "$1")" == *"Invariant Reached is violated"* ]]
  }

  for file in "${files[@]}"; do
    name="$(basename "$file" .ndjson)"
    dir="$out/trace-$name"
    mkdir -p "$dir"
    cp "$model/TelemetryDelivery.tla" "$model/TelemetryDeliveryTrace.tla" "$dir/"
    if ! shape="$(node "$model/trace.mjs" "$file" "$dir")"; then
      fail "$name: trace.mjs could not read the trace"
      continue
    fi
    read -r steps boots joins records < <(node -e 'const s = JSON.parse(process.argv[1]); console.log(s.steps, s.boots, s.joins, s.records)' "$shape")
    {
      echo "CONSTANTS"
      echo "    MaxBoots = $boots"
      echo "    MaxJoins = $joins"
      echo "    MaxRecords = $records"
      echo "    Cap = 1"
      echo "    CheckCap = FALSE"
      echo "    MaxFaults = 9"
      echo "    MayVanish = TRUE"
      echo "    Break = \"none\""
      echo "    Upto = 0"
      echo
      echo "INIT TraceInit"
      echo "NEXT TraceNext"
      echo
      echo "INVARIANT Reached"
    } >"$dir/base.cfg"
    if replays "$dir" "$steps"; then
      echo "ok   $name: all $steps lines are steps of the model"
      continue
    fi
    # Every replay takes 0 lines and none takes all of them: search for the first line none takes.
    low=0 high=$steps
    while ((high - low > 1)); do
      mid=$(((low + high) / 2))
      if replays "$dir" "$mid"; then low=$mid; else high=$mid; fi
    done
    fail "$name: the model can't take line $high of $steps: $(sed -n "${high}p" "$file") (see $dir)"
  done
  echo "Trace logs: $out"
fi

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"
