package providerbridge

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	testOperationID = "operation-000001"
	testTenantID    = "11111111-1111-4111-8111-111111111111"
	testSessionID   = "22222222-2222-4222-8222-222222222222"
)

func TestExecutePersistsBeforeDispatchAndReplaysCompletion(t *testing.T) {
	repository := newMemoryRepository()
	executor := &fakeExecutor{dispatch: ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}}
	service := NewService(repository, executor)

	first, err := service.Execute(context.Background(), operationInput(t))
	if err != nil {
		t.Fatalf("execute provider operation: %v", err)
	}
	second, err := service.Execute(context.Background(), operationInput(t))
	if err != nil {
		t.Fatalf("replay provider operation: %v", err)
	}

	if first.Outcome != provideroperations.OutcomeConfirmed || second != first {
		t.Fatalf("results = %#v, %#v, want stable confirmed result", first, second)
	}
	if executor.dispatchCalls != 1 || executor.reconcileCalls != 0 {
		t.Fatalf("executor calls = dispatch %d reconcile %d, want 1/0", executor.dispatchCalls, executor.reconcileCalls)
	}
	if repository.stateAtDispatch != provideroperations.ReceiptDispatching {
		t.Fatalf("state at dispatch = %q, want dispatching", repository.stateAtDispatch)
	}
}

func TestExecuteReconcilesAmbiguousBeforeReplay(t *testing.T) {
	repository := newMemoryRepository()
	executor := &fakeExecutor{
		dispatch:  ExecutionResult{Outcome: provideroperations.OutcomeAmbiguous},
		reconcile: ExecutionResult{Outcome: provideroperations.OutcomeSatisfied},
	}
	service := NewService(repository, executor)

	first, err := service.Execute(context.Background(), operationInput(t))
	if err != nil {
		t.Fatalf("execute ambiguous operation: %v", err)
	}
	second, err := service.Execute(context.Background(), operationInput(t))
	if err != nil {
		t.Fatalf("reconcile ambiguous operation: %v", err)
	}

	if first.Outcome != provideroperations.OutcomeAmbiguous || second.Outcome != provideroperations.OutcomeSatisfied {
		t.Fatalf("outcomes = %q then %q, want ambiguous then satisfied", first.Outcome, second.Outcome)
	}
	if executor.dispatchCalls != 1 || executor.reconcileCalls != 1 {
		t.Fatalf("executor calls = dispatch %d reconcile %d, want 1/1", executor.dispatchCalls, executor.reconcileCalls)
	}
}

func TestExecuteResetsDefiniteRetryableFailure(t *testing.T) {
	repository := newMemoryRepository()
	executor := &fakeExecutor{dispatch: ExecutionResult{
		Outcome: provideroperations.OutcomeRetryableFailure,
		Reason:  "rate_limited",
	}}
	service := NewService(repository, executor)

	for attempt := 0; attempt < 2; attempt++ {
		result, err := service.Execute(context.Background(), operationInput(t))
		if err != nil {
			t.Fatalf("execute retryable operation: %v", err)
		}
		if result.Outcome != provideroperations.OutcomeRetryableFailure || result.Reason != "rate_limited" {
			t.Fatalf("result = %#v, want retryable rate_limited", result)
		}
	}

	if executor.dispatchCalls != 2 || executor.reconcileCalls != 0 {
		t.Fatalf("executor calls = dispatch %d reconcile %d, want 2/0", executor.dispatchCalls, executor.reconcileCalls)
	}
}

func TestExecuteFingerprintConflictIsTerminalWithoutDispatch(t *testing.T) {
	repository := newMemoryRepository()
	executor := &fakeExecutor{dispatch: ExecutionResult{Outcome: provideroperations.OutcomeConfirmed}}
	service := NewService(repository, executor)

	if _, err := service.Execute(context.Background(), operationInput(t)); err != nil {
		t.Fatalf("execute provider operation: %v", err)
	}
	conflict := operationInput(t)
	conflict.PublicationSource = "microphone"
	result, err := service.Execute(context.Background(), conflict)
	if err != nil {
		t.Fatalf("execute conflicting operation: %v", err)
	}

	if result.Outcome != provideroperations.OutcomeTerminalFailure || result.Reason != "fingerprint_conflict" {
		t.Fatalf("result = %#v, want terminal fingerprint conflict", result)
	}
	if executor.dispatchCalls != 1 {
		t.Fatalf("dispatch calls = %d, want 1", executor.dispatchCalls)
	}
}

func TestExecuteRejectsInvalidProviderResultWithoutCompleting(t *testing.T) {
	repository := newMemoryRepository()
	executor := &fakeExecutor{dispatch: ExecutionResult{
		Outcome: provideroperations.OutcomeConfirmed,
		Reason:  "Provider Secret: leaked",
	}}
	service := NewService(repository, executor)

	result, err := service.Execute(context.Background(), operationInput(t))
	if !errors.Is(err, ErrInvalidProviderResult) {
		t.Fatalf("error = %v, want invalid provider result", err)
	}
	if result.Outcome != provideroperations.OutcomeAmbiguous {
		t.Fatalf("result = %#v, want ambiguous", result)
	}
	if repository.receipt.State != provideroperations.ReceiptDispatching {
		t.Fatalf("receipt state = %q, want dispatching", repository.receipt.State)
	}
}

