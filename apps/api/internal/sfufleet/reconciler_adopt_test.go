package sfufleet

import (
	"errors"
	"net/netip"
	"testing"
	"time"
)

func TestWindowReconcilerAdoptsUnconfirmedCreateByProviderID(t *testing.T) {
	f := newWindowFixture(t)
	f.state.Demand = Demand{LiveSlots: 5, Bookings: []Booking{{StartsAt: f.state.ObservedAt.Add(time.Minute), EndsAt: f.state.ObservedAt.Add(time.Hour), Participants: 3}}}
	f.createErr = errors.New("shape not confirmed in create reply")
	f.createID = 123
	if _, err := f.reconciler.Reconcile(t.Context()); !errors.Is(err, f.createErr) {
		t.Fatalf("unconfirmed create: %v", err)
	}
	if node := f.state.Nodes[0]; node.Phase != Starting || node.ProviderID != 123 {
		t.Fatalf("node=%+v, want starting with provider ID 123", node)
	}
	f.droplet = Droplet{ID: 123, Address: netip.MustParseAddr("192.0.2.9"), Active: true}
	f.health = Health{Incarnation: "first-boot", Admission: true}
	f.reconcile(t, Starting, Serving)
	if f.observes != 0 || f.inspects == 0 {
		t.Fatalf("observes=%d inspects=%d, want adoption by Inspect only", f.observes, f.inspects)
	}
	if f.creates != 1 {
		t.Fatalf("repeated a possibly committed create: %d POSTs", f.creates)
	}
}

func TestWindowReconcilerConfirmsAdoptedCreateByInspect(t *testing.T) {
	f := newWindowFixture(t)
	f.state.Demand = Demand{LiveSlots: 5, Bookings: []Booking{{StartsAt: f.state.ObservedAt.Add(time.Minute), EndsAt: f.state.ObservedAt.Add(time.Hour), Participants: 3}}}
	f.createErr = errors.New("lost create reply")
	if _, err := f.reconciler.Reconcile(t.Context()); !errors.Is(err, f.createErr) {
		t.Fatalf("ambiguous create: %v", err)
	}
	address := netip.MustParseAddr("192.0.2.9")
	f.droplet = Droplet{ID: 123, Address: address, Active: true, Outdated: true}
	confirmed := Droplet{ID: 123, Address: address, Active: true}
	f.inspectDroplet = &confirmed
	f.reconcile(t, Starting)
	if node := f.state.Nodes[0]; node.ProviderID != 123 || node.Phase != Starting {
		t.Fatalf("node=%+v, want adopted starting node", node)
	}
	if f.destroyed != 0 || f.inspects != 1 {
		t.Fatalf("destroyed=%d inspects=%d, want one by-ID read and no delete", f.destroyed, f.inspects)
	}
	f.health = Health{Incarnation: "first-boot", Admission: true}
	f.reconcile(t, Serving)
	if f.creates != 1 || f.destroyed != 0 {
		t.Fatalf("creates=%d destroyed=%d", f.creates, f.destroyed)
	}
}

func TestWindowReconcilerDeletesOutdatedAdoptedCreateAfterInspect(t *testing.T) {
	f := newWindowFixture(t)
	f.state.Demand = Demand{LiveSlots: 5, Bookings: []Booking{{StartsAt: f.state.ObservedAt.Add(time.Minute), EndsAt: f.state.ObservedAt.Add(time.Hour), Participants: 3}}}
	f.createErr = errors.New("lost create reply")
	if _, err := f.reconciler.Reconcile(t.Context()); !errors.Is(err, f.createErr) {
		t.Fatalf("ambiguous create: %v", err)
	}
	f.state.Demand = Demand{}
	f.droplet = Droplet{ID: 123, Address: netip.MustParseAddr("192.0.2.9"), Active: true, Outdated: true}
	f.reconcile(t, Deleting, Deleted)
	if f.destroyed != 123 {
		t.Fatalf("destroyed=%d, want the confirmed outdated Droplet 123", f.destroyed)
	}
}
