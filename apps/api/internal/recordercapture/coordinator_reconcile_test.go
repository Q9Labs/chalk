package recordercapture

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestCoordinatorReconcileClosesBeforePullsAndAcceptsEmptyPlan(t *testing.T) {
	attempt := newAttempt(t)
	initial := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{}
	peer := &fakePeer{}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), initial); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	replacement := newPlan(t, attempt, 2, []planTrack{{name: "two"}})
	if _, err := coordinator.Reconcile(context.Background(), replacement); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if signaling.operations[len(signaling.operations)-2] != captureplane.OperationCloseCaptureTracks || signaling.operations[len(signaling.operations)-1] != captureplane.OperationPullCaptureTracks {
		t.Fatalf("replacement order = %#v", signaling.operations)
	}
	if got := registrationSizes(peer.registrations); len(got) != 3 || got[0] != 1 || got[1] != 0 || got[2] != 1 {
		t.Fatalf("replacement registrations = %v, want complete sets [1 0 1]", got)
	}
	empty := newPlan(t, attempt, 3, nil)
	got, err := coordinator.Reconcile(context.Background(), empty)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(got.Tracks) != 0 || signaling.operations[len(signaling.operations)-1] != captureplane.OperationCloseCaptureTracks {
		t.Fatalf("removed tracks = %#v, operations = %#v", got.Tracks, signaling.operations)
	}
	if got := registrationSizes(peer.registrations); got[len(got)-1] != 0 {
		t.Fatalf("removal registration = %v, want final empty set", got)
	}
	if _, err := coordinator.Reconcile(context.Background(), replacement); !errors.Is(err, ErrStalePlan) {
		t.Fatalf("stale plan error = %v", err)
	}
	if got, err := coordinator.Snapshot(); err != nil || got.Connection.PlanRevision != got.PlanRevision {
		t.Fatalf("snapshot connection revision = %d, plan revision = %d, err = %v", got.Connection.PlanRevision, got.PlanRevision, err)
	}
}

func TestCoordinatorClosesExactCaptureEpochOnce(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if err := coordinator.Close(context.Background(), false); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := coordinator.Close(context.Background(), false); err != nil {
		t.Fatalf("close replay: %v", err)
	}
	if countOperation(signaling.operations, captureplane.OperationCloseCaptureConnection) != 1 {
		t.Fatalf("close operations = %#v", signaling.operations)
	}
	if _, err := coordinator.Snapshot(); !errors.Is(err, ErrCaptureClosed) {
		t.Fatalf("snapshot after close error = %v", err)
	}
	if _, err := coordinator.Reconcile(context.Background(), plan); !errors.Is(err, ErrCaptureClosed) {
		t.Fatalf("reconcile after close error = %v", err)
	}
}

func TestCoordinatorCreatesConnectionForFirstTracksAfterEmptyBootstrap(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{pullNegotiation: answerNeeded("first-pull")}
	peer := &fakePeer{answer: captureplane.Description{Type: "answer", SDP: "v=0\r\n"}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	empty := newPlan(t, attempt, 1, nil)
	initial, err := coordinator.Bootstrap(context.Background(), empty)
	if err != nil {
		t.Fatalf("empty bootstrap: %v", err)
	}
	if !initial.Connection.ConnectionReference.IsZero() || len(initial.Tracks) != 0 || len(signaling.operations) != 0 {
		t.Fatalf("empty bootstrap opened a connection: snapshot=%#v operations=%#v", initial, signaling.operations)
	}
	if _, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, 2, nil)); err != nil {
		t.Fatalf("later empty revision: %v", err)
	}
	firstTracks := newPlan(t, attempt, 3, []planTrack{{name: "one"}})
	got, err := coordinator.Reconcile(context.Background(), firstTracks)
	if err != nil {
		t.Fatalf("first tracks: %v", err)
	}
	want := []captureplane.OperationKind{
		captureplane.OperationCreateCaptureConnection,
		captureplane.OperationPullCaptureTracks,
		captureplane.OperationRenegotiateCaptureConnection,
	}
	if !reflect.DeepEqual(signaling.operations, want) {
		t.Fatalf("operation order = %#v, want %#v", signaling.operations, want)
	}
	if got.PlanRevision != 3 || got.Connection.PlanRevision != 3 || len(got.Tracks) != 1 {
		t.Fatalf("first-track snapshot = %#v", got)
	}
	if !reflect.DeepEqual(registrationSizes(peer.registrations), []int{0, 1}) {
		t.Fatalf("track registrations = %v", registrationSizes(peer.registrations))
	}
}