func operationInput(t *testing.T) provideroperations.OperationInput {
	t.Helper()
	return provideroperations.OperationInput{
		OperationID:          testOperationID,
		Effect:               provideroperations.EffectRevokePublication,
		TenantID:             mustID(t, testTenantID),
		SessionID:            mustID(t, testSessionID),
		ParticipantSessionID: mustID(t, "33333333-3333-4333-8333-333333333333"),
		PublicationSource:    "camera",
	}
}

func mustID(t *testing.T, value string) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}

type fakeExecutor struct {
	dispatch       ExecutionResult
	reconcile      ExecutionResult
	dispatchCalls  int
	reconcileCalls int
}

func (e *fakeExecutor) Dispatch(_ context.Context, _ provideroperations.OperationInput) ExecutionResult {
	e.dispatchCalls++
	return e.dispatch
}

func (e *fakeExecutor) Reconcile(_ context.Context, _ provideroperations.OperationInput) ExecutionResult {
	e.reconcileCalls++
	return e.reconcile
}

type memoryRepository struct {
	receipt         provideroperations.Receipt
	hasReceipt      bool
	stateAtDispatch provideroperations.ReceiptState
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{}
}

func (r *memoryRepository) Prepare(_ context.Context, input provideroperations.OperationInput) (provideroperations.PrepareResult, error) {
	canonical, err := input.Canonicalize()
	if err != nil {
		return provideroperations.PrepareResult{}, err
	}
	if r.hasReceipt {
		if r.receipt.Fingerprint != canonical.Fingerprint {
			return provideroperations.PrepareResult{}, provideroperations.ErrFingerprintConflict
		}
		return provideroperations.PrepareResult{Receipt: r.receipt, Replay: true}, nil
	}
	r.receipt = provideroperations.Receipt{
		OperationID:                  canonical.Input.OperationID,
		Effect:                       canonical.Input.Effect,
		TenantID:                     canonical.Input.TenantID,
		SessionID:                    canonical.Input.SessionID,
		ParticipantSessionID:         canonical.Input.ParticipantSessionID,
		ParticipantSessionGeneration: canonical.Input.ParticipantSessionGeneration,
		PublicationSource:            canonical.Input.PublicationSource,
		RecordingID:                  canonical.Input.RecordingID,
		Fingerprint:                  canonical.Fingerprint,
		Payload:                      canonical.Payload,
		State:                        provideroperations.ReceiptPrepared,
	}
	r.hasReceipt = true
	return provideroperations.PrepareResult{Receipt: r.receipt}, nil
}

func (r *memoryRepository) MarkDispatching(_ context.Context, _ string, _ provideroperations.Effect) (provideroperations.Receipt, error) {
	if r.receipt.State != provideroperations.ReceiptPrepared {
		return provideroperations.Receipt{}, provideroperations.ErrReceiptConflict
	}
	r.receipt.State = provideroperations.ReceiptDispatching
	r.stateAtDispatch = r.receipt.State
	return r.receipt, nil
}

func (r *memoryRepository) ResetForRetry(_ context.Context, _ string, _ provideroperations.Effect) (provideroperations.Receipt, error) {
	if r.receipt.State != provideroperations.ReceiptDispatching {
		return provideroperations.Receipt{}, provideroperations.ErrReceiptConflict
	}
	r.receipt.State = provideroperations.ReceiptPrepared
	return r.receipt, nil
}

func (r *memoryRepository) Complete(_ context.Context, _ string, _ provideroperations.Effect, completion provideroperations.Completion) (provideroperations.Receipt, error) {
	if err := completion.Validate(); err != nil {
		return provideroperations.Receipt{}, err
	}
	r.receipt.State = provideroperations.ReceiptCompleted
	r.receipt.Outcome = &completion.Outcome
	r.receipt.Reason = completion.Reason
	return r.receipt, nil
}

func (r *memoryRepository) Get(_ context.Context, _ string, _ provideroperations.Effect) (provideroperations.Receipt, error) {
	if !r.hasReceipt {
		return provideroperations.Receipt{}, provideroperations.ErrReceiptNotFound
	}
	return r.receipt, nil
}

func (r *memoryRepository) AppendObservation(_ context.Context, input provideroperations.ObservationInput) (provideroperations.Observation, error) {
	canonical, fingerprint, _, err := input.Canonicalize()
	if err != nil {
		return provideroperations.Observation{}, err
	}
	return provideroperations.Observation{
		TenantID: canonical.TenantID, SessionID: canonical.SessionID,
		Incarnation: canonical.Incarnation, Sequence: canonical.Sequence,
		Publications: canonical.Publications, Fingerprint: fingerprint,
	}, nil
}

func (*memoryRepository) ListObservations(context.Context, utilities.ID, utilities.ID, *provideroperations.Cursor, int) (provideroperations.ObservationPage, error) {
	return provideroperations.ObservationPage{}, nil
}

var _ provideroperations.Repository = (*memoryRepository)(nil)
