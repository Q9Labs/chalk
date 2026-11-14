package tests

import (
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// TestLiveSmoke sends real audio and video through a deployed node and checks a second
// participant receives it, then ends the Episode and checks the node returns to the state it
// started in. It is the live media smoke the production canary requires before production serves
// Chalk SFU calls (docs/sfu/production-rollout.md); TestLoopback does not count, because it starts its
// own service. It skips unless scripts/live-smoke sets the environment:
//
//	CHALK_SFU_LIVE_ENV      staging or production
//	CHALK_SFU_LIVE_CONFIRM  the same word again, so a stray variable never reaches a node
//	CHALK_SFU_LIVE_URL      the control API, reached through the SSH tunnel
//	CHALK_SFU_LIVE_DIR      the directory holding ca.crt, operator.crt and operator.key
//	CHALK_SFU_LIVE_SECONDS  how long media flows between the two samples (default 6)
//
// Staging runs must hold the staging lease (scripts/staging-sfu/staging-lock).
func TestLiveSmoke(t *testing.T) {
	svc := liveNode(t)
	seconds := 6
	if raw := os.Getenv("CHALK_SFU_LIVE_SECONDS"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 3 || parsed > 120 {
			t.Fatalf("CHALK_SFU_LIVE_SECONDS must be 3 to 120")
		}
		seconds = parsed
	}
	runLiveSmoke(t, svc, time.Duration(seconds)*time.Second)
}

// liveNode is the gate every test that touches a deployed node passes first. It skips unless
// the wrapper set the environment and refuses unless the confirmation repeats it.
func liveNode(t *testing.T) *service {
	t.Helper()
	environment := os.Getenv("CHALK_SFU_LIVE_ENV")
	if environment == "" {
		t.Skip("CHALK_SFU_LIVE_ENV is not set; run features/media/sfu/scripts/live-smoke")
	}
	if environment != "staging" && environment != "production" {
		t.Fatalf("CHALK_SFU_LIVE_ENV must be staging or production")
	}
	if os.Getenv("CHALK_SFU_LIVE_CONFIRM") != environment {
		t.Fatalf("CHALK_SFU_LIVE_CONFIRM must repeat the environment before this test touches a node")
	}
	svc := &service{baseURL: os.Getenv("CHALK_SFU_LIVE_URL"), client: operatorClient(t, os.Getenv("CHALK_SFU_LIVE_DIR"))}
	if svc.baseURL == "" {
		t.Fatal("CHALK_SFU_LIVE_URL is not set")
	}
	return svc
}

// TestLiveSmokeScenario runs the same smoke against an in-process service, so the scenario
// and its cleanup checks stay correct without a node.
func TestLiveSmokeScenario(t *testing.T) {
	runLiveSmoke(t, startService(t, newAuthority(t, "chalk test CA")), 3*time.Second)
}

// operatorClient trusts the node's service CA and presents the operator certificate that
// infrastructure/sfu/certs issues. The node's certificate names chalk-sfu, not the tunnel address.
func operatorClient(t *testing.T, dir string) *http.Client {
	t.Helper()
	caPEM, err := os.ReadFile(filepath.Join(dir, "ca.crt"))
	if err != nil {
		t.Fatalf("read the service CA: %v", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		t.Fatal("the service CA holds no certificate")
	}
	pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "operator.crt"), filepath.Join(dir, "operator.key"))
	if err != nil {
		t.Fatalf("load the operator certificate: %v", err)
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool, Certificates: []tls.Certificate{pair}, ServerName: "chalk-sfu"}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 20 * time.Second}
}

// readyOK reads /readyz and fails unless the node answers 200.
func (s *service) readyOK(t *testing.T) protocol.ReadyResponse {
	t.Helper()
	status, ready := s.ready(t)
	if status != http.StatusOK {
		t.Fatalf("readyz answered status %d", status)
	}
	return ready
}

// liveEvidence is what a run measured, logged on every run, pass or fail, so the allowance for
// late packets can be tightened from data. A field the run never reached stays at -1.
type liveEvidence struct {
	revision                       string
	audioGain, videoGain           int
	audioLate, videoLate           int
	audioPackets, videoPackets     int
	sessions, allocations, cleanup int
}

func (e liveEvidence) log(t *testing.T, duration time.Duration) {
	t.Helper()
	t.Logf("live smoke: node revision %s, window %s, audio +%d (%d of %d late or repeated), video +%d (%d of %d late or repeated), sessions %d, allocations %d, cleanup debt %d",
		e.revision, duration, e.audioGain, e.audioLate, e.audioPackets, e.videoGain, e.videoLate, e.videoPackets, e.sessions, e.allocations, e.cleanup)
}

// lateBudgetPercent is the share of packets that may arrive late or repeated.
const lateBudgetPercent = 10

