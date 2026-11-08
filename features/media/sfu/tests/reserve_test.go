package tests

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// reserveBudget fits two three-person Episodes of the test costs (3,930 each) and not a third.
const (
	threePersonPackets = 3930
	reserveBudget      = 8000
)

func (s *service) ready(t *testing.T) protocol.ReadyResponse {
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
	return ready
}

func reserveBody(operation, episode string, ttlSeconds int) protocol.ReserveEpisodeRequest {
	return protocol.ReserveEpisodeRequest{
		OperationID: operation, TenantID: "tenant-1", EpisodeID: episode, Generation: 1, TTLSeconds: ttlSeconds,
		Shape: protocol.EpisodeShape{Participants: 3, CamerasPerParticipant: 2},
	}
}

// joinWithAudio joins the Participant with a real Pion peer that publishes a microphone.
func (s *service) joinWithAudio(t *testing.T, scope protocol.Scope) *peer {
	t.Helper()
	s.grantSources(t, scope)
	connection := s.createSession(t, "create-"+scope.EpisodeID+"-"+scope.ParticipantID, scope)
	p := newPeer(t)
	audio, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "mic", scope.ParticipantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.pc.AddTrack(audio); err != nil {
		t.Fatal(err)
	}
	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	description := p.complete(t, offer)
	var pushed protocol.TracksResponse
	s.mustCall(t, "/v1/sessions/"+connection+"/tracks", protocol.TracksRequest{
		OperationID: op(), Scope: scope, SessionDescription: &description,
		Tracks: []protocol.Track{{Location: protocol.LocationLocal, Mid: p.mid(t, audio), TrackName: scope.ParticipantID + "-mic", Source: "microphone"}},
	}, &pushed)
	if pushed.SessionDescription == nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("push by %s: %+v", scope.ParticipantID, pushed)
	}
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: pushed.SessionDescription.SDP}); err != nil {
		t.Fatal(err)
	}
	eventually(t, scope.ParticipantID+" connects", 10*time.Second, func() bool {
		return p.pc.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	return p
}

func TestEpisodeReserveHoldsRoomUntilParticipantsJoin(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) { cfg.PacketBudget = reserveBudget })

	var first protocol.ReserveEpisodeResponse
	svc.mustCall(t, "/v1/episodes/reserve", reserveBody("reserve-a", "episode-a", 0), &first)
	if first.ReservedPackets != threePersonPackets || first.ExpiresAt.IsZero() || first.NodeIncarnation == "" {
		t.Fatalf("reserve response: %+v", first)
	}
	if ready := svc.ready(t); ready.ReservedPackets != threePersonPackets || ready.Sessions != 0 {
		t.Fatalf("readiness reserves %d with %d sessions, want %d and none", ready.ReservedPackets, ready.Sessions, threePersonPackets)
	}

	var replay protocol.ReserveEpisodeResponse
	svc.mustCall(t, "/v1/episodes/reserve", reserveBody("reserve-a", "episode-a", 0), &replay)
	if replay != first {
		t.Fatalf("replay returned %+v, want %+v", replay, first)
	}
	conflicting := reserveBody("reserve-a", "episode-a", 0)
	conflicting.Shape.Participants = 4
	if status, code := svc.call(t, "/v1/episodes/reserve", conflicting, nil); status != http.StatusConflict || code != protocol.CodeOperationConflict {
		t.Fatalf("reused operation ID: status %d code %q, want 409 operation_conflict", status, code)
	}

	svc.mustCall(t, "/v1/episodes/reserve", reserveBody("reserve-b", "episode-b", 0), nil)
	if status, code := svc.call(t, "/v1/episodes/reserve", reserveBody("reserve-c", "episode-c", 0), nil); status != http.StatusTooManyRequests || code != protocol.CodeCapacityExceeded {
		t.Fatalf("a third Episode: status %d code %q, want 429 capacity_exceeded", status, code)
	}
	if reserved := svc.ready(t).ReservedPackets; reserved != 2*threePersonPackets {
		t.Fatalf("readiness reserves %d, want %d: a refused reserve changed the total", reserved, 2*threePersonPackets)
	}

	// Participants rejoin Episode A with real peers: their joins replace the hold.
	for _, participant := range []string{"alice", "bob", "carol"} {
		svc.joinWithAudio(t, protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-a", ParticipantID: participant, Generation: 1})
		if reserved := svc.ready(t).ReservedPackets; reserved != 2*threePersonPackets {
			t.Fatalf("after %s joined, readiness reserves %d, want %d", participant, reserved, 2*threePersonPackets)
		}
	}
	if sessions := svc.ready(t).Sessions; sessions != 3 {
		t.Fatalf("%d sessions, want 3", sessions)
	}

	// Ending Episode B releases its hold, which another Episode can take.
	svc.mustCall(t, "/v1/episodes/end", protocol.EndEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-b"}, nil)
	if reserved := svc.ready(t).ReservedPackets; reserved != threePersonPackets {
		t.Fatalf("after ending the held Episode readiness reserves %d, want %d", reserved, threePersonPackets)
	}
	svc.mustCall(t, "/v1/episodes/reserve", reserveBody("reserve-c", "episode-c", 0), nil)
}

func TestEpisodeReserveExpiryFreesCapacity(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) { cfg.PacketBudget = threePersonPackets + 1000 })

	svc.mustCall(t, "/v1/episodes/reserve", reserveBody("reserve-short", "episode-a", 1), nil)
	if status, code := svc.call(t, "/v1/episodes/reserve", reserveBody("reserve-second", "episode-b", 0), nil); status != http.StatusTooManyRequests || code != protocol.CodeCapacityExceeded {
		t.Fatalf("a second Episode while the first is held: status %d code %q, want 429 capacity_exceeded", status, code)
	}
	eventually(t, "the hold expires", 5*time.Second, func() bool { return svc.ready(t).ReservedPackets == 0 })
	svc.mustCall(t, "/v1/episodes/reserve", reserveBody("reserve-after", "episode-b", 0), nil)

	svc.mustCall(t, "/v1/drain", struct{}{}, nil)
	if status, code := svc.call(t, "/v1/episodes/reserve", reserveBody("reserve-draining", "episode-c", 0), nil); status != http.StatusServiceUnavailable || code != protocol.CodeDraining {
		t.Fatalf("reserve on a draining node: status %d code %q, want 503 draining", status, code)
	}
}
