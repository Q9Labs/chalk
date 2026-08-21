package publicinvites

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

const (
	DefaultLifecycleWorkerBatchSize  = 50
	DefaultLifecycleWorkerMaxBatches = 4
	DefaultLifecycleRetryBase        = time.Minute
	DefaultLifecycleRetryMax         = time.Hour
	DefaultLifecycleWorkerInterval   = time.Minute
)

var (
	ErrLifecycleActionsUnavailable = errors.New("public lifecycle actions port unavailable")

	lifecycleWorkerTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/publicinvites")
	lifecycleWorkerMeter  = otel.Meter("github.com/q9labs/chalk/apps/api/internal/publicinvites")

	lifecycleWorkerRuns, _ = lifecycleWorkerMeter.Int64Counter(
		"chalk.api.public_invites.lifecycle.runs",
		metric.WithUnit("{run}"),
	)
	lifecycleWorkerItems, _ = lifecycleWorkerMeter.Int64Counter(
		"chalk.api.public_invites.lifecycle.items",
		metric.WithUnit("{item}"),
	)
)

// LifecycleActionInput is the narrow cleanup command shared by the Episode
// and Space adapters. RequestKey is stable across retries and never contains a
// credential or invite token.
type LifecycleActionInput struct {
	TenantID             utilities.ID
	SpaceID              utilities.ID
	CreatorArrivalHandle utilities.ID
	RequestKey           string
}

// LifecycleActions owns the external side effects of auto-Space expiry. The
// worker claims and records durable lifecycle state; adapters end the live
// Episode and archive the Space idempotently.
type LifecycleActions interface {
	EndEpisode(context.Context, LifecycleActionInput) error
	ArchiveSpace(context.Context, LifecycleActionInput) error
}

type LifecycleWorkerResult struct {
	Batches  int
	Listed   int
	Claimed  int
	Archived int
	Retried  int
	Skipped  int
	Failed   int
}

type LifecycleWorker struct {
	lifecycle  Lifecycle
	actions    LifecycleActions
	now        func() time.Time
	batchSize  int32
	maxBatches int
	retryBase  time.Duration
	retryMax   time.Duration
}

func NewLifecycleWorker(lifecycle Lifecycle, actions LifecycleActions) LifecycleWorker {
	return LifecycleWorker{
		lifecycle:  lifecycle,
		actions:    actions,
		now:        time.Now,
		batchSize:  DefaultLifecycleWorkerBatchSize,
		maxBatches: DefaultLifecycleWorkerMaxBatches,
		retryBase:  DefaultLifecycleRetryBase,
		retryMax:   DefaultLifecycleRetryMax,
	}
}

func NewLifecycleWorkerWithBatch(lifecycle Lifecycle, actions LifecycleActions, batchSize int32) (LifecycleWorker, error) {
	if batchSize <= 0 {
		return LifecycleWorker{}, ErrInvalidLifecycleState
	}
	worker := NewLifecycleWorker(lifecycle, actions)
	worker.batchSize = batchSize
	return worker, nil
}

