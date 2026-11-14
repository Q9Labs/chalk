package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/q9labs/chalk/features/media/sfu/internal/config"
	"github.com/q9labs/chalk/features/media/sfu/protocol"
)

// The design's costs: a three-person Episode with two cameras each reserves 7,170 packets/s and
// a new Episode's first join 3,480, so two three-person Episodes fit a 16,000 budget and a third
// does not.
const (
	threePerson = 7170
	newEpisode  = 3480
)

type reserveFixture struct {
	node  *Node
	clock *atomic.Pointer[time.Time]
}

func newReserveNode(t *testing.T, configure ...func(*config.Config)) *reserveFixture {
	t.Helper()
	node, err := newReserveNodeErr(configure...)
	if err != nil {
		t.Fatalf("new node: %v", err)
	}
	t.Cleanup(node.Close)
	start := time.Now()
	clock := &atomic.Pointer[time.Time]{}
	clock.Store(&start)
	node.now = func() time.Time { return *clock.Load() }
	return &reserveFixture{node: node, clock: clock}
}

func newReserveNodeErr(configure ...func(*config.Config)) (*Node, error) {
	cfg := config.Config{
		UDPAddr:                "127.0.0.1:0",
		AnnounceIPs:            []string{"127.0.0.1"},
		IncludeLoopback:        true,
		MaxSessions:            64,
		PacketBudget:           16000,
		VideoStreamCost:        300,
		CameraUplinkCost:       390,
		CamerasPerParticipant:  2,
		AudioStreamCost:        50,
		ScreenStreamCost:       210,
		EpisodePacketCeiling:   11520,
		LargeCallParticipants:  6,
		SmallTileStreamCost:    90,
		MaxEpisodeParticipants: 16,
		MaxCapturesPerEpisode:  2,
		NegotiationTimeout:     time.Second,
		ConnectTimeout:         time.Minute,
		Memory:                 config.Memory{HistoryHighBytes: 400 << 10, HistoryLowBytes: 128 << 10, HistoryScreenBytes: 320 << 10, PacerQueueBytes: 128 << 10},
		Guard: config.Guard{
			MaxStealPercent: 3, MaxBusyPercent: 90, MaxSchedulerLatency: 5 * time.Second,
			MaxPacerDropPercent: 5, MaxUDPErrorsPerSecond: 5, Window: 30 * time.Second,
		},
	}
	for _, apply := range configure {
		apply(&cfg)
	}
	return NewNode(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func (f *reserveFixture) advance(d time.Duration) {
	next := f.clock.Load().Add(d)
	f.clock.Store(&next)
}

func (f *reserveFixture) reserved() int {
	_, reserved := f.node.Budget()
	return reserved
}

var reserves atomic.Int64

func reserveRequest(episode string, participants int) protocol.ReserveEpisodeRequest {
	return protocol.ReserveEpisodeRequest{
		OperationID: fmt.Sprintf("reserve-%d", reserves.Add(1)), TenantID: "tenant", EpisodeID: episode, Generation: 1,
		Shape: protocol.EpisodeShape{Participants: participants, CamerasPerParticipant: 2},
	}
}

func join(t *testing.T, node *Node, episode, participant string) {
	t.Helper()
	scope := protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: participant, Generation: 1}
	if _, err := node.Create("join-"+episode+"-"+participant, scope, ParticipantSession, nil); err != nil {
		t.Fatalf("join %s: %v", participant, err)
	}
}

func TestReserveEpisodeCountsInReadiness(t *testing.T) {
	f := newReserveNode(t)
	response, err := f.node.ReserveEpisode(reserveRequest("one", 3))
	if err != nil {
		t.Fatal(err)
	}
	if response.ReservedPackets != threePerson || f.reserved() != threePerson {
		t.Fatalf("reserved %d, node reports %d, want %d", response.ReservedPackets, f.reserved(), threePerson)
	}
	if want := f.clock.Load().Add(30 * time.Second); !response.ExpiresAt.Equal(want) {
		t.Fatalf("expires at %v, want the 30s default %v", response.ExpiresAt, want)
	}
}

func TestReserveEpisodeRefusesWhatWouldExceedTheBudget(t *testing.T) {
	f := newReserveNode(t)
	for _, episode := range []string{"one", "two"} {
		if _, err := f.node.ReserveEpisode(reserveRequest(episode, 3)); err != nil {
			t.Fatalf("reserve %s: %v", episode, err)
		}
	}
	_, err := f.node.ReserveEpisode(reserveRequest("three", 3))
	if !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a third three-person Episode: %v, want capacity exceeded", err)
	}
	if f.reserved() != 2*threePerson {
		t.Fatalf("a refused reserve left %d reserved, want %d", f.reserved(), 2*threePerson)
	}
	// A join of a new Episode meets the same budget: it needs 3,480 and 1,660 are left.
	if _, err := f.node.Create("join-three", protocol.Scope{TenantID: "tenant", EpisodeID: "three", ParticipantID: "p", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a new Episode's first join beside two held Episodes: %v, want capacity exceeded", err)
	}
}

func TestConcurrentReservesNeverOverAdmit(t *testing.T) {
	f := newReserveNode(t)
	const callers = 24
	var admitted, refused atomic.Int64
	var wg sync.WaitGroup
	for i := range callers {
		wg.Go(func() {
			_, err := f.node.ReserveEpisode(reserveRequest(fmt.Sprintf("episode-%d", i), 3))
			switch {
			case err == nil:
				admitted.Add(1)
			case errors.Is(err, ErrCapacityExceeded):
				refused.Add(1)
			default:
				t.Errorf("reserve: %v", err)
			}
		})
	}
	wg.Wait()
	if admitted.Load() != 2 || refused.Load() != callers-2 {
		t.Fatalf("admitted %d and refused %d, want 2 and %d", admitted.Load(), refused.Load(), callers-2)
	}
	if reserved := f.reserved(); reserved != 2*threePerson || reserved > 16000 {
		t.Fatalf("reserved %d, want %d within the budget", reserved, 2*threePerson)
	}
}

func TestJoinsReplaceTheHoldWithoutDoubleCounting(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 3)); err != nil {
		t.Fatal(err)
	}
	for _, participant := range []string{"a", "b", "c"} {
		join(t, f.node, "one", participant)
		if reserved := f.reserved(); reserved != threePerson {
			t.Fatalf("after %s joined the node reserves %d, want %d", participant, reserved, threePerson)
		}
	}
	f.node.mu.Lock()
	remaining := f.node.heldEpisodes()
	f.node.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("%d holds remain after every Participant joined", remaining)
	}
	// Past the held shape the Episode grows like any other.
	join(t, f.node, "one", "d")
	if reserved := f.reserved(); reserved <= threePerson {
		t.Fatalf("a fourth Participant left %d reserved, want more than %d", reserved, threePerson)
	}
}

