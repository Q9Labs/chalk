package capturesignaling

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestServiceDispatchesAllCapturePlaneOperations(t *testing.T) {
	operations := []captureplane.OperationKind{
		captureplane.OperationCreateCaptureConnection,
		captureplane.OperationPullCaptureTracks,
		captureplane.OperationRenegotiateCaptureConnection,
		captureplane.OperationInspectCaptureConnection,
		captureplane.OperationCloseCaptureTracks,
		captureplane.OperationCloseCaptureConnection,
	}
	for _, operation := range operations {
		t.Run(string(operation), func(t *testing.T) {
			provider := &fakePlane{}
			store := newMemoryPort()
			command := commandFor(operation, time.Now().Add(time.Minute))
			if operation != captureplane.OperationCreateCaptureConnection {
				negotiationID := ""
				if operation == captureplane.OperationRenegotiateCaptureConnection {
					negotiationID = "neg-1"
				}
				store.projection = projectionFor(command, negotiationID)
			}
			service, err := NewService(store, provider, Options{MaxWait: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); err != nil {
				t.Fatalf("execute: %v", err)
			}
			if provider.calls(operation) != 1 {
				t.Fatalf("%s calls = %d, want one", operation, provider.calls(operation))
			}
		})
	}
}

func TestServiceReplaysExactCompletedResultWithoutProviderCall(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	command := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.Execute(context.Background(), ExecuteRequest{Command: command})
	if err != nil {
		t.Fatalf("first execute: %v", err)
	}
	second, err := service.Execute(context.Background(), ExecuteRequest{Command: command})
	if err != nil {
		t.Fatalf("replay execute: %v", err)
	}
	if !second.Replayed || string(first.ResultBytes) != string(second.ResultBytes) {
		t.Fatalf("replay = %#v, first bytes %q second bytes %q", second.Replayed, first.ResultBytes, second.ResultBytes)
	}
	if provider.calls(captureplane.OperationCreateCaptureConnection) != 1 {
		t.Fatalf("provider calls = %d, want one", provider.calls(captureplane.OperationCreateCaptureConnection))
	}
}

func TestServicePassesFullAuthorityAndLeaseToEveryMutation(t *testing.T) {
	command := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); err != nil {
		t.Fatalf("success execute: %v", err)
	}
	if !sameAuthority(store.prepare.Authority, command.Authority) || !sameLease(store.prepare.Lease, command.Lease) {
		t.Fatal("prepare did not receive full authority and lease")
	}
	if store.prepare.Input.CreateCaptureConnection == nil {
		t.Fatal("prepare did not receive the canonical typed input")
	}
	metadata := store.prepare.Input.CreateCaptureConnection.Metadata
	if metadata.Identity.TenantID != command.Authority.TenantID || metadata.Identity.SpaceID != command.Authority.SpaceID || metadata.Identity.EpisodeID != command.Authority.EpisodeID || metadata.Identity.RecordingID != command.Authority.RecordingID || metadata.CaptureEpoch != command.Authority.CaptureEpoch || metadata.PlanRevision != command.Identity.PlanRevision || metadata.IdempotencyKey != command.Identity.IdempotencyKey {
		t.Fatal("prepare did not receive the canonical typed input")
	}
	if len(store.claim) != 1 || !sameAuthority(store.claim[0].Authority, command.Authority) || !sameLease(store.claim[0].Lease, command.Lease) {
		t.Fatal("claim did not receive full authority and lease")
	}
	if !bytes.Equal(store.claim[0].RequestBytes, store.prepare.RequestBytes) || store.claim[0].Fingerprint != store.prepare.Fingerprint || store.claim[0].Input.CreateCaptureConnection == nil {
		t.Fatal("claim did not receive the immutable canonical command")
	}
	if !sameAuthority(store.completion.Authority, command.Authority) || !sameLease(store.completion.Lease, command.Lease) {
		t.Fatal("completion did not receive full authority and lease")
	}

	failureStore := newMemoryPort()
	failureService, err := NewService(failureStore, &fakePlane{badResult: true}, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := failureService.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, ErrProviderFailure) {
		t.Fatalf("failure execute: %v", err)
	}
	if !sameAuthority(failureStore.failure.Authority, command.Authority) || !sameLease(failureStore.failure.Lease, command.Lease) {
		t.Fatal("failure did not receive full authority and lease")
	}
}

