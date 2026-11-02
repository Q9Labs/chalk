#!/usr/bin/env bash
# Linux, root. Browsers run in network namespace `arlab`. Its only link is veth a0 <-> a1; a userspace bridge
# (audio-ready-shaper.py) copies frames a1 <-> b1 and impairs UDP, and veth b1 <-> b0 leads to the host, which NATs to the internet.
# Instabox kernels have no netem or ifb, so `tc` cannot shape there.
set -euo pipefail
ns=arlab
case "${1:-}" in
up)
  wan=$(ip route show default | awk '{print $5; exit}')
  ip netns add "$ns"
  ip link add a0 type veth peer name a1
  ip link add b0 type veth peer name b1
  ip link set a0 netns "$ns"
  ip netns exec "$ns" sysctl -qw net.ipv6.conf.all.disable_ipv6=1
  ip netns exec "$ns" ip addr add 10.99.0.2/24 dev a0
  ip netns exec "$ns" ip link set lo up
  ip netns exec "$ns" ip link set a0 up
  ip netns exec "$ns" ip route add default via 10.99.0.1
  ip addr add 10.99.0.1/24 dev b0
  for dev in a1 b0 b1; do ip link set "$dev" up; done
  for dev in a1 b1; do ip link set "$dev" promisc on; done
  shaper="$(dirname "$0")/audio-ready-shaper.py"
  python3 "$shaper" offload a1 b0 b1
  ip netns exec "$ns" python3 "$shaper" offload a0
  sysctl -qw net.ipv4.ip_forward=1
  nft add table ip arnat
  nft "add chain ip arnat post { type nat hook postrouting priority 100; }"
  nft add rule ip arnat post ip saddr 10.99.0.0/24 oifname "$wan" masquerade
  mkdir -p "/etc/netns/$ns"
  nameserver=$(awk '/^nameserver/ && $2 !~ /^127\./ {print $2; exit}' /etc/resolv.conf)
  echo "nameserver ${nameserver:-1.1.1.1}" | install -m 644 /dev/stdin "/etc/netns/$ns/resolv.conf"
  ;;
down)
  ip netns del "$ns" 2>/dev/null || true
  ip link del a1 2>/dev/null || true
  ip link del b0 2>/dev/null || true
  nft delete table ip arnat 2>/dev/null || true
  ;;
*)
  echo "usage: $0 up|down" >&2
  exit 64
  ;;
esac
