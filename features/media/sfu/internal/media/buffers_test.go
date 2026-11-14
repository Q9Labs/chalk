package media

import (
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// Readiness reports the receive buffer the kernel granted, so a deploy can see
// a host whose net.core.rmem_max holds the socket below its request.
func TestReadinessReportsTheGrantedReceiveBuffer(t *testing.T) {
	const requested = 64 << 10 // below every kernel's default rmem_max
	node := newTestNode(t, func(cfg *config.Config) { cfg.UDPReceiveBuffer = requested })
	if got := node.Host().UDPReceiveBufferBytes; got < requested {
		t.Fatalf("readiness reports a %d-byte receive buffer, want at least the %d requested", got, requested)
	}
}
