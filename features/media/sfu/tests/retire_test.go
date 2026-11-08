package tests

import (
	"net/http"
	"testing"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func allocationOf(g int64) *int64 { return &g }

// POST /v1/episodes/retire ends the Episode's sessions below a binding generation and refuses
// every later create, capture and source grant under one, with the stale-generation error. A
// caller that names no generation is unaffected, and a repeat changes nothing.
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

	// The floor and callers that name no generation still join.
	svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "floor", Scope: scope("floor"), AllocationGeneration: allocationOf(2)}, &created)
	svc.mustCall(t, "/v1/sessions", protocol.CreateSessionRequest{OperationID: "older-caller", Scope: scope("older"), AllocationGeneration: nil}, &created)
	grant.AllocationGeneration = allocationOf(2)
	svc.mustCall(t, "/v1/episodes/sources", grant, nil)

	if status, _ := svc.call(t, "/v1/episodes/retire", protocol.RetireEpisodeRequest{TenantID: "tenant-1", EpisodeID: "episode-r", Generation: 0}, nil); status != http.StatusBadRequest {
		t.Fatalf("retire at generation 0: status %d, want 400", status)
	}
}
