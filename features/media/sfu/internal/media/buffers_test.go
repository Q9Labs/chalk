package media

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/pion/transport/v5/packetio"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// An unread stream must never hold more than its cap: Pion's own buffer allows
// 1 MB of RTP per stream, which made an unread camera layer most of the heap.
func TestStreamBuffersStopAtTheirCap(t *testing.T) {
	for _, tc := range []struct {
		kind  packetio.BufferPacketType
		limit int
	}{{packetio.RTPBufferPacket, rtpBufferLimit}, {packetio.RTCPBufferPacket, rtcpBufferLimit}} {
		buffer := boundedBuffer(tc.kind, 1)
		packet := make([]byte, 1200)
		accepted := 0
		var err error
		for range 1000 { // 1.2 MB, past every cap and Pion's own 1 MB
			if _, err = buffer.Write(packet); err != nil {
				break
			}
			accepted += len(packet)
		}
		if !errors.Is(err, packetio.ErrFull) {
			t.Fatalf("buffer type %v: writes past the cap returned %v, want ErrFull", tc.kind, err)
		}
		if accepted > tc.limit {
			t.Fatalf("buffer type %v held %d bytes, cap %d", tc.kind, accepted, tc.limit)
		}
		if buffer.Size() > tc.limit {
			t.Fatalf("buffer type %v reports %d bytes, cap %d", tc.kind, buffer.Size(), tc.limit)
		}
	}
}

// Readiness reports the receive buffer the kernel granted, so a deploy can see
// a host whose net.core.rmem_max holds the socket below its request.
func TestReadinessReportsTheGrantedReceiveBuffer(t *testing.T) {
	const requested = 64 << 10 // below every kernel's default rmem_max
	node := newTestNode(t, func(cfg *config.Config) { cfg.UDPReceiveBuffer = requested })
	if got := node.Host().UDPReceiveBufferBytes; got < requested {
		t.Fatalf("readiness reports a %d-byte receive buffer, want at least the %d requested", got, requested)
	}
}

func TestUDPReceiveErrorsReadTheRcvbufErrorsField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snmp")
	snmp := "Ip: Forwarding DefaultTTL\nIp: 1 64\n" +
		"Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors\n" +
		"Udp: 9120 3 41 8800 37 0 0 0 0\n" +
		"UdpLite: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors\n" +
		"UdpLite: 0 0 0 0 5 0 0 0 0\n"
	if err := os.WriteFile(path, []byte(snmp), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, ok := readUDPReceiveErrors(path); !ok || got != 37 {
		t.Fatalf("RcvbufErrors = %d, %v; want 37 from the Udp line", got, ok)
	}
	if _, ok := readUDPReceiveErrors(filepath.Join(t.TempDir(), "absent")); ok {
		t.Fatal("a host without /proc/net/snmp must report the count as unknown")
	}
}
