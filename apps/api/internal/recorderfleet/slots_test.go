package recorderfleet

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func TestSlotDefaultsMatchOneNodeDemand(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		for _, demand := range []int{0, 1, 2, 4, 8, 10, 11, 20} {
			for _, existing := range []int{0, 1, 4, 10} {
				t.Run(fmt.Sprintf("%s/demand=%d/existing=%d", role, demand, existing), func(t *testing.T) {
					f := newFleetFixture(t)
					f.config.Key.Role, f.config.SlotsPerNode, f.config.MaxNodes = role, 1, 10
					r := &Reconciler{config: f.config}
					state, nodes, observations := slotNodes(f, existing, 1)
					got := r.targetNodes(Demand{DesiredNodes: demand}, state, nodes, observations, f.now)
					if got != min(demand, 10) {
						t.Fatalf("default target=%d, master=%d", got, min(demand, 10))
					}
				})
			}
		}
	}
}

func TestCapturePhysicalFloorsAndLegacyDemand(t *testing.T) {
	for _, tc := range []struct {
		name            string
		demand          Demand
		free, cap, want int
	}{
		{"physical floor", Demand{DesiredNodes: 3, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: 2, PhysicalNodeFloor: 3}}, 0, 10, 3},
		{"free slots", Demand{DesiredNodes: 3, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: 2, PhysicalNodeFloor: 3}}, 12, 10, 4},
		{"cap", Demand{DesiredNodes: 3, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: 2, PhysicalNodeFloor: 3}}, 0, 2, 2},
		{"old API forces one slot", Demand{DesiredNodes: 3}, 0, 10, 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFleetFixture(t)
			f.config.SlotsPerNode, f.config.FreeSlots, f.config.MaxNodes = 4, tc.free, tc.cap
			state, nodes, observed := slotNodes(f, 2, 4)
			r := &Reconciler{config: f.config}
			if got := r.targetNodes(tc.demand, state, nodes, observed, f.now); got != tc.want {
				t.Fatalf("target=%d want=%d", got, tc.want)
			}
		})
	}
}

func TestDensityControllerReconcilesOldAPIDemandAtOneSlot(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode = 4
	f.demand.value = Demand{Revision: "legacy", DesiredNodes: 3, ObservedAt: f.now}
	state, nodes, observed := slotNodes(f, 2, 4)
	state.NextBootGeneration = 3
	f.journal.state, f.journal.found, f.provider.nodes = state, true, nodes
	for _, observation := range observed {
		f.runtime.observations = append(f.runtime.observations, observation)
	}
	if result := f.step(t, f.reconciler(t)); result.Action != ActionCreatePlanned {
		t.Fatalf("legacy API did not reconcile with one-slot capacity: %+v", result)
	}
}

func TestCaptureSlotDemandReplay(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.FreeSlots, f.config.MaxNodes = 4, 8, 5
	f.config.Now = func() time.Time { return f.now }
	f.provider.config = f.config
	r := f.reconciler(t)
	// Every event is followed by reconciliation to steady state. The floor
	// absorbs starts while the provider boots replacements; a burst beyond
	// eight available slots cannot have an instantaneous physical guarantee.
	for _, active := range []int{0, 1, 4, 8, 12, 9, 3, 0} {
		settled := false
		for range 100 {
			f.now = f.now.Add(time.Second)
			f.demand.value = Demand{Revision: fmt.Sprint(active), DesiredNodes: active, ObservedAt: f.now, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: active}}
			f.runtime.observations = nil
			remaining := active
			for _, id := range sortedNodeIDs(f.provider.nodes) {
				managed := f.journal.state.Nodes[id]
				if managed.Identity == nil {
					continue
				}
				leases := 0
				ready := managed.Phase == PhaseBootstrapping || managed.Phase == PhaseReady
				if ready {
					leases = min(4, remaining)
					remaining -= leases
				}
				f.runtime.observations = append(f.runtime.observations, NodeObservation{Identity: *managed.Identity, Ready: ready, AdmissionOpen: ready, ReadyCapacity: 4, ActiveLeases: leases, ObservedAt: f.now, LeasesObservedAt: f.now})
			}
			result := f.step(t, r)
			if len(f.provider.nodes) > f.config.MaxNodes {
				t.Fatal("fleet exceeded cap")
			}
			if result.Action == ActionNone || result.Action == ActionCapacityPublished {
				readySlots := 0
				for _, managed := range f.journal.state.Nodes {
					if managed.Phase == PhaseReady {
						readySlots += 4
					}
				}
				if readySlots-active < 8 {
					t.Fatalf("active=%d ready slots=%d: lost floor", active, readySlots)
				}
				if len(f.provider.nodes) != (active+8+3)/4 {
					t.Fatalf("active=%d nodes=%d", active, len(f.provider.nodes))
				}
				settled = true
				break
			}
		}
		if !settled {
			t.Fatalf("active=%d did not settle", active)
		}
	}
}

