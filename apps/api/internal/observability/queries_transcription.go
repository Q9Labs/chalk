package observability

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

func (q operationQuerier) ReleaseArtifactJob(ctx context.Context, arg sqlc.ReleaseArtifactJobParams) (sqlc.ArtifactJob, error) {
	startedAt := time.Now()
	value, err := q.next.ReleaseArtifactJob(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ReleaseArtifactJob", startedAt, err)
	return value, err
}
