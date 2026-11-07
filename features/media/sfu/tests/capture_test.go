package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

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
