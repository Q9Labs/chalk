package chalksfu_test

import (
	"net"
	"testing"
)

// A UDP port is reserved on UDP, so while it is held no other socket can take it.
func TestReservedUDPPortStaysHeldUntilReleased(t *testing.T) {
	port, release := reservePort(t, "udp4")
	address := net.JoinHostPort("127.0.0.1", port)

	if conn, err := net.ListenPacket("udp4", address); err == nil {
		_ = conn.Close()
		t.Fatalf("udp port %s was free while reserved", port)
	}

	release()
	conn, err := net.ListenPacket("udp4", address)
	if err != nil {
		t.Fatalf("udp port %s not free after release: %v", port, err)
	}
	_ = conn.Close()
}
