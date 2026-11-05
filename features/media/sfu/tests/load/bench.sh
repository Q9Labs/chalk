#!/usr/bin/env bash
# Drives an SFU load test on DigitalOcean Droplets from your own machine.
#
#   bench.sh up                          create the Droplets, install binaries and certificates
#   bench.sh ramp <1|2> <label> <size> <steps> [hold]
#                                        ramp load against the 1 GiB (1) or 2 GiB (2) node
#   bench.sh profile <1|2> <label> <size> <episodes>
#                                        hold one step and capture CPU, heap and allocs profiles
#   bench.sh down                        delete every Droplet carrying the bench tag
#
# Everything the run writes (keys, addresses, results) lives in $BENCH_DIR, outside Git.
# `down` deletes only by tag, so it never touches a Droplet this script did not create.
set -euo pipefail

TAG=chalk-sfu-bench
DO_CONTEXT=${DO_CONTEXT:-collabez}
REGION=${REGION:-sgp1}
IMAGE=${IMAGE:-ubuntu-24-04-x64}
GEN_SIZE=${GEN_SIZE:-c-4}
WORK=${BENCH_DIR:-$HOME/.cache/chalk-sfu-bench}
SFU_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STOP_CPU=${STOP_CPU:-75} # stop a ramp after the step during which host CPU stayed above this for 60 s

mkdir -p "$WORK/bin" "$WORK/results"
SSH_OPTS=(-i "$WORK/id" -o StrictHostKeyChecking=no -o UserKnownHostsFile="$WORK/known_hosts" -o LogLevel=ERROR -o ServerAliveInterval=15 -o ConnectTimeout=10)
ssh_to() { local host=$1; shift; ssh "${SSH_OPTS[@]}" "root@$host" "$@"; }
scp_to() { scp "${SSH_OPTS[@]}" -q "$@"; }
doc() { doctl --context "$DO_CONTEXT" "$@"; }

load_hosts() { # shellcheck disable=SC1091
  source "$WORK/hosts.env"
}

node_host() { if [[ $1 == 1 ]]; then echo "$SFU1_IP"; else echo "$SFU2_IP"; fi; }
node_memlimit() { if [[ $1 == 1 ]]; then echo 384MiB; else echo 768MiB; fi; }