func TestCoordinatorContinuesAfterOnlyPublicationGoneAndClosesOnStop(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{pullGone: true}
	peer := &fakePeer{}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	initial := newPlan(t, attempt, 1, []planTrack{{name: "only"}})
	snapshot, err := coordinator.Bootstrap(context.Background(), initial)
	if err != nil || len(snapshot.Tracks) != 0 {
		t.Fatalf("bootstrap after publication disappearance: snapshot=%#v error=%v", snapshot, err)
	}
	withoutPublisher := newPlan(t, attempt, 2, nil)
	snapshot, err = coordinator.Reconcile(context.Background(), withoutPublisher)
	if err != nil || snapshot.PlanRevision != 2 || len(snapshot.Tracks) != 0 {
		t.Fatalf("reconcile zero-track revision: snapshot=%#v error=%v", snapshot, err)
	}
	stopped, err := captureplan.NewPlan(captureplan.PlanInput{
		Authority: withoutPublisher.Authority(), Revision: 3, Cursors: captureplan.PlanCursors{EpisodeControlRevision: 3, ProviderIncarnation: 1, ProviderSequence: 3},
		LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10, InputBitrateBPS: 4_000_000,
		EffectiveDeadline: coordinatorNow.Add(time.Hour), StopState: captureplan.StopStateRequested,
		StopRequestedAt: coordinatorNow.Add(5 * time.Minute), Participants: withoutPublisher.Participants(),
	})
	if err != nil {
		t.Fatalf("create stop plan: %v", err)
	}
	if snapshot, err = coordinator.Reconcile(context.Background(), stopped); err != nil || snapshot.PlanRevision != 3 || len(snapshot.Tracks) != 0 {
		t.Fatalf("reconcile stopped zero-track plan: snapshot=%#v error=%v", snapshot, err)
	}
	if err := coordinator.Close(context.Background(), true); err != nil {
		t.Fatalf("close stopped Capture: %v", err)
	}
	if signaling.pullCount != 1 || countOperation(signaling.operations, captureplane.OperationCloseCaptureConnection) != 1 {
		t.Fatalf("provider operations = %#v, want one pull and one close", signaling.operations)
	}
}

func TestCoordinatorClosesWithoutProviderConnection(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), newPlan(t, attempt, 1, nil)); err != nil {
		t.Fatalf("empty bootstrap: %v", err)
	}
	if err := coordinator.Close(context.Background(), false); err != nil {
		t.Fatalf("close without provider connection: %v", err)
	}
	if err := coordinator.Close(context.Background(), false); err != nil {
		t.Fatalf("close replay: %v", err)
	}
	if len(signaling.operations) != 0 {
		t.Fatalf("provider operations = %#v, want none", signaling.operations)
	}
	if _, err := coordinator.Snapshot(); !errors.Is(err, ErrCaptureClosed) {
		t.Fatalf("snapshot after close error = %v", err)
	}
}

func TestCoordinatorEmptyPlanRevisionsNeverRemoveWithoutConnection(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{}
	peer := &fakePeer{}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), newPlan(t, attempt, 1, nil)); err != nil {
		t.Fatalf("empty bootstrap: %v", err)
	}
	for revision := captureplane.PlanRevision(2); revision <= 3; revision++ {
		got, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, revision, nil))
		if err != nil {
			t.Fatalf("empty revision %d: %v", revision, err)
		}
		if got.PlanRevision != revision || !got.Connection.ConnectionReference.IsZero() || len(got.Tracks) != 0 {
			t.Fatalf("empty revision %d snapshot = %#v", revision, got)
		}
	}
	if len(signaling.operations) != 0 || !reflect.DeepEqual(registrationSizes(peer.registrations), []int{0}) {
		t.Fatalf("empty revisions touched provider: operations=%#v registrations=%v", signaling.operations, registrationSizes(peer.registrations))
	}
}

func TestCoordinatorCloseNegotiationSettlesBeforePull(t *testing.T) {
	cases := []struct {
		name             string
		closeNegotiation captureplane.Negotiation
		wantPeerOffer    bool
	}{
		{name: "answer", closeNegotiation: answerNeeded("close-answer")},
		{name: "offer", closeNegotiation: offerNeeded("close-offer"), wantPeerOffer: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			attempt := newAttempt(t)
			initial := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
			signaling := &fakeSignaling{closeNegotiation: test.closeNegotiation}
			peer := &fakePeer{answer: captureplane.Description{Type: "answer", SDP: "v=0\r\n"}, offer: captureplane.Negotiation{ID: test.closeNegotiation.ID, Requirement: captureplane.NegotiationOfferNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}}
			coordinator := newCoordinator(t, attempt, signaling, peer, Config{MaxNegotiationRounds: 1})
			if _, err := coordinator.Bootstrap(context.Background(), initial); err != nil {
				t.Fatalf("bootstrap: %v", err)
			}
			if _, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, 2, []planTrack{{name: "two"}})); err != nil {
				t.Fatalf("reconcile: %v", err)
			}
			closeIndex := indexOfOperation(signaling.operations, captureplane.OperationCloseCaptureTracks)
			pullIndex := lastIndexOfOperation(signaling.operations, captureplane.OperationPullCaptureTracks)
			if closeIndex < 0 || pullIndex <= closeIndex+1 || signaling.operations[closeIndex+1] != captureplane.OperationRenegotiateCaptureConnection {
				t.Fatalf("operation order = %#v", signaling.operations)
			}
			if len(signaling.renegotiateIDs) != 1 || signaling.renegotiateIDs[0] != test.closeNegotiation.ID {
				t.Fatalf("close negotiation IDs = %#v", signaling.renegotiateIDs)
			}
			if test.wantPeerOffer && len(peer.createdOfferIDs) != 1 {
				t.Fatalf("created offer IDs = %#v", peer.createdOfferIDs)
			}
		})
	}
}
