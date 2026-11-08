package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var captureScope = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "recording-1", Generation: 1}

func (s *service) createCapture(t *testing.T, operation string, scope protocol.Scope) string {
	t.Helper()
	var response protocol.CreateSessionResponse
	s.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: operation, Scope: scope, Kind: protocol.SessionKindCapture}, &response)
	return response.ConnectionID
}

func TestCaptureSession(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	svc.grantSources(t, scopeA)
	connA := svc.createSession(t, "create-alice", scopeA)

	t.Run("readiness lists the capture kind", func(t *testing.T) {
		response, err := svc.client.Get(svc.baseURL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var ready protocol.ReadyResponse
		if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
			t.Fatal(err)
		}
		if len(ready.SessionKinds) != 1 || ready.SessionKinds[0] != protocol.SessionKindCapture {
			t.Fatalf("session kinds %v, want [capture]", ready.SessionKinds)
		}
	})

	t.Run("an unknown kind and unknown fields are refused", func(t *testing.T) {
		// A node that predates session kinds decodes strictly, so the same refusal is what an old
		// node gives a capture create: 400 and no session.
		before := svc.sessions(t)
		for name, body := range map[string]string{
			"unknown kind":  `{"operationId":"op-bad-kind","scope":{"tenantId":"tenant-1","episodeId":"episode-1","participantId":"x","generation":1},"kind":"bogus"}`,
			"unknown field": `{"operationId":"op-bad-field","scope":{"tenantId":"tenant-1","episodeId":"episode-1","participantId":"x","generation":1},"kind":"capture","future":1}`,
		} {
			response, err := svc.client.Post(svc.baseURL+"/v1/sessions", "application/json", bytes.NewReader([]byte(body)))
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s: status %d, want 400", name, response.StatusCode)
			}
		}
		if svc.sessions(t) != before {
			t.Fatal("a refused create left a session")
		}
	})

	// Alice publishes a microphone and a camera with known payloads.
	alice := newPeer(t)
	audio, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "alice")
	video, _ := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", "alice")
	for _, track := range []*webrtc.TrackLocalStaticRTP{audio, video} {
		if _, err := alice.pc.AddTrack(track); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := alice.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := alice.complete(t, offer)
	audioMid, videoMid := alice.mid(t, audio), alice.mid(t, video)
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connA+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: scopeA, SessionDescription: &pushOffer,
		Tracks: []protocol.Track{
			{Location: protocol.LocationLocal, Mid: audioMid, TrackName: audioName, Source: "microphone"},
			{Location: protocol.LocationLocal, Mid: videoMid, TrackName: videoName, Source: "camera"},
		}}, &pushed)
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	sendCtx, stopSending := context.WithCancel(context.Background())
	var senders sync.WaitGroup
	var audioSent, videoSent atomic.Int64
	sendLoop(sendCtx, audio, 'a', 111, &audioSent, &senders)
	sendLoop(sendCtx, video, 'v', 96, &videoSent, &senders)
	defer func() { stopSending(); senders.Wait() }()

	connCapture := svc.createCapture(t, "create-capture", captureScope)
	if again := svc.createCapture(t, "create-capture", captureScope); again != connCapture {
		t.Fatalf("replayed capture create returned %q, want %q", again, connCapture)
	}

	recorder := newPeer(t)
	received := collect(recorder)
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connCapture+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: captureScope,
		Tracks: []protocol.Track{
			{Location: protocol.LocationRemote, SessionID: connA, TrackName: audioName},
			{Location: protocol.LocationRemote, SessionID: connA, TrackName: videoName, Simulcast: &protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "none"}},
		}}, &pulled)
	if pulled.SessionDescription == nil || pulled.SessionDescription.Type != "offer" || len(pulled.Tracks) != 2 || len(pulled.TrackErrors) != 0 {
		t.Fatalf("capture pull: %+v", pulled)
	}
	if err := recorder.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := recorder.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.mustCall(t, "/v1/sessions/"+connCapture+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: captureScope, SessionDescription: recorder.complete(t, answer)}, nil)

	t.Run("the capture receives the published media in order", func(t *testing.T) {
		eventually(t, "30 audio and 30 video packets", 20*time.Second, func() bool {
			return received.count(webrtc.RTPCodecTypeAudio) >= 30 && received.count(webrtc.RTPCodecTypeVideo) >= 30
		})
		assertKnownStream(t, "audio", received.snapshot(webrtc.RTPCodecTypeAudio), 'a')
		assertKnownStream(t, "video", received.snapshot(webrtc.RTPCodecTypeVideo), 'v')
	})

	t.Run("a capture publishes nothing", func(t *testing.T) {
		pushOffer := protocol.SessionDescription{Type: "offer", SDP: "v=0"}
		status, code := svc.call(t, "/v1/sessions/"+connCapture+"/tracks", protocol.TracksRequest{OperationID: op(), Scope: captureScope, SessionDescription: &pushOffer,
			Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: "9", TrackName: "x", Source: "microphone"}}}, nil)
		if status != http.StatusNotImplemented || code != protocol.CodeUnsupportedOperation {
			t.Fatalf("push on a capture: status %d code %q, want 501 unsupported_operation", status, code)
		}
	})

	t.Run("another Tenant's scope on the capture reads as gone", func(t *testing.T) {
		stranger := captureScope
		stranger.TenantID = "tenant-2"
		if status, code := svc.call(t, "/v1/sessions/"+connCapture+"/inspect", protocol.InspectRequest{Scope: stranger}, nil); status != http.StatusNotFound || code != protocol.CodeSessionGone {
			t.Fatalf("status %d code %q, want 404 session_gone", status, code)
		}
	})

	t.Run("the capture follows the source lease", func(t *testing.T) {
		for _, track := range svc.inspect(t, connCapture, captureScope) {
			if track.Subscription == nil || track.Subscription.State != protocol.SubscriptionActive {
				t.Fatalf("capture subscription before revoke: %+v", track)
			}
		}
		// Revoke the microphone: the lease is the privacy boundary, so the capture's copy stops
		// with the Participants'.
		var controlled protocol.SourceControlResponse
		svc.mustCall(t, "/v1/episodes/sources", protocol.SourceControlRequest{TenantID: "tenant-1", EpisodeID: "episode-1",
			Controls: []protocol.SourceControl{{ParticipantID: "alice", Source: "microphone", Action: protocol.SourceRevoke, Revision: 2}}}, &controlled)
		time.Sleep(300 * time.Millisecond) // packets already in flight
		audioAfterRevoke, videoAfterRevoke := received.count(webrtc.RTPCodecTypeAudio), received.count(webrtc.RTPCodecTypeVideo)
		time.Sleep(time.Second)
		if got := received.count(webrtc.RTPCodecTypeAudio); got != audioAfterRevoke {
			t.Fatalf("capture audio grew from %d to %d after the source was revoked", audioAfterRevoke, got)
		}
		if got := received.count(webrtc.RTPCodecTypeVideo); got <= videoAfterRevoke {
			t.Fatalf("capture video stopped at %d with the camera still granted", got)
		}
	})

	t.Run("ending the Episode closes the capture", func(t *testing.T) {
		var ended protocol.EndEpisodeResponse
		svc.mustCall(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-1"}, &ended)
		if ended.Closed != 2 || svc.sessions(t) != 0 {
			t.Fatalf("closed %d, %d sessions left; want the participant and the capture closed", ended.Closed, svc.sessions(t))
		}
	})
}

