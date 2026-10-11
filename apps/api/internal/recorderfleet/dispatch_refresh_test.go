package recorderfleet

import (
	"testing"
	"time"
)

func TestReadyHealthRefreshDoesNotDelayWaitingCaptureDispatch(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.Now = func() time.Time { return fixture.now }
	fixture.config.MaxNodes, fixture.config.SlotsPerNode = 10, 1
	fixture.provider.config = fixture.config
	reconciler := fixture.reconciler(t)
	for range 3 {
		fixture.step(t, reconciler)
	}
	node := fixture.provider.onlyNode(t)
	fixture.runtime.observations = []NodeObservation{{
		Identity: fixture.bootstrap.identity(node), Ready: true, AdmissionOpen: true,
		ReadyCapacity: 1, ActiveLeases: 1, ObservedAt: fixture.now,
	}}
	fixture.step(t, reconciler)

	fixture.demand.value.DesiredNodes = 2
	fixture.demand.value.QueuedJobs = 1
	fixture.now = fixture.now.Add(fixture.config.HealthRefresh)
	fixture.demand.value.ObservedAt = fixture.now
	fixture.runtime.observations[0].ObservedAt = fixture.now
	result := fixture.step(t, reconciler)
	if result.Action != ActionCreatePlanned {
		t.Fatalf("waiting Capture dispatch = %q, want %q, not a routine health refresh", result.Action, ActionCreatePlanned)
	}
	if got := fixture.journal.state.Nodes[node.ProviderID].LastReadyAt; got == nil || !got.Equal(fixture.now) {
		t.Fatalf("ready observation was not persisted: %v", got)
	}
}

func TestReadyHealthRefreshDoesNotTriggerAnotherProviderPoll(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.Now = func() time.Time { return fixture.now }
	reconciler := fixture.reconciler(t)
	for range 3 {
		fixture.step(t, reconciler)
	}
	node := fixture.provider.onlyNode(t)
	fixture.runtime.observations = []NodeObservation{{
		Identity: fixture.bootstrap.identity(node), Ready: true, AdmissionOpen: true,
		ReadyCapacity: fixture.config.SlotsPerNode, ObservedAt: fixture.now,
	}}
	fixture.step(t, reconciler)
	fixture.now = fixture.now.Add(fixture.config.HealthRefresh)
	fixture.demand.value.ObservedAt = fixture.now
	fixture.runtime.observations[0].ObservedAt = fixture.now
	result := fixture.step(t, reconciler)
	if result.Action != ActionNone && result.Action != ActionCapacityPublished {
		t.Fatalf("routine refresh must retain idle cadence, got %q", result.Action)
	}
}
