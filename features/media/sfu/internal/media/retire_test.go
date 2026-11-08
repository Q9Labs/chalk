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

// A caller that names no generation counts as generation 0 once the Episode has a floor, so the
// previous release's join cannot reopen a retired allocation. Before any retire it is admitted.
func TestRetireRefusesCallersThatNameNoGenerationOnceThereIsAFloor(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.CreateSessionAt("before", scopeOf("one", "before"), nil); err != nil {
		t.Fatalf("a create that names no generation before any retire: %v", err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("one", 5)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.CreateSessionAt("older-api", scopeOf("one", "p"), nil); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create that names no generation after a retire: %v, want stale generation", err)
	}
	if _, err := f.node.CreateCaptureSessionAt("capture", scopeOf("one", "capture"), nil); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a capture that names no generation after a retire: %v, want stale generation", err)
	}
	controls := protocol.SourceControlRequest{TenantID: "tenant", EpisodeID: "one", Controls: []protocol.SourceControl{{ParticipantID: "p", Source: "microphone", Action: protocol.SourceGrant, Revision: 1}}}
	if _, err := f.node.ControlSources(controls); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a source grant that names no generation after a retire: %v, want stale generation", err)
	}
	if _, err := f.node.CreateSessionAt("other", scopeOf("two", "p"), nil); err != nil {
		t.Fatalf("an Episode without a floor: %v", err)
	}
}

func TestRetireExpiresAfterItsTTL(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.RetireEpisode(retireRequest("one", 2)); err != nil {
		t.Fatal(err)
	}
	later := f.clock.Load().Add(retiredTTL + time.Minute)
	f.clock.Store(&later)
	if _, err := f.node.CreateSessionAt("after", scopeOf("one", "p"), generation(1)); err != nil {
		t.Fatalf("a create after the retirement expired: %v", err)
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
	if _, err := f.node.CreateSessionAt("hosted", scopeOf("hosted", "p"), generation(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("first", 1)); err != nil {
		t.Fatal(err)
	}
	retireMany(t, f, retiredLimit-1)

	if _, err := f.node.CreateSessionAt("late", scopeOf("first", "late"), generation(0)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create under generation 0 after %d other retirements: %v, want stale generation", retiredLimit, err)
	}
	if _, err := f.node.RetireEpisode(retireRequest("overflow", 2)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a retire of a new Episode on a full table: %v, want capacity exceeded", err)
	}
	f.node.mu.Lock()
	known, queued := len(f.node.retired), len(f.node.retiredOrder)
	f.node.mu.Unlock()
	if known != retiredLimit || queued != known {
		t.Fatalf("%d floors and %d queued, want equal and %d", known, queued, retiredLimit)
	}
	if reason := f.node.Host().AdmissionReason; reason != reasonRetirementsFull {
		t.Fatalf("admission reason %q, want %q", reason, reasonRetirementsFull)
	}
	if telemetry := f.node.Telemetry(); telemetry.Health.AdmissionReason != reasonRetirementsFull || telemetry.Refusals[RefusedRetirements] == 0 {
		t.Fatalf("telemetry admission %q and %d retirement refusals, want the reason and a count", telemetry.Health.AdmissionReason, telemetry.Refusals[RefusedRetirements])
	}

	// An Episode with no floor that the node does not host is refused, with or without a generation.
	for name, allocation := range map[string]*int64{"named": generation(1), "unnamed": nil} {
		if _, err := f.node.CreateSessionAt("new-"+name, scopeOf("new-"+name, "p"), allocation); !errors.Is(err, ErrCapacityExceeded) {
			t.Fatalf("a %s create for a new Episode on a full table: %v, want capacity exceeded", name, err)
		}
	}
	// A hosted Episode keeps taking callers that name a generation, and not the ones that do not.
	if _, err := f.node.CreateSessionAt("hosted-2", scopeOf("hosted", "q"), generation(1)); err != nil {
		t.Fatalf("a named join of a hosted Episode on a full table: %v", err)
	}
	if _, err := f.node.CreateSessionAt("hosted-3", scopeOf("hosted", "r"), nil); !errors.Is(err, ErrCapacityExceeded) {
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
	if _, err := f.node.CreateCaptureSessionAt("old-capture", scopeOf("one", "capture"), generation(1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a capture under generation 1 after a reserve for 2: %v, want stale generation", err)
	}
	if _, err := f.node.CreateSessionAt("old-join", scopeOf("one", "p"), nil); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a join that names no generation after a reserve for 2: %v, want stale generation", err)
	}
	if _, err := f.node.CreateSessionAt("new-join", scopeOf("one", "p"), generation(2)); err != nil {
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
