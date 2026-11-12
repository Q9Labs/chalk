package media

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// These tests drive the node and its sessions directly with real Pion peers, because they
// assert state HTTP cannot show: transceivers, reader goroutines and timers.

func TestOfferIsBoundedBeforePionSeesIt(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.MaxPublishedPerSession = 1 })
	session := node.newTestSession(t, testScope("alice", 1))

	for round := range 6 {
		peer := newTestPeer(t)
		peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 20)
		offer := peer.offer(t)
		// The request names one track; the other 19 sections belong to nothing.
		_, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
			Scope: session.scope, SessionDescription: offer, Tracks: localTracks("mic", peer.mids()[:1], "microphone"),
		})
		if !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("round %d: unnamed sections: %v, want invalid request", round, err)
		}
		// The request names 16 of 20 sections: still four unnamed.
		_, err = session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
			Scope: session.scope, SessionDescription: offer, Tracks: localTracks("mic", peer.mids()[:protocol.MaxTracksPerRequest], "microphone"),
		})
		if !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("round %d: four unnamed sections: %v, want invalid request", round, err)
		}
		if got := len(session.pc.GetTransceivers()); got != 0 {
			t.Fatalf("round %d: %d transceivers after rejected offers, want 0", round, got)
		}
	}

	t.Run("every section named but over the publication limit", func(t *testing.T) {
		peer := newTestPeer(t)
		peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 3)
		offer := peer.offer(t)
		_, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
			Scope: session.scope, SessionDescription: offer, Tracks: localTracks("mic", peer.mids(), "microphone"),
		})
		if !errors.Is(err, ErrCapacityExceeded) {
			t.Fatalf("3 tracks over a limit of 1: %v, want capacity exceeded", err)
		}
		if got := len(session.pc.GetTransceivers()); got != 0 {
			t.Fatalf("%d transceivers after a refused push, want 0", got)
		}
	})

	t.Run("oversized SDP", func(t *testing.T) {
		huge := &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\n" + strings.Repeat("a=padding:x\r\n", protocol.MaxSDPBytes/10)}
		_, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
			Scope: session.scope, SessionDescription: huge, Tracks: localTracks("mic", []string{"0"}, "microphone"),
		})
		if !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("oversized offer: %v, want invalid request", err)
		}
	})
}

func TestPullBatchCountsItsOwnAdditions(t *testing.T) {
	node := newTestNode(t, func(cfg *config.Config) { cfg.MaxSubscriptionsPerSession = 2 })
	publisher := node.newTestSession(t, testScope("alice", 1))
	publish(t, publisher, "mic", 4)

	t.Run("one publication requested many times", func(t *testing.T) {
		subscriber := node.newTestSession(t, testScope("bob", 1))
		names := make([]string, protocol.MaxTracksPerRequest)
		for index := range names {
			names[index] = "mic-0"
		}
		response, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, names...))
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Tracks) != 1 || len(response.TrackErrors) != len(names)-1 {
			t.Fatalf("%d successes and %d errors, want 1 and %d", len(response.Tracks), len(response.TrackErrors), len(names)-1)
		}
		for _, trackError := range response.TrackErrors {
			if trackError.Code != protocol.TrackCodeDuplicate {
				t.Fatalf("error code %q, want %q", trackError.Code, protocol.TrackCodeDuplicate)
			}
		}
		if got := len(subscriber.pc.GetTransceivers()); got != 1 {
			t.Fatalf("%d transceivers, want 1", got)
		}
	})

	t.Run("distinct publications over the subscription limit", func(t *testing.T) {
		subscriber := node.newTestSession(t, testScope("carol", 1))
		response, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, "mic-0", "mic-1", "mic-2", "mic-3"))
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Tracks) != 2 || len(response.TrackErrors) != 2 {
			t.Fatalf("%d successes and %d errors, want 2 and 2", len(response.Tracks), len(response.TrackErrors))
		}
		for _, trackError := range response.TrackErrors {
			if trackError.Code != protocol.TrackCodeLimitExceeded {
				t.Fatalf("error code %q, want %q", trackError.Code, protocol.TrackCodeLimitExceeded)
			}
		}
	})
}

func TestUnsupportedCodecIsATrackError(t *testing.T) {
	node := newTestNode(t, nil)
	session := node.newTestSession(t, testScope("alice", 1))
	h264 := webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"},
		PayloadType:        102,
	}
	peer := newTestPeer(t, h264)
	peer.sendOnly(t, webrtc.RTPCodecTypeVideo, 1)
	response, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
		Scope: session.scope, SessionDescription: peer.offer(t), Tracks: localTracks("cam", peer.mids(), "camera"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Tracks) != 0 || len(response.TrackErrors) != 1 || response.TrackErrors[0].Code != protocol.TrackCodeInvalid {
		t.Fatalf("H.264-only offer: tracks %+v, errors %+v; want one %s error", response.Tracks, response.TrackErrors, protocol.TrackCodeInvalid)
	}
	if len(session.published) != 0 {
		t.Fatalf("%d publications recorded for an unsupported codec", len(session.published))
	}
	for _, transceiver := range session.pc.GetTransceivers() {
		if transceiver.Direction() != webrtc.RTPTransceiverDirectionInactive {
			t.Fatalf("refused section is %s, want inactive", transceiver.Direction())
		}
	}
}

func TestInvalidCloseBatchChangesNothing(t *testing.T) {
	node := newTestNode(t, nil)
	session := node.newTestSession(t, testScope("alice", 1))
	publish(t, session, "mic", 2)

	_, err := session.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(),
		Scope: session.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: "0"}, {Mid: ""}},
	})
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("batch with an empty mid: %v, want invalid request", err)
	}
	inspected, err := session.Inspect()
	if err != nil || len(inspected.Tracks) != 2 {
		t.Fatalf("inspect after a refused batch: %+v, %v; want both tracks", inspected, err)
	}
}