func TestSlotDemandCountsWorkerCapacityNotControllerConfig(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.FreeSlots = 4, 8
	r := &Reconciler{config: f.config}
	for _, tc := range []struct {
		name     string
		capacity int
		stale    bool
		want     int
	}{
		{"four-slot worker", 4, false, 3},
		{"old worker", 1, false, 4},
		{"unknown worker", 0, false, 4},
		{"stale worker", 4, true, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state, nodes, observed := slotNodes(f, 2, tc.capacity)
			if tc.stale {
				for id, observation := range observed {
					observation.ObservedAt = time.Time{}
					observation.Ready = false
					observed[id] = observation
				}
			}
			if got := r.targetNodes(Demand{DesiredNodes: 1, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: 1}}, state, nodes, observed, f.now); got != tc.want {
				t.Fatalf("target=%d want=%d", got, tc.want)
			}
		})
	}
}

func TestScaleDownRequiresFreshZeroBeforeClosingAdmission(t *testing.T) {
	for _, staleRelease := range []bool{false, true} {
		for _, evidence := range []string{"positive", "missing", "stale", "future", "fresh zero"} {
			t.Run(fmt.Sprintf("stale-release=%v/%s", staleRelease, evidence), func(t *testing.T) {
				f := claimedNodeFixture(t)
				if staleRelease {
					node := f.provider.nodes["1001"]
					node.Size = "old-size"
					f.provider.nodes["1001"] = node
					f.config.MaxNodes = 1
				}
				observation := &f.runtime.observations[0]
				observation.LeasesObservedAt = f.now
				switch evidence {
				case "positive":
					observation.ActiveLeases = 1
				case "missing":
					observation.LeasesObservedAt = time.Time{}
				case "stale":
					observation.LeasesObservedAt = f.now.Add(-f.config.ObservationMaxAge - time.Second)
				case "future":
					observation.LeasesObservedAt = f.now.Add(time.Nanosecond)
				}
				f.step(t, f.reconciler(t))
				want := 0
				if evidence == "fresh zero" {
					want = 1
				}
				if f.runtime.closeCalls != want || f.bootstrap.revokeCalls != 0 || f.provider.deleteCalls != 0 {
					t.Fatalf("close/revoke/delete=%d/%d/%d", f.runtime.closeCalls, f.bootstrap.revokeCalls, f.provider.deleteCalls)
				}
			})
		}
	}
}

func slotNodes(f *fleetFixture, count, capacity int) (Journal, map[string]Node, map[string]NodeObservation) {
	state := NewJournal()
	nodes := map[string]Node{}
	observed := map[string]NodeObservation{}
	for index := range count {
		id := fmt.Sprint(index + 1)
		node := f.provider.nodeFor(f.ensureRequest(uint64(index+1)), id)
		nodes[id] = node
		identity := f.bootstrap.identity(node)
		identity.Role = f.config.Key.Role
		state.Nodes[id] = ManagedNode{ProviderID: id, Name: node.Name, BootGeneration: uint64(index + 1), Identity: &identity, Phase: PhaseReady, LastReadyAt: &f.now}
		observed[id] = NodeObservation{Identity: identity, Ready: true, AdmissionOpen: true, ReadyCapacity: capacity, ObservedAt: f.now, LeasesObservedAt: f.now}
	}
	return state, nodes, observed
}

