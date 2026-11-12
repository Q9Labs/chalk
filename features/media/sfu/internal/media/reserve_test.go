package media

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

func TestReserveReplayAndConflict(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	first, err := f.node.ReserveEpisode(request)
	if err != nil {
		t.Fatal(err)
	}
	f.advance(time.Second)
	again, err := f.node.ReserveEpisode(request)
	if err != nil || again != first {
		t.Fatalf("replay returned %+v, %v, want %+v", again, err, first)
	}
	if f.reserved() != threePerson {
		t.Fatalf("a replay reserved %d, want %d", f.reserved(), threePerson)
	}
	changed := request
	changed.Shape.Participants = 4
	if _, err := f.node.ReserveEpisode(changed); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("reused operation ID with another shape: %v, want a conflict", err)
	}
	changed = request
	changed.EpisodeID = "two"
	if _, err := f.node.ReserveEpisode(changed); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("reused operation ID for another Episode: %v, want a conflict", err)
	}
}

func TestADrainingNodeRefusesReserve(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	f.node.Drain()
	if _, err := f.node.ReserveEpisode(reserveRequest("two", 3)); !errors.Is(err, ErrDraining) {
		t.Fatalf("reserve on a draining node: %v, want draining", err)
	}
	if _, err := f.node.ReserveEpisode(request); !errors.Is(err, ErrDraining) {
		t.Fatalf("replay on a draining node: %v, want draining", err)
	}
	// A hold made before the drain stays an allocation until it expires, so a restart waits for it.
	if allocations := f.node.DrainState().Allocations; allocations != 1 {
		t.Fatalf("%d allocations, want the one hold", allocations)
	}
	f.advance(31 * time.Second)
	if allocations := f.node.DrainState().Allocations; allocations != 0 {
		t.Fatalf("%d allocations after the hold expired", allocations)
	}
}

func TestReserveRefusesAStaleGeneration(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.Generation = 5
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	older := reserveRequest("one", 3)
	older.Generation = 4
	if _, err := f.node.ReserveEpisode(older); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("an older generation: %v, want stale", err)
	}
	// A newer generation replaces the hold and does not add to it.
	newer := reserveRequest("one", 3)
	newer.Generation = 6
	if _, err := f.node.ReserveEpisode(newer); err != nil {
		t.Fatal(err)
	}
	if f.reserved() != threePerson {
		t.Fatalf("reserved %d after a re-reserve, want %d", f.reserved(), threePerson)
	}
	// A live Participant of a newer generation fences an older reserve too.
	scope := protocol.Scope{TenantID: "tenant", EpisodeID: "live", ParticipantID: "a", Generation: 9}
	if _, err := f.node.Create("live-a", scope, ParticipantSession, nil); err != nil {
		t.Fatal(err)
	}
	stale := reserveRequest("live", 3)
	stale.Generation = 8
	if _, err := f.node.ReserveEpisode(stale); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a reserve below a live session's generation: %v, want stale", err)
	}
}

func TestReserveHonoursTheSessionAndEpisodeLimits(t *testing.T) {
	f := newReserveNode(t, func(cfg *config.Config) { cfg.MaxSessions = 5 })
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 3)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.ReserveEpisode(reserveRequest("two", 3)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("six sessions on a limit of five: %v, want capacity exceeded", err)
	}
	// A join counts the other Episodes' held Participants too.
	if _, err := f.node.Create("solo", protocol.Scope{TenantID: "tenant", EpisodeID: "solo", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); err != nil {
		t.Fatalf("one session beside three held fits five: %v", err)
	}
	if _, err := f.node.Create("solo-b", protocol.Scope{TenantID: "tenant", EpisodeID: "solo", ParticipantID: "b", Generation: 1}, ParticipantSession, nil); err != nil {
		t.Fatalf("two sessions beside three held fit five: %v", err)
	}
	if _, err := f.node.Create("solo-c", protocol.Scope{TenantID: "tenant", EpisodeID: "solo", ParticipantID: "c", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a sixth slot: %v, want capacity exceeded", err)
	}

	limited := newReserveNode(t, func(cfg *config.Config) { cfg.MaxEpisodeParticipants = 4 })
	if _, err := limited.node.ReserveEpisode(reserveRequest("big", 5)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("five Participants on a limit of four: %v, want capacity exceeded", err)
	}
}

func TestReserveRefusesAShapeTheNodeCannotCarry(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.Shape.CamerasPerParticipant = 3
	if _, err := f.node.ReserveEpisode(request); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("three cameras on a limit of two: %v, want capacity exceeded", err)
	}
	request = reserveRequest("one", 3)
	request.Shape.CaptureSlots = 3
	if _, err := f.node.ReserveEpisode(request); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("three captures on a limit of two: %v, want capacity exceeded", err)
	}
	// Sixteen microphones with a screen share need more than the Episode ceiling can give.
	request = reserveRequest("one", 16)
	request.Shape.ScreenShare = true
	if _, err := f.node.ReserveEpisode(request); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a shape whose mandatory media exceeds the ceiling: %v, want capacity exceeded", err)
	}
	if f.reserved() != 0 {
		t.Fatalf("refusals left %d reserved", f.reserved())
	}
}

