package postgres

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type talkTimeQueries struct {
	recordings []sqlc.ListEpisodeTalkTimeRecordingsRow
	states     []sqlc.ListRecordingDeferredArtifactStatesRow
}

func (q talkTimeQueries) ListEpisodeTalkTimeRecordings(context.Context, sqlc.ListEpisodeTalkTimeRecordingsParams) ([]sqlc.ListEpisodeTalkTimeRecordingsRow, error) {
	return q.recordings, nil
}

func (q talkTimeQueries) ListRecordingDeferredArtifactStates(context.Context, sqlc.ListRecordingDeferredArtifactStatesParams) ([]sqlc.ListRecordingDeferredArtifactStatesRow, error) {
	return q.states, nil
}

func TestEpisodeTalkTimeRecordingsCarryTheirTranscriptionPreparation(t *testing.T) {
	first, second := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, pgtype.UUID{Bytes: [16]byte{2}, Valid: true}
	queries := talkTimeQueries{
		recordings: []sqlc.ListEpisodeTalkTimeRecordingsRow{
			{RecordingID: first, TranscriptionMode: "automatic"},
			{RecordingID: second, TranscriptionMode: "automatic"},
		},
		states: []sqlc.ListRecordingDeferredArtifactStatesRow{
			{RecordingID: first, TranscriptionPreparationStatus: "pending"},
			{RecordingID: second, TranscriptionPreparationStatus: "failed"},
		},
	}
	got, err := NewEpisodeTalkTimeRepository(queries).ListRecordings(context.Background(), utilities.ID{}, utilities.ID{}, utilities.ID{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].TranscriptionPreparation != recordingpipeline.TranscriptionPreparationPending || got[1].TranscriptionPreparation != recordingpipeline.TranscriptionPreparationFailed {
		t.Fatalf("recordings = %#v", got)
	}
}
