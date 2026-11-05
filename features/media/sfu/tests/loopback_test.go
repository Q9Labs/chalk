package tests

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/internal/control"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

var (
	scopeA = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "alice", Generation: 1}
	scopeB = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "bob", Generation: 1}
	scopeC = protocol.Scope{TenantID: "tenant-2", EpisodeID: "episode-1", ParticipantID: "carol", Generation: 1}
	scopeD = protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-1", ParticipantID: "dave", Generation: 1}
)

// service is the real HTTP service plus a client that holds the API's certificate.
type service struct {
	server  *control.Server
	baseURL string
	client  *http.Client
	stop    func()
}

func startService(t *testing.T, ca *authority) *service {
	t.Helper()
	dir := t.TempDir()
	_, serverCert, serverKey := ca.issue("localhost", x509.ExtKeyUsageServerAuth)
	cfg := config.Config{
		ControlAddr:                "127.0.0.1:0",
		UDPAddr:                    "127.0.0.1:0",
		AnnounceIPs:                []string{"127.0.0.1"},
		IncludeLoopback:            true,
		TLSCertFile:                writeFile(t, dir, "server.pem", serverCert),
		TLSKeyFile:                 writeFile(t, dir, "server.key", serverKey),
		ClientCAFile:               writeFile(t, dir, "ca.pem", ca.pem),
		ClientIdentity:             apiIdentity,
		MaxSessions:                8,
		MaxPublishedPerSession:     4,
		MaxSubscriptionsPerSession: 8,
		MaxRequestBytes:            256 << 10,
		NegotiationTimeout:         time.Second,
		ConnectTimeout:             30 * time.Second,
		ShutdownTimeout:            5 * time.Second,
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	server, err := control.Start(cfg, log)
	if err != nil {
		t.Fatalf("start service: %v", err)
	}
	var once sync.Once
	svc := &service{server: server, baseURL: "https://" + server.Addr().String()}
	svc.stop = func() {
		once.Do(func() {
			if err := server.Stop(context.Background()); err != nil {
				t.Errorf("stop service: %v", err)
			}
		})
	}
	t.Cleanup(svc.stop)
	svc.client = clientFor(t, ca, ca, apiIdentity)
	return svc
}

// clientFor builds an HTTPS client whose certificate comes from clientCA and names identity.
// It trusts the service's CA (serverCA).
func clientFor(t *testing.T, clientCA, serverCA *authority, identity string) *http.Client {
	t.Helper()
	pair, _, _ := clientCA.issue(identity, x509.ExtKeyUsageClientAuth)
	pool := x509.NewCertPool()
	pool.AddCert(serverCA.cert)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{pair}}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}

// call posts a JSON body and decodes a 2xx answer into out. It returns the status and, for
// an error answer, the protocol error code.
func (s *service) call(t *testing.T, path string, body, out any) (int, string) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	response, err := s.client.Post(s.baseURL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode >= 300 {
		var problem protocol.ErrorResponse
		_ = json.Unmarshal(raw, &problem)
		return response.StatusCode, problem.Error.Code
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s: %v (%s)", path, err, raw)
		}
	}
	return response.StatusCode, ""
}

func (s *service) mustCall(t *testing.T, path string, body, out any) {
	t.Helper()
	if status, code := s.call(t, path, body, out); status >= 300 {
		t.Fatalf("POST %s: status %d code %q", path, status, code)
	}
}

func (s *service) createSession(t *testing.T, operation string, scope protocol.Scope) string {
	t.Helper()
	var response protocol.CreateSessionResponse
	s.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: operation, Scope: scope}, &response)
	return response.ConnectionID
}

func (s *service) sessions(t *testing.T) int {
	t.Helper()
	response, err := s.client.Get(s.baseURL + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var ready protocol.ReadyResponse
	if err := json.NewDecoder(response.Body).Decode(&ready); err != nil {
		t.Fatal(err)
	}
	return ready.Sessions
}

func (s *service) inspect(t *testing.T, id string, scope protocol.Scope) []protocol.InspectedTrack {
	t.Helper()
	var response protocol.InspectResponse
	s.mustCall(t, "/v1/sessions/"+id+"/inspect", protocol.InspectRequest{Scope: scope}, &response)
	return response.Tracks
}

// peer is a real Pion peer connection that talks to the SFU on loopback.
type peer struct {
	pc *webrtc.PeerConnection
}

func newPeer(t *testing.T, configure ...func(*webrtc.SettingEngine)) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	for _, apply := range configure {
		apply(&settings)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithSettingEngine(settings))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{pc: pc}
	t.Cleanup(func() { _ = pc.Close() })
	return p
}

// complete sets the local description and waits for ICE gathering, so the SDP carries candidates.
func (p *peer) complete(t *testing.T, description webrtc.SessionDescription) protocol.SessionDescription {
	t.Helper()
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(description); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := p.pc.LocalDescription()
	return protocol.SessionDescription{SDP: local.SDP, Type: local.Type.String()}
}

