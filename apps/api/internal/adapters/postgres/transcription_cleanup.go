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
	MarkDueRecordingTranscriptionSourcesForCleanup(context.Context, pgtype.Timestamptz) ([]sqlc.MarkDueRecordingTranscriptionSourcesForCleanupRow, error)
	ListRecordingTranscriptionSourcesNeedingCleanup(context.Context, sqlc.ListRecordingTranscriptionSourcesNeedingCleanupParams) ([]sqlc.RecordingTranscriptionSource, error)
	ListRecordingTranscriptionSourceChunks(context.Context, sqlc.ListRecordingTranscriptionSourceChunksParams) ([]sqlc.RecordingTranscriptionSourceChunk, error)
	MarkRecordingTranscriptionSourceDeletedIfClean(context.Context, sqlc.MarkRecordingTranscriptionSourceDeletedIfCleanParams) (sqlc.RecordingTranscriptionSource, error)
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
	row, err := q.CreateTranscriptionCleanupJob(ctx, sqlc.CreateTranscriptionCleanupJobParams{ID: uuid(id), TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID), TranscriptID: nullableUUID(input.TranscriptID), ObjectKey: input.ObjectKey, ObjectKind: input.ObjectKind, DueAt: pgtype.Timestamptz{Time: input.DueAt, Valid: true}})
	if err != nil {
		return transcripts.CleanupJob{}, fmt.Errorf("enqueue transcription cleanup: %w", err)
	}
	return mapCleanupJob(row), nil
}

func (r TranscriptRepository) ClaimCleanup(ctx context.Context, input transcripts.CleanupClaimInput) (transcripts.CleanupJob, string, error) {
	if r.transactor == nil {
		return transcripts.CleanupJob{}, "", transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.CleanupJob{}, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	if _, err := q.MarkDueRecordingTranscriptionSourcesForCleanup(ctx, pgtype.Timestamptz{Time: input.Now, Valid: true}); err != nil {
		return transcripts.CleanupJob{}, "", err
	}
	sources, err := q.ListRecordingTranscriptionSourcesNeedingCleanup(ctx, sqlc.ListRecordingTranscriptionSourcesNeedingCleanupParams{Now: pgtype.Timestamptz{Time: input.Now, Valid: true}, PageSize: 100})
	if err != nil {
		return transcripts.CleanupJob{}, "", err
	}
	for _, source := range sources {
		if err := enqueueRecordingTranscriptionSourceCleanupTx(ctx, q, source, input.Now); err != nil {
			return transcripts.CleanupJob{}, "", err
		}
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
	if err := tx.Commit(ctx); err != nil {
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
	if r.transactor == nil {
		return transcripts.CleanupJob{}, transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.CleanupJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	row, err := q.CompleteTranscriptionCleanupJob(ctx, sqlc.CompleteTranscriptionCleanupJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: leaseHash(input.LeaseToken), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.CleanupJob{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.CleanupJob{}, err
	}
	if row.ObjectKind == "source_manifest" || row.ObjectKind == "source_chunk" {
		if _, err := q.MarkRecordingTranscriptionSourceDeletedIfClean(ctx, sqlc.MarkRecordingTranscriptionSourceDeletedIfCleanParams{RecordingID: row.RecordingID, Now: pgtype.Timestamptz{Time: input.Now, Valid: true}}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return transcripts.CleanupJob{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
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
	return transcripts.CleanupJob{ID: utilities.IDFromBytes(row.ID.Bytes), TenantID: utilities.IDFromBytes(row.TenantID.Bytes), RecordingID: utilities.IDFromBytes(row.RecordingID.Bytes), TranscriptID: nullableID(row.TranscriptID), ObjectKey: row.ObjectKey, ObjectKind: row.ObjectKind, DueAt: timestamp(row.DueAt), State: row.State, Attempt: int(row.AttemptCount), AttemptLimit: int(row.AttemptLimit), LeaseOwner: nullableTextValue(row.LeaseOwner), LeaseExpiresAt: nullableTimestamp(row.LeaseExpiresAt), ErrorCode: nullableTextValue(row.ErrorCode), ErrorDetail: nullableTextValue(row.ErrorDetail), VerifiedAt: nullableTimestamp(row.VerifiedAt), ProviderCopyStatus: row.ProviderCopyStatus}
}

func enqueueRecordingTranscriptionSourceCleanupTx(ctx context.Context, queries sqlc.Querier, source sqlc.RecordingTranscriptionSource, dueAt time.Time) error {
	if err := createSourceCleanupJob(ctx, queries, source, source.ManifestKey, "source_manifest", dueAt); err != nil {
		return err
	}
	chunks, err := queries.ListRecordingTranscriptionSourceChunks(ctx, sqlc.ListRecordingTranscriptionSourceChunksParams{RecordingID: source.RecordingID, TenantID: source.TenantID})
	if err != nil {
		return err
	}
	for _, chunk := range chunks {
		if err := createSourceCleanupJob(ctx, queries, source, chunk.StorageKey, "source_chunk", dueAt); err != nil {
			return err
		}
	}
	return nil
}

func createSourceCleanupJob(ctx context.Context, queries sqlc.Querier, source sqlc.RecordingTranscriptionSource, objectKey, objectKind string, dueAt time.Time) error {
	id, err := utilities.NewID()
	if err != nil {
		return err
	}
	_, err = queries.CreateTranscriptionCleanupJob(ctx, sqlc.CreateTranscriptionCleanupJobParams{
		ID: uuid(id), TenantID: source.TenantID, RecordingID: source.RecordingID, TranscriptID: source.LeaseTranscriptID,
		ObjectKey: objectKey, ObjectKind: objectKind, DueAt: pgtype.Timestamptz{Time: dueAt, Valid: true},
	})
	return err
}

var _ transcripts.CleanupRepository = TranscriptRepository{}
