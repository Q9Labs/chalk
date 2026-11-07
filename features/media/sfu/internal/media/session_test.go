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
	cfg := config.Config{
		UDPAddr:                    "127.0.0.1:0",
		UDPBatch:                   true,
		AnnounceIPs:                []string{"127.0.0.1"},
		IncludeLoopback:            true,
		MaxSessions:                8,
		MaxPublishedPerSession:     4,
		MaxSubscriptionsPerSession: 4,
		MaxCapturesPerEpisode:      2,
		MaxCaptureSubscriptions:    8,
		CapturePackets:             530,
		MaxRequestBytes:            256 << 10,
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
	node, err := NewNode(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(node.Close)
	return node
}

func (n *Node) newTestSession(t *testing.T, scope protocol.Scope) *Session {
	t.Helper()
	response, err := n.CreateSession("create-"+scope.EpisodeID+"-"+scope.ParticipantID+"-"+fmt.Sprint(scope.Generation), scope)
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
		huge := &protocol.SessionDescription{Type: "offer", SDP: "v=0\r\n" + strings.Repeat("a=padding:x\r\n", maxSDPBytes/10)}
		_, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
			Scope: session.scope, SessionDescription: huge, Tracks: localTracks("mic", []string{"0"}, "microphone"),
		})
		if !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("oversized offer: %v, want invalid request", err)
		}
	})
}

func TestForcedSubscriptionCloseReleasesTheSender(t *testing.T) {
	node := newTestNode(t, nil)
	publisher := node.newTestSession(t, testScope("alice", 1))
	subscriber := node.newTestSession(t, testScope("bob", 1))
	publish(t, publisher, "mic", 1)
	viewer := newTestPeer(t)

	for cycle := range 6 {
		pulled, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, "mic-0"))
		if err != nil || len(pulled.Tracks) != 1 || len(pulled.TrackErrors) != 0 {
			t.Fatalf("cycle %d pull: %+v, %v", cycle, pulled, err)
		}
		if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
			t.Fatalf("cycle %d answer: %v", cycle, err)
		}
		mid := pulled.Tracks[0].Mid
		subscriber.mu.Lock()
		closing := subscriber.subscribed[mid]
		subscriber.mu.Unlock()
		if closing == nil {
			t.Fatalf("cycle %d: no subscription for mid %q", cycle, mid)
		}

		if _, err := subscriber.CloseTracks(context.Background(), protocol.CloseTracksRequest{OperationID: op(), Scope: subscriber.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: mid}}}); err != nil {
			t.Fatalf("cycle %d close: %v", cycle, err)
		}

		// The RTCP reader must end, or every cycle leaks a goroutine.
		ended := make(chan error, 1)
		go func() {
			_, _, err := closing.sender.ReadRTCP()
			ended <- err
		}()
		select {
		case err := <-ended:
			if err == nil {
				t.Fatalf("cycle %d: the sender still delivers RTCP after the close", cycle)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("cycle %d: the RTCP reader of a closed subscription is still blocked", cycle)
		}
		if direction := closing.transceiver.Direction(); direction != webrtc.RTPTransceiverDirectionInactive {
			t.Fatalf("cycle %d: closed subscription's transceiver is %s, want inactive", cycle, direction)
		}
		if tracks, _ := subscriber.Inspect(); len(tracks.Tracks) != 0 {
			t.Fatalf("cycle %d: inspect still lists %+v", cycle, tracks.Tracks)
		}
	}
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

func TestConnectTimerStopsOnceConnected(t *testing.T) {
	node := newTestNode(t, nil)
	session := node.newTestSession(t, testScope("alice", 1))
	peer := newTestPeer(t)
	peer.sendOnly(t, webrtc.RTPCodecTypeAudio, 1)
	response, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
		Scope: session.scope, SessionDescription: peer.offer(t), Tracks: localTracks("mic", peer.mids(), "microphone"),
	})
	if err != nil || len(response.TrackErrors) != 0 {
		t.Fatalf("push: %+v, %v", response, err)
	}
	if err := peer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the session to connect", 15*time.Second, func() bool {
		return session.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	// Reset reports whether the timer was still armed. The connection callback runs shortly
	// after the state change, so poll; an armed timer stays armed and the wait times out.
	eventually(t, "the connect timer to stop", 2*time.Second, func() bool { return !session.connectTimer.Reset(time.Hour) })
}

func TestRejectedRemoteDescriptionClosesTheSession(t *testing.T) {
	garbage := protocol.SessionDescription{Type: "answer", SDP: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:9\r\n"}

	t.Run("answer", func(t *testing.T) {
		node := newTestNode(t, nil)
		publisher := node.newTestSession(t, testScope("alice", 1))
		publish(t, publisher, "mic", 1)
		subscriber := node.newTestSession(t, testScope("bob", 1))
		pulled, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, "mic-0"))
		if err != nil || pulled.SessionDescription == nil {
			t.Fatalf("pull: %+v, %v", pulled, err)
		}
		if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: garbage}); !errors.Is(err, ErrNegotiationFailed) {
			t.Fatalf("garbage answer: %v, want negotiation failed", err)
		}
		if !subscriber.isClosed() {
			t.Fatal("the session stayed open with a pending offer nobody can answer")
		}
		if _, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, "mic-0")); !errors.Is(err, ErrSessionGone) {
			t.Fatalf("pull after the failed answer: %v, want session gone", err)
		}
	})

	t.Run("offer", func(t *testing.T) {
		node := newTestNode(t, nil)
		session := node.newTestSession(t, testScope("alice", 1))
		_, err := session.AddTracks(context.Background(), protocol.TracksRequest{OperationID: op(),
			Scope: session.scope, SessionDescription: &protocol.SessionDescription{Type: "offer", SDP: "not sdp"},
			Tracks: localTracks("mic", []string{"0"}, "microphone"),
		})
		if !errors.Is(err, ErrNegotiationFailed) {
			t.Fatalf("garbage offer: %v, want negotiation failed", err)
		}
		if !session.isClosed() {
			t.Fatal("the session stayed open after a rejected offer")
		}
	})
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

func TestStaleGenerationStaysFencedAfterTheSessionCloses(t *testing.T) {
	node := newTestNode(t, nil)
	older := testScope("alice", 1)
	newer := testScope("alice", 2)
	current := node.newTestSession(t, newer)
	current.Close()
	if node.SessionCount() != 0 {
		t.Fatal("the newer session did not close")
	}

	if _, err := node.CreateSession("delayed-create", older); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("delayed create from generation 1 after generation 2 closed: %v, want stale generation", err)
	}
	if node.SessionCount() != 0 {
		t.Fatal("the stale create left a session")
	}
	if _, err := node.CreateSession("create-gen-3", testScope("alice", 3)); err != nil {
		t.Fatalf("a newer generation was refused: %v", err)
	}
}
