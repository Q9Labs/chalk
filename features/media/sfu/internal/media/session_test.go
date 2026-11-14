package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// These tests drive the node and its sessions directly with real Pion peers, because they
// assert state HTTP cannot show: transceivers, reader goroutines and timers.

var operations atomic.Int64

// op returns a fresh operation ID for a test request.
func op() string { return fmt.Sprintf("op-%d", operations.Add(1)) }

func testScope(participant string, generation int64) protocol.Scope {
	return protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: participant, Generation: generation}
}

// testMemory is the design memory budget.
var testMemory = config.Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10}

func newTestNode(t *testing.T, mutate func(*config.Config)) *Node {
	t.Helper()
	return newLoggedTestNode(t, mutate, slog.NewTextHandler(io.Discard, nil))
}

// newLoggedTestNode is newTestNode with the node's log going to handler.
func newLoggedTestNode(t *testing.T, mutate func(*config.Config), handler slog.Handler) *Node {
	t.Helper()
	cfg := config.Config{
		UDPAddr:                    "127.0.0.1:0",
		AnnounceIPs:                []string{"127.0.0.1"},
		IncludeLoopback:            true,
		MaxSessions:                8,
		MaxPublishedPerSession:     4,
		MaxSubscriptionsPerSession: 4,
		MaxCapturesPerEpisode:      2,
		MaxCaptureSubscriptions:    8,
		MaxRequestBytes:            384 << 10,
		PacketBudget:               1 << 20,
		VideoStreamCost:            150,
		CameraUplinkCost:           150,
		CamerasPerParticipant:      1,
		AudioStreamCost:            50,
		MaxEpisodeParticipants:     16,
		EpisodePacketCeiling:       1 << 20,
		ScreenStreamCost:           210,
		Memory:                     testMemory,
		// A test process shares its CPUs with other packages, so its own scheduler
		// latency says nothing about a node; guard tests that read it set their own.
		Guard: config.Guard{
			MaxStealPercent: 3, MaxBusyPercent: 90, MaxSchedulerLatency: 5 * time.Second,
			MaxPacerDropPercent: 5, MaxUDPErrorsPerSecond: 5, Window: 30 * time.Second,
		},
		NegotiationTimeout: 5 * time.Second,
		ConnectTimeout:     30 * time.Second,
		ShutdownTimeout:    5 * time.Second,
		SourceLeaseTTL:     time.Hour,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	node, err := NewNode(cfg, slog.New(handler))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(node.Close)
	return node
}

func (n *Node) newTestSession(t *testing.T, scope protocol.Scope) *Session {
	t.Helper()
	response, err := n.Create("create-"+scope.EpisodeID+"-"+scope.ParticipantID+"-"+fmt.Sprint(scope.Generation), scope, ParticipantSession, nil)
	if err != nil {
		t.Fatal(err)
	}
	session, err := n.Session(response.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

type testPeer struct{ pc *webrtc.PeerConnection }

// newTestPeer builds a peer. With no codecs it registers Pion's defaults.
func newTestPeer(t *testing.T, codecs ...webrtc.RTPCodecParameters) *testPeer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if len(codecs) == 0 {
		if err := engine.RegisterDefaultCodecs(); err != nil {
			t.Fatal(err)
		}
	}
	for _, codec := range codecs {
		if err := engine.RegisterCodec(codec, webrtc.RTPCodecTypeVideo); err != nil {
			t.Fatal(err)
		}
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return &testPeer{pc: pc}
}

// sendOnly adds count sendonly sections of one kind.
func (p *testPeer) sendOnly(t *testing.T, kind webrtc.RTPCodecType, count int) {
	t.Helper()
	for range count {
		if _, err := p.pc.AddTransceiverFromKind(kind, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
			t.Fatal(err)
		}
	}
}

func (p *testPeer) mids() []string {
	var mids []string
	for _, transceiver := range p.pc.GetTransceivers() {
		mids = append(mids, transceiver.Mid())
	}
	return mids
}

func (p *testPeer) complete(t *testing.T, create func(*webrtc.OfferOptions) (webrtc.SessionDescription, error)) *protocol.SessionDescription {
	t.Helper()
	description, err := create(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := p.pc.LocalDescription()
	return &protocol.SessionDescription{SDP: local.SDP, Type: local.Type.String()}
}

func (p *testPeer) offer(t *testing.T) *protocol.SessionDescription {
	t.Helper()
	return p.complete(t, p.pc.CreateOffer)
}

// answer applies a server offer and returns the peer's answer.
func (p *testPeer) answer(t *testing.T, offer *protocol.SessionDescription) protocol.SessionDescription {
	t.Helper()
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(p.pc)
	description, err := p.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return protocol.SessionDescription{SDP: p.pc.LocalDescription().SDP, Type: "answer"}
}

// localTracks names one local track per section, in section order.
func localTracks(prefix string, mids []string, source string) []protocol.Track {
	tracks := make([]protocol.Track, len(mids))
	for index, mid := range mids {
		tracks[index] = protocol.Track{Location: protocol.LocationLocal, Mid: mid, TrackName: fmt.Sprintf("%s-%d", prefix, index), Source: source}
	}
	return tracks
}

// publish pushes count audio tracks named prefix-0, prefix-1, ... and fails the test on any refusal.
func publish(t *testing.T, s *Session, prefix string, count int) *testPeer {
	t.Helper()
	peer := newTestPeer(t)
	peer.sendOnly(t, webrtc.RTPCodecTypeAudio, count)
	offer := peer.offer(t)
	response, err := s.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
		Scope: s.scope, SessionDescription: offer, Tracks: localTracks(prefix, peer.mids(), "microphone"),
	})
	if err != nil || len(response.TrackErrors) != 0 || len(response.Tracks) != count {
		t.Fatalf("publish %d tracks: %+v, %v", count, response, err)
	}
	return peer
}

func pullRequest(s *Session, publisher *Session, names ...string) protocol.TracksRequest {
	request := protocol.TracksRequest{OperationID: op(), Scope: s.scope}
	for _, name := range names {
		request.Tracks = append(request.Tracks, protocol.Track{Location: protocol.LocationRemote, SessionID: publisher.id, TrackName: name})
	}
	return request
}

func eventually(t *testing.T, what string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

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
