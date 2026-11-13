package capturesignaling

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
)

func TestServiceReclaimsLatePublisherPullWithinWaitWindow(t *testing.T) {
	command := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	store := newMemoryPort()
	store.projection = projectionFor(command, "")
	provider := &fakePlane{pullNotFoundOnce: true}
	service, err := NewService(store, provider, Options{MaxWait: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); err != nil {
		t.Fatalf("late publisher pull: %v", err)
	}
	if provider.calls(captureplane.OperationPullCaptureTracks) != 2 || store.claims < 2 || store.failure.ProviderError.Class != captureplane.ProviderFailureNotFound {
		t.Fatalf("pull calls=%d claims=%d first failure=%#v, want two attempts of same fenced pull", provider.calls(captureplane.OperationPullCaptureTracks), store.claims, store.failure.ProviderError)
	}
	for _, claim := range store.claim {
		if claim.Key != store.claim[0].Key {
			t.Fatal("late publisher retry changed the command key")
		}
	}
}

type testPublicationRetirer struct {
	calls int
	gone  []captureplane.CaptureTrack
	err   error
}

func (r *testPublicationRetirer) RetireGone(_ context.Context, _ Command, gone []captureplane.CaptureTrack) (int, error) {
	r.calls++
	r.gone = append([]captureplane.CaptureTrack(nil), gone...)
	if r.err != nil {
		return 0, r.err
	}
	return len(gone), nil
}

func TestServiceRetiresGonePublicationBeforeCompletingPull(t *testing.T) {
	command := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	store := newMemoryPort()
	store.projection = projectionFor(command, "")
	provider := &fakePlane{pullGone: true}
	retirer := &testPublicationRetirer{}
	service, err := NewService(store, provider, Options{Retirer: retirer})
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.Execute(context.Background(), ExecuteRequest{Command: command})
	if err != nil || first.Result.PullCaptureTracks == nil || len(first.Result.PullCaptureTracks.Gone) != 1 {
		t.Fatalf("first pull = %#v, %v", first, err)
	}
	second, err := service.Execute(context.Background(), ExecuteRequest{Command: command})
	if err != nil || !second.Replayed || retirer.calls != 1 || len(retirer.gone) != 1 || provider.calls(captureplane.OperationPullCaptureTracks) != 1 {
		t.Fatalf("replay = %#v, error=%v, retire calls=%d, provider calls=%d", second, err, retirer.calls, provider.calls(captureplane.OperationPullCaptureTracks))
	}
}

func TestServiceRejectsUnrequestedGoneTrackWithoutRetirement(t *testing.T) {
	command := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	store := newMemoryPort()
	store.projection = projectionFor(command, "")
	retirer := &testPublicationRetirer{}
	service, err := NewService(store, &fakePlane{pullGoneWrong: true}, Options{Retirer: retirer})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Execute(context.Background(), ExecuteRequest{Command: command})
	var failure ProviderFailureError
	if !errors.As(err, &failure) || failure.Failure.Code != "invalid_result" || retirer.calls != 0 {
		t.Fatalf("unrequested gone track: error=%v, retirement calls=%d", err, retirer.calls)
	}
}

func TestServiceTreatsFailedRetirementAsAmbiguousPull(t *testing.T) {
	command := commandFor(captureplane.OperationPullCaptureTracks, time.Now().Add(time.Minute))
	store := newMemoryPort()
	store.projection = projectionFor(command, "")
	service, err := NewService(store, &fakePlane{pullGone: true}, Options{Retirer: &testPublicationRetirer{err: errors.New("store unavailable")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Execute(context.Background(), ExecuteRequest{Command: command}); !errors.Is(err, ErrAmbiguousOutcome) {
		t.Fatalf("retirement failure = %v, want ambiguous outcome", err)
	}
	if len(store.completion.ResultBytes) != 0 {
		t.Fatalf("retirement failure persisted an acknowledged result: %#v", store.completion)
	}
}
