package observability

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) LockRecordingTranscriptionPreparationAuthority(ctx context.Context, arg sqlc.LockRecordingTranscriptionPreparationAuthorityParams) (sqlc.LockRecordingTranscriptionPreparationAuthorityRow, error) {
	return observe(ctx, q, "LockRecordingTranscriptionPreparationAuthority", func() (sqlc.LockRecordingTranscriptionPreparationAuthorityRow, error) {
		return q.next.LockRecordingTranscriptionPreparationAuthority(ctx, arg)
	})
}

func (q operationQuerier) GetRecordingTranscriptionPreparationCommit(ctx context.Context, arg sqlc.GetRecordingTranscriptionPreparationCommitParams) (pgtype.UUID, error) {
	return observe(ctx, q, "GetRecordingTranscriptionPreparationCommit", func() (pgtype.UUID, error) { return q.next.GetRecordingTranscriptionPreparationCommit(ctx, arg) })
}

func (q operationQuerier) CompleteRecordingTranscriptionPreparation(ctx context.Context, arg sqlc.CompleteRecordingTranscriptionPreparationParams) (pgtype.UUID, error) {
	return observe(ctx, q, "CompleteRecordingTranscriptionPreparation", func() (pgtype.UUID, error) { return q.next.CompleteRecordingTranscriptionPreparation(ctx, arg) })
}
