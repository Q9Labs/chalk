package recordercapture

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
)

func TestCloseCleansConnectionAfterBootstrapPullFailure(t *testing.T) {
	authority := newAttempt(t)
	signaling := &bootstrapFailureSignaling{fakeSignaling: &fakeSignaling{}}
	coordinator := newCoordinator(t, authority, signaling, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(t.Context(), newPlan(t, authority, 1, []planTrack{{name: "one"}})); err == nil {
		t.Fatal("bootstrap unexpectedly succeeded")
	}
	if err := coordinator.Close(t.Context(), true); err != nil {
		t.Fatalf("close partial bootstrap: %v", err)
	}
	if countOperation(signaling.operations, captureplane.OperationCloseCaptureConnection) != 1 {
		t.Fatal("allocated connection was not retired after uncertain pull")
	}
}

type bootstrapFailureSignaling struct{ *fakeSignaling }

func (s *bootstrapFailureSignaling) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	if request.Command.Identity.Operation == captureplane.OperationPullCaptureTracks {
		return capturesignaling.Execution{}, capturesignaling.ProviderFailureError{Failure: captureplane.ProviderError{Class: captureplane.ProviderFailureUnavailable, Code: "internal_error"}}
	}
	return s.fakeSignaling.Execute(ctx, request)
}

func TestNewAttemptAuthorityAndPlanFence(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	if err := attempt.validatePlan(plan); err != nil {
		t.Fatalf("validate plan: %v", err)
	}
	for name, edit := range map[string]func(*captureplan.PlanAuthority){
		"capture epoch":      func(authority *captureplan.PlanAuthority) { authority.CaptureEpoch++ },
		"fencing generation": func(authority *captureplan.PlanAuthority) { authority.FencingGeneration++ },
		"attempt count":      func(authority *captureplan.PlanAuthority) { authority.AttemptCount++ },
		"envelope digest":    func(authority *captureplan.PlanAuthority) { authority.EnvelopeDigest = bytes.Repeat([]byte{9}, 32) },
	} {
		badAuthority := plan.Authority()
		edit(&badAuthority)
		badPlan, err := captureplan.NewPlan(captureplan.PlanInput{
			Authority: badAuthority, Revision: 1,
			LayoutProfile: captureplan.LayoutProfileComposite720PV1, ParticipantLimit: 10,
			InputBitrateBPS: 4_000_000, EffectiveDeadline: coordinatorNow.Add(time.Hour),
			StopState:    captureplan.StopStateRunning,
			Participants: plan.Participants(), Tracks: plan.Tracks(),
		})
		if err != nil {
			t.Fatalf("%s: bad plan: %v", name, err)
		}
		if !errors.Is(attempt.validatePlan(badPlan), ErrAuthorityMismatch) {
			t.Fatalf("%s: expected authority mismatch", name)
		}
	}
	deadlinePlan := newPlanWithDeadline(t, attempt, 1, []planTrack{{name: "one"}}, coordinatorNow.Add(2*time.Hour))
	if !errors.Is(attempt.validatePlan(deadlinePlan), ErrDeadlineMismatch) {
		t.Fatalf("expected deadline mismatch")
	}

	for name, edit := range map[string]func(*recordingpipeline.RecorderJobEnvelope){
		"padded tenant": func(envelope *recordingpipeline.RecorderJobEnvelope) { envelope.TenantID = " " + envelope.TenantID },
		"uppercase tenant": func(envelope *recordingpipeline.RecorderJobEnvelope) {
			envelope.TenantID = "A1111111-a111-4111-8111-111111111111"
		},
		"malformed deadline": func(envelope *recordingpipeline.RecorderJobEnvelope) { envelope.HardDeadline = "not-a-time" },
		"expired deadline": func(envelope *recordingpipeline.RecorderJobEnvelope) {
			envelope.HardDeadline = coordinatorNow.Format(time.RFC3339Nano)
		},
	} {
		t.Run(name, func(t *testing.T) {
			envelope := attempt.Envelope
			edit(&envelope)
			if _, err := NewAttemptAuthorityAt(envelope, digestEnvelope(t, envelope), attempt.Lease, coordinatorNow); !errors.Is(err, ErrInvalidAuthority) {
				t.Fatalf("error = %v, want invalid authority", err)
			}
		})
	}
}