build() {
  (cd "$SFU_ROOT" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$WORK/bin/" ./tests/load/benchnode ./tests/load/loadgen)
  (cd "$SFU_ROOT" && go build -o "$WORK/bin/benchcerts" ./tests/load/benchcerts && go build -o "$WORK/bin/report" ./tests/load/report)
}

create() { # name size
  doc compute droplet create "$1" --size "$2" --image "$IMAGE" --region "$REGION" --tag-name "$TAG" \
    --user-data-file "$WORK/user-data.yaml" --wait --format PublicIPv4 --no-header
}

cmd_up() {
  [[ -f $WORK/id ]] || ssh-keygen -q -t ed25519 -N '' -f "$WORK/id" -C chalk-sfu-bench
  cat >"$WORK/user-data.yaml" <<EOF
#cloud-config
ssh_authorized_keys:
  - $(cat "$WORK/id.pub")
runcmd:
  - systemctl disable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer || true
EOF
  build
  "$WORK/bin/benchcerts" -out "$WORK/certs" -lifetime 24h
  local sfu1 sfu2 gen
  sfu1=$(create bench-sfu-1gb s-1vcpu-1gb) && sfu2=$(create bench-sfu-2gb s-2vcpu-2gb) && gen=$(create bench-gen "$GEN_SIZE")
  printf 'SFU1_IP=%s\nSFU2_IP=%s\nGEN_IP=%s\n' "$sfu1" "$sfu2" "$gen" >"$WORK/hosts.env"
  load_hosts
  for host in "$SFU1_IP" "$SFU2_IP" "$GEN_IP"; do
    until ssh_to "$host" true 2>/dev/null; do sleep 3; done
    ssh_to "$host" 'cloud-init status --wait >/dev/null 2>&1; mkdir -p /root/bench/certs'
  done
  for host in "$SFU1_IP" "$SFU2_IP"; do
    scp_to "$WORK/bin/benchnode" "$host:/root/bench/"
    scp_to "$WORK/certs/ca.pem" "$WORK/certs/server.pem" "$WORK/certs/server.key" "$host:/root/bench/certs/"
  done
  scp_to "$WORK/bin/loadgen" "$GEN_IP:/root/bench/"
  scp_to "$WORK/certs/ca.pem" "$WORK/certs/client.pem" "$WORK/certs/client.key" "$GEN_IP:/root/bench/certs/"
  for host in "$SFU1_IP" "$SFU2_IP" "$GEN_IP"; do
    ssh_to "$host" 'echo "$(hostname): $(nproc) vCPU, $(grep -m1 "model name" /proc/cpuinfo | cut -d: -f2), $(free -m | awk "/Mem:/{print \$2}") MiB, $(uname -r)"; ip -br addr | grep -v "^lo"' | tee -a "$WORK/droplets.txt"
  done
}

start_node() { # which
  local host memlimit
  host=$(node_host "$1"); memlimit=$(node_memlimit "$1")
  ssh_to "$host" "pkill -x benchnode || true; sleep 1; cd /root/bench && rm -f samples.jsonl node.log && ulimit -n 65536 &&
    GOGC=200 GOMEMLIMIT=$memlimit SFU_TLS_CERT_FILE=certs/server.pem SFU_TLS_KEY_FILE=certs/server.key SFU_CLIENT_CA_FILE=certs/ca.pem \
    SFU_CLIENT_IDENTITY=chalk-api.test SFU_ANNOUNCE_IPS=$host SFU_MAX_SESSIONS=256 BENCH_SAMPLES_FILE=samples.jsonl BENCH_NET_IFACE=eth0 \
    setsid nohup ./benchnode >node.log 2>&1 </dev/null &"
  sleep 3
  ssh_to "$host" 'pgrep -x benchnode >/dev/null' || { echo "benchnode did not start" >&2; return 1; }
}

start_gen() { # label size steps hold sfu_ip
  local label=$1 size=$2 steps=$3 hold=$4 sfu=$5
  ssh_to "$GEN_IP" "cd /root/bench && rm -f stop steps.json gen.log && ulimit -n 65536 &&
    setsid nohup ./loadgen -sfu https://$sfu:8443 -ca certs/ca.pem -cert certs/client.pem -key certs/client.key -iface eth0 \
      -size $size -steps $steps -hold $hold -stop-file /root/bench/stop -out steps.json -label '$label' >gen.log 2>&1 </dev/null &"
}

# watch_cpu raises the stop flag once host CPU on the node stays above STOP_CPU for three checks 20 s apart.
watch_cpu() { # node_host
  local host=$1 hot=0 busy
  while ssh_to "$GEN_IP" 'pgrep -x loadgen >/dev/null'; do
    sleep 20
    busy=$(ssh_to "$host" 'tail -n 20 /root/bench/samples.jsonl' | python3 -c 'import sys,json
v=[json.loads(l)["hostBusyPct"] for l in sys.stdin if l.strip()]
print(int(sum(v)/len(v)) if v else 0)')
    echo "$(date +%T) node host CPU (20 s avg): ${busy}%"
    if ((busy > STOP_CPU)); then hot=$((hot + 1)); else hot=0; fi
    if ((hot >= 3)); then ssh_to "$GEN_IP" 'touch /root/bench/stop'; fi
  done
}

collect() { # which label
  local host out
  host=$(node_host "$1"); out="$WORK/results/$2"
  mkdir -p "$out"
  scp_to "$GEN_IP:/root/bench/steps.json" "$GEN_IP:/root/bench/gen.log" "$out/"
  scp_to "$host:/root/bench/samples.jsonl" "$host:/root/bench/node.log" "$out/"
  "$WORK/bin/report" -results "$out/steps.json" -samples "$out/samples.jsonl" >"$out/report.md"
  echo "results in $out"
}

cmd_ramp() { # which label size steps [hold]
  load_hosts
  local which=$1 label=$2 size=$3 steps=$4 hold=${5:-3m} host
  host=$(node_host "$which")
  start_node "$which"
  start_gen "$label" "$size" "$steps" "$hold" "$host"
  sleep 10
  watch_cpu "$host"
  collect "$which" "$label"
}

cmd_profile() { # which label size episodes
  load_hosts
  local which=$1 label=$2 size=$3 episodes=$4 host out
  host=$(node_host "$which"); out="$WORK/results/$label"
  mkdir -p "$out"
  start_node "$which"
  start_gen "$label" "$size" "$episodes" 150s "$host"
  until ssh_to "$GEN_IP" 'grep -q "msg=joined" /root/bench/gen.log'; do sleep 5; done
  sleep 40 # settle, then profile inside the measured window
  ssh_to "$host" 'cd /root/bench && curl -s -o cpu.pprof "http://127.0.0.1:6060/debug/pprof/profile?seconds=30" && curl -s -o heap.pprof http://127.0.0.1:6060/debug/pprof/heap && curl -s -o allocs.pprof http://127.0.0.1:6060/debug/pprof/allocs && curl -s -o goroutine.txt "http://127.0.0.1:6060/debug/pprof/goroutine?debug=1"'
  while ssh_to "$GEN_IP" 'pgrep -x loadgen >/dev/null'; do sleep 10; done
  scp_to "$host:/root/bench/cpu.pprof" "$host:/root/bench/heap.pprof" "$host:/root/bench/allocs.pprof" "$host:/root/bench/goroutine.txt" "$out/"
  cp "$WORK/bin/benchnode" "$out/benchnode.linux"
  collect "$which" "$label"
}

cmd_down() {
  doc compute droplet delete --tag-name "$TAG" --force
  echo "remaining Droplets with tag $TAG:"
  doc compute droplet list --tag-name "$TAG" --format ID,Name --no-header
}

case ${1:-} in
  up) cmd_up ;;
  ramp) shift; cmd_ramp "$@" ;;
  profile) shift; cmd_profile "$@" ;;
  down) cmd_down ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
