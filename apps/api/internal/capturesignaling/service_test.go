package capturesignaling

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
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

func TestServiceFailsBeforeClaimWhenEpisodeCaptureBindingCannotResolve(t *testing.T) {
	provider := &fakePlane{resolveErr: captureplane.ProviderError{
		Class: captureplane.ProviderFailureUnavailable, Code: "adapter_unavailable", Retryable: false,
	}}
	store := newMemoryPort()
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}

	_, err = service.Execute(context.Background(), ExecuteRequest{Command: commandFor(captureplane.OperationCreateCaptureConnection, time.Now().Add(time.Minute))})
	var failure ProviderFailureError
	if !errors.As(err, &failure) || failure.Failure.Code != "adapter_unavailable" || failure.Failure.Retryable {
		t.Fatalf("execute error = %#v, want bounded non-retryable adapter_unavailable", err)
	}
	if store.claims != 0 || provider.calls(captureplane.OperationCreateCaptureConnection) != 0 {
		t.Fatalf("claims = %d provider calls = %d, want no claimed or dispatched command", store.claims, provider.calls(captureplane.OperationCreateCaptureConnection))
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
	if provider.resolved() != metadata.Identity {
		t.Fatal("capture plane resolver did not receive the canonical Chalk identity")
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