func TestNewAttemptAuthorityAcceptsPersistedOriginAcrossClockSkew(t *testing.T) {
	attempt := newAttempt(t)
	captureReadyAt := coordinatorNow.Format(time.RFC3339Nano)
	attempt.Envelope.CaptureReadyAt = &captureReadyAt

	got, err := NewAttemptAuthorityAt(
		attempt.Envelope,
		digestEnvelope(t, attempt.Envelope),
		attempt.Lease,
		coordinatorNow.Add(-time.Second),
	)
	if err != nil {
		t.Fatalf("accept server-validated capture origin across worker clock skew: %v", err)
	}
	if got.CaptureReadyAt == nil || !got.CaptureReadyAt.Equal(coordinatorNow) {
		t.Fatalf("capture ready at = %v, want %v", got.CaptureReadyAt, coordinatorNow)
	}
}

func TestCoordinatorBootstrapAnswerAndProviderFence(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{pullNegotiation: answerNeeded("provider-offer")}
	peer := &fakePeer{answer: captureplane.Description{Type: "answer", SDP: "v=0\r\n"}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{MaxNegotiationRounds: 1})
	got, err := coordinator.Bootstrap(context.Background(), plan)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if len(got.Tracks) != 1 || len(peer.registered) != 1 {
		t.Fatalf("tracks = %#v, registered = %#v", got.Tracks, peer.registered)
	}
	if len(signaling.renegotiateIDs) != 1 || signaling.renegotiateIDs[0] != "provider-offer" {
		t.Fatalf("renegotiation IDs = %#v", signaling.renegotiateIDs)
	}
	if signaling.operations[0] != captureplane.OperationCreateCaptureConnection || signaling.operations[1] != captureplane.OperationPullCaptureTracks || signaling.operations[2] != captureplane.OperationRenegotiateCaptureConnection {
		t.Fatalf("operation order = %#v", signaling.operations)
	}
	if len(signaling.keys) == 0 || len(signaling.keys[0]) > captureplane.MaxIdempotencyKeyBytes {
		t.Fatalf("idempotency key is invalid: %#v", signaling.keys)
	}
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatalf("same-revision bootstrap replay: %v", err)
	}
	if len(signaling.operations) != 3 {
		t.Fatalf("same-revision replay issued provider calls: %#v", signaling.operations)
	}
}

func TestCoordinatorBootstrapOfferRemoteAnswer(t *testing.T) {
	attempt := newAttempt(t)
	plan := newPlan(t, attempt, 1, []planTrack{{name: "one"}})
	signaling := &fakeSignaling{pullNegotiation: offerNeeded("provider-offer"), renegotiation: []captureplane.Negotiation{{Requirement: captureplane.NegotiationRemoteAnswer, Description: &captureplane.Description{Type: "answer", SDP: "v=0\r\n"}}}}
	peer := &fakePeer{offer: captureplane.Negotiation{ID: "provider-offer", Requirement: captureplane.NegotiationOfferNeeded, Description: &captureplane.Description{Type: "offer", SDP: "v=0\r\n"}}}
	coordinator := newCoordinator(t, attempt, signaling, peer, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), plan); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if len(peer.createdOfferIDs) != 1 || peer.createdOfferIDs[0] != "provider-offer" {
		t.Fatalf("offer IDs = %#v", peer.createdOfferIDs)
	}
	if len(peer.appliedAnswers) != 1 || peer.appliedAnswers[0].Requirement != captureplane.NegotiationRemoteAnswer {
		t.Fatalf("applied answers = %#v", peer.appliedAnswers)
	}
}

func TestCoordinatorRejectsDifferentPlanAtTheSameRevision(t *testing.T) {
	attempt := newAttempt(t)
	signaling := &fakeSignaling{}
	coordinator := newCoordinator(t, attempt, signaling, &fakePeer{}, Config{})
	if _, err := coordinator.Bootstrap(context.Background(), newPlan(t, attempt, 1, []planTrack{{name: "one"}})); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if _, err := coordinator.Reconcile(context.Background(), newPlan(t, attempt, 1, []planTrack{{name: "two"}})); !errors.Is(err, ErrPlanConflict) {
		t.Fatalf("reconcile a different plan at revision 1: %v, want plan conflict", err)
	}
}