func TestReserveValidatesItsRequest(t *testing.T) {
	f := newReserveNode(t)
	for name, mutate := range map[string]func(*protocol.ReserveEpisodeRequest){
		"no operation ID":    func(r *protocol.ReserveEpisodeRequest) { r.OperationID = "" },
		"bad Episode":        func(r *protocol.ReserveEpisodeRequest) { r.EpisodeID = "a b" },
		"no generation":      func(r *protocol.ReserveEpisodeRequest) { r.Generation = 0 },
		"no Participants":    func(r *protocol.ReserveEpisodeRequest) { r.Shape.Participants = 0 },
		"negative cameras":   func(r *protocol.ReserveEpisodeRequest) { r.Shape.CamerasPerParticipant = -1 },
		"negative captures":  func(r *protocol.ReserveEpisodeRequest) { r.Shape.CaptureSlots = -1 },
		"negative TTL":       func(r *protocol.ReserveEpisodeRequest) { r.TTLSeconds = -1 },
		"TTL over the limit": func(r *protocol.ReserveEpisodeRequest) { r.TTLSeconds = protocol.MaxReservationTTLSeconds + 1 },
	} {
		request := reserveRequest("one", 3)
		mutate(&request)
		if _, err := f.node.ReserveEpisode(request); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v, want an invalid request", name, err)
		}
	}
	request := reserveRequest("one", 3)
	request.TTLSeconds = protocol.MaxReservationTTLSeconds
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatalf("the longest TTL: %v", err)
	}
}

func TestHoldsAreBounded(t *testing.T) {
	f := newReserveNode(t, func(cfg *config.Config) { cfg.PacketBudget = 1_000_000; cfg.MaxSessions = 1024 })
	for i := range maxHolds {
		if _, err := f.node.ReserveEpisode(reserveRequest(fmt.Sprintf("episode-%d", i), 1)); err != nil {
			t.Fatalf("hold %d: %v", i, err)
		}
	}
	if _, err := f.node.ReserveEpisode(reserveRequest("one-too-many", 1)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("hold %d: %v, want capacity exceeded", maxHolds+1, err)
	}
	// An Episode that already holds a place may re-reserve at the bound.
	if _, err := f.node.ReserveEpisode(reserveRequest("episode-0", 2)); err != nil {
		t.Fatalf("re-reserve at the bound: %v", err)
	}
}

func TestAHoldFencesJoinsOfAnOlderGeneration(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 2)
	request.Generation = 6
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	stale := protocol.Scope{TenantID: "tenant", EpisodeID: "one", ParticipantID: "a", Generation: 5}
	if _, err := f.node.Create("stale", stale, ParticipantSession, nil); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create below the hold's generation: %v, want stale", err)
	}
	if f.reserved() != newEpisode {
		t.Fatalf("a stale create changed the reservation to %d", f.reserved())
	}
	fresh := stale
	fresh.Generation = 6
	if _, err := f.node.Create("fresh", fresh, ParticipantSession, nil); err != nil {
		t.Fatalf("a create at the hold's generation: %v", err)
	}
}

func TestReserveEnforcesTheCallersPacketCeilingAtomically(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.PacketCeiling = threePerson - 1
	if _, err := f.node.ReserveEpisode(request); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a reserve above the caller's ceiling: %v, want capacity exceeded", err)
	}
	if reserved := f.reserved(); reserved != 0 {
		t.Fatalf("a refused reserve left %d reserved", reserved)
	}
	request = reserveRequest("one", 3)
	request.PacketCeiling = threePerson
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatalf("a reserve that fits the caller's ceiling: %v", err)
	}
	// The ceiling counts the node's other Episodes, so a second Episode does not fit beside the first.
	other := reserveRequest("two", 3)
	other.PacketCeiling = threePerson
	if _, err := f.node.ReserveEpisode(other); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a second Episode under the same ceiling: %v, want capacity exceeded", err)
	}
	// A caller that omits the ceiling gets the node's budget alone.
	if _, err := f.node.ReserveEpisode(reserveRequest("two", 3)); err != nil {
		t.Fatalf("a reserve without a ceiling: %v", err)
	}
	negative := reserveRequest("three", 2)
	negative.PacketCeiling = -1
	if _, err := f.node.ReserveEpisode(negative); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("a negative ceiling: %v, want an invalid request", err)
	}
}
