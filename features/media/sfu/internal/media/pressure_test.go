package media

import (
	"testing"
	"time"
)

func probingSession(t *testing.T, now int64) *Session {
	t.Helper()
	return &Session{transport: probingTransport(t, 4e6, now)}
}

func TestTheNodeTellsEveryTransportItsPressureAndStopsAfterTheMaximum(t *testing.T) {
	node := newTestNode(t, nil)
	now := monotonic()
	sessions := []*Session{probingSession(t, now), probingSession(t, now)}
	node.shareHostState(sessions, now)
	for _, session := range sessions {
		if !session.transport.probing() || session.transport.estimate(now).pressured {
			t.Fatal("a calm node pressured a transport")
		}
	}
	node.pressure.stealSample(now, 10)
	node.shareHostState(sessions, now)
	for _, session := range sessions {
		if session.transport.probing() || !session.transport.estimate(now).pressured {
			t.Fatal("a stalled node left a transport probing or unaware")
		}
	}
	// Steal that never lets up cannot freeze the transports for good.
	for at := now; at < now+int64(2*pressureMax); at += int64(time.Second) {
		node.pressure.stealSample(at, 10)
		node.shareHostState(sessions, at)
	}
	if end := now + int64(2*pressureMax); sessions[0].transport.estimate(end).pressured {
		t.Fatal("unbroken steal pressured a transport past the maximum")
	}
}
