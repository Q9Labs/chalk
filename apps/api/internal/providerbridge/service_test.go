package providerbridge

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func TestFailureReceiptSurvivesReconcileAndReplay(t *testing.T) {
	for _, outcome := range []provideroperations.Outcome{provideroperations.OutcomeAmbiguous, provideroperations.OutcomeRetryableFailure} {
		t.Run(string(outcome), func(t *testing.T) {
			repository := &failureReceiptRepository{}
			executor := &failureReceiptExecutor{result: ExecutionResult{Outcome: outcome, Reason: "provider_timeout"}}
			service := NewService(repository, executor)
			input := testEndOperation(t)
			result, err := service.Execute(context.Background(), input)
			if err != nil || result.Reason != "provider_timeout" {
				t.Fatalf("execution = %+v, %v", result, err)
			}
			if repository.receipt.Reason == nil || *repository.receipt.Reason != "provider_timeout" || repository.receipt.LastErrorCode == nil || *repository.receipt.LastErrorCode != "provider_timeout" {
				t.Fatalf("failure was not persisted: %+v", repository.receipt)
			}
			// Resume with the same identity, including a pre-existing dispatching receipt.
			executor.result = ExecutionResult{Outcome: provideroperations.OutcomeSatisfied}
			service = NewService(repository, executor)
			result, err = service.Execute(context.Background(), input)
			if err != nil || result.Outcome != provideroperations.OutcomeSatisfied {
				t.Fatalf("reconcile = %+v, %v", result, err)
			}
			if repository.receipt.LastErrorCode != nil {
				t.Fatal("successful cleanup retained an error code")
			}
			calls := executor.calls
			result, err = service.Execute(context.Background(), input)
			if err != nil || result.Outcome != provideroperations.OutcomeSatisfied || calls != executor.calls {
				t.Fatalf("completed replay redispatched: %+v, %v", result, err)
			}
		})
	}
}

func TestInvalidProviderResultIsRecorded(t *testing.T) {
	repository := &failureReceiptRepository{}
	service := NewService(repository, &failureReceiptExecutor{result: ExecutionResult{Outcome: "invalid"}})
	_, err := service.Execute(context.Background(), testEndOperation(t))
	if !errors.Is(err, ErrInvalidProviderResult) || repository.receipt.LastErrorCode == nil || *repository.receipt.LastErrorCode != "invalid_provider_result" {
		t.Fatalf("invalid result lost: receipt=%+v err=%v", repository.receipt, err)
	}
}

func TestCanceledCallerStillRecordsAttemptFailure(t *testing.T) {
	repository := &failureReceiptRepository{}
	input := testEndOperation(t)
	prepared, err := repository.Prepare(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = NewService(repository, nil).apply(ctx, prepared.Receipt, ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous, Reason: "provider_timeout"})
	if err != nil || repository.receipt.LastErrorCode == nil || *repository.receipt.LastErrorCode != "provider_timeout" {
		t.Fatalf("canceled caller erased failure: %+v, %v", repository.receipt, err)
	}
}

func testEndOperation(t *testing.T) provideroperations.OperationInput {
	t.Helper()
	return provideroperations.OperationInput{OperationID: "episode-end-operation-0001", Effect: provideroperations.EffectEndEpisode, TenantID: testExecutorID(t, "11111111-1111-4111-8111-111111111111"), EpisodeID: testExecutorID(t, "22222222-2222-4222-8222-222222222222")}
}

type failureReceiptRepository struct {
	provideroperations.Repository
	receipt provideroperations.Receipt
}

func (r *failureReceiptRepository) Prepare(_ context.Context, input provideroperations.OperationInput) (provideroperations.PrepareResult, error) {
	if r.receipt.OperationID == "" {
		canonical, err := input.Canonicalize()
		if err != nil {
			return provideroperations.PrepareResult{}, err
		}
		r.receipt = provideroperations.Receipt{OperationID: input.OperationID, Effect: input.Effect, TenantID: input.TenantID, EpisodeID: input.EpisodeID, Payload: canonical.Payload, Fingerprint: canonical.Fingerprint, State: provideroperations.ReceiptPrepared}
	}
	return provideroperations.PrepareResult{Receipt: r.receipt}, nil
}
func (r *failureReceiptRepository) MarkDispatching(context.Context, string, provideroperations.Effect) (provideroperations.Receipt, error) {
	r.receipt.State = provideroperations.ReceiptDispatching
	return r.receipt, nil
}
func (r *failureReceiptRepository) ResetForRetry(context.Context, string, provideroperations.Effect) (provideroperations.Receipt, error) {
	r.receipt.State = provideroperations.ReceiptPrepared
	return r.receipt, nil
}
func (r *failureReceiptRepository) RecordFailure(ctx context.Context, _ string, _ provideroperations.Effect, reason string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.receipt.Reason = &reason
	r.receipt.LastErrorCode = &reason
	return nil
}
func (r *failureReceiptRepository) Complete(_ context.Context, _ string, _ provideroperations.Effect, completion provideroperations.Completion) (provideroperations.Receipt, error) {
	r.receipt.State = provideroperations.ReceiptCompleted
	r.receipt.Outcome = &completion.Outcome
	r.receipt.Reason = completion.Reason
	r.receipt.LastErrorCode = nil
	return r.receipt, nil
}

type failureReceiptExecutor struct {
	result ExecutionResult
	calls  int
}

func (e *failureReceiptExecutor) Dispatch(context.Context, provideroperations.OperationInput) ExecutionResult {
	e.calls++
	return e.result
}
func (e *failureReceiptExecutor) Reconcile(context.Context, provideroperations.OperationInput) ExecutionResult {
	e.calls++
	return e.result
}
