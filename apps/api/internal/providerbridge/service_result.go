package providerbridge

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
)

func (s Service) apply(
	ctx context.Context,
	receipt provideroperations.Receipt,
	execution ExecutionResult,
) (Result, error) {
	if execution.Reason == "" && (execution.Outcome == provideroperations.OutcomeRetryableFailure || execution.Outcome == provideroperations.OutcomeAmbiguous || execution.Outcome == provideroperations.OutcomeTerminalFailure) {
		execution.Reason = "provider_failure_without_reason"
	}
	if err := validateExecutionResult(execution); err != nil {
		recordErr := s.recordFailure(ctx, receipt, "invalid_provider_result")
		return ambiguousResult(receipt, "invalid_provider_result"), errors.Join(ErrInvalidProviderResult, err, recordErr)
	}

	if execution.Observation != nil {
		if _, err := s.repository.AppendObservation(ctx, *execution.Observation); err != nil &&
			!errors.Is(err, provideroperations.ErrObservationStale) {
			recordErr := s.recordFailure(ctx, receipt, "observation_unavailable")
			return ambiguousResult(receipt, "observation_unavailable"), errors.Join(fmt.Errorf("append provider observation: %w", err), recordErr)
		}
	}

	switch execution.Outcome {
	case provideroperations.OutcomeConfirmed,
		provideroperations.OutcomeSatisfied,
		provideroperations.OutcomeTerminalFailure:
		completed, err := s.repository.Complete(ctx, receipt.OperationID, receipt.Effect, provideroperations.Completion{
			Outcome: execution.Outcome,
			Reason:  optionalReason(execution.Reason),
		})
		if err != nil {
			recordErr := s.recordFailure(ctx, receipt, "receipt_completion_failed")
			return Result{}, errors.Join(fmt.Errorf("complete provider operation: %w", err), recordErr)
		}
		return storedResult(completed)

	case provideroperations.OutcomeRetryableFailure:
		if err := s.recordFailure(ctx, receipt, execution.Reason); err != nil {
			return Result{}, err
		}
		if _, err := s.repository.ResetForRetry(ctx, receipt.OperationID, receipt.Effect); err != nil {
			return Result{}, fmt.Errorf("reset retryable provider operation: %w", err)
		}
		return executionResult(receipt, execution), nil

	case provideroperations.OutcomeAmbiguous:
		if err := s.recordFailure(ctx, receipt, execution.Reason); err != nil {
			return Result{}, err
		}
		return executionResult(receipt, execution), nil

	default:
		return Result{}, provideroperations.ErrInvalidOutcome
	}
}

func storedResult(receipt provideroperations.Receipt) (Result, error) {
	if receipt.Outcome == nil {
		return Result{}, provideroperations.ErrReceiptConflict
	}

	result := Result{
		OperationID: receipt.OperationID,
		Effect:      receipt.Effect,
		Outcome:     *receipt.Outcome,
	}
	if receipt.Reason != nil {
		result.Reason = *receipt.Reason
	}
	return result, nil
}

func executionResult(receipt provideroperations.Receipt, execution ExecutionResult) Result {
	return Result{
		OperationID: receipt.OperationID,
		Effect:      receipt.Effect,
		Outcome:     execution.Outcome,
		Reason:      execution.Reason,
	}
}

func ambiguousResult(receipt provideroperations.Receipt, reason string) Result {
	return Result{
		OperationID: receipt.OperationID,
		Effect:      receipt.Effect,
		Outcome:     provideroperations.OutcomeAmbiguous,
		Reason:      reason,
	}
}

func validateExecutionResult(result ExecutionResult) error {
	switch result.Outcome {
	case provideroperations.OutcomeConfirmed,
		provideroperations.OutcomeSatisfied,
		provideroperations.OutcomeRetryableFailure,
		provideroperations.OutcomeTerminalFailure,
		provideroperations.OutcomeAmbiguous:
	default:
		return provideroperations.ErrInvalidOutcome
	}

	if result.Reason == "" {
		return nil
	}
	if len(result.Reason) > maxReasonCodeBytes || strings.TrimSpace(result.Reason) != result.Reason {
		return provideroperations.ErrInvalidReason
	}
	for _, character := range result.Reason {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
			return provideroperations.ErrInvalidReason
		}
	}
	return nil
}

func optionalReason(reason string) *string {
	if reason == "" {
		return nil
	}
	return &reason
}
