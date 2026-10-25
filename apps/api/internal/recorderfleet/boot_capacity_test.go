package recorderfleet

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

type delayedSlotBootstrap struct {
	*fakeBootstrap
	bootableAt map[string]int
	tick       *int
}

func (b *delayedSlotBootstrap) EnsureBootstrap(ctx context.Context, request BootstrapRequest) (NodeIdentity, error) {
	if at, ok := b.bootableAt[request.ProviderID]; !ok || *b.tick < at {
		return NodeIdentity{}, fmt.Errorf("%w: provider node status is new", ErrInventoryNotReady)
	}
	return b.fakeBootstrap.EnsureBootstrap(ctx, request)
}

type slotReplayRun struct {
	peak, creates, deletes, settled, closes int
	trace                                   []int
	readySlots                              []int
}

// coldStart replays a zero-demand free-slot floor where a droplet needs
// bootDelay reconcile ticks before the worker can register.
func runSlowSlotReplay(t *testing.T, slots, free, maxNodes, bootDelay, ticks int, demand func(int) Demand) slotReplayRun {
	return runSlotReplay(t, slots, free, maxNodes, bootDelay, ticks, 10*time.Second, demand)
}

func runSlotReplay(t *testing.T, slots, free, maxNodes, bootDelay, ticks int, step time.Duration, demand func(int) Demand) slotReplayRun {
	t.Helper()
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.FreeSlots, f.config.MaxNodes = slots, free, maxNodes
	f.config.StartupTimeout = time.Hour
	f.config.Now = func() time.Time { return f.now }
	f.provider.config = f.config
	tick := 0
	bootstrap := &delayedSlotBootstrap{fakeBootstrap: f.bootstrap, bootableAt: map[string]int{}, tick: &tick}
	r, err := NewReconciler(f.config, f.demand, f.journal, f.provider, bootstrap, f.runtime)
	if err != nil {
		t.Fatal(err)
	}
	run := slotReplayRun{}
	for tick = 0; tick < ticks; tick++ {
		f.now = f.now.Add(step)
		f.demand.value = demand(tick)
		f.demand.value.ObservedAt = f.now
		active := 0
		if f.demand.value.CaptureCapacity != nil {
			active = f.demand.value.CaptureCapacity.SlotDemand
		}
		f.runtime.observations = nil
		for _, id := range sortedNodeIDs(f.provider.nodes) {
			if _, ok := bootstrap.bootableAt[id]; !ok {
				bootstrap.bootableAt[id] = tick + bootDelay
			}
			managed := f.journal.state.Nodes[id]
			if managed.Identity == nil {
				continue
			}
			ready := managed.Phase == PhaseBootstrapping || managed.Phase == PhaseReady
			leases := 0
			if ready {
				leases = min(slots, active)
				active -= leases
			}
			f.runtime.observations = append(f.runtime.observations, NodeObservation{Identity: *managed.Identity, Ready: ready, AdmissionOpen: ready, ReadyCapacity: slots, ActiveLeases: leases, ObservedAt: f.now, LeasesObservedAt: f.now})
		}
		before := f.runtime.closeCalls
		_, err := r.Reconcile(context.Background())
		if err != nil && !errors.Is(err, ErrBootstrapPending) && !errors.Is(err, ErrInventoryNotReady) {
			t.Fatalf("tick %d: %v", tick, err)
		}
		run.closes += f.runtime.closeCalls - before
		run.peak = max(run.peak, len(f.provider.nodes))
		run.trace = append(run.trace, len(f.provider.nodes))
		readySlots := 0
		for _, managed := range f.journal.state.Nodes {
			if managed.Phase == PhaseReady {
				readySlots += slots
			}
		}
		run.readySlots = append(run.readySlots, readySlots)
	}
	run.creates, run.deletes, run.settled = f.provider.ensureCalls, f.provider.deleteCalls, len(f.provider.nodes)
	return run
}

func emptySlotDemand(int) Demand {
	return Demand{Revision: "zero", CaptureCapacity: &CaptureCapacityDemand{}}
}

func TestCaptureColdStartFreeSlotFloorPeak(t *testing.T) {
	for _, tc := range []struct{ slots, free, cap, delay int }{
		{1, 0, 10, 6},
		{1, 2, 10, 6},
		{4, 8, 5, 6},
		{4, 8, 10, 6},
		{8, 8, 10, 6},
		{4, 8, 5, 0},
	} {
		t.Run(fmt.Sprintf("N=%d/F=%d/cap=%d/boot=%d", tc.slots, tc.free, tc.cap, tc.delay), func(t *testing.T) {
			run := runSlowSlotReplay(t, tc.slots, tc.free, tc.cap, tc.delay, 80, emptySlotDemand)
			floor := 0
			if tc.free > 0 {
				floor = (tc.free + tc.slots - 1) / tc.slots
			}
			t.Logf("settled floor=%d peak=%d settled=%d creates=%d deletes=%d closes=%d trace=%v", floor, run.peak, run.settled, run.creates, run.deletes, run.closes, run.trace)
			if run.peak > tc.cap {
				t.Fatalf("exceeded cap")
			}
			if run.settled != floor {
				t.Fatalf("settled=%d want %d", run.settled, floor)
			}
			if run.peak != floor || run.creates != floor || run.deletes != 0 || run.settled != floor {
				t.Errorf("cold start overshoots the settled floor %d to %d nodes (creates=%d deletes=%d)", floor, run.peak, run.creates, run.deletes)
			}
		})
	}
}

