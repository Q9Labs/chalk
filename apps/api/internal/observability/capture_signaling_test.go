package observability

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/capturesignaling"
)

type captureSignalingExecutorStub struct {
	execute func(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error)
}

func (s captureSignalingExecutorStub) Execute(ctx context.Context, request capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
	return s.execute(ctx, request)
}

func TestObservedCaptureSignalingExecutorPreservesResultAndError(t *testing.T) {
	wantResult := capturesignaling.Execution{Replayed: true}
	wantError := capturesignaling.ErrConflict
	executor := NewObservedCaptureSignalingExecutor(captureSignalingExecutorStub{execute: func(context.Context, capturesignaling.ExecuteRequest) (capturesignaling.Execution, error) {
		return wantResult, wantError
	}})
	result, err := executor.Execute(context.Background(), capturesignaling.ExecuteRequest{Command: capturesignaling.Command{
		Identity:  capturesignaling.CommandIdentity{Operation: captureplane.OperationPullCaptureTracks, PlanRevision: 2},
		Authority: capturesignaling.CommandAuthority{CaptureEpoch: 3},
		Input: capturesignaling.CommandInput{PullCaptureTracks: &captureplane.PullCaptureTracksInput{
			Tracks: []captureplane.CaptureTrack{{}, {}},
		}},
	}})
	if !result.Replayed || !errors.Is(err, wantError) {
		t.Fatalf("observed capture signaling result=%#v error=%v", result, err)
	}
}

func TestCaptureSignalingOutcomeIsBounded(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{err: capturesignaling.ErrInvalidCommand, want: "invalid"},
		{err: capturesignaling.ErrNegotiationMismatch, want: "fenced"},
		{err: capturesignaling.ErrAmbiguousOutcome, want: "ambiguous"},
		{err: capturesignaling.ErrProviderFailure, want: "provider_failure"},
		{err: errors.New("unknown"), want: "internal_error"},
	}
	for _, test := range tests {
		if got := captureSignalingOutcome(capturesignaling.Execution{}, test.err); got != test.want {
			t.Fatalf("capture signaling outcome for %v = %q, want %q", test.err, got, test.want)
		}
	}
}
