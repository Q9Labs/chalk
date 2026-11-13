package capturesignaling

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestServiceRejectsSameKeyDifferentPayload(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	first := commandFor(captureplane.OperationCloseCaptureConnection, time.Now().Add(time.Minute))
	store.projection = projectionFor(first, "neg-1")
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: first}); err != nil {
		t.Fatalf("first execute: %v", err)
	}
	second := first
	value := *second.Input.CloseCaptureConnection
	value.Force = !value.Force
	second.Input.CloseCaptureConnection = &value
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: second}); !errors.Is(err, ErrConflict) {
		t.Fatalf("conflict error = %v", err)
	}
	if provider.calls(captureplane.OperationCloseCaptureConnection) != 1 {
		t.Fatalf("provider calls = %d, want one", provider.calls(captureplane.OperationCloseCaptureConnection))
	}
}

func TestRemoteAnswerResultDoesNotPersistNegotiationFence(t *testing.T) {
	command := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	projection := projectionFor(command, "offer-1")
	result := CommandResult{PullCaptureTracks: &captureplane.PullCaptureTracksResult{
		Connection: captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: 1, PlanRevision: 1},
		Negotiation: captureplane.Negotiation{
			Requirement: captureplane.NegotiationRemoteAnswer,
			Description: &captureplane.Description{Type: "answer", SDP: "v=0"},
		},
	}}
	next, err := ProjectResult(command.SignalingHandle, command.Authority, captureplane.OperationPullCaptureTracks, result, projection)
	if err != nil {
		t.Fatalf("result projection: %v", err)
	}
	if next.NegotiationRequirement != captureplane.NegotiationNotRequired || next.NegotiationID != "" {
		t.Fatalf("remote answer projection = %#v, want no negotiation fence", next)
	}
}

func TestServiceWaitsForBusyCommand(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	store.busyClaims = 2
	now := time.Now()
	waits := 0
	service, err := NewService(store, provider, Options{
		Now: func() time.Time { return now },
		Wait: func(_ context.Context, duration time.Duration) error {
			waits++
			now = now.Add(duration)
			return nil
		},
		PollInterval: time.Millisecond,
		MaxWait:      time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: commandFor(captureplane.OperationCreateCaptureConnection, now.Add(time.Minute))}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if waits != 2 || store.claims != 3 {
		t.Fatalf("waits=%d claims=%d, want two waits and three claims", waits, store.claims)
	}
}

func TestServiceFencesExpiredLeaseAndPersistenceAuthority(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	expired := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(-time.Second))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: expired}); !errors.Is(err, ErrStaleLease) {
		t.Fatalf("expired lease error = %v", err)
	}
	store.prepareErr = FenceError{Kind: "capture_epoch"}
	valid := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: valid}); !errors.Is(err, ErrStaleCaptureEpoch) {
		t.Fatalf("stale epoch error = %v", err)
	}
}

func TestServiceRequiresExactNegotiationForRenegotiation(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	command := commandFor(captureplane.OperationRenegotiateCaptureConnection, time.Now().Add(time.Minute))
	store.projection = projectionFor(command, "neg-1")
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	bad := command
	input := *bad.Input.RenegotiateCaptureConnection
	input.NegotiationID = "neg-2"
	bad.Input.RenegotiateCaptureConnection = &input
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: bad}); !errors.Is(err, ErrNegotiationMismatch) {
		t.Fatalf("negotiation error = %v", err)
	}
	if provider.calls(captureplane.OperationRenegotiateCaptureConnection) != 0 {
		t.Fatal("provider was called for a mismatched negotiation")
	}
}

func TestPreparedCommandBlocksNegotiationProducingOperationsUntilRenegotiated(t *testing.T) {
	for _, operation := range []captureplane.OperationKind{
		captureplane.OperationPullCaptureTracks,
		captureplane.OperationInspectCaptureConnection,
		captureplane.OperationCloseCaptureTracks,
	} {
		t.Run(operation.String(), func(t *testing.T) {
			command := commandFor(operation, time.Now().Add(time.Minute))
			projection := projectionFor(command, "neg-1")
			if err := ValidatePreparedCommand(preparedFor(command), projection); !errors.Is(err, ErrNegotiationMismatch) {
				t.Fatalf("validation error = %v, want %v", err, ErrNegotiationMismatch)
			}
		})
	}

	renegotiate := commandFor(captureplane.OperationRenegotiateCaptureConnection, time.Now().Add(time.Minute))
	projection := projectionFor(renegotiate, "neg-1")
	renegotiate.Identity.PlanRevision++
	if err := ValidatePreparedCommand(preparedFor(renegotiate), projection); !errors.Is(err, ErrNegotiationMismatch) {
		t.Fatalf("newer-plan renegotiation error = %v, want %v", err, ErrNegotiationMismatch)
	}
}

