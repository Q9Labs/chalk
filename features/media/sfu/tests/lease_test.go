package tests

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
)

// A node the API can no longer reach keeps a connected session, but its media stops once the source
// lease ends. The API renews the lease only for an active Episode on the current allocation, so
// when the Episode moves or ends the renewals stop and nothing else tells the node. This stops the
// renewals while a real peer keeps publishing RTP to a real subscriber, and checks that forwarding
// stops within the lease TTL while both sessions stay open, and starts again when the lease is
// granted again.
func TestMediaStopsWhenTheAPIStopsRenewingTheSourceLease(t *testing.T) {
	const lease = 2 * time.Second
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) { cfg.SourceLeaseTTL = lease })

	var revision atomic.Int64
	grant := func() { svc.grantSourcesAt(t, revision.Add(1), scopeA) }
	grant()

	connA := svc.createSession(t, "create-alice", scopeA)
	connB := svc.createSession(t, "create-bob", scopeB)
	alice := publishKnownMedia(t, svc, connA, scopeA)
	defer alice.stop()
	bob, received := subscribeKnownMedia(t, svc, connB, scopeB, connA)

	// While the API renews, media flows. The renewals stop when the Episode ends.
	stopRenewing := renewEvery(lease/4, grant)
	eventually(t, "media flowing under a renewed lease", 20*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) >= 30 })
	stopRenewing()

	// The lease ends within its TTL; the margin covers a packet already in the pacer.
	time.Sleep(lease + time.Second)
	stopped := received.count(webrtc.RTPCodecTypeAudio)
	time.Sleep(1500 * time.Millisecond)
	if got := received.count(webrtc.RTPCodecTypeAudio); got != stopped {
		t.Fatalf("forwarding continued after the lease ended: %d packets, then %d", stopped, got)
	}
	if alice.audioSent.Load() == 0 || alice.peer.pc.ConnectionState() != webrtc.PeerConnectionStateConnected || bob.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("the peers did not stay connected: alice %s, bob %s", alice.peer.pc.ConnectionState(), bob.pc.ConnectionState())
	}
	if sessions := svc.sessions(t); sessions != 2 {
		t.Fatalf("%d sessions after the lease ended, want both still open: the lease stops media, not sessions", sessions)
	}
	// A new grant is the only thing that brings media back, which shows the lease stopped it.
	grant()
	eventually(t, "media after a new grant", 10*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) > stopped })
}

// renewEvery calls renew at every interval until the returned function is called, which waits
// for the last call to finish.
func renewEvery(interval time.Duration, renew func()) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	var renewals sync.WaitGroup
	renewals.Go(func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				renew()
			}
		}
	})
	return func() { cancel(); renewals.Wait() }
}
