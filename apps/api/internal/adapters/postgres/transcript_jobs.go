package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r TranscriptRepository) Claim(ctx context.Context, input transcripts.ClaimInput) (transcripts.Assignment, error) {
	if r.transactor == nil {
		return transcripts.Assignment{}, transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.Assignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	token, err := leaseToken()
	if err != nil {
		return transcripts.Assignment{}, err
	}
	now := input.Now
	expiry := now.Add(input.LeaseDuration)
	job, err := q.ClaimArtifactJob(ctx, sqlc.ClaimArtifactJobParams{LeaseTokenHash: leaseHash(token), LeaseOwner: text(&input.Owner), LeaseExpiresAt: pgtype.Timestamptz{Time: expiry, Valid: true}, Now: pgtype.Timestamptz{Time: now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Assignment{}, transcripts.ErrNoClaimableJob
	}
	if err != nil {
		return transcripts.Assignment{}, fmt.Errorf("claim artifact job: %w", err)
	}
	chunk, err := q.GetTranscriptChunk(ctx, job.ChunkID)
	if err != nil {
		return transcripts.Assignment{}, fmt.Errorf("load claimed chunk: %w", err)
	}
	transcript, err := q.MarkTranscriptionTranscribing(ctx, sqlc.MarkTranscriptionTranscribingParams{TenantID: job.TenantID, ID: job.TranscriptID})
	if errors.Is(err, pgx.ErrNoRows) {
		_, _ = q.CancelArtifactJob(ctx, sqlc.CancelArtifactJobParams{ID: job.ID, Attempt: job.AttemptCount, LeaseOwner: text(&input.Owner), LeaseTokenHash: leaseHash(token), ErrorCode: text(stringPtr("transcript_not_claimable")), ErrorDetail: text(stringPtr("transcript is deleted or terminal")), Now: pgtype.Timestamptz{Time: now, Valid: true}})
		return transcripts.Assignment{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.Assignment{}, fmt.Errorf("mark transcript transcribing: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return transcripts.Assignment{}, err
	}
	chunkInput := mapChunk(chunk)
	chunkInput.ResultKey = chunkResultKey(
		utilities.IDFromBytes(job.TenantID.Bytes),
		utilities.IDFromBytes(job.TranscriptID.Bytes),
		chunk.Generation,
		int(chunk.ChunkIndex),
		int(job.AttemptCount),
	)
	return transcripts.Assignment{Job: mapJob(job), LeaseToken: token, Chunk: &chunkInput, Transcript: mapTranscript(transcript)}, nil
}

func (r TranscriptRepository) Heartbeat(ctx context.Context, input transcripts.LeaseInput, expiresAt time.Time) (transcripts.Job, error) {
	return r.mutateLease(ctx, input, func(q transcriptArtifactQuerier, hash []byte) (sqlc.ArtifactJob, error) {
		return q.HeartbeatArtifactJob(ctx, sqlc.HeartbeatArtifactJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: hash, LeaseExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true}, Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	})
}

func (r TranscriptRepository) Retry(ctx context.Context, input transcripts.RetryInput) (transcripts.Job, error) {
	return r.mutateLease(ctx, input.LeaseInput, func(q transcriptArtifactQuerier, hash []byte) (sqlc.ArtifactJob, error) {
		return q.RetryArtifactJob(ctx, sqlc.RetryArtifactJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: hash, AvailableAt: pgtype.Timestamptz{Time: input.AvailableAt, Valid: true}, ErrorCode: text(&input.ErrorCode), ErrorDetail: text(&input.ErrorDetail), Terminal: input.Terminal, Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	})
}

func (r TranscriptRepository) Complete(ctx context.Context, input transcripts.LeaseInput) (transcripts.Job, error) {
	return r.mutateLease(ctx, input, func(q transcriptArtifactQuerier, hash []byte) (sqlc.ArtifactJob, error) {
		return q.CompleteArtifactJob(ctx, sqlc.CompleteArtifactJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: hash, Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	})
}

func (r TranscriptRepository) Cancel(ctx context.Context, input transcripts.CancelInput) (transcripts.Job, error) {
	return r.mutateLease(ctx, input.LeaseInput, func(q transcriptArtifactQuerier, hash []byte) (sqlc.ArtifactJob, error) {
		return q.CancelArtifactJob(ctx, sqlc.CancelArtifactJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: hash, ErrorCode: text(&input.ErrorCode), ErrorDetail: text(&input.ErrorDetail), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	})
}

func (r TranscriptRepository) Requeue(ctx context.Context, jobID utilities.ID, availableAt time.Time) (transcripts.Job, error) {
	row, err := r.artifactQueries().RequeueArtifactJob(ctx, sqlc.RequeueArtifactJobParams{ID: uuid(jobID), AvailableAt: pgtype.Timestamptz{Time: availableAt, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Job{}, transcripts.ErrJobNotFound
	}
	if err != nil {
		return transcripts.Job{}, err
	}
	return mapJob(row), nil
}

func (r TranscriptRepository) RecoverExpired(ctx context.Context, now, availableAt time.Time) ([]transcripts.Job, error) {
	rows, err := r.artifactQueries().RecoverExpiredArtifactJobs(ctx, sqlc.RecoverExpiredArtifactJobsParams{Now: pgtype.Timestamptz{Time: now, Valid: true}, AvailableAt: pgtype.Timestamptz{Time: availableAt, Valid: true}})
	if err != nil {
		return nil, err
	}
	jobs := make([]transcripts.Job, 0, len(rows))
	for _, row := range rows {
		jobs = append(jobs, mapJob(row))
	}
	return jobs, nil
}
