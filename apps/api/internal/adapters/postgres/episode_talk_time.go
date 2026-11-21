package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/talktime"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type episodeTalkTimeQuerier interface {
	ListEpisodeTalkTimeRecordings(context.Context, sqlc.ListEpisodeTalkTimeRecordingsParams) ([]sqlc.ListEpisodeTalkTimeRecordingsRow, error)
	ListRecordingDeferredArtifactStates(context.Context, sqlc.ListRecordingDeferredArtifactStatesParams) ([]sqlc.ListRecordingDeferredArtifactStatesRow, error)
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
	recordingIDs := make([]pgtype.UUID, 0, len(rows))
	for _, row := range rows {
		recordingIDs = append(recordingIDs, row.RecordingID)
	}
	states, err := r.queries.ListRecordingDeferredArtifactStates(ctx, sqlc.ListRecordingDeferredArtifactStatesParams{TenantID: uuid(tenantID), RecordingIds: recordingIDs})
	if err != nil {
		return nil, fmt.Errorf("list Episode Recording transcription preparation: %w", err)
	}
	preparation := make(map[pgtype.UUID]recordingpipeline.TranscriptionPreparationStatus, len(states))
	for _, state := range states {
		preparation[state.RecordingID] = recordingpipeline.TranscriptionPreparationStatus(state.TranscriptionPreparationStatus)
	}
	result := make([]talktime.Recording, 0, len(rows))
	for _, row := range rows {
		recording := talktime.Recording{
			ID:                       utilities.IDFromBytes(row.RecordingID.Bytes),
			StartedAt:                timestamp(row.StartedAt),
			AutomaticTranscription:   row.TranscriptionMode == string(artifactpolicy.TranscriptionAutomatic),
			TranscriptionPreparation: preparation[row.RecordingID],
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
