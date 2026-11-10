package tests

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
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
	grant := func() {
		var response protocol.SourceControlResponse
		svc.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{
			TenantID: scopeA.TenantID, EpisodeID: scopeA.EpisodeID,
			Controls: []protocol.SourceControl{{ParticipantID: scopeA.ParticipantID, Source: "microphone", Action: protocol.SourceGrant, Revision: revision.Add(1)}},
		}, &response)
	}
	grant()

	connA := svc.createSession(t, "create-alice", scopeA)
	connB := svc.createSession(t, "create-bob", scopeB)

	alice := newPeer(t)
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := alice.pc.AddTrack(audio); err != nil {
		t.Fatal(err)
	}
	offer, err := alice.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := alice.complete(t, offer)
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connA+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: scopeA, SessionDescription: &pushOffer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: alice.mid(t, audio), TrackName: audioName, Source: "microphone"}},
	}, &pushed)
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push response: %+v", pushed)
	}
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	sendCtx, stopSending := context.WithCancel(context.Background())
	var senders sync.WaitGroup
	var sent atomic.Int64
	sendLoop(sendCtx, audio, 'a', 111, &sent, &senders)
	defer func() { stopSending(); senders.Wait() }()

	bob := newPeer(t)
	received := collect(bob)
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connB+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: scopeB,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: connA, TrackName: audioName}},
	}, &pulled)
	if pulled.SessionDescription == nil || len(pulled.TrackErrors) != 0 {
		t.Fatalf("pull response: %+v", pulled)
	}
	if err := bob.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := bob.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.mustCall(t, "/v1/sessions/"+connB+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: scopeB, SessionDescription: bob.complete(t, answer)}, nil)

	// While the API renews, media flows. The renewals stop when the Episode ends.
	renewCtx, stopRenewing := context.WithCancel(context.Background())
	var renewals sync.WaitGroup
	renewals.Go(func() {
		for ticker := time.NewTicker(lease / 4); ; {
			select {
			case <-renewCtx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
				grant()
			}
		}
	})
	eventually(t, "media flowing under a renewed lease", 20*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) >= 30 })
	stopRenewing()
	renewals.Wait()

	// The lease ends within its TTL; the margin covers a packet already in the pacer.
	time.Sleep(lease + time.Second)
	stopped := received.count(webrtc.RTPCodecTypeAudio)
	time.Sleep(1500 * time.Millisecond)
	if got := received.count(webrtc.RTPCodecTypeAudio); got != stopped {
		t.Fatalf("forwarding continued after the lease ended: %d packets, then %d", stopped, got)
	}
	if sent.Load() == 0 || alice.pc.ConnectionState() != webrtc.PeerConnectionStateConnected || bob.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatalf("the peers did not stay connected: alice %s, bob %s", alice.pc.ConnectionState(), bob.pc.ConnectionState())
	}
	if sessions := svc.sessions(t); sessions != 2 {
		t.Fatalf("%d sessions after the lease ended, want both still open: the lease stops media, not sessions", sessions)
	}

	// A new grant is the only thing that brings media back, which shows the lease stopped it.
	grant()
	eventually(t, "media after a new grant", 10*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) > stopped })
}
