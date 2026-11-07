package chalksfu_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// pull subscribes a fresh peer to one remote track and answers the SFU's offer.
func pull(t *testing.T, service mediaplane.Service, connection string, scope mediaplane.Scope, publisher, name string) *peer {
	t.Helper()
	subscriber := newPeer(t)
	pulled, err := service.AddTracks(context.Background(), mediaplane.TracksRequest{
		ConnectionID: connection, Scope: scope,
		Tracks: []mediaplane.Track{{Location: "remote", SessionID: publisher, TrackName: name}},
	})
	if err != nil || len(pulled.Tracks) != 1 {
		t.Fatalf("pull %s = %+v, %v", name, pulled, err)
	}
	if err := service.Renegotiate(context.Background(), mediaplane.RenegotiateRequest{ConnectionID: connection, Scope: scope, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer %s: %v", name, err)
	}
	return subscriber
}

// iceRestartOffer is the offer a browser makes for restartIce(): new credentials, the same sections.
func iceRestartOffer(t *testing.T, p *peer) mediaplane.SessionDescription {
	t.Helper()
	offer, err := p.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: true})
	if err != nil {
		t.Fatal(err)
	}
	return p.describe(t, offer)
}

// restartICE sends the restart offer as the SDK does, a push with no tracks, and applies the answer.
func restartICE(t *testing.T, service mediaplane.Service, p *peer, connection string, scope mediaplane.Scope) {
	t.Helper()
	before := iceUfrag(p.pc.RemoteDescription().SDP)
	offer := iceRestartOffer(t, p)
	response, err := service.AddTracks(context.Background(), mediaplane.TracksRequest{ConnectionID: connection, Scope: scope, SessionDescription: &offer})
	if err != nil {
		t.Fatalf("ice restart: %v", err)
	}
	if len(response.Tracks) != 0 || len(response.TrackErrors) != 0 {
		t.Fatalf("an ICE restart changed tracks: %+v", response)
	}
	p.accept(t, response.SessionDescription)
	if after := iceUfrag(response.SessionDescription.SDP); after == "" || after == before {
		t.Fatalf("the SFU kept its ICE credentials: before %q, after %q", before, after)
	}
}

func iceUfrag(sdp string) string {
	for line := range strings.SplitSeq(sdp, "\n") {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), "a=ice-ufrag:"); ok {
			return value
		}
	}
	return ""
}

func expectTracks(t *testing.T, service mediaplane.Service, connection string, scope mediaplane.Scope, want int) {
	t.Helper()
	state, err := service.InspectSession(context.Background(), mediaplane.InspectSessionRequest{ConnectionID: connection, Scope: scope})
	if err != nil || !state.Found || len(state.Tracks) != want {
		t.Fatalf("session %s = %+v, %v; want %d tracks", scope.ParticipantID, state, err, want)
	}
}

