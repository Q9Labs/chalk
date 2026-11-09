#!/bin/bash
# Runs inside the staging lease: each "tag:load:late" case runs once on the Instabox machine and its evidence comes back.
# A tag starting with "u" runs the UI flow (public invite, join, then camera on by click); any other tag runs the SDK harness.
set -uo pipefail
for case in $CASES; do
  IFS=: read -r tag load late guests <<<"$case"; guests=${guests:-3}
  echo "== $tag load=$load late=$late $(date -u +%T)"
  if [ "$load" -gt 0 ]; then
    instabox exec --background "$BOX" -- "for i in \$(seq 1 $load); do (while :; do :; done) & done; wait" >/dev/null 2>&1
  fi
  if [[ $tag == u* ]]; then
    job=$(instabox exec --background --json "$BOX" --cwd /data/home/ui --env "CHALK_TENANT=$TENANT" --env "CHALK_API_KEY=$KEY" -- "./run-ui.sh $tag > /tmp/run-$tag.log 2>&1" 2>/dev/null | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["jobId"])')
  else
  job=$(instabox exec --background --json "$BOX" --cwd /data/home/work \
    --env CHALK_PROOF_CONFIG_SOURCE=env --env "CHALK_PROOF_API_KEY=$KEY" \
    --env "CHALK_PROOF_TENANT_ID=$TENANT" --env "CHALK_PROOF_API_URL=$APIURL" --env "CHALK_PROOF_WEB_URL=$WEBURL" \
    --env "CHALK_PROOF_PROOF_ORIGIN=$ORIGIN" --env "CHALK_PROOF_WEBHOOK_ENDPOINT_ID=$HOOKID" --env "CHALK_PROOF_WEBHOOK_SERVICE_URL=$HOOKURL" \
    --env CHALK_PROOF_MEDIA_PLANE=chalk_sfu --env "CHALK_PROOF_RUN_ID=$tag" --env "JOIN_STALL_LATE_MS=$late" --env "JOIN_STALL_GUESTS=$guests" --env JOIN_STALL_HOLD_MS=60000 \
    -- "pnpm prod:proof join-stall > /tmp/run-$tag.log 2>&1" 2>/dev/null | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["jobId"])')
  fi
  instabox jobs wait "$BOX" "$job" 2>&1 | grep -v outdated
  if [ "$load" -gt 0 ]; then instabox exec "$BOX" -- 'pkill -f "while :; do :; done"; true' >/dev/null 2>&1; fi
  mkdir -p /tmp/w/$tag
  instabox exec "$BOX" -- "tail -c 400 /tmp/run-$tag.log" 2>&1 | grep -v outdated | tail -4
  if [[ $tag == u* ]]; then
    for f in g1 g2 g3; do
      instabox exec "$BOX" --cwd /data/home/ui/out/$tag -- "gzip -c $f.json | base64 -w0" 2>/dev/null | grep -v outdated | base64 -d | gunzip > /tmp/w/$tag/$f.json
    done
    instabox exec "$BOX" --cwd /data/home/ui/out/$tag -- "cat t0; cat g*.log | grep -c ''" 2>/dev/null | grep -v outdated | tr '\n' ' '; echo
    instabox exec "$BOX" --cwd /data/home/ui/out/$tag -- "cat g1.log g2.log g3.log" 2>/dev/null | grep -v outdated > /tmp/w/$tag/guests.log
  else
    instabox exec "$BOX" --cwd /data/home/work -- "gzip -c .private/prod-proof/$tag/join-stall.json | base64 -w0" 2>/dev/null | grep -v outdated | base64 -d | gunzip > /tmp/w/$tag/join-stall.json
  fi
  du -sk /tmp/w/$tag | cut -f1
done

if [ -n "${READLOGS:-}" ]; then /tmp/w/readlogs.sh 6h /tmp/w/node-pauses.jsonl; wc -l /tmp/w/node-pauses.jsonl; fi
