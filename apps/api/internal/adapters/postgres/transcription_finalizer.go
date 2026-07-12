package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r TranscriptRepository) ClaimFinalizer(ctx context.Context, input transcripts.FinalizerClaimInput) (transcripts.FinalizerAssignment, error) {
	if r.transactor == nil {
		return transcripts.FinalizerAssignment{}, transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	token, err := leaseToken()
	if err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	job, err := q.ClaimTranscriptionFinalizerJob(ctx, sqlc.ClaimTranscriptionFinalizerJobParams{LeaseTokenHash: leaseHash(token), LeaseOwner: text(&input.Owner), LeaseExpiresAt: pgtype.Timestamptz{Time: input.Now.Add(input.LeaseDuration), Valid: true}, Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.FinalizerAssignment{}, transcripts.ErrNoClaimableJob
	}
	if err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	transcript, err := q.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: job.TenantID, ID: job.TranscriptID})
	if err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	transcript, err = q.MarkTranscriptionVerifying(ctx, sqlc.MarkTranscriptionVerifyingParams{TenantID: job.TenantID, ID: job.TranscriptID})
	if errors.Is(err, pgx.ErrNoRows) {
		_, _ = q.CancelArtifactJob(ctx, sqlc.CancelArtifactJobParams{ID: job.ID, Attempt: job.AttemptCount, LeaseOwner: text(&input.Owner), LeaseTokenHash: leaseHash(token), ErrorCode: text(stringPtr("transcript_not_claimable")), ErrorDetail: text(stringPtr("transcript is deleted or terminal")), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}})
		return transcripts.FinalizerAssignment{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	chunks, err := q.ListTranscriptChunks(ctx, sqlc.ListTranscriptChunksParams{TranscriptID: job.TranscriptID, Generation: transcript.Generation})
	if err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	assignment := transcripts.FinalizerAssignment{Job: mapJob(job), LeaseToken: token, Transcript: mapTranscript(transcript), Chunks: make([]transcripts.FinalizerChunk, 0, len(chunks))}
	for _, chunk := range chunks {
		result, resultErr := q.GetTranscriptChunkResult(ctx, sqlc.GetTranscriptChunkResultParams{ChunkID: chunk.ID, Generation: chunk.Generation})
		if resultErr != nil {
			return transcripts.FinalizerAssignment{}, resultErr
		}
		assignment.Chunks = append(assignment.Chunks, transcripts.FinalizerChunk{ID: utilities.IDFromBytes(chunk.ID.Bytes), Generation: chunk.Generation, StartMS: chunk.StartMs, EndMS: chunk.EndMs, ResultKey: result.ResultKey, ResultSHA256: result.ResultSha256, ResultSize: result.ResultSize, ResultContentType: result.ResultContentType})
	}
	if err := tx.Commit(ctx); err != nil {
		return transcripts.FinalizerAssignment{}, err
	}
	return assignment, nil
}

func (r TranscriptRepository) CompleteFinalizer(ctx context.Context, input transcripts.FinalizerCompleteInput) (transcripts.Transcript, error) {
	if r.transactor == nil {
		return transcripts.Transcript{}, transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.Transcript{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	job, err := q.GetArtifactJob(ctx, uuid(input.JobID))
	if errors.Is(err, pgx.ErrNoRows) || !leaseMatches(job, input.Attempt, input.LeaseOwner, input.LeaseToken, input.Now) {
		return transcripts.Transcript{}, transcripts.ErrStaleLease
	}
	row, err := q.FinalizeTranscription(ctx, sqlc.FinalizeTranscriptionParams{ID: job.TranscriptID, Provider: pgtype.Text{String: input.Provider, Valid: true}, Model: pgtype.Text{String: input.Model, Valid: true}, Languages: input.Languages, ArtifactSha256: input.ArtifactSHA256, ArtifactSize: pgtype.Int8{Int64: input.ArtifactSize, Valid: true}, ArtifactContentType: pgtype.Text{String: input.ArtifactContentType, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrStaleLease
	}
	if err != nil {
		return transcripts.Transcript{}, err
	}
	if _, err := q.CompleteArtifactJob(ctx, sqlc.CompleteArtifactJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: leaseHash(input.LeaseToken), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}}); err != nil {
		return transcripts.Transcript{}, transcripts.ErrStaleLease
	}
	chunks, err := q.ListTranscriptChunks(ctx, sqlc.ListTranscriptChunksParams{TranscriptID: job.TranscriptID, Generation: row.Generation})
	if err != nil {
		return transcripts.Transcript{}, err
	}
	dueAt := input.Now.Add(time.Hour)
	for _, chunk := range chunks {
		if err := enqueueCleanupTx(ctx, q, row, chunk.StorageKey, "temp_chunk", dueAt); err != nil {
			return transcripts.Transcript{}, err
		}
		if err := enqueueCleanupTx(ctx, q, row, chunk.ResultKey, "temp_result", dueAt); err != nil {
			return transcripts.Transcript{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return transcripts.Transcript{}, err
	}
	return mapTranscript(row), nil
}

func (r TranscriptRepository) FinalizerKey(ctx context.Context, input transcripts.LeaseInput) (string, error) {
	job, err := r.artifactQueries().GetArtifactJob(ctx, uuid(input.JobID))
	if errors.Is(err, pgx.ErrNoRows) || !leaseMatches(job, input.Attempt, input.LeaseOwner, input.LeaseToken, input.Now) {
		return "", transcripts.ErrStaleLease
	}
	transcript, err := r.queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: job.TenantID, ID: job.TranscriptID})
	if err != nil {
		return "", err
	}
	return "tenants/" + utilities.IDFromBytes(transcript.TenantID.Bytes).String() + "/transcripts/" + utilities.IDFromBytes(transcript.ID.Bytes).String() + "/document.json", nil
}

func (r TranscriptRepository) RetryFinalizer(ctx context.Context, input transcripts.RetryInput) (transcripts.Job, error) {
	return r.Retry(ctx, input)
}

var _ transcripts.FinalizerRepository = TranscriptRepository{}
