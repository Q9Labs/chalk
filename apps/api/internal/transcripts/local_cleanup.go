package transcripts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/objectstorage"
)

const (
	localCleanupLeaseDuration = 5 * time.Minute
	localCleanupMaxClaims     = 50
	localCleanupRetryDelay    = 5 * time.Minute
	LocalCleanupInterval      = time.Hour
)

// LocalCleanupService is the durable cleanup boundary used when Recording is
// enabled but transcription workers are deliberately disabled. It shares the
// same claims and fences as the dispatcher path, without making retention
// depend on an ASR worker deployment.
type LocalCleanupService interface {
	ClaimCleanup(context.Context, CleanupClaimInput) (CleanupJob, string, error)
	CleanupKey(context.Context, CleanupLeaseInput) (string, error)
	CompleteCleanup(context.Context, CleanupLeaseInput) (CleanupJob, error)
	RetryCleanup(context.Context, CleanupRetryInput) (CleanupJob, error)
	RecoverExpiredCleanup(context.Context, time.Time, time.Time) ([]CleanupJob, error)
}

type LocalCleanupObjectStore interface {
	DeleteObject(context.Context, string) error
}

type LocalCleanupResult struct {
	Claimed   int
	Completed int
	Failed    int
}

type LocalCleanupWorker struct {
	service LocalCleanupService
	objects LocalCleanupObjectStore
	now     func() time.Time
}

func NewLocalCleanupWorker(service LocalCleanupService, objects LocalCleanupObjectStore) LocalCleanupWorker {
	return LocalCleanupWorker{service: service, objects: objects, now: time.Now}
}

// Run deletes due objects directly from the configured object store. It is
// only started for Recording-only deployments; when transcription is enabled,
// the existing dispatcher owns the same fenced cleanup queue instead.
func (w LocalCleanupWorker) Run(ctx context.Context) (result LocalCleanupResult, resultErr error) {
	if w.service == nil || w.objects == nil || w.now == nil {
		return result, ErrArtifactRepository
	}
	now := w.now().UTC()
	if _, err := w.service.RecoverExpiredCleanup(ctx, now, now); err != nil {
		return result, fmt.Errorf("recover expired recording source cleanup: %w", err)
	}

	var failures []error
	for range localCleanupMaxClaims {
		if err := ctx.Err(); err != nil {
			return result, errors.Join(errors.Join(failures...), err)
		}
		job, token, err := w.service.ClaimCleanup(ctx, CleanupClaimInput{
			Owner: "recording-source-cleanup", LeaseDuration: localCleanupLeaseDuration, Now: now,
		})
		if errors.Is(err, ErrNoClaimableJob) {
			break
		}
		if err != nil {
			return result, errors.Join(errors.Join(failures...), fmt.Errorf("claim recording source cleanup: %w", err))
		}
		result.Claimed++
		lease := CleanupLeaseInput{JobID: job.ID, Attempt: job.Attempt, LeaseOwner: "recording-source-cleanup", LeaseToken: token, Now: now}
		key, err := w.service.CleanupKey(ctx, lease)
		if err == nil {
			err = w.objects.DeleteObject(ctx, key)
			if errors.Is(err, objectstorage.ErrObjectNotFound) {
				err = nil
			}
		}
		if err != nil {
			result.Failed++
			_, retryErr := w.service.RetryCleanup(ctx, CleanupRetryInput{
				CleanupLeaseInput: lease,
				DueAt:             now.Add(localCleanupRetryDelay),
				ErrorCode:         "recording_source_cleanup_failed",
				ErrorDetail:       "recording source cleanup failed",
			})
			failures = append(failures, fmt.Errorf("delete recording source cleanup object: %w", err))
			if retryErr != nil {
				failures = append(failures, fmt.Errorf("retry recording source cleanup: %w", retryErr))
			}
			continue
		}
		if _, err := w.service.CompleteCleanup(ctx, lease); err != nil {
			result.Failed++
			failures = append(failures, fmt.Errorf("complete recording source cleanup: %w", err))
			continue
		}
		result.Completed++
	}
	return result, errors.Join(failures...)
}

type LocalCleanupScheduler struct {
	worker   LocalCleanupWorker
	interval time.Duration
	logger   *slog.Logger
}

func NewLocalCleanupScheduler(worker LocalCleanupWorker, interval time.Duration, logger *slog.Logger) *LocalCleanupScheduler {
	if interval <= 0 {
		interval = LocalCleanupInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &LocalCleanupScheduler{worker: worker, interval: interval, logger: logger}
}

func (s *LocalCleanupScheduler) Run(ctx context.Context) error {
	if s == nil || s.interval <= 0 || s.logger == nil {
		return ErrArtifactRepository
	}
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		result, err := s.worker.Run(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			s.logger.ErrorContext(ctx, "recording source cleanup cycle failed", "event", "recording_sources.cleanup", "claimed", result.Claimed, "completed", result.Completed, "failed", result.Failed, "error", err.Error())
		} else if result.Claimed > 0 {
			s.logger.InfoContext(ctx, "recording source cleanup cycle completed", "event", "recording_sources.cleanup", "claimed", result.Claimed, "completed", result.Completed, "failed", result.Failed)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
