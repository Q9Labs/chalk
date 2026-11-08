package media

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func generation(g int64) *int64 { return &g }

func retireRequest(episode string, floor int64) protocol.RetireEpisodeRequest {
	return protocol.RetireEpisodeRequest{TenantID: "tenant", EpisodeID: episode, Generation: floor}
}

func scopeOf(episode, participant string) protocol.Scope {
	return protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: participant, Generation: 1}
}

func TestRetireEndsTheSessionsBelowTheFloorAndSparesTheRest(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.CreateSessionAt("old", scopeOf("one", "old"), generation(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("new", scopeOf("one", "new"), generation(2)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("unnamed", scopeOf("one", "unnamed"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("other", scopeOf("two", "other"), generation(1)); err != nil {
		t.Fatal(err)
	}
	response, err := f.node.RetireEpisode(retireRequest("one", 2))
	if err != nil {
		t.Fatal(err)
	}
	if response.Closed != 2 || response.Floor != 2 {
		t.Fatalf("retire at 2 closed %d at floor %d, want 2 at 2 (generation 1 and the unnamed one)", response.Closed, response.Floor)
	}
	if count := f.node.SessionCount(); count != 2 {
		t.Fatalf("%d sessions live, want the generation 2 session and the other Episode's", count)
	}
}

func TestRetireRefusesALowerGenerationAfterwardsAndAdmitsTheFloor(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.RetireEpisode(retireRequest("one", 2)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("late", scopeOf("one", "late"), generation(1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create under generation 1 after retire at 2: %v, want stale generation", err)
	}
	if _, err := f.node.CreateCaptureSessionAt("capture", scopeOf("one", "capture"), generation(1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a capture under generation 1 after retire at 2: %v, want stale generation", err)
	}
	controls := protocol.SourceControlRequest{
		TenantID: "tenant", EpisodeID: "one", AllocationGeneration: generation(1),
		Controls: []protocol.SourceControl{{ParticipantID: "late", Source: "microphone", Action: protocol.SourceGrant, Revision: 1}},
	}
	if _, err := f.node.ControlSources(controls); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a source grant under generation 1 after retire at 2: %v, want stale generation", err)
	}
	if _, err := f.node.CreateSessionAt("floor", scopeOf("one", "floor"), generation(2)); err != nil {
		t.Fatalf("a create at the floor: %v", err)
	}
	controls.AllocationGeneration = generation(2)
	if _, err := f.node.ControlSources(controls); err != nil {
		t.Fatalf("a source grant at the floor: %v", err)
	}
}

func TestRetireRefusesAReplayOfAnEarlierCreate(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.CreateSessionAt("join", scopeOf("one", "p"), generation(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("one", 2)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("join", scopeOf("one", "p"), generation(1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a replay of a create the retire closed: %v, want stale generation", err)
	}
}

func TestRetireIsIdempotentAndNeverLowersTheFloor(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.CreateSessionAt("old", scopeOf("one", "old"), generation(1)); err != nil {
		t.Fatal(err)
	}
	first, err := f.node.RetireEpisode(retireRequest("one", 3))
	if err != nil || first.Closed != 1 || first.Floor != 3 {
		t.Fatalf("first retire: %+v, %v; want 1 closed at floor 3", first, err)
	}
	again, err := f.node.RetireEpisode(retireRequest("one", 3))
	if err != nil || again.Closed != 0 || again.Floor != 3 {
		t.Fatalf("repeat retire: %+v, %v; want 0 closed at floor 3", again, err)
	}
	lower, err := f.node.RetireEpisode(retireRequest("one", 2))
	if err != nil || lower.Floor != 3 {
		t.Fatalf("lower retire: %+v, %v; want the floor to stay 3", lower, err)
	}
}

func TestRetireLeavesCallersThatNameNoGenerationAlone(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.RetireEpisode(retireRequest("one", 5)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("older-api", scopeOf("one", "p"), nil); err != nil {
		t.Fatalf("a create that names no generation after a retire: %v", err)
	}
}

func TestRetireExpiresAndStaysBounded(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.RetireEpisode(retireRequest("one", 2)); err != nil {
		t.Fatal(err)
	}
	later := f.clock.Load().Add(retiredTTL + time.Minute)
	f.clock.Store(&later)
	if _, err := f.node.CreateSessionAt("after", scopeOf("one", "p"), generation(1)); err != nil {
		t.Fatalf("a create after the retirement expired: %v", err)
	}
	for index := range retiredLimit + 10 {
		if _, err := f.node.RetireEpisode(retireRequest(fmt.Sprintf("episode-%d", index), 2)); err != nil {
			t.Fatal(err)
		}
	}
	f.node.mu.Lock()
	known, queued := len(f.node.retired), len(f.node.retiredOrder)
	f.node.mu.Unlock()
	if known > retiredLimit || queued != known {
		t.Fatalf("%d retirements and %d queued, want equal and at most %d", known, queued, retiredLimit)
	}
}

func TestRetireValidatesItsRequest(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.RetireEpisode(retireRequest("one", 0)); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("retire at generation 0: %v, want invalid request", err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("", 1)); err == nil {
		t.Fatal("retire without an Episode succeeded")
	}
}

func TestRetireAtALowerGenerationKeepsTheFloorOfAFullTable(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.RetireEpisode(retireRequest("oldest", 3)); err != nil {
		t.Fatal(err)
	}
	for index := range retiredLimit - 1 {
		if _, err := f.node.RetireEpisode(retireRequest(fmt.Sprintf("episode-%d", index), 2)); err != nil {
			t.Fatal(err)
		}
	}
	// The table is full and the oldest Episode is next to go. A retry for it only gains time.
	response, err := f.node.RetireEpisode(retireRequest("oldest", 1))
	if err != nil || response.Floor != 3 {
		t.Fatalf("a lower retry on a full table: %+v, %v; want the floor to stay 3", response, err)
	}
	if _, err := f.node.CreateSessionAt("late", scopeOf("oldest", "late"), generation(2)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create under generation 2 after the lower retry: %v, want stale generation", err)
	}
	f.node.mu.Lock()
	known, queued := len(f.node.retired), len(f.node.retiredOrder)
	f.node.mu.Unlock()
	if known != retiredLimit || queued != known {
		t.Fatalf("%d retirements and %d queued, want equal and %d", known, queued, retiredLimit)
	}
}
