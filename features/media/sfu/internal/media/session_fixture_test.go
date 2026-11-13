package media

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

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
	pc := newLoopbackPeerConnection(t, engine)
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

// newLoopbackPeerConnection makes a UDP4 peer connection that offers loopback candidates.
func newLoopbackPeerConnection(t *testing.T, engine *webrtc.MediaEngine) *webrtc.PeerConnection {
	t.Helper()
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	return pc
}

// pushAll offers every section of the peer as a track of one source, named prefix plus its index.
func pushAll(t *testing.T, s *Session, peer *testPeer, prefix, source string) (protocol.TracksResponse, error) {
	t.Helper()
	return s.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: op(), Scope: s.scope, SessionDescription: peer.offer(t), Tracks: localTracks(prefix, peer.mids(), source),
	})
}

// pullAndAnswer has the subscriber pull the publisher's tracks and answer the SFU's offer with
// the viewer peer, and returns the pull response.
func pullAndAnswer(t *testing.T, subscriber, publisher *Session, viewer *testPeer, names ...string) protocol.TracksResponse {
	t.Helper()
	pulled, err := subscriber.AddTracks(context.Background(), pullRequest(subscriber, publisher, names...))
	if err != nil || len(pulled.Tracks) != len(names) {
		t.Fatalf("pull %v: %+v %v", names, pulled, err)
	}
	if err := subscriber.Renegotiate(context.Background(), protocol.RenegotiateRequest{OperationID: op(), Scope: subscriber.scope, SessionDescription: viewer.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatal(err)
	}
	return pulled
}

// pullMic has alice publish a microphone and bob pull it through a viewer peer, and returns the
// two sessions, the viewer and the pull response.
func pullMic(t *testing.T, node *Node) (publisher, subscriber *Session, viewer *testPeer, pulled protocol.TracksResponse) {
	t.Helper()
	publisher = node.newTestSession(t, testScope("alice", 1))
	subscriber = node.newTestSession(t, testScope("bob", 1))
	publish(t, publisher, "mic", 1)
	viewer = newTestPeer(t)
	return publisher, subscriber, viewer, pullAndAnswer(t, subscriber, publisher, viewer, "mic-0")
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