func TestCapturePinsRequestedSimulcastLayer(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	t.Cleanup(svc.stop)
	svc.grantSources(t, scopeA)
	fixtures := [2]layerFixture{{rid: "h", frames: readIVF(t, "high.ivf")}, {rid: "l", frames: readIVF(t, "low.ivf")}}

	connA := svc.createSession(t, "create-alice", scopeA)
	alice := newPeer(t)
	publisher := &simulcastPublisher{fixtures: fixtures, enabled: [2]bool{true, true}}
	for layer, fixture := range fixtures {
		track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", "alice", webrtc.WithRTPStreamID(fixture.rid))
		if err != nil {
			t.Fatal(err)
		}
		publisher.tracks[layer] = track
	}
	sender, err := alice.pc.AddTrack(publisher.tracks[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := sender.AddEncoding(publisher.tracks[1]); err != nil {
		t.Fatal(err)
	}
	offer, err := alice.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	pushOffer := alice.complete(t, offer)
	publisher.mid = alice.mid(t, publisher.tracks[0])
	var pushed protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connA+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope: scopeA, SessionDescription: &pushOffer,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: publisher.mid, TrackName: videoName, Source: "camera"}},
	}, &pushed)
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push response: %+v", pushed)
	}
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	publisher.midID = extensionID(t, sender, sdp.SDESMidURI)
	publisher.ridID = extensionID(t, sender, sdp.SDESRTPStreamIDURI)

	ctx, stop := context.WithCancel(context.Background())
	var sending sync.WaitGroup
	publisher.run(ctx, &sending)
	t.Cleanup(func() { stop(); sending.Wait() })
	eventually(t, "both layers active", 10*time.Second, func() bool {
		tracks := svc.inspect(t, connA, scopeA)
		return len(tracks) == 1 && len(tracks[0].Layers) == 2 && tracks[0].Layers[0].Active && tracks[0].Layers[1].Active
	})

	conn := svc.createCapture(t, "create-capture-high", captureScope)
	received := pullVideo(t, svc, conn, captureScope, connA, protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "none"})
	eventually(t, "capture receives video", 5*time.Second, func() bool { return received.count() >= 30 })
	state := subscriptionState(t, svc, conn, captureScope)
	t.Logf("requested=%q effective=%q state=%q, received=%d packets", state.RequestedRID, state.EffectiveRID, state.State, received.count())
	frames, _ := reassemble(t, "capture", received.snapshot(), fixtures)
	if len(frames) == 0 {
		t.Fatal("capture has no complete frames")
	}
	for _, frame := range frames {
		if fixtures[frame.layer].rid != "h" {
			t.Fatalf("capture explicitly pinned h without fallback received real %q-layer VP8 frame (%d bytes); inspected effective=%q", fixtures[frame.layer].rid, len(frame.data), state.EffectiveRID)
		}
	}
}