func TestSignalingHandleIsCanonicalEnvelopeUUID(t *testing.T) {
	canonical := signalingHandle()
	if _, err := NewSignalingHandle(string(canonical)); err != nil {
		t.Fatalf("canonical handle: %v", err)
	}
	if _, err := NewSignalingHandle("signal-1"); !errors.Is(err, ErrInvalidSignalingHandle) {
		t.Fatalf("opaque handle error = %v", err)
	}
	if _, err := NewSignalingHandle(" 11111111-1111-1111-1111-111111111111"); !errors.Is(err, ErrInvalidSignalingHandle) {
		t.Fatalf("spaced handle error = %v", err)
	}
	if _, err := NewSignalingHandle("11111111-1111-1111-1111-111111111111"); err != nil {
		t.Fatalf("fixed UUID: %v", err)
	}
}

func TestCommandIdentityHasOneOperationField(t *testing.T) {
	command := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	request, _, err := CanonicalRequest(command)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(request, []byte("operation_kind")) || bytes.Contains(request, []byte(`"kind"`)) {
		t.Fatalf("canonical identity contains removed aliases: %s", request)
	}
}

func TestServiceRejectsMalformedOrStaleConnectionProjection(t *testing.T) {
	for name, projectionError := range map[string]error{
		"malformed": ErrCorruptStoredResult,
		"handle":    ErrStaleConnection,
		"epoch":     ErrStaleCaptureEpoch,
	} {
		t.Run(name, func(t *testing.T) {
			command := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
			store := newMemoryPort()
			projection := projectionFor(command, "neg-1")
			switch name {
			case "malformed":
				projection = &ConnectionProjection{SignalingHandle: command.SignalingHandle}
			case "handle":
				projection.SignalingHandle = differentSignalingHandle()
			case "epoch":
				projection.CaptureEpoch = 2
				projection.Connection.CaptureEpoch = 2
			}
			store.projection = projection
			service, err := NewService(store, &fakePlane{}, Options{MaxWait: time.Second})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, projectionError) {
				t.Fatalf("projection error = %v, want %v", err, projectionError)
			}
		})
	}
}

func TestServiceRequiresPriorConnectionForNonCreate(t *testing.T) {
	command := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
	service, err := NewService(newMemoryPort(), &fakePlane{}, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("missing connection error = %v", err)
	}
}

func TestValidatePreparedCommandFencesCurrentProjection(t *testing.T) {
	base := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
	projection := projectionFor(base, "neg-1")
	wrongConnection := base
	wrongInput := *wrongConnection.Input.InspectCaptureConnection
	wrongInput.Connection = "another-connection"
	wrongConnection.Input.InspectCaptureConnection = &wrongInput
	if err := ValidatePreparedCommand(preparedFor(wrongConnection), projection); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("wrong connection error = %v", err)
	}
	oldPlan := base
	oldPlan.Identity.PlanRevision = 1
	oldProjection := projectionFor(oldPlan, "neg-1")
	oldProjection.PlanRevision = 2
	oldProjection.Connection.PlanRevision = 2
	if err := ValidatePreparedCommand(preparedFor(oldPlan), oldProjection); !errors.Is(err, ErrStalePlanRevision) {
		t.Fatalf("old plan error = %v", err)
	}
	secondCreate := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	if err := ValidatePreparedCommand(preparedFor(secondCreate), projection); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("second create error = %v", err)
	}
	closed := *projection
	closed.Closed = true
	closed.State = captureplane.CaptureConnectionClosed
	closedCommand := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	if err := ValidatePreparedCommand(preparedFor(closedCommand), &closed); !errors.Is(err, ErrStaleConnection) {
		t.Fatalf("command after close error = %v", err)
	}
	closeCommand := commandFor(captureplane.OperationCloseCaptureConnection, time.Now().Add(time.Minute))
	if err := ValidatePreparedCommand(preparedFor(closeCommand), &closed); err != nil {
		t.Fatalf("close after close: %v", err)
	}
}

func TestCompletedReplaySurvivesAdvancedProjection(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	command := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); err != nil {
		t.Fatalf("first execute: %v", err)
	}
	store.projection.Connection.ConnectionReference = "advanced-connection"
	store.projection.PlanRevision = 2
	store.projection.Connection.PlanRevision = 2
	store.projection.Closed = true
	store.projection.State = captureplane.CaptureConnectionClosed
	replay, err := service.Execute(context.Background(), ExecuteRequest{Command: command})
	if err != nil {
		t.Fatalf("advanced replay: %v", err)
	}
	if !replay.Replayed || provider.calls(captureplane.OperationCreateCaptureConnection) != 1 {
		t.Fatalf("replay=%v provider calls=%d", replay.Replayed, provider.calls(captureplane.OperationCreateCaptureConnection))
	}
}

