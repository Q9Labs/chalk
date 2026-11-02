#!/usr/bin/env python3
"""Userspace stand-in for netem on kernels without it (Instabox). Root, Linux.

Copies Ethernet frames between veth ends a1 (browser side) and b1 (host side) and impairs UDP the way the rig's tc
profiles do: fixed delay with uniform jitter, random loss, and a rate limit with a packet queue. Everything that is not UDP
(and UDP ports 53 and 123) passes straight through, so the local API/Sync TCP traffic stays clean.
Profiles are read from /dev/shm/ar-shape.json, {"egress": {...}, "ingress": {...}}; egress is browser to host.
Each direction takes delay_ms, jitter_ms, loss (percent), rate (bits/s) and limit (packets). Counters go to /dev/shm/ar-shape-stats.json.
"""
import ctypes, fcntl, heapq, json, os, random, select, socket, struct, sys, time

CONTROL = "/dev/shm/ar-shape.json"
STATS = "/dev/shm/ar-shape-stats.json"
UNSHAPED_PORTS = {53, 123}
PACKET_OUTGOING = 4


def disable_offloads(names):
    """No ethtool binary on the box: ETHTOOL_S{TXCSUM,SG,TSO,GSO,GRO} through ioctl. Frames re-sent from a raw socket arrive with unfinished checksums unless the sender computed them."""
    control = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for name in names:
        for command in (0x17, 0x1A, 0x1E, 0x24, 0x2C):
            value = ctypes.create_string_buffer(struct.pack("II", command, 0))
            request = struct.pack("16sP", name.encode(), ctypes.addressof(value))
            try:
                fcntl.ioctl(control.fileno(), 0x8946, request)
            except OSError:
                pass  # the device does not offer this feature


def open_raw(name):
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3))
    sock.bind((name, 0))
    sock.setblocking(False)
    return sock


def udp_ports(frame):
    if len(frame) < 42 or frame[12:14] != b"\x08\x00" or frame[23] != 17:
        return None
    if struct.unpack("!H", frame[20:22])[0] & 0x1FFF:
        return None
    start = 14 + (frame[14] & 0x0F) * 4
    if len(frame) < start + 4:
        return None
    return struct.unpack("!HH", frame[start : start + 4])


class Direction:
    def __init__(self, name, tx):
        self.name, self.tx = name, tx
        self.params = {}
        self.next_free = 0.0
        self.in_rate_queue = []
        self.shaped = self.dropped = self.passed = 0


heap, sequence = [], 0


def forward(direction, frame, now):
    global sequence
    params = direction.params
    ports = udp_ports(frame)
    if not params or ports is None or ports[0] in UNSHAPED_PORTS or ports[1] in UNSHAPED_PORTS:
        direction.passed += 1
        direction.tx.send(frame)
        return
    direction.shaped += 1
    if random.random() * 100 < params.get("loss", 0):
        direction.dropped += 1
        return
    leave = now
    rate = params.get("rate")
    if rate:
        direction.in_rate_queue = [t for t in direction.in_rate_queue if t > now]
        if len(direction.in_rate_queue) >= params.get("limit", 1000):
            direction.dropped += 1
            return
        leave = max(now, direction.next_free) + len(frame) * 8 / rate
        direction.next_free = leave
        direction.in_rate_queue.append(leave)
    jitter = params.get("jitter_ms", 0)
    delay = max(0.0, params.get("delay_ms", 0) + random.uniform(-jitter, jitter))
    sequence += 1
    heapq.heappush(heap, (leave + delay / 1000, sequence, direction.tx, frame))


def main():
    browser_side, host_side = open_raw("a1"), open_raw("b1")
    egress, ingress = Direction("egress", host_side), Direction("ingress", browser_side)
    sources = {browser_side: egress, host_side: ingress}
    loaded_mtime, stats_at = None, 0.0
    while True:
        now = time.monotonic()
        timeout = max(0.0, min(0.1, heap[0][0] - now)) if heap else 0.1
        readable, _, _ = select.select(list(sources), [], [], timeout)
        now = time.monotonic()
        for sock in readable:
            for _ in range(256):
                try:
                    frame, address = sock.recvfrom(65535)
                except BlockingIOError:
                    break
                if address[2] != PACKET_OUTGOING:
                    forward(sources[sock], frame, now)
        while heap and heap[0][0] <= now:
            _, _, tx, frame = heapq.heappop(heap)
            tx.send(frame)
        try:
            mtime = os.stat(CONTROL).st_mtime_ns
            if mtime != loaded_mtime:
                with open(CONTROL) as control:
                    profile = json.load(control)
                egress.params, ingress.params = profile.get("egress", {}), profile.get("ingress", {})
                loaded_mtime = mtime
        except (FileNotFoundError, ValueError):
            egress.params = ingress.params = {}
        if now - stats_at > 1:
            stats_at = now
            snapshot = {d.name: {"shaped": d.shaped, "dropped": d.dropped, "passed": d.passed} for d in (egress, ingress)}
            with open(STATS + ".tmp", "w") as out:
                json.dump(snapshot, out)
            os.replace(STATS + ".tmp", STATS)


if len(sys.argv) > 2 and sys.argv[1] == "offload":
    disable_offloads(sys.argv[2:])
else:
    main()