func TestAHoldExpiresAndReleasesWhatNoJoinUsed(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.TTLSeconds = 10
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	join(t, f.node, "one", "a")
	f.advance(9 * time.Second)
	if f.reserved() != threePerson {
		t.Fatalf("reserved %d before the deadline, want %d", f.reserved(), threePerson)
	}
	f.advance(2 * time.Second)
	// One Participant is left, and a lone Participant reserves what two would.
	if f.reserved() != newEpisode {
		t.Fatalf("reserved %d after expiry, want the joined Participant's %d", f.reserved(), newEpisode)
	}
	// Releasing twice changes nothing.
	f.node.mu.Lock()
	f.node.expireHolds()
	f.node.expireHolds()
	holds := f.node.heldEpisodes()
	f.node.mu.Unlock()
	if holds != 0 || f.reserved() != newEpisode {
		t.Fatalf("holds %d and reserved %d after a second release", holds, f.reserved())
	}
}

func TestEndEpisodeReleasesItsHold(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 3)); err != nil {
		t.Fatal(err)
	}
	join(t, f.node, "one", "a")
	f.node.EndEpisode("tenant", "one")
	if f.reserved() != 0 {
		t.Fatalf("reserved %d after the Episode ended", f.reserved())
	}
}

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

func (f *reserveFixture) closeAdmission(reason string) {
	f.node.guard.mu.Lock()
	f.node.guard.health.AdmissionReason = reason
	f.node.guard.mu.Unlock()
}

