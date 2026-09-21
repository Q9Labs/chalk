package observability

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) LockRecordingTranscriptionPreparationAuthority(ctx context.Context, arg sqlc.LockRecordingTranscriptionPreparationAuthorityParams) (sqlc.LockRecordingTranscriptionPreparationAuthorityRow, error) {
	startedAt := time.Now()
	authority, err := q.next.LockRecordingTranscriptionPreparationAuthority(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "LockRecordingTranscriptionPreparationAuthority", startedAt, err)
	return authority, err
}

func (q operationQuerier) GetRecordingTranscriptionPreparationCommit(ctx context.Context, arg sqlc.GetRecordingTranscriptionPreparationCommitParams) (pgtype.UUID, error) {
	startedAt := time.Now()
	sourceID, err := q.next.GetRecordingTranscriptionPreparationCommit(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetRecordingTranscriptionPreparationCommit", startedAt, err)
	return sourceID, err
}

func (q operationQuerier) CompleteRecordingTranscriptionPreparation(ctx context.Context, arg sqlc.CompleteRecordingTranscriptionPreparationParams) (pgtype.UUID, error) {
	startedAt := time.Now()
	sourceID, err := q.next.CompleteRecordingTranscriptionPreparation(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CompleteRecordingTranscriptionPreparation", startedAt, err)
	return sourceID, err
}
