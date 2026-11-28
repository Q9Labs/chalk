package recorderfleet

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

type deletingFixture struct {
	exists    bool
	published []PoolProjection
	journal   Journal
}

func (f *deletingFixture) GetDemand(context.Context, PoolKey) (Demand, error) {
	return Demand{Revision: "demand-1", ObservedAt: time.Now()}, nil
}
func (f *deletingFixture) NodeExists(context.Context, PoolKey, string) (bool, error) {
	return f.exists, nil
}
func (f *deletingFixture) ListNodes(context.Context, PoolKey) ([]Node, error) { return nil, nil }
func (f *deletingFixture) EnsureNode(context.Context, EnsureNodeRequest) (Node, error) {
	return Node{}, errors.New("unexpected create")
}
func (f *deletingFixture) DeleteNode(context.Context, DeleteNodeRequest) error { return nil }
func (f *deletingFixture) EnsureBootstrap(context.Context, BootstrapRequest) (NodeIdentity, error) {
	return NodeIdentity{}, errors.New("unexpected bootstrap")
}
func (f *deletingFixture) AbandonBootstrap(context.Context, BootstrapRequest) error { return nil }
func (f *deletingFixture) RevokeIdentity(context.Context, NodeIdentity) error       { return nil }
func (f *deletingFixture) ObserveNodes(context.Context, PoolKey) ([]NodeObservation, error) {
	return nil, nil
}
func (f *deletingFixture) CloseAdmission(context.Context, NodeIdentity) error { return nil }
func (f *deletingFixture) PublishPool(_ context.Context, projection PoolProjection) error {
	f.published = append(f.published, projection)
	return nil
}
func (f *deletingFixture) Load(context.Context, PoolKey) (Journal, error) { return f.journal, nil }
func (f *deletingFixture) Save(_ context.Context, _ PoolKey, _ uint64, state Journal) (Journal, error) {
	f.journal = state
	return state, nil
}

func newDeletingReconciler(t *testing.T, fixture *deletingFixture) *Reconciler {
	t.Helper()
	sha := strings.Repeat("a", 64)
	reconciler, err := NewReconciler(Config{
		Key:      PoolKey{Environment: "production", Role: workeridentity.RoleCapture},
		OwnerTag: "chalk-owner", MaxNodes: 2, SlotsPerNode: 1,
		DemandMaxAge: time.Minute, ObservationMaxAge: time.Minute, StartupTimeout: time.Hour,
		DrainTimeout: time.Hour, HealthRefresh: time.Minute,
		Release: ReleaseSpec{
			ReleaseID: "release-1", ImageID: 1, ImageDigest: "sha256:" + sha,
			Archive: ArchiveSpec{Bucket: "chalk-archive", Key: "recorder/capture/" + sha + ".tar.gz", SHA256: sha, Region: "nyc3"},
			Region:  "nyc3", Size: "s-2vcpu-4gb", FirewallID: "firewall-1", BootstrapEndpoint: "https://bootstrap.example.test",
		},
	}, fixture, fixture, fixture, fixture, fixture)
	if err != nil {
		t.Fatal(err)
	}
	return reconciler
}

func TestDeletingNodeStillServedByProviderIsNotDrift(t *testing.T) {
	journal := NewJournal()
	journal.Nodes["624282174"] = ManagedNode{ProviderID: "624282174", Name: "recorder-1", Phase: PhaseDeleting, BootGeneration: 1}
	fixture := &deletingFixture{exists: true, journal: journal}
	reconciler := newDeletingReconciler(t, fixture)

	if _, err := reconciler.Reconcile(context.Background()); err != nil {
		t.Fatalf("a node whose delete was issued must not fail the pass while the provider still serves it: %v", err)
	}
	if _, kept := fixture.journal.Nodes["624282174"]; !kept {
		t.Fatal("the journal row must stay until the provider confirms the node is gone")
	}

	fixture.exists = false
	result, err := reconciler.Reconcile(context.Background())
	if err != nil || result.Action != ActionMissingNodeReconciled {
		t.Fatalf("a confirmed 404 must retire the row: action=%q err=%v", result.Action, err)
	}
}

func TestMissingReadyNodeStillServedByProviderIsDrift(t *testing.T) {
	journal := NewJournal()
	journal.Nodes["624282174"] = ManagedNode{ProviderID: "624282174", Name: "recorder-1", Phase: PhaseAwaitingBootstrap, BootGeneration: 1}
	fixture := &deletingFixture{exists: true, journal: journal}

	if _, err := newDeletingReconciler(t, fixture).Reconcile(context.Background()); !errors.Is(err, ErrInventoryDrift) {
		t.Fatalf("a node we never asked to delete that vanishes from the list is real drift: %v", err)
	}
}
