package observability

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

var errAPIKeyQueryFailed = errors.New("query failed")

func (q operationQuerier) CreateAPIKey(ctx context.Context, arg sqlc.CreateAPIKeyParams) (sqlc.CreateAPIKeyRow, error) {
	startedAt := time.Now()
	key, err := q.next.CreateAPIKey(ctx, arg)
	q.logAPIKeyQuery(ctx, "CreateAPIKey", startedAt, err)
	return key, err
}

func (q operationQuerier) GetActiveAPIKeyByPrefix(ctx context.Context, prefix string) (sqlc.GetActiveAPIKeyByPrefixRow, error) {
	startedAt := time.Now()
	key, err := q.next.GetActiveAPIKeyByPrefix(ctx, prefix)
	q.logAPIKeyQuery(ctx, "GetActiveAPIKeyByPrefix", startedAt, err)
	return key, err
}

func (q operationQuerier) GetTenantAPIKey(ctx context.Context, arg sqlc.GetTenantAPIKeyParams) (sqlc.GetTenantAPIKeyRow, error) {
	startedAt := time.Now()
	key, err := q.next.GetTenantAPIKey(ctx, arg)
	q.logAPIKeyQuery(ctx, "GetTenantAPIKey", startedAt, err)
	return key, err
}

func (q operationQuerier) ListTenantAPIKeys(ctx context.Context, arg sqlc.ListTenantAPIKeysParams) ([]sqlc.ListTenantAPIKeysRow, error) {
	startedAt := time.Now()
	keys, err := q.next.ListTenantAPIKeys(ctx, arg)
	q.logAPIKeyQuery(ctx, "ListTenantAPIKeys", startedAt, err)
	return keys, err
}

func (q operationQuerier) RevokeActiveAPIKey(ctx context.Context, arg sqlc.RevokeActiveAPIKeyParams) (pgtype.UUID, error) {
	startedAt := time.Now()
	id, err := q.next.RevokeActiveAPIKey(ctx, arg)
	q.logAPIKeyQuery(ctx, "RevokeActiveAPIKey", startedAt, err)
	return id, err
}

func (q operationQuerier) RotateActiveAPIKey(ctx context.Context, arg sqlc.RotateActiveAPIKeyParams) (sqlc.RotateActiveAPIKeyRow, error) {
	startedAt := time.Now()
	key, err := q.next.RotateActiveAPIKey(ctx, arg)
	q.logAPIKeyQuery(ctx, "RotateActiveAPIKey", startedAt, err)
	return key, err
}

func (q operationQuerier) TouchActiveAPIKeyLastUsed(ctx context.Context, arg sqlc.TouchActiveAPIKeyLastUsedParams) error {
	startedAt := time.Now()
	err := q.next.TouchActiveAPIKeyLastUsed(ctx, arg)
	q.logAPIKeyQuery(ctx, "TouchActiveAPIKeyLastUsed", startedAt, err)
	return err
}

func (q operationQuerier) logAPIKeyQuery(ctx context.Context, name string, startedAt time.Time, err error) {
	if err != nil {
		err = errAPIKeyQueryFailed
	}
	LogOperation(ctx, q.logger, "db.query", name, startedAt, err)
}