func TestServiceProjectsConnectionLifecycleAndPreservesState(t *testing.T) {
	provider := &fakePlane{}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	create := commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: create}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnecting || store.projection.Closed {
		t.Fatalf("create projection = %#v", store.projection)
	}
	pull := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: pull}); err != nil {
		t.Fatalf("pull: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnecting {
		t.Fatalf("pull did not preserve state: %#v", store.projection)
	}
	inspect := commandFor(captureplane.OperationInspectCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: inspect}); err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnected {
		t.Fatalf("inspect state = %s", store.projection.State)
	}
	closeConnection := commandFor(captureplane.OperationCloseCaptureConnection, time.Now().Add(time.Minute))
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: closeConnection}); err != nil {
		t.Fatalf("close connection: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionClosed || !store.projection.Closed {
		t.Fatalf("close projection = %#v", store.projection)
	}
}

func TestServicePreservesProjectionWhenCloseIsNotConfirmed(t *testing.T) {
	command := commandFor(captureplane.OperationCloseCaptureConnection, time.Now().Add(time.Minute))
	store := newMemoryPort()
	store.projection = projectionFor(command, "neg-1")
	store.projection.State = captureplane.CaptureConnectionConnected
	service, err := NewService(store, &fakePlane{closeDenied: true}, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); err != nil {
		t.Fatalf("close connection: %v", err)
	}
	if store.projection.State != captureplane.CaptureConnectionConnected || store.projection.Closed || store.projection.NegotiationID != "neg-1" || store.projection.NegotiationRequirement != captureplane.NegotiationAnswerNeeded {
		t.Fatalf("unconfirmed close projection = %#v", store.projection)
	}
}

func sameAuthority(left, right CommandAuthority) bool {
	return left.TenantID == right.TenantID && left.SpaceID == right.SpaceID && left.EpisodeID == right.EpisodeID && left.RecordingID == right.RecordingID && left.JobID == right.JobID && left.AttemptCount == right.AttemptCount && left.FencingGeneration == right.FencingGeneration && left.CaptureEpoch == right.CaptureEpoch && bytes.Equal(left.EnvelopeDigest, right.EnvelopeDigest)
}

func sameLease(left, right WorkerLease) bool {
	return left.Owner == right.Owner && left.Token == right.Token && left.ExpiresAt.Equal(right.ExpiresAt)
}

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
	next, err := resultProjection(command.SignalingHandle, command.Authority, captureplane.OperationPullCaptureTracks, result, projection)
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

