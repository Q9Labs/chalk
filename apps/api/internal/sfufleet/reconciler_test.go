package sfufleet

import (
	"context"
	"errors"
	"net/netip"
	"slices"
	"testing"
	"time"
)

func TestWindowReconcilerKeepsLiveBindingsAndConfirmsDrain(t *testing.T) {
	f := newWindowFixture(t)
	address := netip.MustParseAddr("192.0.2.9")
	f.state.Nodes = []Node{{
		ID: "window-node", ProviderID: 123, Address: address, Phase: Serving, CreatedAt: f.state.ObservedAt.Add(-time.Hour),
	}}
	f.health = Health{Incarnation: "first-boot", Admission: true, Allocations: 2}
	f.bound = true
	f.reconcile(t, Draining, Draining)
	if f.health.Draining {
		t.Fatal("the node no longer accepts media for its live Episode")
	}

	// An Episode can be live before it has any SFU sessions, for example
	// between creation and the first media join. A zero SFU count is not enough.
	f.health.Allocations = 0
	f.reconcile(t, Draining, Draining, Draining)

	f.bound = false
	f.reconcile(t, Draining)
	if !f.health.Draining {
		t.Fatal("the node did not drain after its last Episode ended")
	}
	f.healthErr = errors.New("single missed probe")
	f.reconcile(t, Draining)
	f.healthErr = nil
	f.reconcile(t, Draining)
	f.health.Incarnation = "second-boot"
	f.reconcile(t, Draining)
	f.reconcile(t, Deleting, Deleted)
	if f.destroyed != 123 {
		t.Fatalf("deleted Droplet %d, want 123", f.destroyed)
	}
}

func TestWindowReconcilerAdoptsAnAmbiguousCreate(t *testing.T) {
	f := newWindowFixture(t)
	f.state.Demand = Demand{LiveSlots: 5, Bookings: []Booking{{StartsAt: f.state.ObservedAt.Add(time.Minute), EndsAt: f.state.ObservedAt.Add(time.Hour), Participants: 3}}}
	f.createErr = errors.New("lost create reply")
	if _, err := f.reconciler.Reconcile(t.Context()); !errors.Is(err, f.createErr) {
		t.Fatalf("ambiguous create: %v", err)
	}
	f.reconcile(t, Starting)
	f.droplet = Droplet{ID: 123, Address: netip.MustParseAddr("192.0.2.9"), Active: true}
	f.health = Health{Incarnation: "first-boot", Admission: true}
	f.reconcile(t, Starting, Serving, Serving)
	if f.creates != 1 {
		t.Fatalf("repeated a possibly committed create: %d POSTs", f.creates)
	}
}

func TestWindowReconcilerStopsCreatingAtBudget(t *testing.T) {
	f := newWindowFixture(t)
	f.state.Demand.LiveSlots = 20
	f.state.NodeTime = 900 * time.Hour
	result, err := f.reconciler.Reconcile(t.Context())
	if err != nil || !result.BudgetLimited || len(f.state.Nodes) != 0 || f.creates != 0 {
		t.Fatalf("result=%+v creates=%d err=%v", result, f.creates, err)
	}
}

type windowFixture struct {
	reconciler *Reconciler
	state      Snapshot
	health     Health
	healthErr  error
	bound      bool
	droplet    Droplet
	createErr  error
	creates    int
	destroyed  int64
}

func newWindowFixture(t *testing.T) *windowFixture {
	t.Helper()
	f := &windowFixture{state: Snapshot{ObservedAt: time.Now()}}
	var err error
	f.reconciler, err = NewReconciler(Policy{
		Application: "test", Capacity: Capacity{StandingSlots: 8, SlotsPerNode: 4, SpareSlots: 4, MaxNodes: 6},
		MonthlyNodeTime: 900 * time.Hour,
	}, f, fakeWindowProvider{f}, f)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *windowFixture) reconcile(t *testing.T, phases ...Phase) {
	t.Helper()
	for _, phase := range phases {
		f.state.ObservedAt = f.state.ObservedAt.Add(ReconcileEvery)
		_, err := f.reconciler.Reconcile(t.Context())
		if !errors.Is(err, f.healthErr) {
			t.Fatalf("got %v, want %v", err, f.healthErr)
		}
		if len(f.state.Nodes) != 1 || f.state.Nodes[0].Phase != phase {
			t.Fatalf("got %+v, want one %s node", f.state.Nodes, phase)
		}
		if phase != Deleted && f.destroyed != 0 {
			t.Fatalf("deleted Droplet %d while %s", f.destroyed, phase)
		}
	}
}

func (f *windowFixture) Load(context.Context, string, time.Duration, int) (Snapshot, error) {
	state := f.state
	state.Nodes = slices.Clone(state.Nodes)
	return state, nil
}

func (f *windowFixture) Reserve(_ context.Context, _, id string, _ int) error {
	f.state.Nodes = append(f.state.Nodes, Node{ID: id, Phase: Starting, CreatedAt: f.state.ObservedAt})
	return nil
}

func (f *windowFixture) Save(_ context.Context, id string, from Phase, node Node) error {
	for i, existing := range f.state.Nodes {
		if existing.ID == id && existing.Phase == from {
			f.state.Nodes[i] = node
			return nil
		}
	}
	return errors.New("journal did not have the requested node")
}

func (f *windowFixture) ForgetIntent(context.Context, string) error {
	f.state.Nodes = nil
	return nil
}

func (f *windowFixture) Unbound(context.Context, string) (bool, error) { return !f.bound, nil }

func (f *windowFixture) Observe(context.Context, netip.Addr) (Health, error) {
	return f.health, f.healthErr
}

func (f *windowFixture) SetDrain(_ context.Context, _ netip.Addr, drain bool) error {
	f.health.Draining = drain
	return nil
}

type fakeWindowProvider struct{ f *windowFixture }

func (p fakeWindowProvider) Create(context.Context, string) (bool, error) {
	p.f.creates++
	return true, p.f.createErr
}

func (p fakeWindowProvider) Observe(context.Context, string) (Droplet, bool, error) {
	return p.f.droplet, p.f.droplet.ID > 0, nil
}

func (p fakeWindowProvider) Destroy(_ context.Context, _ string, id int64) error {
	p.f.destroyed = id
	return nil
}

func (p fakeWindowProvider) Gone(_ context.Context, _ string, id int64) (bool, error) {
	return id == p.f.destroyed, nil
}
