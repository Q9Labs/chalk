package recorderfleet

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestDiagnosticNodeSurvivesWithoutDemand(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.demand.value.DesiredNodes = 0
	fixture.demand.value.ScheduledPrewarms = 0
	node := fixture.provider.nodeFor(fixture.ensureRequest(7), "7007")
	node.Tags = append(node.Tags, "chalk-recorder-diagnostic")
	node.CreatedAt = fixture.now.Add(-time.Hour)
	fixture.provider.nodes[node.ProviderID] = node
	reconciler := fixture.reconciler(t)
	for range 4 {
		fixture.step(t, reconciler)
	}
	if len(fixture.journal.state.Nodes) != 0 || fixture.provider.deleteCalls != 0 || fixture.bootstrap.ensureCalls != 0 || fixture.bootstrap.abandonCalls != 0 {
		t.Fatalf("diagnostic node entered fleet lifecycle: journal=%+v events=%v", fixture.journal.state, fixture.events)
	}
	if _, exists := fixture.provider.nodes[node.ProviderID]; !exists {
		t.Fatal("diagnostic node was deleted")
	}
}

func TestDiagnosticNodeDoesNotConsumeLiveCapacity(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes = 1
	node := fixture.provider.nodeFor(fixture.ensureRequest(7), "7007")
	node.Tags = append(node.Tags, "chalk-recorder-diagnostic")
	fixture.provider.nodes[node.ProviderID] = node
	result := fixture.step(t, fixture.reconciler(t))
	if result.Action != ActionCreatePlanned || fixture.journal.state.PendingCreate == nil || len(fixture.journal.state.Nodes) != 0 || result.Projection.ReadyCapacity != 0 {
		t.Fatalf("diagnostic node displaced live demand: result=%+v journal=%+v", result, fixture.journal.state)
	}
}

func TestDiagnosticTagDoesNotBypassInventoryFences(t *testing.T) {
	fixture := newFleetFixture(t)
	node := fixture.provider.nodeFor(fixture.ensureRequest(7), "7007")
	node.Tags = append(node.Tags, "chalk-recorder-diagnostic")
	node.Tags = slices.DeleteFunc(node.Tags, func(tag string) bool { return tag == fixture.config.OwnerTag })
	fixture.provider.nodes[node.ProviderID] = node
	result, err := fixture.reconciler(t).Reconcile(context.Background())
	if !errors.Is(err, ErrInventoryDrift) || !slices.Equal(result.Quarantined, []string{node.ProviderID}) {
		t.Fatalf("foreign diagnostic node escaped inventory fences: result=%+v error=%v", result, err)
	}
}

func TestDiagnosticTagCannotHideManagedNode(t *testing.T) {
	fixture := newFleetFixture(t)
	reconciler := fixture.reconciler(t)
	fixture.step(t, reconciler)
	fixture.step(t, reconciler)
	node := fixture.provider.onlyNode(t)
	node.Tags = append(node.Tags, "chalk-recorder-diagnostic")
	fixture.provider.nodes[node.ProviderID] = node
	result := fixture.step(t, reconciler)
	if result.Action != ActionBootstrapEnsured || fixture.bootstrap.ensureCalls != 1 {
		t.Fatalf("managed node escaped lifecycle: result=%+v events=%v", result, fixture.events)
	}
}

func TestDiagnosticTagCannotHidePendingCreate(t *testing.T) {
	fixture := newFleetFixture(t)
	reconciler := fixture.reconciler(t)
	fixture.step(t, reconciler)
	node := fixture.provider.nodeFor(fixture.journal.state.PendingCreate.Request, "7007")
	node.Tags = append(node.Tags, "chalk-recorder-diagnostic")
	fixture.provider.nodes[node.ProviderID] = node
	result := fixture.step(t, reconciler)
	if result.Action != ActionNodeEnsured || fixture.journal.state.Nodes[node.ProviderID].ProviderID != node.ProviderID {
		t.Fatalf("pending create escaped lifecycle: result=%+v journal=%+v", result, fixture.journal.state)
	}
}
