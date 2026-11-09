#!/bin/bash
# usage: readlogs.sh SINCE OUT   (runs inside the staging lease)
H=$(cat ~/.config/chalk-sfu/staging/address); D=~/.config/chalk-sfu/staging
ssh -i ~/.ssh/chalk-sfu-operator_ed25519 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=$D/known_hosts root@$H \
 'cd /home/chalk-sfu && uid=$(id -u chalk-sfu) && runuser -u chalk-sfu -- env -i HOME=/home/chalk-sfu PATH=/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus podman logs --since '"$1"' chalk-sfu 2>&1' | grep -E 'congestion pause|subscription paused|subscription resumed|media telemetry' > "$2"
