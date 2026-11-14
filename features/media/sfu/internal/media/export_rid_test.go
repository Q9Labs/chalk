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
	var mu sync.Mutex
	var exported []byte
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		exported = append(exported, raw...)
		mu.Unlock()
	}))
	defer sink.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "Authorization=Bearer test-token")
	var journal bytes.Buffer
	var journalMu sync.Mutex
	logger, shutdown, err := telemetry.NewLogger(context.Background(), config.Telemetry{OTLPEndpoint: sink.URL, OTLPInsecure: true},
		slog.NewJSONHandler(lockedWriter{&journalMu, &journal}, nil))
	if err != nil {
		t.Fatal(err)
	}
	node := newExportedNode(t, logger)

	aliceScope := protocol.Scope{TenantID: "tenant", EpisodeID: "episode", ParticipantID: "alice", Generation: 1}
	bobScope := aliceScope
	bobScope.ParticipantID = "bob"
	create := func(id string, scope protocol.Scope) (*media.Session, string) {
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
	alice, aliceID := create("create-alice", aliceScope)
	bob, _ := create("create-bob", bobScope)
	if _, err := node.ControlSources(protocol.SourceControlRequest{TenantID: "tenant", EpisodeID: "episode", Controls: []protocol.SourceControl{
		{ParticipantID: "alice", Source: "camera", Action: protocol.SourceGrant, Revision: 1},
	}}); err != nil {
		t.Fatal(err)
	}

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
	defer pc.Close()
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
	sending, stop := context.WithCancel(context.Background())
	var sent sync.WaitGroup
	sent.Add(1)
	defer func() { stop(); sent.Wait() }()
	go func() {
		defer sent.Done()
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
			_ = packet.Header.SetExtension(midID, []byte(publisherMid))
			_ = packet.Header.SetExtension(ridID, []byte(chosen))
			_ = track.WriteRTP(packet)
			sequence++
		}
	}()

	viewer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	pulled, err := bob.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: "pull", Scope: bobScope,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: aliceID, TrackName: "cam-0"}},
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
		OperationID: "answer", Scope: bobScope,
		SessionDescription: protocol.SessionDescription{Type: "answer", SDP: viewer.LocalDescription().SDP},
	}); err != nil {
		t.Fatal(err)
	}

	// The journal must show the layer event with the raw rid, so the test knows the node logged it.
	deadline := time.After(8 * time.Second)
	for {
		journalMu.Lock()
		logged := strings.Contains(journal.String(), `"event":"sfu.subscription.layer"`) && strings.Contains(journal.String(), chosen)
		journalMu.Unlock()
		if logged {
			break
		}
		select {
		case <-deadline:
			t.Fatal("the node never logged the layer event, so the test proves nothing")
		case <-time.After(25 * time.Millisecond):
		}
	}
	stop()
	sent.Wait()
	node.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := shutdown(ctx); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if bytes.Contains(exported, []byte(chosen)) || bytes.Contains(exported, []byte("203.0.113")) {
		t.Fatal("a publisher-chosen rid left the node")
	}
	for _, want := range []string{"sfu.subscription.layer", "other"} {
		if !bytes.Contains(exported, []byte(want)) {
			t.Errorf("the exported layer event lacks %q", want)
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

type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
