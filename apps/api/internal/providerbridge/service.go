package providerbridge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/provideroperations"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

var (
	ErrUnavailable           = errors.New("provider bridge unavailable")
	ErrInvalidProviderResult = errors.New("invalid provider bridge result")
)

const maxReasonCodeBytes = 64

var tracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/providerbridge")
var operationCounter, _ = otel.Meter("github.com/q9labs/chalk/apps/api/internal/providerbridge").Int64Counter(
	"chalk.api.provider_bridge.operations",
	metric.WithDescription("Provider bridge operations by bounded effect and outcome"),
)

type Executor interface {
	Dispatch(context.Context, provideroperations.OperationInput) ExecutionResult
	Reconcile(context.Context, provideroperations.OperationInput) ExecutionResult
}

type ExecutionResult struct {
	Outcome     provideroperations.Outcome
	Reason      string
	Observation *provideroperations.ObservationInput
}

type Result struct {
	OperationID string
	Effect      provideroperations.Effect
	Outcome     provideroperations.Outcome
	Reason      string
}

type Service struct {
	repository provideroperations.Repository
	executor   Executor
}

func NewService(repository provideroperations.Repository, executor Executor) Service {
	return Service{repository: repository, executor: executor}
}

func (s Service) Ready(context.Context) error {
	if s.repository == nil || s.executor == nil {
		return ErrUnavailable
	}
	return nil
}

func (s Service) Execute(ctx context.Context, input provideroperations.OperationInput) (result Result, err error) {
	ctx, span := tracer.Start(ctx, "provider_bridge.execute")
	defer func() {
		outcome := string(result.Outcome)
		if outcome == "" {
			outcome = "internal_error"
		}
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "provider operation failed")
		} else if result.Outcome == provideroperations.OutcomeRetryableFailure || result.Outcome == provideroperations.OutcomeTerminalFailure || result.Outcome == provideroperations.OutcomeAmbiguous {
			span.SetStatus(codes.Error, "provider operation was not confirmed")
		}
		span.SetAttributes(
			attribute.String("chalk.provider.effect", string(input.Effect)),
			attribute.String("chalk.provider.outcome", outcome),
		)
		operationCounter.Add(ctx, 1, metric.WithAttributes(
			attribute.String("chalk.provider.effect", string(input.Effect)),
			attribute.String("chalk.provider.outcome", outcome),
		))
		span.End()
		level := slog.LevelInfo
		errorCode := result.Reason
		if err != nil {
			level = slog.LevelError
			if errorCode == "" {
				errorCode = "provider_bridge_failed"
			}
		}
		slog.Log(ctx, level, "Provider operation executed", "operation_id", input.OperationID, "effect", input.Effect, "stage", "execute", "outcome", outcome, "error_code", errorCode)
	}()

	if s.repository == nil || s.executor == nil {
		return Result{}, ErrUnavailable
	}

	prepared, err := s.repository.Prepare(ctx, input)
	if errors.Is(err, provideroperations.ErrFingerprintConflict) {
		return Result{
			OperationID: input.OperationID,
			Effect:      input.Effect,
			Outcome:     provideroperations.OutcomeTerminalFailure,
			Reason:      "fingerprint_conflict",
		}, nil
	}
	if err != nil {
		return Result{}, fmt.Errorf("prepare provider operation: %w", err)
	}

	return s.resume(ctx, prepared.Receipt)
}

func (s Service) ListObservations(
	ctx context.Context,
	tenantID utilities.ID,
	episodeID utilities.ID,
	after *provideroperations.Cursor,
	limit int,
) (provideroperations.ObservationPage, error) {
	if s.repository == nil {
		return provideroperations.ObservationPage{}, ErrUnavailable
	}

	page, err := s.repository.ListObservations(ctx, tenantID, episodeID, after, limit)
	if err != nil {
		return provideroperations.ObservationPage{}, fmt.Errorf("list provider observations: %w", err)
	}
	return page, nil
}

func (s Service) resume(ctx context.Context, receipt provideroperations.Receipt) (Result, error) {
	switch receipt.State {
	case provideroperations.ReceiptCompleted:
		return storedResult(receipt)

	case provideroperations.ReceiptDispatching:
		input, err := provideroperations.OperationFromReceipt(receipt)
		if err != nil {
			return Result{}, fmt.Errorf("decode provider operation receipt payload: %w", err)
		}
		return s.apply(ctx, receipt, s.runExecutor(ctx, input, "reconcile"))

	case provideroperations.ReceiptPrepared:
		dispatching, err := s.repository.MarkDispatching(ctx, receipt.OperationID, receipt.Effect)
		if errors.Is(err, provideroperations.ErrReceiptConflict) {
			current, getErr := s.repository.Get(ctx, receipt.OperationID, receipt.Effect)
			if getErr != nil {
				return Result{}, fmt.Errorf("resolve provider operation dispatch race: %w", getErr)
			}
			return s.resume(ctx, current)
		}
		if err != nil {
			return Result{}, fmt.Errorf("mark provider operation dispatching: %w", err)
		}
		input, err := provideroperations.OperationFromReceipt(dispatching)
		if err != nil {
			return Result{}, fmt.Errorf("decode provider operation receipt payload: %w", err)
		}
		return s.apply(ctx, dispatching, s.runExecutor(ctx, input, "dispatch"))

	default:
		return Result{}, provideroperations.ErrInvalidReceiptState
	}
}

func (s Service) runExecutor(ctx context.Context, input provideroperations.OperationInput, stage string) ExecutionResult {
	slog.InfoContext(ctx, "Provider operation started", "operation_id", input.OperationID, "effect", input.Effect, "stage", stage)
	var result ExecutionResult
	if stage == "reconcile" {
		result = s.executor.Reconcile(ctx, input)
	} else {
		result = s.executor.Dispatch(ctx, input)
	}
	slog.InfoContext(ctx, "Provider operation result", "operation_id", input.OperationID, "effect", input.Effect, "stage", stage, "outcome", result.Outcome, "error_code", result.Reason)
	return result
}

func (s Service) recordFailure(ctx context.Context, receipt provideroperations.Receipt, reason string) error {
	// A disconnected caller must not erase the durable attempt's failure evidence.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()
	if err := s.repository.RecordFailure(ctx, receipt.OperationID, receipt.Effect, reason); err != nil {
		slog.ErrorContext(ctx, "Provider operation failure could not be recorded", "operation_id", receipt.OperationID, "effect", receipt.Effect, "stage", "record_failure", "error_code", reason)
		return fmt.Errorf("record provider operation failure: %w", err)
	}
	return nil
}

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
