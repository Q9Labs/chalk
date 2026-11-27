package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

type recordingPipelineInventoryQuerier interface {
	ListHeldCaptureSlots(context.Context, int32) ([]sqlc.ListHeldCaptureSlotsRow, error)
	GetRecordingTranscriptionRearmCandidate(context.Context, pgtype.UUID) (sqlc.GetRecordingTranscriptionRearmCandidateRow, error)
	ListRecordingTranscriptionRearmCandidates(context.Context, sqlc.ListRecordingTranscriptionRearmCandidatesParams) ([]sqlc.ListRecordingTranscriptionRearmCandidatesRow, error)
}
