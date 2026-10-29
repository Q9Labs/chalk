package whiteboardfiles

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

const (
	whiteboardFileRetention = 7 * 24 * time.Hour
	cleanupLeaseDuration    = 5 * time.Minute
	cleanupBatchSize        = 50
	cleanupMaxBatches       = 4
)

var (
	cleanupTracer = otel.Tracer("github.com/q9labs/chalk/apps/api/internal/whiteboardfiles")
	cleanupMeter  = otel.Meter("github.com/q9labs/chalk/apps/api/internal/whiteboardfiles")

	cleanupRuns, _ = cleanupMeter.Int64Counter(
		"chalk.api.whiteboard_files.cleanup.runs",
		metric.WithUnit("{run}"),
	)
	cleanupObjects, _ = cleanupMeter.Int64Counter(
		"chalk.api.whiteboard_files.cleanup.objects",
		metric.WithUnit("{object}"),
	)
)

type CleanupClaim struct {
	UploadID  utilities.ID
	ObjectKey string
	Token     utilities.ID
}

type CleanupClaimInput struct {
	Now         time.Time
	EndedBefore time.Time
	LeaseUntil  time.Time
	Limit       int
}

type CleanupRepository interface {
	ClaimCleanup(context.Context, CleanupClaimInput) ([]CleanupClaim, error)
	CompleteCleanup(context.Context, CleanupClaim) error
}

type ObjectDeleter interface {
	DeleteObject(context.Context, string) error
}

type CleanupResult struct {
	Batches int
	Claimed int
	Deleted int
	Failed  int
}

type CleanupWorker struct {
	repository    CleanupRepository
	objects       ObjectDeleter
	now           func() time.Time
	batchSize     int
	maxBatches    int
	leaseDuration time.Duration
}

func NewCleanupWorker(repository CleanupRepository, objects ObjectDeleter) CleanupWorker {
	return CleanupWorker{
		repository: repository, objects: objects, now: time.Now,
		batchSize: cleanupBatchSize, maxBatches: cleanupMaxBatches,
		leaseDuration: cleanupLeaseDuration,
	}
}

func (w CleanupWorker) Run(ctx context.Context) (result CleanupResult, resultErr error) {
	ctx, span := cleanupTracer.Start(ctx, "whiteboard_files.cleanup")
	defer func() {
		outcome := "succeeded"
		if resultErr != nil {
			outcome = "failed"
			span.RecordError(resultErr)
			span.SetStatus(codes.Error, "whiteboard file cleanup failed")
		}
		span.SetAttributes(
			attribute.String("chalk.whiteboard_files.cleanup.outcome", outcome),
			attribute.Int("chalk.whiteboard_files.cleanup.batches", result.Batches),
			attribute.Int("chalk.whiteboard_files.cleanup.claimed", result.Claimed),
			attribute.Int("chalk.whiteboard_files.cleanup.deleted", result.Deleted),
			attribute.Int("chalk.whiteboard_files.cleanup.failed", result.Failed),
		)
		cleanupRuns.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
		span.End()
	}()

	if w.repository == nil || w.objects == nil || w.now == nil ||
		w.batchSize <= 0 || w.maxBatches <= 0 || w.leaseDuration <= 0 {
		return result, ErrInvalidInput
	}

	now := w.now().UTC()
	input := CleanupClaimInput{
		Now: now, EndedBefore: now.Add(-whiteboardFileRetention),
		LeaseUntil: now.Add(w.leaseDuration), Limit: w.batchSize,
	}
	var failures []error

	for result.Batches < w.maxBatches {
		if err := ctx.Err(); err != nil {
			return result, errors.Join(errors.Join(failures...), err)
		}

		claims, err := w.repository.ClaimCleanup(ctx, input)
		result.Batches++
		if err != nil {
			return result, errors.Join(errors.Join(failures...), fmt.Errorf("claim whiteboard file cleanup: %w", err))
		}
		result.Claimed += len(claims)

		for _, claim := range claims {
			outcome, err := w.deleteClaim(ctx, claim)
			cleanupObjects.Add(ctx, 1, metric.WithAttributes(attribute.String("outcome", outcome)))
			if err != nil {
				result.Failed++
				failures = append(failures, err)
				continue
			}
			result.Deleted++
		}

		if len(claims) < w.batchSize {
			break
		}
	}

	return result, errors.Join(failures...)
}

func (w CleanupWorker) deleteClaim(ctx context.Context, claim CleanupClaim) (string, error) {
	err := w.objects.DeleteObject(ctx, claim.ObjectKey)
	outcome := "deleted"
	if errors.Is(err, objectstorage.ErrObjectNotFound) {
		outcome = "already_absent"
	} else if err != nil {
		return "delete_failed", fmt.Errorf("delete whiteboard object: %w", err)
	}

	if err := w.repository.CompleteCleanup(ctx, claim); err != nil {
		return "complete_failed", fmt.Errorf("complete whiteboard file cleanup: %w", err)
	}
	return outcome, nil
}
