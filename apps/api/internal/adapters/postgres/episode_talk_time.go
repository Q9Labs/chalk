package postgres

import (
	"context"
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/talktime"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeTalkTimeQuerier interface {
	ListEpisodeTalkTimeRecordings(context.Context, sqlc.ListEpisodeTalkTimeRecordingsParams) ([]sqlc.ListEpisodeTalkTimeRecordingsRow, error)
}

type EpisodeTalkTimeRepository struct {
	queries episodeTalkTimeQuerier
}

func NewEpisodeTalkTimeRepository(queries episodeTalkTimeQuerier) EpisodeTalkTimeRepository {
	return EpisodeTalkTimeRepository{queries: queries}
}

func (r EpisodeTalkTimeRepository) ListRecordings(ctx context.Context, tenantID, spaceID, episodeID utilities.ID, limit int) ([]talktime.Recording, error) {
	rows, err := r.queries.ListEpisodeTalkTimeRecordings(ctx, sqlc.ListEpisodeTalkTimeRecordingsParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: uuid(episodeID), RowLimit: int32(limit)})
	if err != nil {
		return nil, fmt.Errorf("list Episode Recordings with transcripts: %w", err)
	}
	result := make([]talktime.Recording, 0, len(rows))
	for _, row := range rows {
		recording := talktime.Recording{
			ID:                     utilities.IDFromBytes(row.RecordingID.Bytes),
			Status:                 row.RecordingStatus,
			StartedAt:              timestamp(row.StartedAt),
			AutomaticTranscription: row.TranscriptionMode == string(artifactpolicy.TranscriptionAutomatic),
		}
		if row.TranscriptionStatus != "" {
			transcript := transcripts.Transcript{
				RecordingID:         recording.ID,
				Status:              row.TranscriptionStatus,
				ArtifactKey:         nullableText(row.ArtifactKey),
				ArtifactContentType: nullableText(row.ArtifactContentType),
				DeletedAt:           nullableTimestamp(row.TranscriptionDeletedAt),
			}
			if row.ArtifactSize.Valid {
				transcript.ArtifactSize = &row.ArtifactSize.Int64
			}
			recording.Transcript = &transcript
		}
		result = append(result, recording)
	}
	return result, nil
}
