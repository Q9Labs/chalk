#!/bin/bash
# usage: run-ui.sh <tag> ; env CHALK_TENANT CHALK_API_KEY ; runs 3 UI guests (join at 0, 12, 25 s)
set -u
tag=$1; cd /data/home/ui; mkdir -p out/$tag
mkdir -p /tmp/dress; node mkspace.mjs $tag > out/$tag/space.log 2>&1 || { cat out/$tag/space.log | head -3; exit 1; }
T0=$(( $(date +%s) * 1000 + 3000 ))
for i in 1 2 3; do
  SHOT_DIR=out/$tag/shots node guest.mjs pw G$i 44$i 1${i}0 $T0 /tmp/dress/$tag.json plan-$i.json out/$tag/g$i.json > out/$tag/g$i.log 2>&1 &
done
wait; echo "$T0" > out/$tag/t0; tail -2 out/$tag/g*.log | head -12