// runLiveSmoke is the whole smoke. It uses one random Tenant and Episode, ends that Episode
// whatever happens, and fails if the node does not return to the load it had before.
func runLiveSmoke(t *testing.T, svc *service, duration time.Duration) {
	t.Helper()
	evidence := liveEvidence{revision: "unread", audioGain: -1, videoGain: -1, audioLate: -1, videoLate: -1, audioPackets: -1, videoPackets: -1, sessions: -1, allocations: -1, cleanup: -1}
	defer func() { evidence.log(t, duration) }()
	before := svc.readyOK(t)
	evidence.revision = before.Revision
	if before.Protocol != protocol.WireProtocol {
		t.Fatalf("node speaks protocol %d, this build speaks %d", before.Protocol, protocol.WireProtocol)
	}
	if before.Draining {
		t.Fatal("the node is draining and refuses new Episodes")
	}

	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	id := "live-smoke-" + hex.EncodeToString(suffix[:])
	alice := protocol.Scope{TenantID: id, EpisodeID: id, ParticipantID: "alice", Generation: 1}
	bob := protocol.Scope{TenantID: id, EpisodeID: id, ParticipantID: "bob", Generation: 1}
	var ended bool
	endEpisode := func() {
		if ended {
			return
		}
		ended = true
		var response protocol.EndEpisodeResponse
		svc.mustCall(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: id, EpisodeID: id}, &response)
	}
	defer endEpisode()

	revision := int64(1)
	svc.grantSourcesAt(t, revision, alice, bob)
	connA := svc.createSession(t, "create-"+id+"-alice", alice)
	connB := svc.createSession(t, "create-"+id+"-bob", bob)
	published := publishKnownMedia(t, svc, connA, alice)
	defer published.stop()
	_, received := subscribeKnownMedia(t, svc, connB, bob, connA)

	const arrived = 30
	eventually(t, fmt.Sprintf("%d audio and %d video packets at the subscriber", arrived, arrived), 20*time.Second, func() bool {
		return received.count(webrtc.RTPCodecTypeAudio) >= arrived && received.count(webrtc.RTPCodecTypeVideo) >= arrived
	})
	audioStart, videoStart := received.count(webrtc.RTPCodecTypeAudio), received.count(webrtc.RTPCodecTypeVideo)

	// Media keeps flowing for the whole window. Each renewal is a newer revision, so a short
	// source lease never ends the publication under the test.
	deadline := time.Now().Add(duration)
	for time.Now().Before(deadline) {
		time.Sleep(time.Second)
		revision++
		svc.grantSourcesAt(t, revision, alice, bob)
	}
	audioEnd, videoEnd := received.count(webrtc.RTPCodecTypeAudio), received.count(webrtc.RTPCodecTypeVideo)
	evidence.audioGain, evidence.videoGain = audioEnd-audioStart, videoEnd-videoStart
	// The sender writes 100 packets a second per kind; a fifth of that over the window is far
	// above what a stalled forwarder delivers and far below what ordinary loss costs.
	floor := int(duration.Seconds()) * 20
	if evidence.audioGain < floor || evidence.videoGain < floor {
		t.Fatalf("media did not keep advancing: audio %d to %d, video %d to %d, want at least %d more of each", audioStart, audioEnd, videoStart, videoEnd, floor)
	}
	// The internet reorders UDP and the subscriber NACKs, so some packets arrive late or twice;
	// a changed payload or sequence number is not allowed.
	audioPackets, videoPackets := received.snapshot(webrtc.RTPCodecTypeAudio), received.snapshot(webrtc.RTPCodecTypeVideo)
	evidence.audioPackets, evidence.videoPackets = len(audioPackets), len(videoPackets)
	evidence.audioLate = countLate(t, "audio", audioPackets, 'a')
	evidence.videoLate = countLate(t, "video", videoPackets, 'v')
	if evidence.audioLate*100 > lateBudgetPercent*evidence.audioPackets || evidence.videoLate*100 > lateBudgetPercent*evidence.videoPackets {
		t.Fatalf("more than %d%% of packets arrived late or repeated", lateBudgetPercent)
	}
	if audioSent, videoSent := published.audioSent.Load(), published.videoSent.Load(); audioSent == 0 || videoSent == 0 {
		t.Fatalf("the publisher sent audio %d and video %d packets", audioSent, videoSent)
	}
	for _, track := range svc.inspect(t, connA, alice) {
		if !track.Active {
			t.Fatalf("published track %s is not active", track.TrackName)
		}
	}

	published.stop()
	endEpisode()
	var after protocol.ReadyResponse
	eventually(t, "the node to return to its load from before the smoke", 30*time.Second, func() bool {
		after = svc.readyOK(t)
		evidence.sessions, evidence.allocations, evidence.cleanup = after.Sessions, after.Allocations, after.CleanupDebt
		return after.Sessions == before.Sessions && after.Allocations == before.Allocations && after.CleanupDebt == before.CleanupDebt
	})
	if after.Draining || after.Protocol != protocol.WireProtocol {
		t.Fatalf("the node is not ready after the smoke: draining %v, protocol %d", after.Draining, after.Protocol)
	}
	if status, code := svc.call(t, "/v1/sessions/"+connA+"/inspect", protocol.InspectRequest{Scope: alice}, nil); status != http.StatusNotFound || code != protocol.CodeSessionGone {
		t.Fatalf("the publisher's session survived the end of its Episode: status %d code %q", status, code)
	}
}
