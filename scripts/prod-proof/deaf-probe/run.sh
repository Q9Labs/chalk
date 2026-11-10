#!/bin/bash
# Usage (from the checkout on the Air): run.sh <label> [chromium:safari safari:chromium chromium:chromium]
# Runs the deafness probe on the Mac mini (its Chromium and real Safari) against the nightly (staging) Chalk SFU, one Space per join
# order. Needs `staging-lock` (hold the lease around this script) and the one-day nightly proof key in 1Password (never printed).
# Output: ~/sfu-ops/out/<label>-<first>-<second>/ on the mini, summaries copied to ./out/<label>/ here.
set -euo pipefail
label=${1:?label}
shift
orders=("$@")
[ ${#orders[@]} -gt 0 ] || orders=(chromium:safari safari:chromium chromium:chromium)
here=$(cd "$(dirname "$0")" && pwd)
var() { gh variable get "$1" -R Q9Labs/chalk --env nightly; }
api=$(var CHALK_PROOF_API_URL)
web=$(var CHALK_PROOF_WEB_URL)
tenant=$(var CHALK_PROOF_TENANT_ID)
mini=agents-macmini
ssh "$mini" 'mkdir -p ~/sfu-ops/rig ~/sfu-ops/out'
scp -q "$here/probe.mjs" "$here/inject.js" "$mini:sfu-ops/rig/"
mkdir -p "$here/out/$label"
for order in "${orders[@]}"; do
  first=${order%%:*}
  second=${order##*:}
  dir="sfu-ops/out/$label-$first-$second"
  echo "== $label $first>$second $(date -u +%T)Z"
  # The proof key travels on stdin, never in an argument list or the log.
  2password read "op://dev/Chalk nightly proof Tenant/credential" | ssh "$mini" "read -r K; cd ~/sfu-ops/rig && CHALK_PROOF_API_KEY=\$K CHALK_PROOF_API_URL='$api' CHALK_PROOF_WEB_URL='$web' CHALK_PROOF_TENANT_ID='$tenant' PROBE_FIRST=$first PROBE_SECOND=$second PROBE_OUT=\$HOME/$dir node probe.mjs > \$HOME/$dir.log 2>&1; echo exit \$?; tail -n 70 \$HOME/$dir.log" || echo "run failed: $order"
  mkdir -p "$here/out/$label/$first-$second"
  scp -q "$mini:$dir/summary.json" "$mini:$dir"/*.png "$here/out/$label/$first-$second/" 2>/dev/null || echo "no summary for $order"
done
