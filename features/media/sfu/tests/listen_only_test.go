package tests

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func TestListenOnlyBeforeAnyonePublishes(t *testing.T) {
	const connectTimeout = 2 * time.Second
	svc := startService(t, newAuthority(t, "chalk test CA"), func(cfg *config.Config) {
		cfg.ConnectTimeout = connectTimeout
	})
	conn := svc.createSession(t, "create-listener", scopeB)
	listener := newPeer(t)
	received := collect(listener)
	_, err := listener.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly})
	if err != nil {
		t.Fatal(err)
	}
	offer, err := listener.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	description := listener.complete(t, offer)
	sending := description
	sending.SDP = strings.Replace(sending.SDP, "a=recvonly", "a=sendrecv", 1)
	if status, code := svc.call(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: scopeB, SessionDescription: &sending,
	}, nil); status != http.StatusBadRequest || code != protocol.CodeInvalidRequest {
		t.Fatalf("a new sending section still needs a named track: status %d, code %q", status, code)
	}
	var response protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: scopeB, SessionDescription: &description,
	}, &response)
	if response.SessionDescription == nil || len(response.Tracks) != 0 || len(response.TrackErrors) != 0 {
		t.Fatalf("listener expected a transport answer without publications: %+v", response)
	}
	if err := listener.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: response.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "listener connected with no publisher", connectTimeout, func() bool {
		return listener.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	})

	// The original binding must still be inspectable after the idle deadline.
	time.Sleep(connectTimeout)
	if tracks := svc.inspect(t, conn, scopeB); len(tracks) != 0 {
		t.Fatalf("listener unexpectedly has tracks: %+v", tracks)
	}
	svc.grantSources(t, scopeA)
	publisherConn := svc.createSession(t, "create-publisher", scopeA)
	publisher := publishKnownMedia(t, svc, publisherConn, scopeA)
	defer publisher.stop()
	pullKnownMedia(t, svc, listener, conn, scopeB, publisherConn)
	eventually(t, "late publisher audio and video on the original listener connection", 5*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) > 0 && received.count(webrtc.RTPCodecTypeVideo) > 0
	})
}

func subscribeKnownMedia(t *testing.T, svc *service, conn string, scope protocol.Scope, publisherConn string) (*peer, *receiver) {
	t.Helper()
	bob := newPeer(t)
	received := collect(bob)
	pullKnownMedia(t, svc, bob, conn, scope, publisherConn)
	return bob, received
}

func pullKnownMedia(t *testing.T, svc *service, listener *peer, conn string, scope protocol.Scope, publisherConn string) {
	t.Helper()
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+conn+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope: scope,
		Tracks: []protocol.Track{
			{Location: protocol.LocationRemote, SessionID: publisherConn, TrackName: audioName},
			{Location: protocol.LocationRemote, SessionID: publisherConn, TrackName: videoName, Simulcast: &protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}},
		},
	}, &pulled)
	if pulled.SessionDescription == nil || pulled.SessionDescription.Type != "offer" || !pulled.RequiresImmediateRenegotiation || len(pulled.Tracks) != 2 || len(pulled.TrackErrors) != 0 {
		t.Fatalf("pull response: %+v", pulled)
	}
	mids := map[string]bool{}
	for _, track := range pulled.Tracks {
		if track.Location != protocol.LocationRemote || track.SessionID != publisherConn || track.Mid == "" || mids[track.Mid] {
			t.Fatalf("pulled track identity: %+v", track)
		}
		mids[track.Mid] = true
	}
	if err := listener.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := listener.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answerSDP := listener.complete(t, answer)
	svc.mustCall(t, "/v1/sessions/"+conn+"/renegotiate", protocol.RenegotiateRequest{OperationID: op(), Scope: scope, SessionDescription: answerSDP}, nil)
}
