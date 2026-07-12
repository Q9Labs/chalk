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

func (r TranscriptRepository) Delete(ctx context.Context, tenantID, transcriptID utilities.ID) (transcripts.Transcript, error) {
	if r.transactor == nil {
		return transcripts.Transcript{}, transcripts.ErrArtifactRepository
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return transcripts.Transcript{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := sqlc.New(tx)
	row, err := q.DeleteTenantTranscription(ctx, sqlc.DeleteTenantTranscriptionParams{TenantID: uuid(tenantID), ID: uuid(transcriptID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.Transcript{}, transcripts.ErrTranscriptNotFound
	}
	if err != nil {
		return transcripts.Transcript{}, err
	}
	dueAt := time.Now().Add(24 * time.Hour)
	if row.ArtifactKey.Valid {
		if err := enqueueCleanupTx(ctx, q, row, row.ArtifactKey.String, "final_artifact", dueAt); err != nil {
			return transcripts.Transcript{}, err
		}
	}
	chunks, err := q.ListTranscriptChunks(ctx, sqlc.ListTranscriptChunksParams{TranscriptID: row.ID, Generation: row.Generation})
	if err != nil {
		return transcripts.Transcript{}, err
	}
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

func enqueueCleanupTx(ctx context.Context, q interface {
	CreateTranscriptionCleanupJob(context.Context, sqlc.CreateTranscriptionCleanupJobParams) (sqlc.TranscriptionCleanupJob, error)
}, row sqlc.Transcription, key, kind string, dueAt time.Time) error {
	id, err := utilities.NewID()
	if err != nil {
		return err
	}
	_, err = q.CreateTranscriptionCleanupJob(ctx, sqlc.CreateTranscriptionCleanupJobParams{ID: uuid(id), TenantID: row.TenantID, TranscriptID: row.ID, ObjectKey: key, ObjectKind: kind, DueAt: pgtype.Timestamptz{Time: dueAt, Valid: true}})
	return err
}