func TestServiceValidatesProviderResult(t *testing.T) {
	provider := &fakePlane{badResult: true}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))}); !errors.Is(err, ErrProviderFailure) {
		t.Fatalf("provider result error = %v", err)
	}
	if store.failure.ProviderError.Code != "invalid_result" {
		t.Fatalf("stored failure = %#v", store.failure.ProviderError)
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

func commandFor(operation captureplane.OperationKind, expiresAt time.Time) Command {
	authority := CommandAuthority{
		TenantID: utilities.IDFromBytes([16]byte{1}), SpaceID: utilities.IDFromBytes([16]byte{2}),
		EpisodeID: utilities.IDFromBytes([16]byte{3}), RecordingID: utilities.IDFromBytes([16]byte{4}),
		JobID: utilities.IDFromBytes([16]byte{5}), AttemptCount: 1, FencingGeneration: 1, CaptureEpoch: 1,
		EnvelopeDigest: func() []byte { digest := sha256.Sum256([]byte("envelope")); return digest[:] }(),
	}
	command := Command{
		SignalingHandle: signalingHandle(), Authority: authority,
		Lease:    WorkerLease{Owner: "worker-1", Token: "lease-1", ExpiresAt: expiresAt},
		Identity: CommandIdentity{Operation: operation, PlanRevision: 1, IdempotencyKey: "key-1"},
	}
	connection := captureplane.ProviderReference("connection-1")
	pulled := captureplane.PulledCaptureTrack{CaptureTrack: validTrack(6), MID: "mid-1"}
	switch operation {
	case captureplane.OperationCreateCaptureConnection:
		command.Input.CreateCaptureConnection = &captureplane.CreateCaptureConnectionInput{}
	case captureplane.OperationPullCaptureTracks:
		command.Input.PullCaptureTracks = &captureplane.PullCaptureTracksInput{Connection: connection, Tracks: []captureplane.CaptureTrack{validTrack(6)}}
	case captureplane.OperationRenegotiateCaptureConnection:
		command.Input.RenegotiateCaptureConnection = &captureplane.RenegotiateCaptureConnectionInput{Connection: connection, NegotiationID: "neg-1", Description: captureplane.Description{Type: "answer", SDP: "v=0"}}
	case captureplane.OperationInspectCaptureConnection:
		command.Input.InspectCaptureConnection = &captureplane.InspectCaptureConnectionInput{Connection: connection, Tracks: []captureplane.PulledCaptureTrack{pulled}}
	case captureplane.OperationCloseCaptureTracks:
		command.Input.CloseCaptureTracks = &captureplane.CloseCaptureTracksInput{Connection: connection, Tracks: []captureplane.PulledCaptureTrack{pulled}}
	case captureplane.OperationCloseCaptureConnection:
		command.Input.CloseCaptureConnection = &captureplane.CloseCaptureConnectionInput{Connection: connection, Tracks: []captureplane.PulledCaptureTrack{pulled}, Force: true}
	}
	return command
}

func signalingHandle() SignalingHandle {
	return SignalingHandle(utilities.IDFromBytes([16]byte{9}).String())
}

func preparedFor(command Command) PreparedCommand {
	return PreparedCommand{SignalingHandle: command.SignalingHandle, Authority: command.Authority, Identity: command.Identity, Input: command.Input}
}

func differentSignalingHandle() SignalingHandle {
	return SignalingHandle(utilities.IDFromBytes([16]byte{10}).String())
}

func validTrack(participant byte) captureplane.CaptureTrack {
	return captureplane.CaptureTrack{
		OwnerReference: "owner-1", TrackReference: captureplane.ProviderReference(fmt.Sprintf("track-%d", participant)),
		ParticipantID: utilities.IDFromBytes([16]byte{participant}), ParticipantGeneration: 1,
		Source: captureplane.TrackSourceMicrophone, Kind: captureplane.TrackKindAudio, RequestedLayer: captureplane.TrackLayerAuto,
	}
}

func projectionFor(command Command, negotiation string) *ConnectionProjection {
	requirement := captureplane.NegotiationNotRequired
	if negotiation != "" {
		requirement = captureplane.NegotiationAnswerNeeded
	}
	return &ConnectionProjection{SignalingHandle: command.SignalingHandle, Connection: captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: 1, PlanRevision: 1}, CaptureEpoch: 1, PlanRevision: 1, NegotiationID: captureplane.ProviderReference(negotiation), NegotiationRequirement: requirement}
}

type fakePlane struct {
	mu          sync.Mutex
	counts      map[captureplane.OperationKind]int
	badResult   bool
	closeDenied bool
}

func (p *fakePlane) calls(operation captureplane.OperationKind) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.counts[operation]
}

func (p *fakePlane) count(operation captureplane.OperationKind) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.counts == nil {
		p.counts = make(map[captureplane.OperationKind]int)
	}
	p.counts[operation]++
}

func (p *fakePlane) connection() captureplane.CaptureConnection {
	epoch, plan := captureplane.CaptureEpoch(1), captureplane.PlanRevision(1)
	if p.badResult {
		epoch = 2
	}
	return captureplane.CaptureConnection{ConnectionReference: "connection-1", CaptureEpoch: epoch, PlanRevision: plan}
}

