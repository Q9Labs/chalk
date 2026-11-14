#!/bin/sh
curl -s -X POST "https://api.axiom.co/v1/datasets/_apl?format=tabular" -H "Authorization: Bearer $(cat /tmp/ax1384/tok)" -H "Content-Type: application/json" -d "$(jq -nc --arg a "$1" --arg s "$2" --arg e "$3" '{apl:$a,startTime:$s,endTime:$e}')" > /tmp/ax1384/out.json
jq -c '(.tables[0].fields|map(.name)) as $f | (.tables[0].columns // []) as $c | if ($c|length)>0 then [range(0; ($c[0]|length))] | map(. as $i | [range(0;($f|length))] | map($c[.][$i])) | .[] else .message // .error // . end' /tmp/ax1384/out.json | head -${4:-40}
