#!/bin/bash
set -euo pipefail
export BOX=$1 CASES=$2
cd /Users/macmini/.t3/worktrees/chalk/t3-fd7f13ac-b59ec274fc39905d
vars=$(gh api "repos/Q9Labs/chalk/environments/nightly/variables?per_page=100")
v() { printf '%s' "$vars" | python3 -I -c "import json,sys;print(next(x['value'] for x in json.load(sys.stdin)['variables'] if x['name']==sys.argv[1]))" "$1"; }
export TENANT=$(v CHALK_PROOF_TENANT_ID) APIURL=$(v CHALK_PROOF_API_URL) WEBURL=$(v CHALK_PROOF_WEB_URL) ORIGIN=$(v CHALK_PROOF_PROOF_ORIGIN) HOOKID=$(v CHALK_PROOF_WEBHOOK_ENDPOINT_ID) HOOKURL=$(v CHALK_PROOF_WEBHOOK_SERVICE_URL)
export KEY=${KEY:?export KEY: the nightly proof Tenant credential, read with the 1password skill}
scripts/staging-sfu/staging-lock --holder join-stall-lane --purpose join-stall-diagnostics --run-id "w-$(date +%s)" --wait 1800 --ttl 3000 -- bash /tmp/w/on-box.sh