func TestSlotConfigRejectsInvalidDensityFloorAndCap(t *testing.T) {
	for _, tc := range []struct {
		slots, floor, cap int
		valid             bool
	}{{1, 0, 10, true}, {4, 8, 2, true}, {4, 8, 1, false}, {0, 0, 10, false}, {4, -1, 10, false}, {4, 8, 30, true}} {
		config := newFleetFixture(t).config
		config.SlotsPerNode, config.FreeSlots, config.MaxNodes = tc.slots, tc.floor, tc.cap
		if err := config.Validate(); (err == nil) != tc.valid {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
}

func TestDefaultFleetDecisionsMatchMasterScenarios(t *testing.T) {
	for _, role := range []workeridentity.Role{workeridentity.RoleCapture, workeridentity.RoleRender} {
		for _, tc := range []struct {
			name          string
			demand, nodes int
			want          Action
		}{
			{"empty", 0, 0, ActionCapacityPublished},
			{"cold start", 1, 0, ActionCreatePlanned},
			{"prewarm", 2, 1, ActionCreatePlanned},
			{"steady", 3, 3, ActionCapacityPublished},
			{"scale down", 1, 2, ActionAdmissionClosed},
			{"to zero", 0, 1, ActionAdmissionClosed},
			{"cap", 20, 10, ActionCapacityPublished},
		} {
			t.Run(string(role)+"/"+tc.name, func(t *testing.T) {
				f := newFleetFixture(t)
				f.config.Key.Role, f.config.SlotsPerNode, f.config.MaxNodes = role, 1, 10
				f.config.Release.Archive.Key = "recorder/" + string(role) + "/" + f.config.Release.Archive.SHA256 + ".tar.gz"
				f.provider.config = f.config
				state, nodes, observations := slotNodes(f, tc.nodes, 1)
				state.NextBootGeneration = uint64(tc.nodes + 1)
				f.journal.state, f.journal.found, f.provider.nodes = state, true, nodes
				for _, observation := range observations {
					f.runtime.observations = append(f.runtime.observations, observation)
				}
				f.demand.value = Demand{Revision: tc.name, DesiredNodes: tc.demand, ObservedAt: f.now}
				if result := f.step(t, f.reconciler(t)); result.Action != tc.want {
					t.Fatalf("default decision=%s master=%s", result.Action, tc.want)
				}
			})
		}
	}
}

func TestPendingBootstrapDoesNotBlockSibling(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode = 1
	f.provider.config = f.config
	f.demand.value.DesiredNodes = 2
	f.bootstrap.ensureErr = ErrBootstrapPending
	r := f.reconciler(t)
	for range 8 {
		if _, err := r.Reconcile(t.Context()); err != nil && !errors.Is(err, ErrBootstrapPending) {
			t.Fatal(err)
		}
	}
	if len(f.provider.nodes) != 2 {
		t.Fatalf("pending certificate blocked sibling create: %d nodes", len(f.provider.nodes))
	}
	for _, node := range f.journal.state.Nodes {
		if node.PendingBootstrap == nil {
			t.Fatal("sibling was never registered")
		}
	}
}

func TestMixedDensityPromotesNewReadyWorker(t *testing.T) {
	f := newFleetFixture(t)
	f.config.FreeSlots = 4
	f.demand.value = Demand{Revision: "floor", ObservedAt: f.now}
	state, nodes, observed := slotNodes(f, 2, 1)
	state.NextBootGeneration = 3
	newWorker := state.Nodes["2"]
	newWorker.Phase, newWorker.LastReadyAt = PhaseBootstrapping, nil
	state.Nodes["2"] = newWorker
	observation := observed["2"]
	observation.ReadyCapacity = 4
	observed["2"] = observation
	f.journal.state, f.journal.found, f.provider.nodes = state, true, nodes
	for _, observation := range observed {
		f.runtime.observations = append(f.runtime.observations, observation)
	}
	result := f.step(t, f.reconciler(t))
	if result.Action != ActionNodeReady || result.Projection.ReadyCapacity != 5 {
		t.Fatalf("new worker capacity hidden: %+v", result)
	}
}

func TestAdoptedWorkerIdentityIsRecoveredBeforeDrain(t *testing.T) {
	f := claimedNodeFixture(t)
	managed := f.journal.state.Nodes["1001"]
	managed.Identity, managed.LastReadyAt = nil, nil
	managed.Phase = PhaseAwaitingBootstrap
	f.journal.state.Nodes["1001"] = managed
	r := f.reconciler(t)
	result := f.step(t, r)
	if result.Action != ActionBootstrapEnsured || f.journal.state.Nodes["1001"].Identity == nil || f.runtime.closeCalls != 0 || f.provider.deleteCalls != 0 {
		t.Fatalf("adopted identity not recovered before drain: %+v", result)
	}
	f.step(t, r)
	result = f.step(t, r)
	if result.Action != ActionAdmissionClosed || f.runtime.closeCalls != 1 {
		t.Fatalf("recovered identity admission not closed: %+v", result)
	}
	f.runtime.observations[0].ActiveLeases = 1
	result = f.step(t, r)
	if result.Action != ActionDrainWaiting || f.bootstrap.revokeCalls != 0 || f.provider.deleteCalls != 0 {
		t.Fatalf("late claim lost: %+v", result)
	}
}
