package tests

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var (
	scopeA = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "alice", Generation: 1}
	scopeB = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "bob", Generation: 1}
	scopeC = protocol.Scope{TenantID: "tenant-2", EpisodeID: "episode-1", ParticipantID: "carol", Generation: 1}
	scopeD = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "dave", Generation: 1}
)

var operations atomic.Int64

const (
	firstSequence = 1000
	audioName     = "alice-mic"
	videoName     = "alice-cam"
)

// loopback is the state the scenarios of TestLoopback share: one service, three live sessions, and
// the known media Alice sends and Bob receives.
type loopback struct {
	svc                 *service
	ca                  *authority
	connA, connB, connC string
	alice               *publication
	bob                 *peer
	received            *receiver
}

func TestLoopback(t *testing.T) {
	baseline := runtime.NumGoroutine()
	ca := newAuthority(t, "chalk test CA")
	l := &loopback{svc: startService(t, ca), ca: ca}
	l.svc.grantSources(t, scopeA, scopeB, scopeC, scopeD)

	t.Run("mutual TLS", l.mutualTLS)

	l.connA = l.svc.createSession(t, "create-alice", scopeA)
	t.Run("duplicate create returns one session", l.duplicateCreate)
	l.connB = l.svc.createSession(t, "create-bob", scopeB)
	l.connC = l.svc.createSession(t, "create-carol", scopeC)

	// Peer A pushes known audio and video RTP; peer B pulls both tracks.
	l.alice = publishKnownMedia(t, l.svc, l.connA, scopeA)
	defer l.alice.stop()
	l.bob, l.received = subscribeKnownMedia(t, l.svc, l.connB, scopeB, l.connA)

	t.Run("audio and video arrive in order", l.arriveInOrder)
	t.Run("inspect lists the tracks", l.inspectLists)
	t.Run("a pull across Tenants fails", l.crossTenantPull)
	t.Run("close stops forwarding and inspect marks the track gone", l.closeStopsForwarding)
	t.Run("an unanswered server offer closes the session", l.unansweredOfferCloses)

	l.shutdown(t, baseline)
}

// shutdown closes everything: peers, the service and every goroutine.
func (l *loopback) shutdown(t *testing.T, baseline int) {
	udpPort := l.svc.server.UDPPort()
	l.alice.stop()
	_ = l.alice.peer.pc.Close()
	_ = l.bob.pc.Close()
	l.received.readersWG.Wait()
	l.svc.stop()
	l.svc.client.CloseIdleConnections()
	eventually(t, fmt.Sprintf("goroutines to return to %d", baseline), 15*time.Second, func() bool {
		return runtime.NumGoroutine() <= baseline
	})
	if connection, err := net.DialTimeout("tcp", l.svc.server.Addr().String(), time.Second); err == nil {
		connection.Close()
		t.Fatal("the control listener still accepts connections")
	}
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: udpPort})
	if err != nil {
		t.Fatalf("the media port was not released: %v", err)
	}
	udp.Close()
}

func (l *loopback) mutualTLS(t *testing.T) {
	rogue := newAuthority(t, "rogue CA")
	if response, err := clientFor(t, rogue, l.ca, apiIdentity).Get(l.svc.baseURL + "/healthz"); err == nil {
		response.Body.Close()
		t.Fatal("a certificate from another CA was accepted")
	}
	pool := x509.NewCertPool()
	pool.AddCert(l.ca.cert)
	anonymous := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool}}}
	if response, err := anonymous.Get(l.svc.baseURL + "/healthz"); err == nil {
		response.Body.Close()
		t.Fatal("a client without a certificate was accepted")
	}

	stranger := &service{baseURL: l.svc.baseURL, client: clientFor(t, l.ca, l.ca, "someone-else.test")}
	if status, code := stranger.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "op-stranger", Scope: scopeA}, nil); status != http.StatusForbidden || code != protocol.CodeForbidden {
		t.Fatalf("right CA, wrong identity: status %d code %q, want 403 forbidden", status, code)
	}
	if l.svc.sessions(t) != 0 {
		t.Fatal("a forbidden call created a session")
	}
	// Readiness names the node incarnation, so it needs the service identity too.
	response, err := stranger.client.Get(l.svc.baseURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("readiness with the wrong identity: status %d, want 403", response.StatusCode)
	}
}

func (l *loopback) duplicateCreate(t *testing.T) {
	if again := l.svc.createSession(t, "create-alice", scopeA); again != l.connA {
		t.Fatalf("replayed create returned %q, want %q", again, l.connA)
	}
	if got := l.svc.sessions(t); got != 1 {
		t.Fatalf("%d sessions after a duplicate create, want 1", got)
	}
	if status, code := l.svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "create-alice", Scope: scopeB}, nil); status != http.StatusConflict || code != protocol.CodeOperationConflict {
		t.Fatalf("reused operation ID: status %d code %q, want 409 operation_conflict", status, code)
	}
}