func TestAHeldEpisodeRejoinsAfterTheNodeDrainsOrTheGuardCloses(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.ReserveEpisode(reserveRequest("held", 2)); err != nil {
		t.Fatal(err)
	}
	f.closeAdmission(RefusedCPUBusy)
	join(t, f.node, "held", "a")
	if _, err := f.node.Create("new", protocol.Scope{TenantID: "tenant", EpisodeID: "new", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a new Episode while the guard is closed: %v, want capacity exceeded", err)
	}

	f.closeAdmission("")
	other := newReserveNode(t)
	if _, err := other.node.ReserveEpisode(reserveRequest("held", 2)); err != nil {
		t.Fatal(err)
	}
	other.node.Drain()
	join(t, other.node, "held", "a")
	join(t, other.node, "held", "b")
	if _, err := other.node.Create("new", protocol.Scope{TenantID: "tenant", EpisodeID: "new", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrDraining) {
		t.Fatalf("a new Episode on a draining node: %v, want draining", err)
	}
}

func TestReservedCapturesKeepTheirSessionSlots(t *testing.T) {
	f := newReserveNode(t, func(cfg *config.Config) { cfg.MaxSessions = 4 })
	request := reserveRequest("one", 3)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	// Three Participants and the capture fill the four slots: nobody else gets one.
	if _, err := f.node.Create("other", protocol.Scope{TenantID: "tenant", EpisodeID: "other", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("another Episode took a slot the hold promised: %v", err)
	}
	for _, participant := range []string{"a", "b", "c"} {
		join(t, f.node, "one", participant)
	}
	if _, err := f.node.Create("other", protocol.Scope{TenantID: "tenant", EpisodeID: "other", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("another Episode took the capture's slot: %v", err)
	}
	if _, err := f.node.Create("capture", protocol.Scope{TenantID: "tenant", EpisodeID: "one", ParticipantID: "recorder", Generation: 1}, CaptureSession, nil); err != nil {
		t.Fatalf("the reserved capture: %v", err)
	}

	short := newReserveNode(t, func(cfg *config.Config) { cfg.MaxSessions = 3 })
	if _, err := short.node.ReserveEpisode(request); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("three Participants and a capture on a limit of three: %v, want capacity exceeded", err)
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

func TestASameGenerationReserveNeverShrinksTheHold(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 3)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 2)); err != nil {
		t.Fatal(err)
	}
	if reserved := f.reserved(); reserved != threePerson {
		t.Fatalf("a delayed smaller reserve left %d reserved, want %d", reserved, threePerson)
	}
	// A newer generation is a new decision and may hold less.
	newer := reserveRequest("one", 2)
	newer.Generation = 2
	if _, err := f.node.ReserveEpisode(newer); err != nil {
		t.Fatal(err)
	}
	if reserved := f.reserved(); reserved >= threePerson {
		t.Fatalf("a newer generation left %d reserved, want less than %d", reserved, threePerson)
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

func TestNewNodeRefusesACeilingBelowTheMandatoryMediaOfALargeCall(t *testing.T) {
	if _, err := newReserveNodeErr(func(cfg *config.Config) { cfg.EpisodePacketCeiling = 2000 }); err == nil {
		t.Fatal("NewNode accepted a ceiling below the large-call threshold's mandatory media")
	}
}

// The capture tests below drive real Pion peers through the node's session API. A capture bound
// of three Participants with two cameras and a microphone each is 1,950 packets/s, and one camera
// subscription costs 300.
const (
	captureBound  = 3 * (2*300 + 50)
	cameraStream  = 300
	captureBudget = threePerson + captureBound
)

// newCaptureNode is a node with session limits for a few publishers and a capture, and a
// negotiation timeout that outlasts the test, because the capture here never answers the server's offers.
func newCaptureNode(t *testing.T, configure ...func(*config.Config)) *reserveFixture {
	t.Helper()
	return newReserveNode(t, append([]func(*config.Config){func(cfg *config.Config) {
		cfg.NegotiationTimeout = time.Minute
		cfg.MaxPublishedPerSession = 4
		cfg.MaxSubscriptionsPerSession = 4
		cfg.MaxCaptureSubscriptions = 8
	}}, configure...)...)
}

func (f *reserveFixture) reserveWithCapture(t *testing.T, episode string, participants int) {
	t.Helper()
	request := reserveRequest(episode, participants)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatalf("reserve %s with a capture slot: %v", episode, err)
	}
}

// camera joins the Participant and publishes one camera track with a Pion peer that never
// connects. It returns the track a capture pulls.
func (f *reserveFixture) camera(t *testing.T, episode, participant string) protocol.Track {
	t.Helper()
	scope := protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: participant, Generation: 1}
	if _, err := f.node.ControlSources(protocol.SourceControlRequest{TenantID: "tenant", EpisodeID: episode, Controls: []protocol.SourceControl{
		{ParticipantID: participant, Source: "camera", Action: protocol.SourceGrant, Revision: 1},
	}}); err != nil {
		t.Fatalf("grant %s a camera: %v", participant, err)
	}
	created, err := f.node.Create("join-"+episode+"-"+participant, scope, ParticipantSession, nil)
	if err != nil {
		t.Fatalf("join %s: %v", participant, err)
	}
	session, err := f.node.Session(created.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	video, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "cam", participant)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pc.AddTrack(video); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	name := participant + "-cam"
	pushed, err := session.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID:        fmt.Sprintf("push-%d", reserves.Add(1)),
		Scope:              scope,
		SessionDescription: &protocol.SessionDescription{Type: "offer", SDP: offer.SDP},
		Tracks:             []protocol.Track{{Location: protocol.LocationLocal, Mid: pc.GetTransceivers()[0].Mid(), TrackName: name, Source: "camera"}},
	})
	if err != nil || len(pushed.TrackErrors) != 0 {
		t.Fatalf("%s publishes a camera: %v %+v", participant, err, pushed.TrackErrors)
	}
	return protocol.Track{Location: protocol.LocationRemote, SessionID: created.ConnectionID, TrackName: name}
}

