package media_test

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/media"
	"github.com/q9labs/chalk/features/media/sfu/internal/telemetry"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// A publisher chooses the rid of its simulcast layers, so a rid can look like an address. The
// layer events carry a label the node derives from it; the rid itself stays in the journal.
func TestPublisherChosenRIDStaysOnTheNode(t *testing.T) {
	const chosen = "203.0.113.9:443"
	sink := &logSink{}
	collector := httptest.NewServer(sink)
	defer collector.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer test-token")
	journal := &lockedBuffer{}
	logger, shutdown, err := telemetry.NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: collector.URL, OTLPInsecure: true},
		slog.NewJSONHandler(journal, nil))
	if err != nil {
		t.Fatal(err)
	}
	node := newExportedNode(t, logger)

	aliceScope := protocol.Scope{TenantID: "tenant", EpisodeID: "episode", ParticipantID: "alice", Generation: 1}
	bobScope := aliceScope
	bobScope.ParticipantID = "bob"
	alice, aliceID := createExportedSession(t, node, "create-alice", aliceScope)
	bob, _ := createExportedSession(t, node, "create-bob", bobScope)
	if _, err := node.ControlSources(protocol.SourceControlRequest{TenantID: "tenant", EpisodeID: "episode", Controls: []protocol.SourceControl{
		{ParticipantID: "alice", Source: "camera", Action: protocol.SourceGrant, Revision: 1},
	}}); err != nil {
		t.Fatal(err)
	}

	pc, track, sender := simulcastPeer(t, chosen)
	defer pc.Close()
	offer := gatheredOffer(t, pc)
	if !strings.Contains(offer.SDP, "a=rid:"+chosen+" send") {
		t.Fatal("the offer does not carry the rid")
	}
	publisherMid := pc.GetTransceivers()[0].Mid()
	response, err := alice.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: "publish", Scope: aliceScope, SessionDescription: offer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: publisherMid, TrackName: "cam-0", Source: "camera"}},
	})
	if err != nil || len(response.TrackErrors) != 0 {
		t.Fatalf("publish: %v %+v", err, response.TrackErrors)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	stopSending := sendRIDPackets(t, track, sender, publisherMid, chosen)
	defer stopSending()

	pullAndAnswer(t, bob, bobScope, aliceID)
	journal.waitFor(t, `"event":"sfu.subscription.layer"`, chosen)
	stopSending()
	node.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	exported := sink.bytes()
	if bytes.Contains(exported, []byte(chosen)) || bytes.Contains(exported, []byte("203.0.113")) {
		t.Fatal("a publisher-chosen rid left the node")
	}
	for _, want := range []string{"sfu.subscription.layer", "other"} {
		if !bytes.Contains(exported, []byte(want)) {
			t.Errorf("the exported layer event lacks %q", want)
		}
	}
}

func createExportedSession(t *testing.T, node *media.Node, id string, scope protocol.Scope) (*media.Session, string) {
	t.Helper()
	response, err := node.Create(id, scope, media.ParticipantSession, nil)
	if err != nil {
		t.Fatal(err)
	}
	session, err := node.Session(response.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	return session, response.ConnectionID
}

// simulcastPeer is a publisher whose first layer carries the rid chosen and whose second carries "z".
func simulcastPeer(t *testing.T, chosen string) (*webrtc.PeerConnection, *webrtc.TrackLocalStaticRTP, *webrtc.RTPSender) {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	for _, uri := range []string{sdp.SDESMidURI, sdp.SDESRTPStreamIDURI} {
		if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: uri}, webrtc.RTPCodecTypeVideo); err != nil {
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
	vp8 := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}
	track, err := webrtc.NewTrackLocalStaticRTP(vp8, "cam", "stream", webrtc.WithRTPStreamID(chosen))
	if err != nil {
		t.Fatal(err)
	}
	second, err := webrtc.NewTrackLocalStaticRTP(vp8, "cam", "stream", webrtc.WithRTPStreamID("z"))
	if err != nil {
		t.Fatal(err)
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	if err := sender.AddEncoding(second); err != nil {
		t.Fatal(err)
	}
	return pc, track, sender
}

// sendRIDPackets sends a VP8 packet every 20 ms on the first layer, tagged with the mid and the
// rid, until the returned stop runs. Stop is safe to call twice.
func sendRIDPackets(t *testing.T, track *webrtc.TrackLocalStaticRTP, sender *webrtc.RTPSender, mid, rid string) (stop func()) {
	t.Helper()
	var midID, ridID uint8
	for _, extension := range sender.GetParameters().HeaderExtensions {
		switch extension.URI {
		case sdp.SDESMidURI:
			midID = uint8(extension.ID)
		case sdp.SDESRTPStreamIDURI:
			ridID = uint8(extension.ID)
		}
	}
	if midID == 0 || ridID == 0 {
		t.Fatal("the mid and rid extensions were not negotiated")
	}
	sending, cancel := context.WithCancel(context.Background())
	var sent sync.WaitGroup
	sent.Go(func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-sending.Done():
				return
			case <-ticker.C:
			}
			packet := &rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence, Timestamp: uint32(sequence) * 1800, Marker: true},
				Payload: []byte{0x10, 0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0},
			}
			_ = packet.Header.SetExtension(midID, []byte(mid))
			_ = packet.Header.SetExtension(ridID, []byte(rid))
			_ = track.WriteRTP(packet)
			sequence++
		}
	})
	return func() { cancel(); sent.Wait() }
}

// pullAndAnswer has the session pull Alice's camera and answer the server's offer with a fresh viewer.
func pullAndAnswer(t *testing.T, bob *media.Session, scope protocol.Scope, publisherID string) {
	t.Helper()
	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { viewer.Close() })
	pulled, err := bob.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: "pull", Scope: scope,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: publisherID, TrackName: "cam-0"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := viewer.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := viewer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(viewer)
	if err := viewer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err := bob.Renegotiate(context.Background(), protocol.RenegotiateRequest{
		OperationID: "answer", Scope: scope,
		SessionDescription: protocol.SessionDescription{Type: "answer", SDP: viewer.LocalDescription().SDP},
	}); err != nil {
		t.Fatal(err)
	}
}

// logSink collects what the log exporter posts.
type logSink struct {
	mu   sync.Mutex
	body []byte
}

func (s *logSink) ServeHTTP(_ http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.body = append(s.body, raw...)
	s.mu.Unlock()
}

func (s *logSink) bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.body...)
}

// lockedBuffer is a log destination that tests read while the node writes to it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// waitFor fails the test unless the log shows every substring within eight seconds.
func (b *lockedBuffer) waitFor(t *testing.T, wants ...string) {
	t.Helper()
	deadline := time.After(8 * time.Second)
	for {
		b.mu.Lock()
		logged := true
		for _, want := range wants {
			logged = logged && strings.Contains(b.buf.String(), want)
		}
		b.mu.Unlock()
		if logged {
			return
		}
		select {
		case <-deadline:
			t.Fatal("the node never logged the layer event, so the test proves nothing")
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func gatheredOffer(t *testing.T, pc *webrtc.PeerConnection) *protocol.SessionDescription {
	t.Helper()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	return &protocol.SessionDescription{Type: "offer", SDP: pc.LocalDescription().SDP}
}