// TestConformanceICERestartKeepsMediaAndNodeLossNeedsAFreshSession is the API
// half of the SDK's in-place ICE restart against the real SFU binary: a restart
// while publishing and while pulling keeps the one publication and the audio,
// a request that is not a restart offer is refused, and after node loss the
// restart fails as gone so the client replaces the session at a newer generation.
func TestConformanceICERestartKeepsMediaAndNodeLossNeedsAFreshSession(t *testing.T) {
	box := startSFU(t, map[string]string{"SFU_PACKET_BUDGET": "200000"})
	service := box.service(t)
	ctx := context.Background()
	alice, bob := scopeOf("ep-ice", "alice"), scopeOf("ep-ice", "bob")
	box.grant(t, alice, bob)
	aliceConn, _ := join(t, service, alice)
	bobConn, _ := join(t, service, bob)
	publisher, _, _ := publish(t, service, aliceConn, alice, "alice-mic", "microphone")
	subscriber := pull(t, service, bobConn, bob, aliceConn, "alice-mic")
	eventually(t, "media to reach the subscriber", 20*time.Second, func() bool { return subscriber.received.Load() >= 20 })

	t.Run("a restart while publishing keeps the publication and the audio", func(t *testing.T) {
		restartICE(t, service, publisher, aliceConn, alice)
		before := subscriber.received.Load()
		eventually(t, "media after the publisher restarted ICE", 20*time.Second, func() bool { return subscriber.received.Load() >= before+20 })
		expectTracks(t, service, aliceConn, alice, 1)
	})
	t.Run("a restart while pulling keeps the subscription and the audio", func(t *testing.T) {
		restartICE(t, service, subscriber, bobConn, bob)
		before := subscriber.received.Load()
		eventually(t, "media after the subscriber restarted ICE", 20*time.Second, func() bool { return subscriber.received.Load() >= before+20 })
		expectTracks(t, service, bobConn, bob, 1)
	})
	t.Run("a request with no tracks that is not an offer is refused", func(t *testing.T) {
		answer := mediaplane.SessionDescription{Type: "answer", SDP: publisher.pc.LocalDescription().SDP}
		for _, description := range []*mediaplane.SessionDescription{nil, &answer, {Type: "offer"}} {
			if _, err := service.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: aliceConn, Scope: alice, SessionDescription: description}); !errors.Is(err, mediaplane.ErrInvalidSignalRequest) {
				t.Fatalf("restart with %+v: %v", description, err)
			}
		}
		expectTracks(t, service, aliceConn, alice, 1)
	})
	t.Run("after node loss a restart is gone and a fresh session receives audio", func(t *testing.T) {
		// The node's shutdown closes the old peer, so the offer is made just before it.
		offer := iceRestartOffer(t, publisher)
		box.restart(t)
		if _, err := service.AddTracks(ctx, mediaplane.TracksRequest{ConnectionID: aliceConn, Scope: alice, SessionDescription: &offer}); !errors.Is(err, mediaplane.ErrConnectionNotFound) {
			t.Fatalf("restart on a lost node: %v", err)
		}
		freshAlice, freshBob := alice, bob
		freshAlice.Generation, freshBob.Generation = 2, 2
		box.grant(t, freshAlice, freshBob)
		freshAliceConn, _ := join(t, service, freshAlice)
		freshBobConn, _ := join(t, service, freshBob)
		if freshAliceConn == aliceConn || freshBobConn == bobConn {
			t.Fatal("a lost node handed back an old connection")
		}
		publish(t, service, freshAliceConn, freshAlice, "alice-mic", "microphone")
		listener := pull(t, service, freshBobConn, freshBob, freshAliceConn, "alice-mic")
		eventually(t, "media on the fresh sessions", 20*time.Second, func() bool { return listener.received.Load() >= 20 })
		expectTracks(t, service, freshAliceConn, freshAlice, 1)
	})
}

// TestICERestartIsRefusedWithoutAnInPlacePlane keeps Cloudflare's contract: a
// push with no tracks stays an invalid request on a plane that cannot restart ICE in place.
func TestICERestartIsRefusedWithoutAnInPlacePlane(t *testing.T) {
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderCloudflareSFU, signalingOnly{})
	offer := mediaplane.SessionDescription{Type: "offer", SDP: "v=0\r\n"}
	if _, err := service.AddTracks(context.Background(), mediaplane.TracksRequest{ConnectionID: "c", SessionDescription: &offer}); !errors.Is(err, mediaplane.ErrInvalidSignalRequest) {
		t.Fatalf("restart on a plane without in-place restart: %v", err)
	}
}

type signalingOnly struct{ mediaplane.Plane }

func (signalingOnly) AddTracks(context.Context, mediaplane.TracksRequest) (mediaplane.TracksResponse, error) {
	return mediaplane.TracksResponse{}, errors.New("a push with no tracks reached the plane")
}

func (signalingOnly) Renegotiate(context.Context, mediaplane.RenegotiateRequest) error { return nil }
