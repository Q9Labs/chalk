package media

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
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
	if _, err := f.node.Create("old", scopeOf("one", "old"), ParticipantSession, generation(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.Create("new", scopeOf("one", "new"), ParticipantSession, generation(2)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.Create("unnamed", scopeOf("one", "unnamed"), ParticipantSession, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.Create("other", scopeOf("two", "other"), ParticipantSession, generation(1)); err != nil {
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

// retireMany records floors for n Episodes at generation 2.
func retireMany(t *testing.T, f *reserveFixture, count int) {
	t.Helper()
	for index := range count {
		if _, err := f.node.RetireEpisode(retireRequest(fmt.Sprintf("episode-%d", index), 2)); err != nil {
			t.Fatal(err)
		}
	}
}

// A full table never drops a floor to make room. The Episode whose floor was recorded first stays
// protected after the limit is passed, and the node falls back to conservative admission.
func TestAFullTableOfFloorsNeverForgetsOneAndClosesAdmission(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.Create("hosted", scopeOf("hosted", "p"), ParticipantSession, generation(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("first", 1)); err != nil {
		t.Fatal(err)
	}
	retireMany(t, f, retiredLimit-1)

	if _, err := f.node.Create("late", scopeOf("first", "late"), ParticipantSession, generation(0)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create under generation 0 after %d other retirements: %v, want stale generation", retiredLimit, err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("overflow", 2)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a retire of a new Episode on a full table: %v, want capacity exceeded", err)
	}
	f.node.mu.Lock()
	known := f.node.retired.Len()
	f.node.mu.Unlock()
	if known != retiredLimit {
		t.Fatalf("%d floors, want %d", known, retiredLimit)
	}
	if reason := f.node.Host().AdmissionReason; reason != reasonRetirementsFull {
		t.Fatalf("admission reason %q, want %q", reason, reasonRetirementsFull)
	}
	if telemetry := f.node.Telemetry(); telemetry.Health.AdmissionReason != reasonRetirementsFull || telemetry.Refusals[RefusedRetirements] == 0 {
		t.Fatalf("telemetry admission %q and %d retirement refusals, want the reason and a count", telemetry.Health.AdmissionReason, telemetry.Refusals[RefusedRetirements])
	}

	// An Episode with no floor that the node does not host is refused, with or without a generation.
	for name, allocation := range map[string]*int64{"named": generation(1), "unnamed": nil} {
		if _, err := f.node.Create("new-"+name, scopeOf("new-"+name, "p"), ParticipantSession, allocation); !errors.Is(err, ErrCapacityExceeded) {
			t.Fatalf("a %s create for a new Episode on a full table: %v, want capacity exceeded", name, err)
		}
	}
	// A hosted Episode keeps taking callers that name a generation, and not the ones that do not.
	if _, err := f.node.Create("hosted-2", scopeOf("hosted", "q"), ParticipantSession, generation(1)); err != nil {
		t.Fatalf("a named join of a hosted Episode on a full table: %v", err)
	}
	if _, err := f.node.Create("hosted-3", scopeOf("hosted", "r"), ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("an unnamed join of a hosted Episode on a full table: %v, want capacity exceeded", err)
	}
	// A floor that expires makes room again.
	later := f.clock.Load().Add(retiredTTL + time.Minute)
	f.clock.Store(&later)
	if reason := f.node.Host().AdmissionReason; reason != "" {
		t.Fatalf("admission reason %q after every floor expired, want none", reason)
	}
}

// A reserve names the generation its move commits and installs it as the Episode's floor, so a node
// that restarted and lost its floors still refuses the generations the Episode left.
func TestAReserveInstallsTheFloorOfTheGenerationItCommits(t *testing.T) {
	f := newReserveNode(t)
	request := protocol.ReserveEpisodeRequest{
		OperationID: "reserve-1", TenantID: "tenant", EpisodeID: "one", Generation: 1,
		Shape: protocol.EpisodeShape{Participants: 1}, AllocationGeneration: generation(2),
	}
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.Create("old-capture", scopeOf("one", "capture"), CaptureSession, generation(1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a capture under generation 1 after a reserve for 2: %v, want stale generation", err)
	}
	if _, err := f.node.Create("old-join", scopeOf("one", "p"), ParticipantSession, nil); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a join that names no generation after a reserve for 2: %v, want stale generation", err)
	}
	if _, err := f.node.Create("new-join", scopeOf("one", "p"), ParticipantSession, generation(2)); err != nil {
		t.Fatalf("a join under the reserved generation: %v", err)
	}
	older := request
	older.OperationID, older.AllocationGeneration = "reserve-0", generation(1)
	if _, err := f.node.ReserveEpisode(older); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a reserve for generation 1 below the floor: %v, want stale generation", err)
	}
}

// A grant made under an older allocation does not outlive the retire, and does not authorize a
// publication under a newer allocation even when the retire never reached the node.
func TestRetireLapsesSourceLeasesBelowTheFloor(t *testing.T) {
	f := newReserveNode(t, func(c *config.Config) { c.SourceLeaseTTL = time.Hour })
	leases := func() int {
		f.node.mu.Lock()
		defer f.node.mu.Unlock()
		return f.node.sourceLeases()
	}
	grant := func(allocation int64, revision int64) error {
		_, err := f.node.ControlSources(protocol.SourceControlRequest{
			TenantID: "tenant", EpisodeID: "one", AllocationGeneration: generation(allocation),
			Controls: []protocol.SourceControl{{ParticipantID: "p", Source: "microphone", Action: protocol.SourceGrant, Revision: revision}},
		})
		return err
	}
	if err := grant(1, 1); err != nil {
		t.Fatal(err)
	}
	if count := leases(); count != 1 {
		t.Fatalf("%d leases after a grant, want 1", count)
	}
	if _, err := f.node.RetireEpisode(retireRequest("one", 2)); err != nil {
		t.Fatal(err)
	}
	if count := leases(); count != 0 {
		t.Fatalf("%d leases after the retire, want the lease lapsed", count)
	}
	if err := grant(1, 1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a renewal under generation 1 after the retire: %v, want stale generation", err)
	}
	if err := grant(2, 1); err != nil {
		t.Fatalf("a grant under the floor: %v", err)
	}
	if count := leases(); count != 1 {
		t.Fatalf("%d leases after a fresh grant, want 1", count)
	}

	// Without any retire: the lease a publication under a newer generation finds lapses.
	if err := grant(3, 2); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := f.node.authorityFor(scopeOf("one", "p"), 4, "microphone"); err != nil {
		t.Fatal(err)
	}
	if count := leases(); count != 0 {
		t.Fatalf("%d leases after a publication under generation 4, want the older grant lapsed", count)
	}
	if _, _, _, err := f.node.authorityFor(scopeOf("one", "p"), 0, "microphone"); err != nil {
		t.Fatal(err)
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
