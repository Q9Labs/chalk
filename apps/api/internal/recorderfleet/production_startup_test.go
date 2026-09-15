package recorderfleet

import (
	"context"
	"errors"
	"testing"
)

func TestTenWorkerStartupSurvivesLostCreateIncompleteInventoryAndRestart(t *testing.T) {
	fixture := newFleetFixture(t)
	fixture.config.MaxNodes, fixture.config.SlotsPerNode = 10, 1
	fixture.provider.config = fixture.config
	fixture.demand.value.DesiredNodes = 10
	provider := &interruptedStartupProvider{fakeProvider: fixture.provider, loseCreate: true}
	newReconciler := func() *Reconciler {
		reconciler, err := NewReconciler(fixture.config, fixture.demand, fixture.journal, provider, fixture.bootstrap, fixture.runtime)
		if err != nil {
			t.Fatal(err)
		}
		return reconciler
	}
	reconciler := newReconciler()
	lostResponse, incompleteInventory := false, false
	for step := range 200 {
		provider.incomplete = step == 12
		before := provider.ensureCalls
		result, err := reconciler.Reconcile(context.Background())
		if provider.incomplete {
			if err == nil || provider.ensureCalls != before {
				t.Fatal("incomplete inventory allowed provisioning")
			}
			incompleteInventory = true
		} else if errors.Is(err, context.DeadlineExceeded) {
			lostResponse = true
		} else if err != nil {
			t.Fatal(err)
		}
		if len(provider.nodes) > 10 {
			t.Fatal("created more than ten workers")
		}
		if step == 8 || step == 17 {
			reconciler = newReconciler()
		}
		// Bootstrap is deliberately slow: no node reports ready before all ten
		// exist. Starting one node must not block provisioning the remaining nine.
		if len(provider.nodes) == 10 {
			fixture.runtime.observations = nil
			for _, managed := range fixture.journal.state.Nodes {
				if managed.Identity != nil {
					fixture.runtime.observations = append(fixture.runtime.observations, NodeObservation{Identity: *managed.Identity, Ready: true, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: fixture.now})
				}
			}
		}
		if result.Projection.ReadyCapacity == 10 {
			if !lostResponse || !incompleteInventory || provider.nextID != 10 {
				t.Fatal("startup did not exercise recovery without duplicates")
			}
			return
		}
	}
	t.Fatal("ten-worker startup did not converge")
}

type interruptedStartupProvider struct {
	*fakeProvider
	loseCreate bool
	incomplete bool
}

func (p *interruptedStartupProvider) EnsureNode(ctx context.Context, request EnsureNodeRequest) (Node, error) {
	node, err := p.fakeProvider.EnsureNode(ctx, request)
	if err == nil && p.loseCreate {
		p.loseCreate = false
		return Node{}, context.DeadlineExceeded
	}
	return node, err
}

func (p *interruptedStartupProvider) ListNodes(ctx context.Context, key PoolKey) ([]Node, error) {
	if p.incomplete {
		return nil, errors.New("inventory pagination incomplete")
	}
	return p.fakeProvider.ListNodes(ctx, key)
}