// recorder is a capture session of an Episode.
type recorder struct {
	session *Session
	scope   protocol.Scope
}

func (f *reserveFixture) recorder(t *testing.T, episode string) recorder {
	t.Helper()
	scope := protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: "recorder", Generation: 1}
	created, err := f.node.Create("capture-"+episode, scope, CaptureSession, nil)
	if err != nil {
		t.Fatalf("create the capture session: %v", err)
	}
	session, err := f.node.Session(created.ConnectionID, scope)
	if err != nil {
		t.Fatal(err)
	}
	return recorder{session: session, scope: scope}
}

// pull subscribes the capture to the tracks in one request and returns their MIDs in order.
func (r recorder) pull(t *testing.T, tracks ...protocol.Track) []string {
	t.Helper()
	pulled, err := r.session.AddTracks(context.Background(), protocol.TracksRequest{
		OperationID: fmt.Sprintf("pull-%d", reserves.Add(1)), Scope: r.scope, Tracks: tracks,
	})
	if err != nil || len(pulled.TrackErrors) != 0 || len(pulled.Tracks) != len(tracks) {
		t.Fatalf("capture pulls %d tracks: %v %+v", len(tracks), err, pulled)
	}
	mids := make([]string, len(pulled.Tracks))
	for i, track := range pulled.Tracks {
		mids[i] = track.Mid
	}
	return mids
}

// stop ends the capture's subscription to the MID.
func (r recorder) stop(t *testing.T, mid string) {
	t.Helper()
	closed, err := r.session.CloseTracks(context.Background(), protocol.CloseTracksRequest{
		OperationID: fmt.Sprintf("stop-%d", reserves.Add(1)), Scope: r.scope, Force: true, Tracks: []protocol.CloseTrack{{Mid: mid}},
	})
	if err != nil || len(closed.Tracks) != 1 || closed.Tracks[0].AlreadyClosed {
		t.Fatalf("stop the subscription %s: %v %+v", mid, err, closed)
	}
}

func TestCaptureSlotsKeepRoomUntilACaptureTakesIt(t *testing.T) {
	f := newCaptureNode(t)
	f.reserveWithCapture(t, "one", 3)
	if f.reserved() != captureBudget {
		t.Fatalf("reserved %d, want the Episode and its capture bound %d", f.reserved(), captureBudget)
	}
	alice := f.camera(t, "one", "alice")
	// A capture takes the room as it subscribes, without adding to the total.
	f.recorder(t, "one").pull(t, alice)
	if f.reserved() != captureBudget {
		t.Fatalf("a capture subscription changed the total to %d, want %d", f.reserved(), captureBudget)
	}
	f.advance(31 * time.Second)
	// The hold is gone: the one joined Participant and the capture's own subscription remain.
	if want := newEpisode + cameraStream; f.reserved() != want {
		t.Fatalf("after expiry %d reserved, want %d", f.reserved(), want)
	}
}