func (p *fakePlane) CreateCaptureConnection(context.Context, captureplane.CreateCaptureConnectionInput) (captureplane.CreateCaptureConnectionResult, error) {
	p.count(captureplane.OperationCreateCaptureConnection)
	return captureplane.CreateCaptureConnectionResult{Connection: p.connection(), Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) PullCaptureTracks(context.Context, captureplane.PullCaptureTracksInput) (captureplane.PullCaptureTracksResult, error) {
	p.count(captureplane.OperationPullCaptureTracks)
	return captureplane.PullCaptureTracksResult{Connection: p.connection(), Tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: validTrack(6), MID: "mid-1"}}, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) RenegotiateCaptureConnection(context.Context, captureplane.RenegotiateCaptureConnectionInput) (captureplane.RenegotiateCaptureConnectionResult, error) {
	p.count(captureplane.OperationRenegotiateCaptureConnection)
	return captureplane.RenegotiateCaptureConnectionResult{Connection: p.connection(), Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) InspectCaptureConnection(context.Context, captureplane.InspectCaptureConnectionInput) (captureplane.InspectCaptureConnectionResult, error) {
	p.count(captureplane.OperationInspectCaptureConnection)
	return captureplane.InspectCaptureConnectionResult{Connection: p.connection(), State: captureplane.CaptureConnectionConnected, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) CloseCaptureTracks(context.Context, captureplane.CloseCaptureTracksInput) (captureplane.CloseCaptureTracksResult, error) {
	p.count(captureplane.OperationCloseCaptureTracks)
	return captureplane.CloseCaptureTracksResult{Connection: p.connection(), Tracks: []captureplane.PulledCaptureTrack{{CaptureTrack: validTrack(6), MID: "mid-1"}}, Negotiation: captureplane.Negotiation{Requirement: captureplane.NegotiationNotRequired}}, nil
}

func (p *fakePlane) CloseCaptureConnection(context.Context, captureplane.CloseCaptureConnectionInput) (captureplane.CloseCaptureConnectionResult, error) {
	p.count(captureplane.OperationCloseCaptureConnection)
	return captureplane.CloseCaptureConnectionResult{Connection: p.connection(), Closed: !p.closeDenied}, nil
}

type memoryCommand struct {
	fingerprint [32]byte
	outcome     StoredOutcome
	inflight    bool
	claimToken  string
}

type memoryPort struct {
	mu              sync.Mutex
	commands        map[CommandKey]*memoryCommand
	projection      *ConnectionProjection
	claimProjection *ConnectionProjection
	prepare         PrepareRequest
	claim           []ClaimRequest
	completion      Completion
	prepareErr      error
	busyClaims      int
	claims          int
	notBefore       bool
	notBeforeAt     time.Time
	ambiguous       bool
	failure         Failure
	releases        int
}

func newMemoryPort() *memoryPort { return &memoryPort{commands: make(map[CommandKey]*memoryCommand)} }

func (p *memoryPort) PrepareCommand(_ context.Context, request PrepareRequest) (PrepareResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prepare = request
	if p.prepareErr != nil {
		return PrepareResult{}, p.prepareErr
	}
	command, ok := p.commands[request.Key]
	if ok {
		if command.fingerprint != request.Fingerprint {
			return PrepareResult{}, ConflictError{Operation: request.Key.Operation}
		}
		return PrepareResult{Prepared: false, Outcome: command.outcome, CurrentProjection: p.projection}, nil
	}
	p.commands[request.Key] = &memoryCommand{fingerprint: request.Fingerprint}
	return PrepareResult{Prepared: true, CurrentProjection: p.projection}, nil
}

func (p *memoryPort) ClaimCommand(_ context.Context, request ClaimRequest) (ClaimResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.claim = append(p.claim, request)
	p.claims++
	command := p.commands[request.Key]
	projection := p.projection
	if p.claimProjection != nil {
		projection = p.claimProjection
	}
	if len(command.outcome.ResultBytes) > 0 || command.outcome.ProviderFailure != nil {
		return ClaimResult{Outcome: command.outcome, CurrentProjection: projection}, nil
	}
	if p.ambiguous {
		return ClaimResult{Ambiguous: true}, nil
	}
	if p.busyClaims > 0 {
		p.busyClaims--
		return ClaimResult{}, nil
	}
	if command.inflight {
		return ClaimResult{}, nil
	}
	command.inflight = true
	command.claimToken = "claim-1"
	if p.notBefore && p.notBeforeAt.IsZero() {
		p.notBeforeAt = request.ClaimedAt.Add(50 * time.Millisecond)
		return ClaimResult{Claimed: true, ClaimToken: command.claimToken, NotBefore: p.notBeforeAt, CurrentProjection: projection}, nil
	}
	return ClaimResult{Claimed: true, ClaimToken: command.claimToken, CurrentProjection: projection}, nil
}

func (p *memoryPort) ReleaseCommand(_ context.Context, release Release) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	command := p.commands[release.Key]
	if command == nil || !command.inflight || command.claimToken != release.ClaimToken {
		return ErrStaleLease
	}
	command.inflight = false
	command.claimToken = ""
	p.releases++
	return nil
}

func (p *memoryPort) CompleteCommand(_ context.Context, completion Completion) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.completion = completion
	command := p.commands[completion.Key]
	if command.claimToken != completion.ClaimToken {
		return ErrStaleLease
	}
	command.inflight = false
	command.outcome = StoredOutcome{ResultBytes: append([]byte(nil), completion.ResultBytes...)}
	if completion.Projection != nil {
		projection := *completion.Projection
		p.projection = &projection
	}
	return nil
}

func (p *memoryPort) FailCommand(_ context.Context, failure Failure) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	command := p.commands[failure.Key]
	command.inflight = false
	command.outcome = StoredOutcome{ProviderFailure: &failure.ProviderError}
	p.failure = failure
	return nil
}