func (w LifecycleWorker) Run(ctx context.Context) (result LifecycleWorkerResult, resultErr error) {
	ctx, span := lifecycleWorkerTracer.Start(ctx, "public_invites.lifecycle")
	defer func() {
		outcome := "succeeded"
		if resultErr != nil {
			outcome = "failed"
			span.RecordError(resultErr)
			span.SetStatus(codes.Error, "public Space lifecycle failed")
		}
		span.SetAttributes(
			attribute.String("chalk.public_invites.lifecycle.outcome", outcome),
			attribute.Int("chalk.public_invites.lifecycle.batches", result.Batches),
			attribute.Int("chalk.public_invites.lifecycle.listed", result.Listed),
			attribute.Int("chalk.public_invites.lifecycle.claimed", result.Claimed),
			attribute.Int("chalk.public_invites.lifecycle.archived", result.Archived),
			attribute.Int("chalk.public_invites.lifecycle.retried", result.Retried),
			attribute.Int("chalk.public_invites.lifecycle.skipped", result.Skipped),
			attribute.Int("chalk.public_invites.lifecycle.failed", result.Failed),
		)
		lifecycleWorkerRuns.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
		span.End()
	}()

	if err := w.validate(); err != nil {
		return result, err
	}
	now := w.now().UTC()
	var failures []error
	for result.Batches < w.maxBatches {
		if err := ctx.Err(); err != nil {
			return result, errors.Join(errors.Join(failures...), err)
		}
		rows, err := w.lifecycle.ListDueAutoLifecycles(ctx, now, w.batchSize)
		result.Batches++
		if err != nil {
			return result, errors.Join(errors.Join(failures...), fmt.Errorf("list due public Space lifecycles: %w", err))
		}
		result.Listed += len(rows)
		for _, lifecycle := range rows {
			if err := ctx.Err(); err != nil {
				return result, errors.Join(errors.Join(failures...), err)
			}
			status, claimed, err := w.process(ctx, now, lifecycle)
			if claimed {
				result.Claimed++
			}
			lifecycleWorkerItems.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", lifecycleItemOutcome(status))))
			switch status {
			case lifecycleItemArchived:
				result.Archived++
			case lifecycleItemRetried:
				result.Retried++
				result.Failed++
			case lifecycleItemSkipped:
				result.Skipped++
			case lifecycleItemFailed:
				result.Failed++
			}
			if err != nil {
				failures = append(failures, err)
			}
		}
		if len(rows) < int(w.batchSize) {
			break
		}
	}
	return result, errors.Join(failures...)
}

type lifecycleItemStatus uint8

const (
	lifecycleItemArchived lifecycleItemStatus = iota + 1
	lifecycleItemRetried
	lifecycleItemSkipped
	lifecycleItemFailed
)

func (w LifecycleWorker) process(ctx context.Context, now time.Time, lifecycle AutoLifecycle) (lifecycleItemStatus, bool, error) {
	if err := validateLifecycleForWorker(lifecycle); err != nil {
		return lifecycleItemFailed, false, err
	}
	claimed, err := w.lifecycle.MarkAutoLifecycleArchiving(ctx, lifecycle.TenantID, lifecycle.SpaceID)
	if errors.Is(err, ErrAutoLifecycleNotFound) || errors.Is(err, ErrInvalidLifecycleState) {
		return lifecycleItemSkipped, false, nil
	}
	if err != nil {
		return lifecycleItemFailed, false, fmt.Errorf("claim public Space lifecycle: %w", err)
	}

	input := LifecycleActionInput{
		TenantID:             claimed.TenantID,
		SpaceID:              claimed.SpaceID,
		CreatorArrivalHandle: claimed.CreatorArrivalHandle,
	}
	input.RequestKey = lifecycleActionRequestKey(claimed, "end")
	if err := w.actions.EndEpisode(ctx, input); err != nil {
		status, retryErr := w.retry(ctx, now, claimed, "episode_end_failed", err)
		return status, true, retryErr
	}
	input.RequestKey = lifecycleActionRequestKey(claimed, "archive")
	if err := w.actions.ArchiveSpace(ctx, input); err != nil {
		status, retryErr := w.retry(ctx, now, claimed, "space_archive_failed", err)
		return status, true, retryErr
	}
	if _, err := w.lifecycle.MarkAutoLifecycleArchived(ctx, claimed.TenantID, claimed.SpaceID); err != nil {
		status, retryErr := w.retry(ctx, now, claimed, "lifecycle_archive_failed", err)
		return status, true, retryErr
	}
	return lifecycleItemArchived, true, nil
}