func TestACaptureReturnsHeldPacketsWhenItsSubscriptionEnds(t *testing.T) {
	f := newCaptureNode(t)
	f.reserveWithCapture(t, "one", 3)
	alice := f.camera(t, "one", "alice")
	capture := f.recorder(t, "one")
	mid := capture.pull(t, alice)[0]
	capture.stop(t, mid)
	// The hold keeps the capture room again; if it did not, the total would drop by the subscription.
	if f.reserved() != captureBudget {
		t.Fatalf("after the subscription ended %d reserved, want %d", f.reserved(), captureBudget)
	}
}

func TestEndingAnEpisodeWithALiveCaptureSubscriptionLeavesNothingReserved(t *testing.T) {
	f := newCaptureNode(t)
	f.reserveWithCapture(t, "one", 3)
	alice := f.camera(t, "one", "alice")
	f.recorder(t, "one").pull(t, alice)
	f.node.EndEpisode("tenant", "one")
	if f.reserved() != 0 {
		t.Fatalf("ending the Episode left %d reserved", f.reserved())
	}
}

func TestReleasingOneSubscriptionReturnsOnlyWhatItBorrowed(t *testing.T) {
	f := newCaptureNode(t)
	// One Participant's capture room is 650: the first two cameras borrow 300 each and the third
	// borrows the last 50, so it adds 250 to the total.
	f.reserveWithCapture(t, "one", 1)
	alice, bob, carol := f.camera(t, "one", "alice"), f.camera(t, "one", "bob"), f.camera(t, "one", "carol")
	joined := f.reserved()
	capture := f.recorder(t, "one")
	mids := capture.pull(t, alice, bob, carol)
	if f.reserved() != joined+250 {
		t.Fatalf("three subscriptions left %d reserved, want %d", f.reserved(), joined+250)
	}
	capture.stop(t, mids[2])
	if f.reserved() != joined {
		t.Fatalf("ending the subscription that borrowed 50 left %d reserved, want %d", f.reserved(), joined)
	}
	capture.stop(t, mids[0])
	capture.stop(t, mids[1])
	if f.reserved() != joined {
		t.Fatalf("ending the subscriptions that borrowed 300 each left %d reserved, want %d", f.reserved(), joined)
	}
}

func TestReReservingAfterACaptureSubscribedDoesNotCountItTwice(t *testing.T) {
	// The budget fits the Episode and its capture bound exactly, with no room to count it twice.
	f := newCaptureNode(t, func(cfg *config.Config) { cfg.PacketBudget = captureBudget })
	f.reserveWithCapture(t, "one", 3)
	alice := f.camera(t, "one", "alice")
	f.recorder(t, "one").pull(t, alice)
	again := reserveRequest("one", 3)
	again.Shape.CaptureSlots = 1
	response, err := f.node.ReserveEpisode(again)
	if err != nil {
		t.Fatalf("an unchanged shape was refused after its capture subscribed: %v", err)
	}
	if response.ReservedPackets != captureBudget || f.reserved() != captureBudget {
		t.Fatalf("reserved %d (node %d), want %d", response.ReservedPackets, f.reserved(), captureBudget)
	}
}

// A subscription that ends after its Episode was re-reserved returns its share to the new hold,
// so the Episode is still promised its whole capture bound and no other Episode can take it.
func TestASubscriptionEndingAfterAReReserveReturnsItsShareToTheNewHold(t *testing.T) {
	f := newCaptureNode(t, func(cfg *config.Config) { cfg.PacketBudget = captureBudget })
	f.reserveWithCapture(t, "one", 3)
	alice := f.camera(t, "one", "alice")
	capture := f.recorder(t, "one")
	mid := capture.pull(t, alice)[0]
	f.reserveWithCapture(t, "one", 3)
	capture.stop(t, mid)
	if f.reserved() != captureBudget {
		t.Fatalf("after the subscription ended the node reserves %d, want %d", f.reserved(), captureBudget)
	}
	if _, err := f.node.Create("other", protocol.Scope{TenantID: "tenant", EpisodeID: "other", ParticipantID: "a", Generation: 1}, ParticipantSession, nil); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("another Episode took the capture room the hold promised: %v", err)
	}
}
