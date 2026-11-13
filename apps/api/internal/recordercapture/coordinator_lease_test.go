package recordercapture

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

func TestCoordinatorBoundsNegotiationLoop(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{pullNegotiation: offerNeeded("provider-0"), repeatOffer: true}
	peer := &fakePeer{offer: captureplane.Negotiation{ID: "provider-0", Requirement: captureplane.NegotiationOfferNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{MaxNegotiationRounds: 2})
	if _, err := coordinator.Bootstrap(context.Background(), plan); !errors.Is(err, ErrNegotiationLoop) {
		t.Fatalf("bootstrap error = %v", err)
	}
	if len(signaling.renegotiateIDs) != 2 {
		t.Fatalf("renegotiations = %#v", signaling.renegotiateIDs)
	}
}

func TestCoordinatorRenewLeaseCarriesIntoLaterCommands(t *testing.T) {
	attempt := newAttempt(t)
	initial := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{Now: func() time.Time { return coordinatorNow }})
	if _, err := coordinator.Bootstrap(context.Background(), initial); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	renewed := capturesignaling.WorkerLease{Owner: attempt.Lease.Owner, Token: attempt.Lease.Token, ExpiresAt: coordinatorNow.Add(2 * time.Hour)}
	if err := coordinator.RenewLeaseAt(renewed, coordinatorNow); err != nil {
		t.Fatalf("renew lease: %v", err)
	}
	if _, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, 2, []planTrack{{name: "two"}})); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(signaling.leases) == 0 || !signaling.leases[len(signaling.leases)-1].Equal(renewed.ExpiresAt) {
		t.Fatalf("last lease expiry = %v, want %v", signaling.leases, renewed.ExpiresAt)
	}
	if err := coordinator.RenewLeaseAt(renewed, coordinatorNow); err != nil {
		t.Fatalf("idempotent renewal: %v", err)
	}
}

func TestCoordinatorRejectsExpiredDeadlineAndWrongExecutionKey(t *testing.T) {
	attempt := newAttempt(t)
	attempt.HardDeadline = coordinatorNow
	if _, err := NewCoordinator(attempt, &fakeSignaling{}, &fakePeer{}, Config{Now: func() time.Time { return coordinatorNow }}); !errors.Is(err, ErrDeadlineExpired) {
		t.Fatalf("expired deadline error = %v", err)
	}

	attempt = newAttempt(t)
	coordinator := newCoordinator(t, attempt, &fakeSignaling{wrongKey: true}, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), newPlan(t, attempt, 1, []planTrack{{name: "one"}})); !errors.Is(err, ErrProtocol) {
		t.Fatalf("wrong execution key error = %v", err)
	}
}

func TestCoordinatorDeadlineAllowsOnlyProviderShutdown(t *testing.T) {
	authority := newAttempt(t)
	now := coordinatorNow
	authority.Lease.ExpiresAt = authority.HardDeadline.Add(time.Minute)
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, authority, signaling, &fakePeer{}, Config{Now: func() time.Time { return now }})
	if _, err := coordinator.Bootstrap(context.Background(), newPlan(t, authority, 1, []planTrack{{name: "one"}})); err != nil {
		t.Fatal(err)
	}
	now = authority.HardDeadline
	if _, err := coordinator.Reconcile(context.Background(), newPlan(t, authority, 2, []planTrack{{name: "two"}})); !errors.Is(err, ErrDeadlineExpired) {
		t.Fatalf("reconcile at limit = %v", err)
	}
	if err := coordinator.Close(context.Background(), true); err != nil {
		t.Fatalf("shutdown at limit = %v", err)
	}
	if err := coordinator.Close(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if countOperation(signaling.operations, captureplane.OperationCloseCaptureConnection) != 1 {
		t.Fatalf("shutdown calls = %v", signaling.operations)
	}
}

func TestUnavailableCaptureTrackRecoversWithoutPlanChange(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{pullUnavailable: 2}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{})
	plan := newPlan(t, attempt, 1, []planTrack{{name: "late"}})
	first, err := coordinator.Bootstrap(context.Background(), plan)
	if err != nil || len(first.Tracks) != 0 || !first.PendingTracks {
		t.Fatalf("bootstrap: %+v %v", first, err)
	}
	for i := 0; i < 2; i++ {
		if _, err := coordinator.Reconcile(context.Background(), plan); err != nil {
			t.Fatal(err)
		}
	}
	recovered, err := coordinator.Snapshot()
	if err != nil || len(recovered.Tracks) != 1 || recovered.PendingTracks {
		t.Fatalf("recovery: %+v %v", recovered, err)
	}
	if signaling.pullCount != 3 {
		t.Fatalf("pulls = %d", signaling.pullCount)
	}
	keys := map[string]bool{}
	for i, op := range signaling.operations {
		if op == captureplane.OperationPullCaptureTracks {
			key := signaling.keys[i]
			if keys[key] {
				t.Fatal("retry replayed an unavailable result")
			}
			keys[key] = true
		}
	}
	if _, err := coordinator.Reconcile(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if signaling.pullCount != 3 {
		t.Fatal("resubscribed a recovered track")
	}
}

func TestUnavailableCaptureTrackIsNotRetriedAfterRemoval(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{pullUnavailable: 1}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{})
	plan := newPlan(t, attempt, 1, []planTrack{{name: "late"}})
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	empty := newPlan(t, attempt, 2, nil)
	snapshot, err := coordinator.Reconcile(context.Background(), empty)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.PendingTracks || signaling.pullCount != 1 {
		t.Fatal("retried a removed publication")
	}
}
