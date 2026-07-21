package providerbridge

import (
	"context"
	"errors"
	"fmt"
	"strings"

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
	sessionID utilities.ID,
	after *provideroperations.Cursor,
	limit int,
) (provideroperations.ObservationPage, error) {
	if s.repository == nil {
		return provideroperations.ObservationPage{}, ErrUnavailable
	}

	page, err := s.repository.ListObservations(ctx, tenantID, sessionID, after, limit)
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
		return s.apply(ctx, receipt, s.executor.Reconcile(ctx, receiptInput(receipt)))

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
		return s.apply(ctx, dispatching, s.executor.Dispatch(ctx, receiptInput(dispatching)))

	default:
		return Result{}, provideroperations.ErrInvalidReceiptState
	}
}

func (s Service) apply(
	ctx context.Context,
	receipt provideroperations.Receipt,
	execution ExecutionResult,
) (Result, error) {
	if err := validateExecutionResult(execution); err != nil {
		return ambiguousResult(receipt, "invalid_provider_result"), errors.Join(ErrInvalidProviderResult, err)
	}

	if execution.Observation != nil {
		if _, err := s.repository.AppendObservation(ctx, *execution.Observation); err != nil &&
			!errors.Is(err, provideroperations.ErrObservationStale) {
			return ambiguousResult(receipt, "observation_unavailable"), fmt.Errorf("append provider observation: %w", err)
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
			return Result{}, fmt.Errorf("complete provider operation: %w", err)
		}
		return storedResult(completed)

	case provideroperations.OutcomeRetryableFailure:
		if _, err := s.repository.ResetForRetry(ctx, receipt.OperationID, receipt.Effect); err != nil {
			return Result{}, fmt.Errorf("reset retryable provider operation: %w", err)
		}
		return executionResult(receipt, execution), nil

	case provideroperations.OutcomeAmbiguous:
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

func receiptInput(receipt provideroperations.Receipt) provideroperations.OperationInput {
	return provideroperations.OperationInput{
		OperationID:                  receipt.OperationID,
		Effect:                       receipt.Effect,
		TenantID:                     receipt.TenantID,
		SessionID:                    receipt.SessionID,
		ParticipantSessionID:         receipt.ParticipantSessionID,
		ParticipantSessionGeneration: receipt.ParticipantSessionGeneration,
		PublicationSource:            receipt.PublicationSource,
		RecordingID:                  receipt.RecordingID,
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
