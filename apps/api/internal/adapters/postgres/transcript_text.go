package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type transcriptTextQuerier interface {
	GetTranscriptTextMetadata(context.Context, sqlc.GetTranscriptTextMetadataParams) (sqlc.GetTranscriptTextMetadataRow, error)
}

type TranscriptTextRepository struct {
	queries transcriptTextQuerier
}

func NewTranscriptTextRepository(queries transcriptTextQuerier) TranscriptTextRepository {
	return TranscriptTextRepository{queries: queries}
}

func (r TranscriptTextRepository) GetTextMetadata(ctx context.Context, tenantID, transcriptID utilities.ID) (transcripts.TextMetadata, error) {
	row, err := r.queries.GetTranscriptTextMetadata(ctx, sqlc.GetTranscriptTextMetadataParams{TenantID: uuid(tenantID), TranscriptID: uuid(transcriptID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return transcripts.TextMetadata{}, transcripts.ErrTranscriptNotFound
	}
	if err != nil {
		return transcripts.TextMetadata{}, fmt.Errorf("read transcript text metadata: %w", err)
	}
	return transcripts.TextMetadata{SpaceTitle: row.SpaceTitle, StartedAt: timestamp(row.StartedAt), Duration: time.Duration(row.DurationMillis) * time.Millisecond}, nil
}