func (w LifecycleWorker) retry(ctx context.Context, now time.Time, lifecycle AutoLifecycle, family string, cause error) (lifecycleItemStatus, error) {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return lifecycleItemFailed, errors.Join(cause, ctxErr)
	}
	nextRetryAt := now.Add(lifecycleRetryBackoff(lifecycle.RetryCount, w.retryBase, w.retryMax))
	_, retryErr := w.lifecycle.RetryAutoLifecycle(ctx, RetryAutoLifecycleInput{
		TenantID:    lifecycle.TenantID,
		SpaceID:     lifecycle.SpaceID,
		NextRetryAt: nextRetryAt,
		ErrorFamily: family,
	})
	if retryErr != nil {
		return lifecycleItemFailed, errors.Join(cause, fmt.Errorf("schedule public Space lifecycle retry: %w", retryErr))
	}
	return lifecycleItemRetried, cause
}

func (w LifecycleWorker) validate() error {
	if w.lifecycle == nil {
		return ErrLifecycleUnavailable
	}
	if w.actions == nil {
		return ErrLifecycleActionsUnavailable
	}
	if w.now == nil || w.batchSize <= 0 || w.maxBatches <= 0 || w.retryBase <= 0 || w.retryMax < w.retryBase {
		return ErrInvalidLifecycleState
	}
	return nil
}

func validateLifecycleForWorker(lifecycle AutoLifecycle) error {
	if lifecycle.TenantID.IsZero() || lifecycle.SpaceID.IsZero() || lifecycle.DeadlineAt.IsZero() || lifecycle.CreatorArrivalHandle.IsZero() {
		return ErrInvalidLifecycleState
	}
	if lifecycle.State != AutoLifecycleActive {
		return ErrInvalidLifecycleState
	}
	if lifecycle.RetryCount < 0 || lifecycle.RetryCount > 1<<30 || lifecycle.LastErrorFamily != "" && !validErrorFamily(lifecycle.LastErrorFamily) {
		return ErrInvalidLifecycleState
	}
	return nil
}

func lifecycleRetryBackoff(retryCount int32, base, maximum time.Duration) time.Duration {
	if retryCount <= 0 {
		return base
	}
	backoff := base
	for index := int32(0); index < retryCount && backoff < maximum; index++ {
		if backoff > maximum/2 {
			return maximum
		}
		backoff *= 2
	}
	if backoff > maximum {
		return maximum
	}
	return backoff
}

func lifecycleActionRequestKey(lifecycle AutoLifecycle, action string) string {
	return fmt.Sprintf("public-space-lifecycle-v1-%s-%s-%s", lifecycle.TenantID, lifecycle.SpaceID, action)
}

func lifecycleItemOutcome(status lifecycleItemStatus) string {
	switch status {
	case lifecycleItemArchived:
		return "archived"
	case lifecycleItemRetried:
		return "retry_scheduled"
	case lifecycleItemSkipped:
		return "skipped"
	default:
		return "failed"
	}
}

type LifecycleCycleRunner interface {
	Run(context.Context) (LifecycleWorkerResult, error)
}

type LifecycleScheduler struct {
	worker   LifecycleCycleRunner
	interval time.Duration
	logger   *slog.Logger
}

func NewLifecycleScheduler(worker LifecycleCycleRunner, interval time.Duration, logger *slog.Logger) *LifecycleScheduler {
	if interval <= 0 {
		interval = DefaultLifecycleWorkerInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &LifecycleScheduler{worker: worker, interval: interval, logger: logger}
}

func (s *LifecycleScheduler) Run(ctx context.Context) error {
	if s == nil || s.worker == nil || s.interval <= 0 || s.logger == nil {
		return ErrInvalidLifecycleState
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		result, err := s.worker.Run(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			s.logger.ErrorContext(ctx, "public Space lifecycle cycle failed",
				"event", "public_invites.lifecycle", "listed", result.Listed,
				"claimed", result.Claimed, "archived", result.Archived,
				"retried", result.Retried, "failed", result.Failed, "error", err)
		} else if result.Listed > 0 {
			s.logger.InfoContext(ctx, "public Space lifecycle cycle completed",
				"event", "public_invites.lifecycle", "listed", result.Listed,
				"claimed", result.Claimed, "archived", result.Archived,
				"retried", result.Retried, "skipped", result.Skipped)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

var _ LifecycleCycleRunner = LifecycleWorker{}