func (l *loopback) arriveInOrder(t *testing.T) {
	eventually(t, "30 audio and 30 video packets", 20*time.Second, func() bool {
		return l.received.count(webrtc.RTPCodecTypeAudio) >= 30 && l.received.count(webrtc.RTPCodecTypeVideo) >= 30
	})
	assertKnownStream(t, "audio", l.received.snapshot(webrtc.RTPCodecTypeAudio), 'a')
	assertKnownStream(t, "video", l.received.snapshot(webrtc.RTPCodecTypeVideo), 'v')
}

func (l *loopback) inspectLists(t *testing.T) {
	eventually(t, "both published tracks active", 5*time.Second, func() bool {
		tracks := l.svc.inspect(t, l.connA, scopeA)
		return len(tracks) == 2 && tracks[0].Active && tracks[1].Active
	})
	for _, track := range l.svc.inspect(t, l.connB, scopeB) {
		if track.Location != protocol.LocationRemote || track.SessionID != l.connA || !track.Active {
			t.Fatalf("subscriber track: %+v", track)
		}
	}
}

func (l *loopback) crossTenantPull(t *testing.T) {
	var response protocol.TracksResponse
	l.svc.mustCall(t, "/v1/sessions/"+l.connC+"/tracks", protocol.TracksRequest{OperationID: op(),
		Scope:  scopeC,
		Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: l.connA, TrackName: videoName}},
	}, &response)
	if response.SessionDescription != nil || len(response.Tracks) != 0 || len(response.TrackErrors) != 1 || response.TrackErrors[0].Code != protocol.TrackCodeNotFound {
		t.Fatalf("cross-Tenant pull: %+v", response)
	}
	if status, code := l.svc.call(t, "/v1/sessions/"+l.connB+"/inspect", protocol.InspectRequest{Scope: scopeC}, nil); status != http.StatusNotFound || code != protocol.CodeSessionGone {
		t.Fatalf("another Tenant's scope on a session: status %d code %q, want 404 session_gone", status, code)
	}
}

func (l *loopback) closeStopsForwarding(t *testing.T) {
	var closed protocol.CloseTracksResponse
	l.svc.mustCall(t, "/v1/sessions/"+l.connA+"/tracks/close", protocol.CloseTracksRequest{OperationID: op(), Scope: scopeA, Force: true, Tracks: []protocol.CloseTrack{{Mid: l.alice.videoMid}}}, &closed)
	if len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
		t.Fatalf("close response: %+v", closed)
	}
	for _, track := range l.svc.inspect(t, l.connA, scopeA) {
		if track.Mid == l.alice.videoMid {
			t.Fatalf("closed track still listed: %+v", track)
		}
	}
	time.Sleep(300 * time.Millisecond) // packets already in flight
	videoAfterClose, audioAfterClose := l.received.count(webrtc.RTPCodecTypeVideo), l.received.count(webrtc.RTPCodecTypeAudio)
	sentAfterClose := l.alice.videoSent.Load()
	time.Sleep(600 * time.Millisecond)
	if got := l.received.count(webrtc.RTPCodecTypeVideo); got != videoAfterClose {
		t.Fatalf("video kept arriving after close: %d then %d", videoAfterClose, got)
	}
	if l.alice.videoSent.Load() <= sentAfterClose {
		t.Fatal("the publisher stopped sending, so this proves nothing")
	}
	if l.received.count(webrtc.RTPCodecTypeAudio) <= audioAfterClose {
		t.Fatal("closing video stopped the audio")
	}
	var again protocol.CloseTracksResponse
	l.svc.mustCall(t, "/v1/sessions/"+l.connA+"/tracks/close", protocol.CloseTracksRequest{OperationID: op(), Scope: scopeA, Force: true, Tracks: []protocol.CloseTrack{{Mid: l.alice.videoMid}}}, &again)
	if !again.Tracks[0].AlreadyClosed {
		t.Fatal("closing an absent track was not idempotent")
	}
	for _, track := range l.svc.inspect(t, l.connB, scopeB) {
		if track.TrackName == videoName && track.Active {
			t.Fatal("subscriber still sees the closed video as active")
		}
	}
}

func (l *loopback) unansweredOfferCloses(t *testing.T) {
	connD := l.svc.createSession(t, "create-dave", scopeD)
	pull := protocol.TracksRequest{OperationID: op(), Scope: scopeD, Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: l.connA, TrackName: audioName}}}
	l.svc.mustCall(t, "/v1/sessions/"+connD+"/tracks", pull, nil)
	pull.OperationID = op()
	if status, code := l.svc.call(t, "/v1/sessions/"+connD+"/tracks", pull, nil); status != http.StatusConflict || code != protocol.CodeNegotiationBusy {
		t.Fatalf("second negotiation: status %d code %q, want 409 negotiation_in_progress", status, code)
	}
	eventually(t, "the session to close", 5*time.Second, func() bool {
		status, code := l.svc.call(t, "/v1/sessions/"+connD+"/inspect", protocol.InspectRequest{Scope: scopeD}, nil)
		return status == http.StatusNotFound && code == protocol.CodeSessionGone
	})
}
