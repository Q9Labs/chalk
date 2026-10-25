package recorderfleet

import (
	"fmt"
	"testing"
	"time"
)

func TestWorkerCapacityUsesProtocolBound(t *testing.T) {
	f := newFleetFixture(t)
	_, nodes, observations := slotNodes(f, 1, 1)
	for _, capacity := range []int{-1, 1, 4, 100, 101} {
		t.Run(fmt.Sprint(capacity), func(t *testing.T) {
			observation := observations["1"]
			observation.ReadyCapacity = capacity
			if err := observation.Validate(f.config.Key, nodes["1"]); (err == nil) != (capacity >= 0 && capacity <= 100) {
				t.Fatalf("capacity=%d: %v", capacity, err)
			}
		})
	}
}

func TestLowerCaptureDensityKeepsLiveWorkersAndDrainsOnlyIdle(t *testing.T) {
	f := newFleetFixture(t)
	f.config.SlotsPerNode, f.config.MaxNodes = 4, 10
	state, nodes, observations := slotNodes(f, 2, 4)
	state.NextBootGeneration = 3
	f.journal.state, f.journal.found, f.provider.nodes = state, true, nodes
	for _, observation := range observations {
		observation.ActiveLeases = 4
		f.runtime.observations = append(f.runtime.observations, observation)
	}
	f.config.SlotsPerNode = 1
	f.config.Now = func() time.Time { return f.now }
	f.provider.config = f.config
	r := f.reconciler(t)
	demand := 8
	step := func() Result {
		t.Helper()
		f.now = f.now.Add(time.Second)
		f.demand.value = Demand{Revision: "density-rollback", DesiredNodes: demand, ObservedAt: f.now, CaptureCapacity: &CaptureCapacityDemand{SlotDemand: demand}}
		for i := range f.runtime.observations {
			f.runtime.observations[i].ObservedAt = f.now
			f.runtime.observations[i].LeasesObservedAt = f.now
		}
		return f.step(t, r)
	}
	for range 5 {
		step()
	}
	if f.runtime.closeCalls != 0 || f.provider.ensureCalls != 0 {
		t.Fatal("density rollback moved live Recordings")
	}
	demand = 10
	for range 12 {
		step()
	}
	if f.provider.ensureCalls != 2 || len(f.provider.nodes) != 4 {
		t.Fatalf("new nodes must supply one slot each: creates=%d nodes=%d", f.provider.ensureCalls, len(f.provider.nodes))
	}
	for id, managed := range f.journal.state.Nodes {
		if id == "1" || id == "2" {
			continue
		}
		if managed.Identity == nil {
			t.Fatal("new node never registered")
		}
		f.runtime.observations = append(f.runtime.observations, NodeObservation{Identity: *managed.Identity, Ready: true, AdmissionOpen: true, ReadyCapacity: 1, ActiveLeases: 1})
	}
	for range 6 {
		step()
	}
	demand = 6
	for range 5 {
		step()
	}
	if f.runtime.closeCalls != 0 || f.provider.deleteCalls != 0 || f.bootstrap.revokeCalls != 0 {
		t.Fatal("live four-slot worker was drained")
	}
	old := 0
	for i, observation := range f.runtime.observations {
		if observation.Identity.ProviderID == "1" {
			old = i
		}
	}
	f.runtime.observations[old].ActiveLeases = 0
	for _, leaseTime := range []time.Time{{}, f.now.Add(-time.Hour), f.now.Add(time.Hour)} {
		f.runtime.observations[old].ObservedAt = f.now
		f.runtime.observations[old].LeasesObservedAt = leaseTime
		if _, err := r.Reconcile(t.Context()); err != nil {
			t.Fatal(err)
		}
		if f.runtime.closeCalls != 0 {
			t.Fatal("uncertain lease evidence closed admission")
		}
	}
	if result := step(); result.Action != ActionAdmissionClosed || result.ProviderNodeID != "1" {
		t.Fatalf("idle old worker did not close: %+v", result)
	}
	f.runtime.observations[old].ActiveLeases = 1
	step()
	if f.bootstrap.revokeCalls != 0 || f.provider.deleteCalls != 0 {
		t.Fatal("late lease did not fence old-worker removal")
	}
	f.runtime.observations[old].ActiveLeases = 0
	if result := step(); result.Action != ActionIdentityRevoked || result.ProviderNodeID != "1" {
		t.Fatalf("idle old worker did not revoke: %+v", result)
	}
	if result := step(); result.Action != ActionNodeDeleted || result.ProviderNodeID != "1" {
		t.Fatalf("idle old worker did not delete: %+v", result)
	}
	if _, ok := f.provider.nodes["2"]; !ok || f.provider.ensureCalls != 2 {
		t.Fatal("surviving four-slot worker or new one-slot nodes changed")
	}
}