func TestServiceReleasesClaimRejectedBeforeProviderDispatch(t *testing.T) {
	command := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	store := newMemoryPort()
	store.projection = projectionFor(command, "")
	store.claimProjection = projectionFor(command, "neg-1")
	provider := &fakePlane{}
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, ErrNegotiationMismatch) {
		t.Fatalf("execute error = %v, want %v", err, ErrNegotiationMismatch)
	}
	if store.releases != 1 || store.commands[store.prepare.Key].inflight {
		t.Fatalf("releases=%d inflight=%v, want one release and no claim", store.releases, store.commands[store.prepare.Key].inflight)
	}
	if provider.calls(captureplane.OperationPullCaptureTracks) != 0 {
		t.Fatal("provider was called after the pre-dispatch fence")
	}
}

func TestServiceReturnsAmbiguousExpiredClaim(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	store.ambiguous = true
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))}); !errors.Is(err, ErrAmbiguousOutcome) {
		t.Fatalf("ambiguous error = %v", err)
	}
	if provider.calls(captureplane.OperationCreateCaptureConnection) != 0 {
		t.Fatal("provider was called after an ambiguous claim")
	}
}

func TestServiceDoesNotRecordProviderFailureAfterLeaseExpiry(t *testing.T) {
	now := time.Now()
	provider := &fakePlane{createFailure: &captureplane.ProviderError{Class: captureplane.ProviderFailureNotFound, Code: "provider_unavailable", Retryable: true}}
	provider.onCreate = func() { now = now.Add(2 * time.Minute) }
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{Now: func() time.Time { return now }, MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	command := commandFor(captureplane.OperationCreateCaptureConnection, now.Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, ErrAmbiguousOutcome) {
		t.Fatalf("create failure after lease expiry error = %v, want ambiguous outcome", err)
	}
	if store.failure.ClaimToken != "" {
		t.Fatal("a failure was recorded under an expired worker lease")
	}
}

func TestServiceRejectsTrackAndSDPBounds(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	tooMany := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	input := *tooMany.Input.PullCaptureTracks
	input.Tracks = make([]captureplane.CaptureTrack, captureplane.MaxCaptureTracks+1)
	for index := range input.Tracks {
		input.Tracks[index] = validTrack(byte(index + 1))
	}
	tooMany.Input.PullCaptureTracks = &input
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: tooMany}); !errors.Is(err, captureplane.ErrInvalidTrack) {
		t.Fatalf("track bound error = %v", err)
	}
	badSDP := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	input = *badSDP.Input.PullCaptureTracks
	input.LocalDescription = &captureplane.Description{Type: "offer", SDP: string(make([]byte, captureplane.MaxSDPBytes+1))}
	badSDP.Input.PullCaptureTracks = &input
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: badSDP}); !errors.Is(err, captureplane.ErrInvalidDescription) {
		t.Fatalf("SDP bound error = %v", err)
	}
}

func TestServiceHonorsNotBefore(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	store.notBefore = true
	now := time.Now()
	waits := 0
	service, err := NewService(store, provider, Options{
		Now: func() time.Time { return now },
		Wait: func(_ context.Context, duration time.Duration) error {
			waits++
			now = now.Add(duration)
			return nil
		},
		MaxWait: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: commandFor(captureplane.OperationCreateCaptureConnection, now.Add(time.Minute))}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if waits != 1 || store.claims != 1 {
		t.Fatalf("waits=%d claims=%d, want one wait and one claim", waits, store.claims)
	}
	if store.completion.ClaimToken != "claim-1" || provider.calls(captureplane.OperationCreateCaptureConnection) != 1 {
		t.Fatalf("completion token=%q provider calls=%d, want claim-1 and one call", store.completion.ClaimToken, provider.calls(captureplane.OperationCreateCaptureConnection))
	}
}
