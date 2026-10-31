#!/bin/sh
# Gives the viewer browser its own network namespace so its downlink alone can be
# capped. Run as root on a disposable Linux machine: it edits routing and iptables.
#   setup | cap <packets-per-second> | clear | teardown
# The machine's kernel may lack tc qdiscs, so the cap is an iptables token bucket
# that drops UDP above a packet rate, like a policed downlink.
set -eu
NS=chalkviewer
HOST_IP=10.200.1.1
VIEWER_IP=10.200.1.2
case "$1" in
setup)
  ip netns add "$NS"
  ip link add chalkvh type veth peer name chalkvn
  ip link set chalkvn netns "$NS"
  ip addr add "$HOST_IP/24" dev chalkvh
  ip link set chalkvh up
  ip netns exec "$NS" ip addr add "$VIEWER_IP/24" dev chalkvn
  ip netns exec "$NS" ip link set chalkvn up
  ip netns exec "$NS" ip link set lo up
  ip netns exec "$NS" ip route add default via "$HOST_IP"
  mkdir -p "/etc/netns/$NS"
  echo "nameserver 1.1.1.1" >"/etc/netns/$NS/resolv.conf"
  echo 1 >/proc/sys/net/ipv4/ip_forward
  iptables -t nat -A POSTROUTING -s 10.200.1.0/24 ! -o chalkvh -j MASQUERADE
  iptables -I FORWARD -s 10.200.1.0/24 -j ACCEPT
  iptables -I FORWARD -d 10.200.1.0/24 -j ACCEPT
  ;;
cap)
  "$0" clear
  iptables -I FORWARD 1 -d "$VIEWER_IP" -p udp -j DROP
  iptables -I FORWARD 1 -d "$VIEWER_IP" -p udp -m limit --limit "$2/s" --limit-burst 20 -j ACCEPT
  ;;
clear)
  while iptables -D FORWARD -d "$VIEWER_IP" -p udp -j DROP 2>/dev/null; do :; done
  # The cap rate is unknown here, so find the limit rule by its line number.
  for number in $(iptables -L FORWARD -n --line-numbers | awk -v ip="$VIEWER_IP" '$0 ~ ip && $0 ~ /limit/ { print $1 }' | sort -rn); do iptables -D FORWARD "$number"; done
  ;;
teardown)
  "$0" clear
  iptables -D FORWARD -s 10.200.1.0/24 -j ACCEPT 2>/dev/null || true
  iptables -D FORWARD -d 10.200.1.0/24 -j ACCEPT 2>/dev/null || true
  iptables -t nat -D POSTROUTING -s 10.200.1.0/24 ! -o chalkvh -j MASQUERADE 2>/dev/null || true
  ip link del chalkvh 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  rm -rf "/etc/netns/$NS"
  ;;
*)
  echo "usage: $0 setup|cap <pps>|clear|teardown" >&2
  exit 2
  ;;
esac
