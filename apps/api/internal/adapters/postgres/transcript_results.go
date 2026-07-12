package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r TranscriptRepository) ResultKey(ctx context.Context, input transcripts.LeaseInput) (string, error) {
	job, err := r.artifactQueries().GetArtifactJob(ctx, uuid(input.JobID))
	if errors.Is(err, pgx.ErrNoRows) {
		return "", transcripts.ErrJobNotFound
	}
	if err != nil {
		return "", err
	}
	if !leaseMatches(job, input.Attempt, input.LeaseOwner, input.LeaseToken, input.Now) {
		return "", transcripts.ErrStaleLease
	}
	chunk, err := r.artifactQueries().GetTranscriptChunk(ctx, job.ChunkID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", transcripts.ErrInvalidArtifact
	}
	if err != nil {
		return "", err
	}
	return chunk.ResultKey, nil
}

func (r TranscriptRepository) Finalize(ctx context.Context, input transcripts.FinalizeInput) (transcripts.Transcript, error) {
	q := r.artifactQueries()
	row, err := q.FinalizeTranscription(ctx, sqlc.FinalizeTranscriptionParams{ID: uuid(input.TranscriptID), Provider: pgtype.Text{String: input.Provider, Valid: true}, Model: pgtype.Text{String: input.Model, Valid: true}, Languages: input.Languages, ArtifactSha256: input.ArtifactSHA256, ArtifactSize: pgtype.Int8{Int64: input.ArtifactSize, Valid: true}, ArtifactContentType: pgtype.Text{String: input.ArtifactContentType, Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrInvalidArtifact
	}
	if err != nil {
		return transcripts.Transcript{}, err
	}
	return mapTranscript(row), nil
}

func (r TranscriptRepository) AcceptResult(ctx context.Context, input transcripts.ResultInput) (transcripts.Result, error) {
	if r.transactor == nil {
		return transcripts.Result{}, transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	job, err := q.GetArtifactJob(ctx, uuid(input.JobID))
	if err != nil {
		return transcripts.Result{}, transcripts.ErrStaleLease
	}
	if !leaseMatches(job, input.Attempt, input.LeaseOwner, input.LeaseToken, input.Now) {
		return transcripts.Result{}, transcripts.ErrStaleLease
	}
	chunk, err := q.GetTranscriptChunk(ctx, job.ChunkID)
	if err != nil {
		return transcripts.Result{}, transcripts.ErrInvalidArtifact
	}
	// Serialize readiness checks across the last concurrent chunk results. The
	// first finisher can then observe the second job as leased; the second
	// finisher waits on this row and creates the durable finalizer after the
	// first commit completes.
	transcript, err := q.LockTenantTranscriptionForUpdate(ctx, sqlc.LockTenantTranscriptionForUpdateParams{TenantID: job.TenantID, ID: job.TranscriptID})
	if err != nil {
		return transcripts.Result{}, transcripts.ErrStaleLease
	}
	if transcript.Status == transcripts.StatusDeleted || transcript.Status == transcripts.StatusComplete || transcript.Status == transcripts.StatusTerminalFailure || transcript.Status == transcripts.StatusVerifying {
		return transcripts.Result{}, transcripts.ErrStaleLease
	}
	attemptID, err := utilities.NewID()
	if err != nil {
		return transcripts.Result{}, err
	}
	measuredAudioMS := input.MeasuredAudioMS
	if measuredAudioMS == 0 {
		measuredAudioMS = chunk.EndMs - chunk.StartMs
	}
	if _, err := q.CreateTranscriptionAttempt(ctx, sqlc.CreateTranscriptionAttemptParams{ID: uuid(attemptID), TranscriptID: job.TranscriptID, ChunkID: job.ChunkID, Generation: chunk.Generation, Attempt: int32(input.Attempt), Provider: input.Provider, Model: input.Model, ProviderVersion: input.ProviderVersion, ExecutionIdentity: text(stringPtr(input.ExecutionIdentity)), ProviderRequestID: text(stringPtr(input.ProviderRequestID)), MeasuredAudioMs: pgtype.Int8{Int64: measuredAudioMS, Valid: true}, ProviderObservedDurationMs: int64Value(input.ProviderObservedDurationMS), State: "started", JourneyID: job.JourneyID, Traceparent: job.Traceparent, Tracestate: job.Tracestate, Quality: jsonBytes(input.Quality)}); err != nil {
		return transcripts.Result{}, err
	}
	row, err := q.AcceptTranscriptionChunkResult(ctx, sqlc.AcceptTranscriptionChunkResultParams{ID: uuid(attemptID), ChunkID: job.ChunkID, Generation: chunk.Generation, AttemptID: uuid(attemptID), Provider: input.Provider, Model: input.Model, ProviderVersion: input.ProviderVersion, ResultKey: chunk.ResultKey, ResultSha256: input.ResultSHA256, ResultSize: input.ResultSize, ResultContentType: input.ResultContentType, Language: text(stringPtr(input.Language)), BilledAudioSeconds: pgtype.Int4{Int32: int32(input.BilledAudioSeconds), Valid: input.BilledAudioSeconds > 0}, Quality: jsonBytes(input.Quality)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Result{}, transcripts.ErrDuplicateResult
	}
	if err != nil {
		return transcripts.Result{}, err
	}
	if _, err := q.FinishTranscriptionAttempt(ctx, sqlc.FinishTranscriptionAttemptParams{ID: uuid(attemptID), State: "accepted", BilledAudioSeconds: pgtype.Int4{}, ExecutionIdentity: text(stringPtr(input.ExecutionIdentity)), ProviderRequestID: text(stringPtr(input.ProviderRequestID)), MeasuredAudioMs: pgtype.Int8{Int64: measuredAudioMS, Valid: true}, ProviderObservedDurationMs: int64Value(input.ProviderObservedDurationMS), Quality: jsonBytes(input.Quality)}); err != nil {
		return transcripts.Result{}, err
	}
	if _, err := q.CompleteArtifactJob(ctx, sqlc.CompleteArtifactJobParams{ID: uuid(input.JobID), Attempt: int32(input.Attempt), LeaseOwner: text(&input.LeaseOwner), LeaseTokenHash: leaseHash(input.LeaseToken), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}}); err != nil {
		return transcripts.Result{}, transcripts.ErrStaleLease
	}
	finalizerID, err := utilities.NewID()
	if err != nil {
		return transcripts.Result{}, err
	}
	if _, err := q.CreateTranscriptionFinalizerJobIfReady(ctx, sqlc.CreateTranscriptionFinalizerJobIfReadyParams{ID: uuid(finalizerID), Priority: 0, AvailableAt: pgtype.Timestamptz{Time: input.Now, Valid: true}, AttemptLimit: 4, JourneyID: job.JourneyID, Traceparent: job.Traceparent, Tracestate: job.Tracestate, TranscriptID: job.TranscriptID}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return transcripts.Result{}, err
	}
	return transcripts.Result{ID: utilities.IDFromBytes(row.ID.Bytes), ChunkID: utilities.IDFromBytes(row.ChunkID.Bytes), Generation: row.Generation, Accepted: true, Provider: row.Provider, Model: row.Model, ProviderVersion: row.ProviderVersion, ResultKey: row.ResultKey, ResultSHA256: row.ResultSha256, ResultSize: row.ResultSize, ResultContentType: row.ResultContentType, Language: nullableTextValue(row.Language), AcceptedAt: timestamp(row.AcceptedAt)}, nil
}
