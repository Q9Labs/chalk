# Usage: sudo bash netns-up.sh ; builds the client namespace `cli` (10.1.0.2) and the server side in the root namespace (10.1.0.1).
# Frames between them pass through the userspace shaper (sa <-> sb), which delays, drops and rate-limits UDP only.
set -e
ip netns del cli 2>/dev/null || true
ip link del sa 2>/dev/null || true
ip link del sb 2>/dev/null || true
ip netns add cli
ip link add vc type veth peer name sa
ip link add sb type veth peer name vb
ip link set vc netns cli
ip addr add 10.1.0.1/24 dev vb
for d in sa sb vb; do ip link set $d up; done
ip netns exec cli ip link set lo up
ip netns exec cli ip addr add 10.1.0.2/24 dev vc
ip netns exec cli ip link set vc up
ip netns exec cli ip route add default via 10.1.0.1
for d in sa sb vb; do ethtool -K $d tso off gso off gro off tx off rx off >/dev/null 2>&1 || true; done
ip netns exec cli ethtool -K vc tso off gso off gro off tx off rx off >/dev/null 2>&1 || true
sysctl -qw net.ipv4.ip_forward=1
mkdir -p /etc/netns/cli
printf 'nameserver 1.1.1.1\n' > /etc/netns/cli/resolv.conf
nft delete table ip sfuspike 2>/dev/null || true
nft add table ip sfuspike
nft add chain ip sfuspike post '{ type nat hook postrouting priority 100 ; }'
nft add rule ip sfuspike post ip saddr 10.1.0.0/24 oifname "eth0" masquerade
echo "netns-up done"