func TestCaptureCannotExceedNodePacketBudget(t *testing.T) {
	const budget = 7700
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) {
		cfg.PacketBudget, cfg.EpisodePacketCeiling = budget, 11520
		cfg.VideoStreamCost, cfg.CameraUplinkCost = 300, 390
		cfg.CamerasPerParticipant, cfg.MaxCaptureSubscriptions = 2, 64
	})
	people := make([]*participant, 3)
	for index := range people {
		people[index] = joinEpisode(t, svc, "episode-1", fmt.Sprintf("p%d", index), false)
		people[index].publish(t, svc, publishing{cameras: 2, screen: index == 0,
			chunks: [2]int{1150, 1150}, frameBytes: [3]int{11500, 3450, 8050}, screenChunk: 1150})
	}
	recorder := &participant{name: "capture", scope: captureScope, peer: newPeer(t)}
	recorder.media = receiveMedia(recorder.peer, false)
	recorder.conn = svc.createCapture(t, "create-budget-capture", captureScope)
	for _, person := range people {
		var tracks []protocol.Track
		for _, other := range people {
			if other == person {
				continue
			}
			tracks = append(tracks, remote(other, cameraName), remote(other, cameraTrack(1)), remote(other, micName))
			if other == people[0] {
				tracks = append(tracks, remote(other, screenName))
			}
		}
		person.pull(t, svc, tracks)
	}
	var captureTracks []protocol.Track
	for _, person := range people {
		captureTracks = append(captureTracks, remote(person, cameraName), remote(person, cameraTrack(1)), remote(person, micName))
	}
	captureTracks = append(captureTracks, remote(people[0], screenName))
	pulled := recorder.pullSome(t, svc, captureTracks)
	if len(pulled.TrackErrors) == 0 || len(pulled.Tracks) == 0 {
		t.Fatalf("a capture past the node budget needs some tracks accepted and some refused: %d accepted, %d refused", len(pulled.Tracks), len(pulled.TrackErrors))
	}
	for _, refused := range pulled.TrackErrors {
		if refused.Code != protocol.TrackCodeLimitExceeded {
			t.Fatalf("refused %s with %q, want %q", refused.TrackName, refused.Code, protocol.TrackCodeLimitExceeded)
		}
	}
	var ready protocol.ReadyResponse
	readReady := func() {
		response, err := svc.client.Get(svc.baseURL + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("ready status: %d", response.StatusCode)
		}
		if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
			t.Fatal(err)
		}
	}
	readReady()
	t.Logf("admitted %d of %d capture tracks, reserved=%d packetBudget=%d", len(pulled.Tracks), len(captureTracks), ready.ReservedPackets, ready.PacketBudget)
	if ready.ReservedPackets > ready.PacketBudget {
		t.Fatalf("reserved %d past the budget %d", ready.ReservedPackets, ready.PacketBudget)
	}
	reservedWithCapture := ready.ReservedPackets
	eventually(t, "participant cameras on h", 20*time.Second, func() bool {
		for _, person := range people {
			response := person.inspect(t, svc)
			for _, track := range response.Tracks {
				if track.Location == protocol.LocationRemote && strings.HasPrefix(track.TrackName, cameraName) &&
					(track.Subscription == nil || track.Subscription.EffectiveRID != "h") {
					return false
				}
			}
		}
		return recorder.media.packets.Load() >= 1000
	})
	counted := func() int64 {
		total := recorder.media.packets.Load()
		for _, person := range people {
			total += person.sent.Load() + person.media.packets.Load()
		}
		return total
	}
	from, before, captureBefore := time.Now(), counted(), recorder.media.packets.Load()
	<-time.After(3 * time.Second)
	elapsed := time.Since(from).Seconds()
	actual := float64(counted()-before) / elapsed
	capture := float64(recorder.media.packets.Load()-captureBefore) / elapsed
	readReady()
	t.Logf("capture received %.0f packets/s; all peers sent+received %.0f; node reports %.0f; budget=%d reserved=%d", capture, actual, ready.Host.PacketsPerSecond, budget, reservedWithCapture)
	if actual > budget {
		t.Fatalf("admitted capture bypassed node packet ceiling: actual %.0f > %d", actual, budget)
	}
	// Closing the capture's tracks returns their reservation.
	var closes []protocol.CloseTrack
	for _, track := range pulled.Tracks {
		closes = append(closes, protocol.CloseTrack{Mid: track.Mid})
	}
	svc.mustCall(t, "/v1/sessions/"+recorder.conn+"/tracks/close", protocol.CloseTracksRequest{OperationID: op(), Scope: captureScope, Force: true, Tracks: closes}, nil)
	readReady()
	if ready.ReservedPackets >= reservedWithCapture {
		t.Fatalf("reserved %d after the capture closed its tracks, was %d", ready.ReservedPackets, reservedWithCapture)
	}
}
