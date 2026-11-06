package chalksfu_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/apps/api/internal/adapters/chalksfu"
	runtimeconfig "github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

// TestLiveRelayOverTCP443 sends audio between two peers through a deployed node
// when the peers may use only TURN over TLS on TCP 443, as on a network that
// blocks UDP. It runs only against a live node:
//
//	CHALK_SFU_LIVE_URL         the node's control URL, such as an SSH tunnel
//	CHALK_SFU_LIVE_CA          the service CA
//	CHALK_SFU_LIVE_CERT, _KEY  a client certificate with the API identity
//	CHALK_SFU_LIVE_ICE_SERVERS a JSON file of TURN servers, as Cloudflare returns them
func TestLiveRelayOverTCP443(t *testing.T) {
	controlURL := os.Getenv("CHALK_SFU_LIVE_URL")
	if controlURL == "" {
		t.Skip("CHALK_SFU_LIVE_URL is not set")
	}
	servers := tcp443TURN(t, os.Getenv("CHALK_SFU_LIVE_ICE_SERVERS"))
	fleet, err := chalksfu.NewFleet(runtimeconfig.ChalkSFUConfig{
		Enabled: true, ApplicationID: "live-relay", ServerName: "chalk-sfu", RequestTimeout: 10 * time.Second,
		Nodes:  []runtimeconfig.ChalkSFUNode{{ID: "live", ControlURL: controlURL}},
		CAFile: os.Getenv("CHALK_SFU_LIVE_CA"), ClientCertFile: os.Getenv("CHALK_SFU_LIVE_CERT"), ClientKeyFile: os.Getenv("CHALK_SFU_LIVE_KEY"),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	adapter, err := fleet.Node("live")
	if err != nil {
		t.Fatal(err)
	}
	service := mediaplane.NewServiceForProvider(mediaplane.ProviderChalkSFU, adapter)
	ctx := context.Background()
	episode := fmt.Sprintf("live-relay-%d", time.Now().UnixNano())
	alice, bob := scopeOf(episode, "alice"), scopeOf(episode, "bob")
	if _, err := adapter.ControlSources(ctx, mediaplane.ControlSourcesInput{TenantID: alice.TenantID, EpisodeID: episode, Controls: []mediaplane.SourceControl{
		{ParticipantID: "alice", Source: "microphone", Action: mediaplane.SourceGrant, Revision: 1},
	}}); err != nil {
		t.Fatalf("grant: %v", err)
	}
	aliceConn, _ := join(t, service, alice)
	bobConn, _ := join(t, service, bob)
	t.Cleanup(func() {
		_ = adapter.EndEpisode(context.WithoutCancel(ctx), mediaplane.EndEpisodeInput{Provider: mediaplane.ProviderChalkSFU, TenantID: alice.TenantID, EpisodeRef: episode})
	})

	publisher := relayPeer(t, servers)
	audio := publisher.addAudio(t, "alice-mic")
	offer := publisher.offer(t)
	pushed, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: aliceConn, Scope: alice, SessionDescription: &offer,
		Tracks: []mediaplane.Track{{Location: "local", Mid: publisher.mid(t, audio), TrackName: "alice-mic", Source: "microphone"}},
	})
	if err != nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push = %+v, %v", pushed, err)
	}
	publisher.accept(t, pushed.SessionDescription)
	media, stop := context.WithCancel(ctx)
	defer stop()
	send(media, audio)

	subscriber := relayPeer(t, servers)
	pulled, err := service.AddTracks(ctx, mediaplane.TracksRequest{
		ConnectionID: bobConn, Scope: bob,
		Tracks: []mediaplane.Track{{Location: "remote", SessionID: aliceConn, TrackName: "alice-mic"}},
	})
	if err != nil || len(pulled.TrackErrors) != 0 {
		t.Fatalf("pull = %+v, %v", pulled, err)
	}
	started := time.Now()
	if err := service.Renegotiate(ctx, mediaplane.RenegotiateRequest{ConnectionID: bobConn, Scope: bob, SessionDescription: subscriber.answer(t, pulled.SessionDescription)}); err != nil {
		t.Fatalf("answer: %v", err)
	}
	eventually(t, "relayed media to reach the subscriber", 30*time.Second, func() bool { return subscriber.received.Load() >= 1 })
	firstMedia := time.Since(started)
	time.Sleep(10 * time.Second)
	for name, p := range map[string]*peer{"publisher": publisher, "subscriber": subscriber} {
		candidate, protocol := selectedLocalCandidate(p.pc)
		if candidate != webrtc.ICECandidateTypeRelay || protocol != "tls" {
			t.Fatalf("%s selected a %s candidate over %q, want relay over tls", name, candidate, protocol)
		}
	}
	// The sender writes 50 packets/s; ten seconds should deliver most of 500.
	if got := subscriber.received.Load(); got < 400 {
		t.Fatalf("subscriber received %d packets in about 10 s, want at least 400", got)
	}
	t.Logf("relay over TLS on TCP 443: first media %v after the answer, %d packets received", firstMedia.Round(time.Millisecond), subscriber.received.Load())
}

// tcp443TURN keeps only the TURN servers reached over TLS on TCP 443.
func tcp443TURN(t *testing.T, path string) []webrtc.ICEServer {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		ICEServers []mediaplane.ICEServer `json:"iceServers"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	var servers []webrtc.ICEServer
	for _, server := range decoded.ICEServers {
		for _, u := range server.URLs {
			if strings.HasPrefix(u, "turns:") && strings.Contains(u, ":443") {
				servers = append(servers, webrtc.ICEServer{URLs: []string{u}, Username: server.Username, Credential: server.Credential})
			}
		}
	}
	if len(servers) == 0 {
		t.Fatal("no TURN server over TLS on TCP 443")
	}
	return servers
}

// relayPeer may gather only relay candidates, so all media crosses TURN.
func relayPeer(t *testing.T, servers []webrtc.ICEServer) *peer {
	t.Helper()
	engine := &webrtc.MediaEngine{}
	if err := engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewAPI(webrtc.WithMediaEngine(engine)).NewPeerConnection(webrtc.Configuration{
		ICEServers: servers, ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	})
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{pc: pc}
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := remote.ReadRTP(); err != nil {
				return
			}
			p.received.Add(1)
		}
	})
	t.Cleanup(func() { _ = pc.Close() })
	return p
}

func selectedLocalCandidate(pc *webrtc.PeerConnection) (webrtc.ICECandidateType, string) {
	stats := pc.GetStats()
	for _, stat := range stats {
		pair, ok := stat.(webrtc.ICECandidatePairStats)
		if !ok || !pair.Nominated || pair.State != webrtc.StatsICECandidatePairStateSucceeded {
			continue
		}
		if local, ok := stats[pair.LocalCandidateID].(webrtc.ICECandidateStats); ok {
			return local.CandidateType, local.RelayProtocol
		}
	}
	return webrtc.ICECandidateTypeUnknown, ""
}
