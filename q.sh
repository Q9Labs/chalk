#!/bin/sh
# usage: q.sh "apl" start end
curl -s -X POST "https://api.axiom.co/v1/datasets/_apl?format=legacy" -H "Authorization: Bearer $(cat /tmp/ax1384/tok)" -H "Content-Type: application/json" -d "$(jq -nc --arg a "$1" --arg s "$2" --arg e "$3" '{apl:$a,startTime:$s,endTime:$e}')"