func (p *peer) mid(t *testing.T, track *webrtc.TrackLocalStaticRTP) string {
	t.Helper()
	for _, transceiver := range p.pc.GetTransceivers() {
		if sender := transceiver.Sender(); sender != nil && sender.Track() != nil && sender.Track().ID() == track.ID() {
			return transceiver.Mid()
		}
	}
	t.Fatalf("no transceiver for track %s", track.ID())
	return ""
}

const (
	firstSequence = 1000
	audioName     = "alice-mic"
	videoName     = "alice-cam"
)

// payloadFor builds the known payload of packet number index: the VP8 start-of-partition
// byte, a kind tag, and the index.
func payloadFor(kind byte, index int) []byte {
	return []byte{0x10, kind, byte(index >> 8), byte(index), 'c', 'h', 'a', 'l', 'k'}
}

// sendLoop writes known RTP until ctx ends. It reports how many packets it sent.
func sendLoop(ctx context.Context, track *webrtc.TrackLocalStaticRTP, kind byte, payloadType uint8, sent *atomic.Int64, done *sync.WaitGroup) {
	done.Go(func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for index := 0; ; index++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			packet := &rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: payloadType, SequenceNumber: uint16(firstSequence + index), Timestamp: uint32(index * 960), Marker: true},
				Payload: payloadFor(kind, index),
			}
			if err := track.WriteRTP(packet); err != nil {
				return
			}
			sent.Add(1)
		}
	})
}

// receiver records the RTP packets one peer receives, per kind.
type receiver struct {
	mu        sync.Mutex
	packets   map[webrtc.RTPCodecType][]*rtp.Packet
	readersWG sync.WaitGroup
}

func collect(p *peer) *receiver {
	r := &receiver{packets: map[webrtc.RTPCodecType][]*rtp.Packet{}}
	p.pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		r.readersWG.Go(func() {
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					return
				}
				r.mu.Lock()
				r.packets[remote.Kind()] = append(r.packets[remote.Kind()], packet)
				r.mu.Unlock()
			}
		})
	})
	return r
}

func (r *receiver) count(kind webrtc.RTPCodecType) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.packets[kind])
}

func (r *receiver) snapshot(kind webrtc.RTPCodecType) []*rtp.Packet {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*rtp.Packet(nil), r.packets[kind]...)
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

// assertKnownStream checks every packet carries the sender's payload for kind, that its
// sequence number is the one the sender gave that payload, and that sequences increase.
func assertKnownStream(t *testing.T, label string, packets []*rtp.Packet, kind byte) {
	t.Helper()
	if len(packets) == 0 {
		t.Fatalf("%s: no packets", label)
	}
	var previous uint16
	for position, packet := range packets {
		if len(packet.Payload) != len(payloadFor(kind, 0)) {
			t.Fatalf("%s: packet %d has payload %v", label, position, packet.Payload)
		}
		index := int(packet.Payload[2])<<8 | int(packet.Payload[3])
		if !bytes.Equal(packet.Payload, payloadFor(kind, index)) {
			t.Fatalf("%s: packet %d payload %v is not the sent payload", label, position, packet.Payload)
		}
		if packet.SequenceNumber != uint16(firstSequence+index) {
			t.Fatalf("%s: packet %d has sequence %d for payload index %d", label, position, packet.SequenceNumber, index)
		}
		if position > 0 && int16(packet.SequenceNumber-previous) <= 0 {
			t.Fatalf("%s: sequence went %d then %d", label, previous, packet.SequenceNumber)
		}
		previous = packet.SequenceNumber
	}
}

