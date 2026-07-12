package transcripts

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const (
	CleanupStatePending   = "pending"
	CleanupStateLeased    = "leased"
	CleanupStateRetryable = "retryable"
	CleanupStateCompleted = "completed"
	CleanupStateDead      = "dead_letter"
)

type CleanupJob struct {
	ID                 utilities.ID
	TenantID           utilities.ID
	TranscriptID       utilities.ID
	ObjectKey          string
	ObjectKind         string
	DueAt              time.Time
	State              string
	Attempt            int
	AttemptLimit       int
	LeaseOwner         string
	LeaseExpiresAt     *time.Time
	ErrorCode          string
	ErrorDetail        string
	VerifiedAt         *time.Time
	ProviderCopyStatus string
}

type CleanupEnqueueInput struct {
	TenantID     utilities.ID
	TranscriptID utilities.ID
	ObjectKey    string
	ObjectKind   string
	DueAt        time.Time
}

type CleanupClaimInput struct {
	Owner         string
	LeaseDuration time.Duration
	Now           time.Time
}

type CleanupLeaseInput struct {
	JobID      utilities.ID
	Attempt    int
	LeaseOwner string
	LeaseToken string
	Now        time.Time
}

type CleanupRetryInput struct {
	CleanupLeaseInput
	DueAt       time.Time
	ErrorCode   string
	ErrorDetail string
	Terminal    bool
}

type CleanupRepository interface {
	EnqueueCleanup(context.Context, CleanupEnqueueInput) (CleanupJob, error)
	ClaimCleanup(context.Context, CleanupClaimInput) (CleanupJob, string, error)
	CleanupKey(context.Context, CleanupLeaseInput) (string, error)
	CompleteCleanup(context.Context, CleanupLeaseInput) (CleanupJob, error)
	RetryCleanup(context.Context, CleanupRetryInput) (CleanupJob, error)
	RecoverExpiredCleanup(context.Context, time.Time, time.Time) ([]CleanupJob, error)
}

// Recording source deletion remains recorder-owned. These jobs only cover
// transcript-selected final and temporary artifact keys.

func (s Service) EnqueueCleanup(ctx context.Context, input CleanupEnqueueInput) (CleanupJob, error) {
	if s.cleanup == nil {
		return CleanupJob{}, ErrArtifactRepository
	}
	if input.TenantID.IsZero() || input.TranscriptID.IsZero() || input.ObjectKey == "" || input.DueAt.IsZero() || input.DueAt.After(time.Now().Add(24*time.Hour)) {
		return CleanupJob{}, ErrInvalidArtifact
	}
	return s.cleanup.EnqueueCleanup(ctx, input)
}

func (s Service) ClaimCleanup(ctx context.Context, input CleanupClaimInput) (CleanupJob, string, error) {
	if s.cleanup == nil {
		return CleanupJob{}, "", ErrArtifactRepository
	}
	if input.Owner == "" || input.LeaseDuration <= 0 || input.LeaseDuration > 15*time.Minute {
		return CleanupJob{}, "", ErrInvalidLease
	}
	if input.Now.IsZero() {
		input.Now = time.Now()
	}
	return s.cleanup.ClaimCleanup(ctx, input)
}

func (s Service) CompleteCleanup(ctx context.Context, input CleanupLeaseInput) (CleanupJob, error) {
	if s.cleanup == nil {
		return CleanupJob{}, ErrArtifactRepository
	}
	return s.cleanup.CompleteCleanup(ctx, input)
}

func (s Service) CleanupKey(ctx context.Context, input CleanupLeaseInput) (string, error) {
	if s.cleanup == nil {
		return "", ErrArtifactRepository
	}
	return s.cleanup.CleanupKey(ctx, input)
}

func (s Service) RetryCleanup(ctx context.Context, input CleanupRetryInput) (CleanupJob, error) {
	if s.cleanup == nil {
		return CleanupJob{}, ErrArtifactRepository
	}
	return s.cleanup.RetryCleanup(ctx, input)
}

func (s Service) RecoverExpiredCleanup(ctx context.Context, now, dueAt time.Time) ([]CleanupJob, error) {
	if s.cleanup == nil {
		return nil, ErrArtifactRepository
	}
	return s.cleanup.RecoverExpiredCleanup(ctx, now, dueAt)
}
