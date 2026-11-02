ip netns del cli 2>/dev/null || true
ip link del sa 2>/dev/null || true
ip link del sb 2>/dev/null || true
nft delete table ip sfuspike 2>/dev/null || true
pkill -x shaper 2>/dev/null || true
echo down
