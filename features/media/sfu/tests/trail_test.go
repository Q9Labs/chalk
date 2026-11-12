package tests

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

const (
	trailTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	trailTraceID     = "0af7651916cd43dd8448eb211c80319c"
	trailJourney     = "4d0d1c2e-6f2a-4a6b-9b6e-5c1f0f7d9a11"
)

// postTraced sends one control request with the trace headers the API sends and returns its status.
func (s *service) postTraced(t *testing.T, path string, body, out any) int {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, s.baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("traceparent", trailTraceparent)
	request.Header.Set("X-Chalk-Journey-ID", trailJourney)
	response, err := s.client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if out != nil && response.StatusCode < 300 && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s: %v", path, err)
		}
	}
	return response.StatusCode
}

// breakOneParticipant runs a call of two healthy Participants and a third whose offer is garbage,
// so the SFU closes her session. It returns the Episode id and the time window of the run.
func breakOneParticipant(t *testing.T, svc *service) (episode string, from, to time.Time) {
	t.Helper()
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	episode = "trail-proof-" + hex.EncodeToString(suffix[:])
	scope := func(participant string) protocol.Scope {
		return protocol.Scope{TenantID: episode, EpisodeID: episode, ParticipantID: participant, Generation: 1}
	}
	alice, bob, carol := scope("alice"), scope("bob"), scope("carol")
	from = time.Now().Add(-5 * time.Second)
	defer func() {
		svc.mustCall(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: episode, EpisodeID: episode}, &protocol.EndEpisodeResponse{})
		to = time.Now().Add(5 * time.Second)
	}()

	svc.grantSourcesAt(t, 1, alice, bob, carol)
	var created protocol.CreateSessionResponse
	connA := svc.createSession(t, "create-"+episode+"-alice", alice)
	connB := svc.createSession(t, "create-"+episode+"-bob", bob)
	if status := svc.postTraced(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "create-" + episode + "-carol", Scope: carol}, &created); status != http.StatusOK {
		t.Fatalf("carol's create answered %d", status)
	}
	published := publishKnownMedia(t, svc, connA, alice)
	defer published.stop()
	_, received := subscribeKnownMedia(t, svc, connB, bob, connA)
	eventually(t, "media at bob", 20*time.Second, func() bool { return received.count(webrtc.RTPCodecTypeAudio) >= 30 })

	// Carol's client sends an offer that is not SDP. The SFU closes her session; Alice and Bob go on.
	status := svc.postTraced(t, "/v1/sessions/"+created.ConnectionID+"/tracks", protocol.TracksRequest{
		OperationID: "tracks-" + episode + "-carol", Scope: carol,
		SessionDescription: &protocol.SessionDescription{Type: "offer", SDP: "not sdp"},
		Tracks:             []protocol.Track{{Location: protocol.LocationLocal, Mid: "0", TrackName: "mic", Source: "microphone"}},
	}, nil)
	if status != http.StatusUnprocessableEntity {
		t.Fatalf("carol's garbage offer answered %d, want 422", status)
	}
	return episode, from, to
}

// TestLoopbackTrailExplainsABrokenParticipant runs the break against a real service with real
// HTTP and real Pion peers, and reads the account back from the service's own log.
func TestLoopbackTrailExplainsABrokenParticipant(t *testing.T) {
	svc := startService(t, newAuthority(t, "chalk test CA"))
	episode, _, _ := breakOneParticipant(t, svc)
	var lines []string
	for _, line := range strings.Split(svc.logs.String(), "\n") {
		if strings.Contains(line, "episode_id="+episode) {
			lines = append(lines, line)
		}
	}
	text := strings.Join(lines, "\n")
	for _, want := range []string{
		"event=sfu.session.registered", "participant_id=carol", "trace_id=" + trailTraceID, "journey_id=" + trailJourney,
		"event=sfu.publication.started", "event=sfu.subscription.started",
		"event=sfu.session.closed", "cause=negotiation_failed", "cause=episode_ended",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the trail for the Episode lacks %q\n%s", want, text)
		}
	}
	for _, line := range lines {
		for _, forbidden := range []string{"v=0", "a=ice", "a=fingerprint", "candidate:", "127.0.0.1"} {
			if strings.Contains(line, forbidden) {
				t.Errorf("a trail line holds %q: %s", forbidden, line)
			}
		}
	}
}

// TestLiveBrokenParticipant is the staging proof for the diagnosis trail. It needs the
// environment of TestLiveSmoke and prints the Episode id and window to query the log store with.
func TestLiveBrokenParticipant(t *testing.T) {
	svc := liveNode(t)
	episode, from, to := breakOneParticipant(t, svc)
	t.Logf("trail proof episode=%s from=%s to=%s", episode, from.UTC().Format(time.RFC3339), to.UTC().Format(time.RFC3339))
}
