package tests

import (
	"net/http"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func allocationOf(g int64) *int64 { return &g }

// POST /v1/episodes/retire ends the Episode's sessions below a binding generation and refuses
// every later create, capture and source grant under one, with the stale-generation error. A
// caller that names no generation counts as generation 0, and a repeat changes nothing.
func TestRetireEpisodeOverHTTP(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca)
	scope := func(participant string) protocol.Scope {
		return protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-r", ParticipantID: participant, Generation: 1}
	}
	var created protocol.CreateSessionResponse
	svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "old", Scope: scope("old"), AllocationGeneration: allocationOf(1)}, &created)
	svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "unnamed", Scope: scope("unnamed")}, &created)
	if sessions := svc.sessions(t); sessions != 2 {
		t.Fatalf("%d sessions before the retire, want 2", sessions)
	}

	var retired protocol.RetireEpisodeResponse
	svc.mustCall(t, "/v1/episodes/retire", protocol.RetireEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-r", Generation: 2}, &retired)
	if retired.Closed != 2 || retired.Floor != 2 || svc.sessions(t) != 0 {
		t.Fatalf("retire at 2: %+v, %d sessions left, want both closed at floor 2", retired, svc.sessions(t))
	}
	var again protocol.RetireEpisodeResponse
	svc.mustCall(t, "/v1/episodes/retire", protocol.RetireEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-r", Generation: 2}, &again)
	if again.Closed != 0 || again.Floor != 2 {
		t.Fatalf("a repeated retire: %+v, want nothing closed at floor 2", again)
	}

	for name, request := range map[string]protocol.CreateSessionRequest{
		"participant": {OperationID: "late", Scope: scope("late"), AllocationGeneration: allocationOf(1)},
		"capture":     {OperationID: "late-capture", Scope: scope("recorder"), Kind: protocol.SessionKindCapture, AllocationGeneration: allocationOf(1)},
		"replay":      {OperationID: "old", Scope: scope("old"), AllocationGeneration: allocationOf(1)},
	} {
		if status, code := svc.call(t, "/v1/sessions", request, nil); status != http.StatusConflict || code != protocol.CodeStaleGeneration {
			t.Fatalf("%s under generation 1: status %d code %q, want 409 %s", name, status, code, protocol.CodeStaleGeneration)
		}
	}
	grant := protocol.SourceControlRequest{
		TenantID: "tenant-1", EpisodeID: "episode-r", AllocationGeneration: allocationOf(1),
		Controls: []protocol.SourceControl{{ParticipantID: "old", Source: "microphone", Action: protocol.SourceGrant, Revision: 1}},
	}
	if status, code := svc.call(t, "/v1/episodes/sources", grant, nil); status != http.StatusConflict || code != protocol.CodeStaleGeneration {
		t.Fatalf("a source grant under generation 1: status %d code %q, want 409 %s", status, code, protocol.CodeStaleGeneration)
	}

	// A caller that names no generation counts as generation 0, so it is refused too.
	if status, code := svc.call(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "older-caller", Scope: scope("older")}, nil); status != http.StatusConflict || code != protocol.CodeStaleGeneration {
		t.Fatalf("a join that names no generation: status %d code %q, want 409 %s", status, code, protocol.CodeStaleGeneration)
	}
	// The floor still joins.
	svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "floor", Scope: scope("floor"), AllocationGeneration: allocationOf(2)}, &created)
	grant.AllocationGeneration = allocationOf(2)
	svc.mustCall(t, "/v1/episodes/sources", grant, nil)

	if status, _ := svc.call(t, "/v1/episodes/retire", protocol.RetireEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-r", Generation: 0}, nil); status != http.StatusBadRequest {
		t.Fatalf("retire at generation 0: status %d, want 400", status)
	}
}

// An Episode that returns to a node's same boot reserves there while its sessions from the earlier
// allocation are still open. Those sessions belong to the allocation that is being retired, so they
// must not settle the new hold: after the retire the hold still keeps the Episode's room, and no
// other Episode can take it before the Participants rejoin under the new allocation.
func TestAHoldSurvivesTheRetireOfTheSessionsOfAnEarlierAllocation(t *testing.T) {
	ca := newAuthority(t, "chalk test CA")
	svc := startService(t, ca, func(cfg *config.Config) { cfg.PacketBudget = threePersonPackets + 1000 })
	scope := func(participant string) protocol.Scope {
		return protocol.Scope{TenantID: "tenant-1", EpisodeID: "episode-a", ParticipantID: participant, Generation: 1}
	}
	participants := []string{"alice", "bob", "carol"}
	for _, participant := range participants {
		svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "old-" + participant, Scope: scope(participant), AllocationGeneration: allocationOf(1)}, nil)
	}

	reserve := reserveBody("reserve-a", "episode-a", 0)
	reserve.AllocationGeneration = allocationOf(3)
	svc.mustCall(t, "/v1/episodes/reserve", reserve, nil)
	var retired protocol.RetireEpisodeResponse
	svc.mustCall(t, "/v1/episodes/retire", protocol.RetireEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-a", Generation: 3}, &retired)
	if retired.Closed != len(participants) || svc.sessions(t) != 0 {
		t.Fatalf("retire at 3 closed %d, %d sessions left, want all %d closed", retired.Closed, svc.sessions(t), len(participants))
	}

	if reserved := svc.readiness(t).ReservedPackets; reserved != threePersonPackets {
		t.Fatalf("after the retire the node reserves %d, want the Episode's %d: the old sessions settled its hold", reserved, threePersonPackets)
	}
	if status, code := svc.call(t, "/v1/episodes/reserve", reserveBody("reserve-b", "episode-b", 0), nil); status != http.StatusTooManyRequests || code != protocol.CodeCapacityExceeded {
		t.Fatalf("another Episode took the recovering Episode's room: status %d code %q, want 429 capacity_exceeded", status, code)
	}

	for _, participant := range participants {
		svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "new-" + participant, Scope: scope(participant), AllocationGeneration: allocationOf(3)}, nil)
	}
	if sessions := svc.sessions(t); sessions != len(participants) {
		t.Fatalf("%d sessions after the rejoin, want %d", sessions, len(participants))
	}
}
