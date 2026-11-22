package postgres

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/recordingpresentation"
)

func TestRecordingCompletionOmitsOverBudgetAnnotation(t *testing.T) {
	origin := time.Now()
	empty := []byte("[]")
	source, err := mapRecordingPresentationCompletionSource(sqlc.GetRecordingPresentationCompletionSourceRow{
		SchemaVersion:        recordingpresentation.SchemaVersion,
		Profile:              []byte("{}"),
		CaptureReadyAt:       pgtype.Timestamptz{Time: origin, Valid: true},
		EndedAt:              pgtype.Timestamptz{Time: origin.Add(time.Second), Valid: true},
		DurationMillis:       1000,
		EpisodeControlEvents: empty, EpisodeControlTailEventsJson: "[]",
		InitialChatMessages: empty, ChatTailMessagesJson: "[]",
		WhiteboardEvents: empty, WhiteboardTailEventsJson: "[]", WhiteboardFilesJson: "[]",
		CapturePlansJson: "[]", ReactionsJson: "[]",
		ScreenAnnotationOverflow: pgtype.Bool{Bool: true, Valid: true}, ScreenAnnotationJson: "[]",
	})
	if err != nil || len(source.ScreenAnnotation) != 0 || source.DurationMillis != 1000 {
		t.Fatalf("recorded media must survive annotation overflow: %v", err)
	}
}
