package media

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
	if _, err := node.CreateSession("join-"+episode+"-"+participant, scope); err != nil {
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
	if _, err := f.node.CreateSession("join-three", protocol.Scope{TenantID: "tenant", EpisodeID: "three", ParticipantID: "p", Generation: 1}); !errors.Is(err, ErrCapacityExceeded) {
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
	remaining := len(f.node.holds)
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

func TestOtherEpisodesCannotTakeAHeldEpisodesRoom(t *testing.T) {
	f := newReserveNode(t)
	if _, err := f.node.ReserveEpisode(reserveRequest("held", 3)); err != nil {
		t.Fatal(err)
	}
	// 16,000 less the held 7,170 leaves 8,830: two more three-person Episodes do not fit.
	if _, err := f.node.ReserveEpisode(reserveRequest("other", 3)); err != nil {
		t.Fatal(err)
	}
	for _, participant := range []string{"x", "y", "z"} {
		scope := protocol.Scope{TenantID: "tenant", EpisodeID: "late", ParticipantID: participant, Generation: 1}
		if _, err := f.node.CreateSession("late-"+participant, scope); err == nil {
			t.Fatalf("%s joined a third Episode though two Episodes already reserve %d", participant, f.reserved())
		}
	}
	for _, participant := range []string{"a", "b", "c"} {
		join(t, f.node, "held", participant)
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
	holds := len(f.node.holds)
	f.node.mu.Unlock()
	if holds != 0 || f.reserved() != newEpisode {
		t.Fatalf("holds %d and reserved %d after a second release", holds, f.reserved())
	}
}

func TestAnExpiredHoldFreesCapacityForAnotherEpisode(t *testing.T) {
	f := newReserveNode(t)
	for _, episode := range []string{"one", "two"} {
		request := reserveRequest(episode, 3)
		request.TTLSeconds = 5
		if _, err := f.node.ReserveEpisode(request); err != nil {
			t.Fatal(err)
		}
	}
	f.advance(6 * time.Second)
	if f.reserved() != 0 {
		t.Fatalf("reserved %d after both expired", f.reserved())
	}
	if _, err := f.node.ReserveEpisode(reserveRequest("three", 3)); err != nil {
		t.Fatalf("reserve after expiry: %v", err)
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
	if _, err := f.node.CreateSession("live-a", scope); err != nil {
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
	if _, err := f.node.CreateSession("solo", protocol.Scope{TenantID: "tenant", EpisodeID: "solo", ParticipantID: "a", Generation: 1}); err != nil {
		t.Fatalf("one session beside three held fits five: %v", err)
	}
	if _, err := f.node.CreateSession("solo-b", protocol.Scope{TenantID: "tenant", EpisodeID: "solo", ParticipantID: "b", Generation: 1}); err != nil {
		t.Fatalf("two sessions beside three held fit five: %v", err)
	}
	if _, err := f.node.CreateSession("solo-c", protocol.Scope{TenantID: "tenant", EpisodeID: "solo", ParticipantID: "c", Generation: 1}); !errors.Is(err, ErrCapacityExceeded) {
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

func TestCaptureSlotsKeepRoomUntilACaptureTakesIt(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.Shape.CaptureSlots = 1
	response, err := f.node.ReserveEpisode(request)
	if err != nil {
		t.Fatal(err)
	}
	// One capture pulls three Participants' two cameras and microphone at the top layer.
	capture := 3 * (2*300 + 50)
	if want := threePerson + capture; response.ReservedPackets != want || f.reserved() != want {
		t.Fatalf("reserved %d (node %d), want %d", response.ReservedPackets, f.reserved(), want)
	}
	// A capture session takes the room as it subscribes, without adding to the total.
	session := &Session{kind: kindCapture, scope: protocol.Scope{TenantID: "tenant", EpisodeID: "one", ParticipantID: "recorder", Generation: 1}}
	f.node.mu.Lock()
	f.node.sessions["capture"] = session
	f.node.mu.Unlock()
	t.Cleanup(func() {
		f.node.mu.Lock()
		delete(f.node.sessions, "capture")
		f.node.mu.Unlock()
	})
	if _, err := f.node.reserveCapture(session, 300); err != nil {
		t.Fatal(err)
	}
	if want := threePerson + capture; f.reserved() != want {
		t.Fatalf("a capture subscription changed the total to %d, want %d", f.reserved(), want)
	}
	f.advance(31 * time.Second)
	if want := 300; f.reserved() != want {
		t.Fatalf("after expiry %d reserved, want the capture's own %d", f.reserved(), want)
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
	if _, err := f.node.CreateSession("new", protocol.Scope{TenantID: "tenant", EpisodeID: "new", ParticipantID: "a", Generation: 1}); !errors.Is(err, ErrCapacityExceeded) {
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
	if _, err := other.node.CreateSession("new", protocol.Scope{TenantID: "tenant", EpisodeID: "new", ParticipantID: "a", Generation: 1}); !errors.Is(err, ErrDraining) {
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
	if _, err := f.node.CreateSession("other", protocol.Scope{TenantID: "tenant", EpisodeID: "other", ParticipantID: "a", Generation: 1}); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("another Episode took a slot the hold promised: %v", err)
	}
	for _, participant := range []string{"a", "b", "c"} {
		join(t, f.node, "one", participant)
	}
	if _, err := f.node.CreateSession("other", protocol.Scope{TenantID: "tenant", EpisodeID: "other", ParticipantID: "a", Generation: 1}); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("another Episode took the capture's slot: %v", err)
	}
	if _, err := f.node.CreateCaptureSession("capture", protocol.Scope{TenantID: "tenant", EpisodeID: "one", ParticipantID: "recorder", Generation: 1}); err != nil {
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
	if _, err := f.node.CreateSession("stale", stale); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("a create below the hold's generation: %v, want stale", err)
	}
	if f.reserved() != newEpisode {
		t.Fatalf("a stale create changed the reservation to %d", f.reserved())
	}
	fresh := stale
	fresh.Generation = 6
	if _, err := f.node.CreateSession("fresh", fresh); err != nil {
		t.Fatalf("a create at the hold's generation: %v", err)
	}
}

func TestACaptureReturnsHeldPacketsWhenItsSubscriptionRollsBack(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	session := &Session{kind: kindCapture, scope: protocol.Scope{TenantID: "tenant", EpisodeID: "one", ParticipantID: "recorder", Generation: 1}}
	f.node.mu.Lock()
	f.node.sessions["capture"] = session
	f.node.mu.Unlock()
	t.Cleanup(func() {
		f.node.mu.Lock()
		delete(f.node.sessions, "capture")
		f.node.mu.Unlock()
	})
	before := f.reserved()
	heldCapture := func() int {
		f.node.mu.Lock()
		defer f.node.mu.Unlock()
		return f.node.holds[episodeKey{"tenant", "one"}].capture
	}
	full := heldCapture()
	lease, err := f.node.reserveCapture(session, 300)
	if err != nil {
		t.Fatal(err)
	}
	if heldCapture() != full-300 {
		t.Fatalf("the hold keeps %d, want %d", heldCapture(), full-300)
	}
	f.node.releaseCapture(session, lease)
	if heldCapture() != full || f.reserved() != before {
		t.Fatalf("after a rollback the hold keeps %d (want %d) and %d is reserved (want %d)", heldCapture(), full, f.reserved(), before)
	}

	// Once the Episode ends, a late release must not bring the hold back.
	lease, err = f.node.reserveCapture(session, 300)
	if err != nil {
		t.Fatal(err)
	}
	f.node.mu.Lock()
	delete(f.node.sessions, "capture") // the fake has no peer connection for EndEpisode to close
	f.node.mu.Unlock()
	f.node.EndEpisode("tenant", "one")
	f.node.releaseCapture(session, lease)
	if f.reserved() != 0 {
		t.Fatalf("a release after the Episode ended left %d reserved", f.reserved())
	}
}

func TestReserveChecksMandatoryMediaAtEveryRejoinCount(t *testing.T) {
	// NewNode refuses a ceiling that a call at the large-call threshold cannot meet, so a valid
	// node never reaches a refusal at an intermediate count. Lowering the ceiling after start,
	// before any session exists, stands in for a node whose rule and shape disagree: seven
	// Participants pass at their last count against the budget, but the third rejoin needs 2,790
	// mandatory packets/s against 2,000.
	f := newReserveNode(t)
	f.node.cfg.EpisodePacketCeiling = 2000
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 7)); !errors.Is(err, ErrCapacityExceeded) {
		t.Fatalf("a shape that cannot reach its size: %v, want capacity exceeded", err)
	}
	if f.reserved() != 0 {
		t.Fatalf("the refusal left %d reserved", f.reserved())
	}
	if _, err := f.node.ReserveEpisode(reserveRequest("one", 2)); err != nil {
		t.Fatalf("a shape within the ceiling: %v", err)
	}
	if _, err := newReserveNodeErr(func(cfg *config.Config) { cfg.EpisodePacketCeiling = 2000 }); err == nil {
		t.Fatal("NewNode accepted a ceiling below the large-call threshold's mandatory media")
	}
}

// addCaptureSession registers a capture session without a peer connection, as the tests above do.
func (f *reserveFixture) addCaptureSession(t *testing.T, episode string) *Session {
	t.Helper()
	session := &Session{kind: kindCapture, scope: protocol.Scope{TenantID: "tenant", EpisodeID: episode, ParticipantID: "recorder", Generation: 1}}
	f.node.mu.Lock()
	f.node.sessions["capture-"+episode] = session
	f.node.mu.Unlock()
	t.Cleanup(func() { // the fake has no peer connection for Close to shut down
		f.node.mu.Lock()
		delete(f.node.sessions, "capture-"+episode)
		f.node.mu.Unlock()
	})
	return session
}

func (f *reserveFixture) heldCapture(episode string) int {
	f.node.mu.Lock()
	defer f.node.mu.Unlock()
	return f.node.holds[episodeKey{"tenant", episode}].capture
}

func TestReleasingOneSubscriptionReturnsOnlyWhatItBorrowed(t *testing.T) {
	f := newReserveNode(t)
	request := reserveRequest("one", 3)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	session := f.addCaptureSession(t, "one")
	// The first subscription takes the hold's whole capture room, so the second borrows nothing
	// and adds its cost to the node total.
	whole := f.heldCapture("one")
	first, err := f.node.reserveCapture(session, whole)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.node.reserveCapture(session, 300)
	if err != nil {
		t.Fatal(err)
	}
	withBoth := f.reserved()
	f.node.releaseCapture(session, second)
	if f.heldCapture("one") != 0 || f.reserved() != withBoth-300 {
		t.Fatalf("ending a subscription that borrowed nothing left the hold at %d (want 0) and %d reserved (want %d)", f.heldCapture("one"), f.reserved(), withBoth-300)
	}
	f.node.releaseCapture(session, first)
	if f.heldCapture("one") != whole {
		t.Fatalf("the first subscription returned %d to the hold, want %d", f.heldCapture("one"), whole)
	}
}

func TestReReservingAfterACaptureSubscribedDoesNotCountItTwice(t *testing.T) {
	capture := 3 * (2*300 + 50)
	// The budget fits the Episode and its capture bound exactly, with no room to count it twice.
	f := newReserveNode(t, func(cfg *config.Config) { cfg.PacketBudget = threePerson + capture })
	request := reserveRequest("one", 3)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	session := f.addCaptureSession(t, "one")
	if _, err := f.node.reserveCapture(session, 300); err != nil {
		t.Fatal(err)
	}
	again := reserveRequest("one", 3)
	again.Shape.CaptureSlots = 1
	response, err := f.node.ReserveEpisode(again)
	if err != nil {
		t.Fatalf("an unchanged shape was refused after its capture subscribed: %v", err)
	}
	if want := threePerson + capture; response.ReservedPackets != want || f.reserved() != want {
		t.Fatalf("reserved %d (node %d), want %d", response.ReservedPackets, f.reserved(), want)
	}
}

// A subscription that ends after its Episode was re-reserved returns its share to the new hold,
// so the Episode is still promised its whole capture bound and no other Episode can take it.
func TestASubscriptionEndingAfterAReReserveReturnsItsShareToTheNewHold(t *testing.T) {
	capture := 3 * (2*300 + 50)
	f := newReserveNode(t, func(cfg *config.Config) { cfg.PacketBudget = threePerson + capture })
	request := reserveRequest("one", 3)
	request.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(request); err != nil {
		t.Fatal(err)
	}
	session := f.addCaptureSession(t, "one")
	lease, err := f.node.reserveCapture(session, 300)
	if err != nil {
		t.Fatal(err)
	}
	again := reserveRequest("one", 3)
	again.Shape.CaptureSlots = 1
	if _, err := f.node.ReserveEpisode(again); err != nil {
		t.Fatal(err)
	}
	if got := f.heldCapture("one"); got != capture-300 {
		t.Fatalf("the new hold keeps %d for captures, want %d", got, capture-300)
	}
	f.node.releaseCapture(session, lease)
	if got, want := f.heldCapture("one"), capture; got != want || f.reserved() != threePerson+capture {
		t.Fatalf("after the subscription ended the hold keeps %d (want %d) and the node reserves %d (want %d)", got, want, f.reserved(), threePerson+capture)
	}
}