func TestLoopback(t *testing.T) {
	baseline := runtime.NumGoroutine()
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)

	t.Run("mutual TLS", func(t *testing.T) {
		rogue := newAuthority(t, "rogue CA")
		if response, err := clientFor(t, rogue, ca, apiIdentity).Get(svc.baseURL + "/healthz"); err == nil {
			response.Body.Close()
			t.Fatal("a certificate from another CA was accepted")
		}
		pool := x509.NewCertPool()
		pool.AddCert(ca.cert)
		anonymous := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool}}}
		if response, err := anonymous.Get(svc.baseURL + "/healthz"); err == nil {
			response.Body.Close()
			t.Fatal("a client without a certificate was accepted")
		}

		stranger := &service{baseURL: svc.baseURL, client: clientFor(t, ca, ca, "someone-else.test")}
		if status, code := stranger.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "op-stranger", Scope: scopeA}, nil); status != http.StatusForbidden || code != protocol.CodeForbidden {
			t.Fatalf("right CA, wrong identity: status %d code %q, want 403 forbidden", status, code)
		}
		if svc.sessions(t) != 0 {
			t.Fatal("a forbidden call created a session")
		}
	})

	connA := svc.createSession(t, "create-alice", scopeA)
	t.Run("duplicate create returns one session", func(t *testing.T) {
		if again := svc.createSession(t, "create-alice", scopeA); again != connA {
			t.Fatalf("replayed create returned %q, want %q", again, connA)
		}
		if got := svc.sessions(t); got != 1 {
			t.Fatalf("%d sessions after a duplicate create, want 1", got)
		}
		if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "create-alice", Scope: scopeB}, nil); status != http.StatusConflict || code != protocol.CodeOperationConflict {
			t.Fatalf("reused operation ID: status %d code %q, want 409 operation_conflict", status, code)
		}
		if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "create-alice-2", Scope: scopeA}, nil); status != http.StatusConflict || code != protocol.CodeSessionExists {
			t.Fatalf("second create for one generation: status %d code %q, want 409 session_exists", status, code)
		}
	})
	connB := svc.createSession(t, "create-bob", scopeB)
	connC := svc.createSession(t, "create-carol", scopeC)

	// Peer A pushes known audio and video RTP.
	alice := newPeer(t)
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", "alice")
	if err != nil {
		t.Fatal(err)
	}
	video, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", "alice")
	if err != nil {
		t.Fatal(err)
	}
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
	svc.mustCall(t, "/v1/sessions/"+connA+"/tracks", protocol.TracksRequest{
		Scope:              scopeA,
		SessionDescription: &pushOffer,
		Tracks: []protocol.Track{
			{Location: protocol.LocationLocal, Mid: audioMid, TrackName: audioName, Source: "microphone"},
			{Location: protocol.LocationLocal, Mid: videoMid, TrackName: videoName, Source: "camera"},
		},
	}, &pushed)
	if pushed.SessionDescription == nil || pushed.SessionDescription.Type != "answer" || len(pushed.Tracks) != 2 || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push response: %+v", pushed)
	}
	if err := alice.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}

	sendCtx, stopSending := context.WithCancel(context.Background())
	var senders sync.WaitGroup
	var audioSent, videoSent atomic.Int64
	sendLoop(sendCtx, audio, 'a', 111, &audioSent, &senders)
	sendLoop(sendCtx, video, 'v', 96, &videoSent, &senders)
	defer func() { stopSending(); senders.Wait() }()

	// Peer B pulls both tracks and answers the SFU's offer through Renegotiate.
	bob := newPeer(t)
	received := collect(bob)
	var pulled protocol.TracksResponse
	svc.mustCall(t, "/v1/sessions/"+connB+"/tracks", protocol.TracksRequest{
		Scope: scopeB,
		Tracks: []protocol.Track{
			{Location: protocol.LocationRemote, SessionID: connA, TrackName: audioName},
			{Location: protocol.LocationRemote, SessionID: connA, TrackName: videoName, Simulcast: &protocol.Simulcast{PreferredRID: "h", PriorityOrdering: "none", RIDNotAvailable: "asciibetical"}},
		},
	}, &pulled)
	if pulled.SessionDescription == nil || pulled.SessionDescription.Type != "offer" || !pulled.RequiresImmediateRenegotiation || len(pulled.Tracks) != 2 || len(pulled.TrackErrors) != 0 {
		t.Fatalf("pull response: %+v", pulled)
	}
	mids := map[string]bool{}
	for _, track := range pulled.Tracks {
		if track.Location != protocol.LocationRemote || track.SessionID != connA || track.Mid == "" || mids[track.Mid] {
			t.Fatalf("pulled track identity: %+v", track)
		}
		mids[track.Mid] = true
	}
	if err := bob.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: pulled.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	answer, err := bob.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	answerSDP := bob.complete(t, answer)
	svc.mustCall(t, "/v1/sessions/"+connB+"/renegotiate", protocol.RenegotiateRequest{Scope: scopeB, SessionDescription: answerSDP}, nil)

	t.Run("audio and video arrive in order", func(t *testing.T) {
		eventually(t, "30 audio and 30 video packets", 20*time.Second, func() bool {
			return received.count(webrtc.RTPCodecTypeAudio) >= 30 && received.count(webrtc.RTPCodecTypeVideo) >= 30
		})
		assertKnownStream(t, "audio", received.snapshot(webrtc.RTPCodecTypeAudio), 'a')
		assertKnownStream(t, "video", received.snapshot(webrtc.RTPCodecTypeVideo), 'v')
	})

	t.Run("inspect lists the tracks", func(t *testing.T) {
		eventually(t, "both published tracks active", 5*time.Second, func() bool {
			tracks := svc.inspect(t, connA, scopeA)
			return len(tracks) == 2 && tracks[0].Active && tracks[1].Active
		})
		for _, track := range svc.inspect(t, connB, scopeB) {
			if track.Location != protocol.LocationRemote || track.SessionID != connA || !track.Active {
				t.Fatalf("subscriber track: %+v", track)
			}
		}
	})

	t.Run("a pull across Tenants fails", func(t *testing.T) {
		var response protocol.TracksResponse
		svc.mustCall(t, "/v1/sessions/"+connC+"/tracks", protocol.TracksRequest{
			Scope:  scopeC,
			Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: connA, TrackName: videoName}},
		}, &response)
		if response.SessionDescription != nil || len(response.Tracks) != 0 || len(response.TrackErrors) != 1 || response.TrackErrors[0].Code != protocol.TrackCodeNotFound {
			t.Fatalf("cross-Tenant pull: %+v", response)
		}
		if status, code := svc.call(t, "/v1/sessions/"+connB+"/inspect", protocol.InspectRequest{Scope: scopeC}, nil); status != http.StatusNotFound || code != protocol.CodeSessionGone {
			t.Fatalf("another Tenant's scope on a session: status %d code %q, want 404 session_gone", status, code)
		}
	})

	t.Run("close stops forwarding and inspect marks the track gone", func(t *testing.T) {
		var closed protocol.CloseTracksResponse
		svc.mustCall(t, "/v1/sessions/"+connA+"/tracks/close", protocol.CloseTracksRequest{Scope: scopeA, Force: true, Tracks: []protocol.CloseTrack{{Mid: videoMid}}}, &closed)
		if len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
			t.Fatalf("close response: %+v", closed)
		}
		for _, track := range svc.inspect(t, connA, scopeA) {
			if track.Mid == videoMid {
				t.Fatalf("closed track still listed: %+v", track)
			}
		}
		time.Sleep(300 * time.Millisecond) // packets already in flight
		videoAfterClose, audioAfterClose := received.count(webrtc.RTPCodecTypeVideo), received.count(webrtc.RTPCodecTypeAudio)
		sentAfterClose := videoSent.Load()
		time.Sleep(600 * time.Millisecond)
		if got := received.count(webrtc.RTPCodecTypeVideo); got != videoAfterClose {
			t.Fatalf("video kept arriving after close: %d then %d", videoAfterClose, got)
		}
		if videoSent.Load() <= sentAfterClose {
			t.Fatal("the publisher stopped sending, so this proves nothing")
		}
		if received.count(webrtc.RTPCodecTypeAudio) <= audioAfterClose {
			t.Fatal("closing video stopped the audio")
		}
		var again protocol.CloseTracksResponse
		svc.mustCall(t, "/v1/sessions/"+connA+"/tracks/close", protocol.CloseTracksRequest{Scope: scopeA, Force: true, Tracks: []protocol.CloseTrack{{Mid: videoMid}}}, &again)
		if !again.Tracks[0].AlreadyClosed {
			t.Fatal("closing an absent track was not idempotent")
		}
		for _, track := range svc.inspect(t, connB, scopeB) {
			if track.TrackName == videoName && track.Active {
				t.Fatal("subscriber still sees the closed video as active")
			}
		}
	})

	t.Run("an unanswered server offer closes the session", func(t *testing.T) {
		connD := svc.createSession(t, "create-dave", scopeD)
		pull := protocol.TracksRequest{Scope: scopeD, Tracks: []protocol.Track{{Location: protocol.LocationRemote, SessionID: connA, TrackName: audioName}}}
		svc.mustCall(t, "/v1/sessions/"+connD+"/tracks", pull, nil)
		if status, code := svc.call(t, "/v1/sessions/"+connD+"/tracks", pull, nil); status != http.StatusConflict || code != protocol.CodeNegotiationBusy {
			t.Fatalf("second negotiation: status %d code %q, want 409 negotiation_in_progress", status, code)
		}
		eventually(t, "the session to close", 5*time.Second, func() bool {
			status, code := svc.call(t, "/v1/sessions/"+connD+"/inspect", protocol.InspectRequest{Scope: scopeD}, nil)
			return status == http.StatusNotFound && code == protocol.CodeSessionGone
		})
	})

	udpPort := svc.server.UDPPort()

	// Everything closes: peers, the service and every goroutine.
	stopSending()
	senders.Wait()
	_ = alice.pc.Close()
	_ = bob.pc.Close()
	received.readersWG.Wait()
	svc.stop()
	svc.client.CloseIdleConnections()
	eventually(t, fmt.Sprintf("goroutines to return to %d", baseline), 15*time.Second, func() bool {
		return runtime.NumGoroutine() <= baseline
	})
	if connection, err := net.DialTimeout("tcp", svc.server.Addr().String(), time.Second); err == nil {
		connection.Close()
		t.Fatal("the control listener still accepts connections")
	}
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: udpPort})
	if err != nil {
		t.Fatalf("the media port was not released: %v", err)
	}
	udp.Close()
}
