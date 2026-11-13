package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

// transcriptReplayQuerier is what a repeated Request needs to find the transcription its first attempt made.
type transcriptReplayQuerier interface {
	GetArtifactJobByIdempotency(context.Context, sqlc.GetArtifactJobByIdempotencyParams) (sqlc.ArtifactJob, error)
	GetTenantTranscription(context.Context, sqlc.GetTenantTranscriptionParams) (sqlc.Transcription, error)
}

func (r TranscriptRepository) Request(ctx context.Context, input transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, error) {
	if r.transactor == nil {
		return transcripts.Transcript{}, transcripts.Job{}, transcripts.ErrArtifactRepository
	}
	idempotencyQueries, ok := r.queries.(transcriptReplayQuerier)
	if !ok {
		return transcripts.Transcript{}, transcripts.Job{}, transcripts.ErrArtifactRepository
	}
	if transcript, job, found, err := replayTranscriptRequest(ctx, idempotencyQueries, input); err != nil || found {
		return transcript, job, err
	}
	if err := r.requireTranscriptionEnabled(ctx, input); err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, err
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("begin transcription request: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return requestTranscriptionTx(ctx, tx, input)
}

// replayTranscriptRequest finds the transcription and first job an earlier attempt of this request made.
func replayTranscriptRequest(ctx context.Context, queries transcriptReplayQuerier, input transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, bool, error) {
	existing, err := queries.GetArtifactJobByIdempotency(ctx, sqlc.GetArtifactJobByIdempotencyParams{TenantID: uuid(input.TenantID), IdempotencyKey: chunkJobKey(input.IdempotencyKey, 0)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.Job{}, false, nil
	}
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, false, err
	}
	transcript, err := queries.GetTenantTranscription(ctx, sqlc.GetTenantTranscriptionParams{TenantID: uuid(input.TenantID), ID: existing.TranscriptID})
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, false, err
	}
	if !requestMatchesTranscript(input, transcript) {
		return transcripts.Transcript{}, transcripts.Job{}, false, transcripts.ErrIdempotencyConflict
	}
	return mapTranscript(transcript), mapJob(existing), true, nil
}

func (r TranscriptRepository) requireTranscriptionEnabled(ctx context.Context, input transcripts.RequestInput) error {
	mode, err := r.queries.GetRecordingTranscriptionMode(ctx, sqlc.GetRecordingTranscriptionModeParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.ErrRecordingNotFound
	}
	if err != nil {
		return fmt.Errorf("get recording transcription policy: %w", err)
	}
	if mode != "on_demand" && mode != "automatic" {
		return transcripts.ErrTranscriptionDisabled
	}
	return nil
}

func requestTranscriptionTx(ctx context.Context, tx pgx.Tx, input transcripts.RequestInput) (transcripts.Transcript, transcripts.Job, error) {
	q := sqlc.New(tx)
	if transcript, job, found, err := replayTranscriptRequest(ctx, q, input); err != nil || found {
		if err != nil {
			return transcripts.Transcript{}, transcripts.Job{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return transcripts.Transcript{}, transcripts.Job{}, err
		}
		return transcript, job, nil
	}
	if _, err := q.GetTenantTranscriptionByRecording(ctx, sqlc.GetTenantTranscriptionByRecordingParams{TenantID: uuid(input.TenantID), RecordingID: uuid(input.RecordingID)}); err == nil {
		return transcripts.Transcript{}, transcripts.Job{}, transcripts.ErrTranscriptAlreadyExists
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.Job{}, err
	}
	sourceRow, err := q.LockRecordingTranscriptionSource(ctx, sqlc.LockRecordingTranscriptionSourceParams{RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.Job{}, transcripts.ErrSourceNotReady
	}
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, err
	}
	if sourceRow.Status != "ready" || !timestamp(sourceRow.ExpiresAt).After(input.Now) {
		return transcripts.Transcript{}, transcripts.Job{}, expireTranscriptionSource(ctx, tx, q, input, sourceRow)
	}
	chunkRows, err := q.ListRecordingTranscriptionSourceChunks(ctx, sqlc.ListRecordingTranscriptionSourceChunksParams{RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID)})
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, err
	}
	chunks := make([]transcripts.ChunkInput, 0, len(chunkRows))
	for _, chunk := range chunkRows {
		chunks = append(chunks, mapSourceChunk(chunk))
	}
	transcript, jobs, err := admitTranscriptionTx(ctx, q, input, mapRecordingTranscriptionSource(sourceRow, chunks), chunks, false)
	if err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return transcripts.Transcript{}, transcripts.Job{}, fmt.Errorf("commit transcription request: %w", err)
	}
	if len(jobs) == 0 {
		return transcript, transcripts.Job{}, nil
	}
	return transcript, jobs[0], nil
}

// expireTranscriptionSource marks a ready source expired and queues its cleanup, then commits that and
// reports the source as expired. A source that was never ready is left as it is.
func expireTranscriptionSource(ctx context.Context, tx pgx.Tx, q *sqlc.Queries, input transcripts.RequestInput, sourceRow sqlc.RecordingTranscriptionSource) error {
	if sourceRow.Status == "ready" {
		if _, err := q.MarkRecordingTranscriptionSourceExpired(ctx, sqlc.MarkRecordingTranscriptionSourceExpiredParams{RecordingID: uuid(input.RecordingID), TenantID: uuid(input.TenantID), Now: pgtype.Timestamptz{Time: input.Now, Valid: true}}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := enqueueRecordingTranscriptionSourceCleanupTx(ctx, q, sourceRow, input.Now); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return transcripts.ErrSourceExpired
}