// One recording arrives with a warm floor already settled; a burst then
// overshoots the target while new droplets boot.
func TestCaptureBurstWithBootDelay(t *testing.T) {
	demand := func(tick int) Demand {
		active := 0
		switch {
		case tick >= 40 && tick < 80:
			active = 9
		case tick >= 80:
			active = 0
		}
		return Demand{Revision: fmt.Sprint("d", active), DesiredNodes: active, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: active}}
	}
	run := runSlowSlotReplay(t, 4, 8, 10, 6, 140, demand)
	t.Logf("peak=%d settled=%d creates=%d deletes=%d trace=%v", run.peak, run.settled, run.creates, run.deletes, run.trace)
	// settled target with 9 active: ceil(17/4)=5; final: 2.
	if run.settled != 2 {
		t.Fatalf("settled=%d", run.settled)
	}
	if run.peak > 5 {
		t.Errorf("burst of 9 overshoots ceil((9+8)/4)=5 to %d nodes", run.peak)
	}
}

// The command fast-follows progress actions every 100 ms, and a droplet takes
// 46-76 s to boot, so roughly 600 reconcile steps pass before registration.
func TestCaptureColdStartAtCommandCadence(t *testing.T) {
	for _, tc := range []struct{ slots, free, cap int }{{1, 2, 10}, {4, 8, 5}, {4, 8, 10}, {8, 8, 10}} {
		t.Run(fmt.Sprintf("N=%d/F=%d/cap=%d", tc.slots, tc.free, tc.cap), func(t *testing.T) {
			run := runSlotReplay(t, tc.slots, tc.free, tc.cap, 600, 900, 100*time.Millisecond, emptySlotDemand)
			floor := (tc.free + tc.slots - 1) / tc.slots
			t.Logf("floor=%d peak=%d settled=%d creates=%d deletes=%d", floor, run.peak, run.settled, run.creates, run.deletes)
			if run.peak != floor || run.creates != floor || run.deletes != 0 || run.settled != floor {
				t.Errorf("cold start at command cadence boots %d droplets for a %d-node floor", run.peak, floor)
			}
		})
	}
}

func TestMixedCaptureDensityBootstrapsPlannedCapacity(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.StartupTimeout = 4, time.Hour
	f.config.Now = func() time.Time { return f.now }
	f.provider.config = f.config
	state, nodes, observations := slotNodes(f, 2, 1)
	state.NextBootGeneration = 3
	f.journal.state, f.journal.found, f.provider.nodes = state, true, nodes
	for _, observation := range observations {
		observation.ActiveLeases = 1
		f.runtime.observations = append(f.runtime.observations, observation)
	}
	f.demand.value = Demand{Revision: "mixed", DesiredNodes: 4, ObservedAt: f.now, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: 4}}
	r := f.reconciler(t)
	if result := f.step(t, r); result.Action != ActionCreatePlanned {
		t.Fatalf("initial action: %+v", result)
	}
	f.bootstrap.ensureErr = ErrInventoryNotReady
	if result := f.step(t, r); result.Action != ActionNodeEnsured {
		t.Fatalf("ensure action: %+v", result)
	}
	f.bootstrap.ensureErr = nil
	var result Result
	for range 20 {
		f.now = f.now.Add(time.Second)
		f.demand.value.ObservedAt = f.now
		for _, id := range sortedManagedNodeIDs(f.journal.state.Nodes) {
			managed := f.journal.state.Nodes[id]
			if id == "1" || id == "2" || managed.Identity == nil {
				continue
			}
			found := false
			for _, observation := range f.runtime.observations {
				if observation.Identity.ProviderID == id {
					found = true
				}
			}
			if !found {
				f.runtime.observations = append(f.runtime.observations, NodeObservation{Identity: *managed.Identity, Ready: true, AdmissionOpen: true, ReadyCapacity: 4})
			}
		}
		for i := range f.runtime.observations {
			f.runtime.observations[i].ObservedAt, f.runtime.observations[i].LeasesObservedAt = f.now, f.now
		}
		result = f.step(t, r)
	}
	if result.Projection.ReadyCapacity < 4 {
		t.Fatalf("demand=4 ready=%d nodes=%d bootstrap calls=%d new node phase=%s target=%d", result.Projection.ReadyCapacity, len(f.provider.nodes), f.bootstrap.ensureCalls, f.journal.state.Nodes["node-1"].Phase, r.targetNodes(f.demand.value, f.journal.state, f.provider.nodes, observations, f.now))
	}
	t.Logf("demand=4 ready=%d nodes=%d bootstrap calls=%d", result.Projection.ReadyCapacity, len(f.provider.nodes), f.bootstrap.ensureCalls)
}
