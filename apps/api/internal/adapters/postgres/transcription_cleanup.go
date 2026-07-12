package postgres

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type cleanupQuerier interface {
	CreateTranscriptionCleanupJob(context.Context, sqlc.CreateTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error)
	GetTranscriptionCleanupJob(context.Context, pgtype.UUID) (sqlc.TranscriptionCleanupJob, error)
	ClaimTranscriptionCleanupJob(context.Context, sqlc.ClaimTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error)
	CompleteTranscriptionCleanupJob(context.Context, sqlc.CompleteTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error)
	RetryTranscriptionCleanupJob(context.Context, sqlc.RetryTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error)
	RecoverExpiredTranscriptionCleanupJobs(context.Context, sqlc.RecoverExpiredTranscriptionCleanupJobsParams) ([]sqlc.TranscriptionCleanupJob, error)
}

func (r TranscriptRepository) EnqueueCleanup(ctx context.Context, input transcripts.CleanupEnqueueInput) (transcripts.CleanupJob, error) {
	q, ok := r.queries.(cleanupQuerier)
	if !ok {
		return transcripts.CleanupJob{}, transcripts.ErrArtifactRepository
	}
	id, err := utilities.NewID()
	if err != nil {
		return transcripts.CleanupJob{}, err
	}
	row, err := q.CreateTranscriptionCleanupJob(ctx, sqlc.CreateTranscriptionCleanupJobParams{ID: uuid(id), TenantID: uuid(input.TenantID), TranscriptID: uuid(input.TranscriptID), ObjectKey: input.ObjectKey, ObjectKind: input.ObjectKind, DueAt: pgtype.Timestamptz{Time: input.DueAt, Valid: true}})
	if err != nil {
		return transcripts.CleanupJob{}, fmt.Errorf("enqueue transcription cleanup: %w", err)
	}
	return mapCleanupJob(row), nil
}

func (r TranscriptRepository) ClaimCleanup(ctx context.Context, input transcripts.CleanupClaimInput) (transcripts.CleanupJob, string, error) {
	q, ok := r.queries.(cleanupQuerier)
	if !ok {
		return transcripts.CleanupJob{}, "", transcripts.ErrArtifactRepository
	}
	token, err := leaseToken()
	if err != nil {
		return transcripts.CleanupJob{}, "", err
	}
	row, err := q.ClaimTranscriptionCleanupJob(ctx, sqlc.ClaimTranscriptionCleanupJobParams{LeaseTokenHash: leaseHash(token), LeaseOwner: text(&input.Owner), LeaseExpiresAt: pgtype.Timestamptz{Time: input.Now.Add(input.LeaseDuration), Valid: true}, Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.CleanupJob{}, "", transcripts.ErrNoClaimableJob
	}
	if err != nil {
		return transcripts.CleanupJob{}, "", err
	}
	return mapCleanupJob(row), token, nil
}

func (r TranscriptRepository) CleanupKey(ctx context.Context, input transcripts.CleanupLeaseInput) (string, error) {
	q, ok := r.queries.(cleanupQuerier)
	if !ok {
		return "", transcripts.ErrArtifactRepository
	}
	row, err := q.GetTranscriptionCleanupJob(ctx, uuid(input.JobID))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", transcripts.ErrJobNotFound
	}
	if err != nil {
		return "", err
	}
	if row.AttemptCount != int32(input.Attempt) || !row.LeaseOwner.Valid || row.LeaseOwner.String != input.LeaseOwner || !row.LeaseExpiresAt.Valid || !row.LeaseExpiresAt.Time.After(input.Now) || !constantLeaseHash(row.LeaseTokenHash, input.LeaseToken) {
		return "", transcripts.ErrStaleLease
	}
	return row.ObjectKey, nil
}

func constantLeaseHash(expected []byte, token string) bool {
	actual := leaseHash(token)
	return len(expected) == len(actual) && subtle.ConstantTimeCompare(expected, actual) == 1
}

func (r TranscriptRepository) CompleteCleanup(ctx context.Context, input transcripts.CleanupLeaseInput) (transcripts.CleanupJob, error) {
	q, ok := r.queries.(cleanupQuerier)
	if !ok {
		return transcripts.CleanupJob{}, transcripts.ErrArtifactRepository
	}
	row, err := q.CompleteTranscriptionCleanupJob(ctx, sqlc.CompleteTranscriptionCleanupJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: leaseHash(input.LeaseToken), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.CleanupJob{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.CleanupJob{}, err
	}
	return mapCleanupJob(row), nil
}

func (r TranscriptRepository) RetryCleanup(ctx context.Context, input transcripts.CleanupRetryInput) (transcripts.CleanupJob, error) {
	q, ok := r.queries.(cleanupQuerier)
	if !ok {
		return transcripts.CleanupJob{}, transcripts.ErrArtifactRepository
	}
	row, err := q.RetryTranscriptionCleanupJob(ctx, sqlc.RetryTranscriptionCleanupJobParams{Terminal: input.Terminal, DueAt: pgtype.Timestamptz{Time: input.DueAt, Valid: true}, ErrorCode: text(&input.ErrorCode), ErrorDetail: text(&input.ErrorDetail), ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: leaseHash(input.LeaseToken), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.CleanupJob{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.CleanupJob{}, err
	}
	return mapCleanupJob(row), nil
}

func (r TranscriptRepository) RecoverExpiredCleanup(ctx context.Context, now, dueAt time.Time) ([]transcripts.CleanupJob, error) {
	q, ok := r.queries.(cleanupQuerier)
	if !ok {
		return nil, transcripts.ErrArtifactRepository
	}
	rows, err := q.RecoverExpiredTranscriptionCleanupJobs(ctx, sqlc.RecoverExpiredTranscriptionCleanupJobsParams{Now: pgtype.Timestamptz{Time: now, Valid: true}, DueAt: pgtype.Timestamptz{Time: dueAt, Valid: true}})
	if err != nil {
		return nil, err
	}
	jobs := make([]transcripts.CleanupJob, 0, len(rows))
	for _, row := range rows {
		jobs = append(jobs, mapCleanupJob(row))
	}
	return jobs, nil
}

func mapCleanupJob(row sqlc.TranscriptionCleanupJob) transcripts.CleanupJob {
	return transcripts.CleanupJob{ID: utilities.IDFromBytes(row.ID.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), TranscriptID: utilities.IDFromBytes(row.TranscriptID.Bytes), ObjectKey: row.ObjectKey, ObjectKind: row.ObjectKind, DueAt: timestamp(row.DueAt), State: row.State, Attempt: int(row.AttemptCount), AttemptLimit: int(row.AttemptLimit), LeaseOwner: nullableTextValue(row.LeaseOwner), LeaseExpiresAt: nullableTimestamp(row.LeaseExpiresAt), ErrorCode: nullableTextValue(row.ErrorCode), ErrorDetail: nullableTextValue(row.ErrorDetail), VerifiedAt: nullableTimestamp(row.VerifiedAt), ProviderCopyStatus: row.ProviderCopyStatus}
}

var _ transcripts.CleanupRepository = TranscriptRepository{}
