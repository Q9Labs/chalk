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
	return observeAPIKey(ctx, q, "CreateAPIKey", func() (sqlc.CreateAPIKeyRow, error) { return q.next.CreateAPIKey(ctx, arg) })
}

func (q operationQuerier) GetActiveAPIKeyByPrefix(ctx context.Context, prefix string) (sqlc.GetActiveAPIKeyByPrefixRow, error) {
	return observeAPIKey(ctx, q, "GetActiveAPIKeyByPrefix", func() (sqlc.GetActiveAPIKeyByPrefixRow, error) { return q.next.GetActiveAPIKeyByPrefix(ctx, prefix) })
}

func (q operationQuerier) GetTenantAPIKey(ctx context.Context, arg sqlc.GetTenantAPIKeyParams) (sqlc.GetTenantAPIKeyRow, error) {
	return observeAPIKey(ctx, q, "GetTenantAPIKey", func() (sqlc.GetTenantAPIKeyRow, error) { return q.next.GetTenantAPIKey(ctx, arg) })
}

func (q operationQuerier) ListTenantAPIKeys(ctx context.Context, arg sqlc.ListTenantAPIKeysParams) ([]sqlc.ListTenantAPIKeysRow, error) {
	return observeAPIKey(ctx, q, "ListTenantAPIKeys", func() ([]sqlc.ListTenantAPIKeysRow, error) { return q.next.ListTenantAPIKeys(ctx, arg) })
}

func (q operationQuerier) RevokeActiveAPIKey(ctx context.Context, arg sqlc.RevokeActiveAPIKeyParams) (pgtype.UUID, error) {
	return observeAPIKey(ctx, q, "RevokeActiveAPIKey", func() (pgtype.UUID, error) { return q.next.RevokeActiveAPIKey(ctx, arg) })
}

func (q operationQuerier) RotateActiveAPIKey(ctx context.Context, arg sqlc.RotateActiveAPIKeyParams) (sqlc.RotateActiveAPIKeyRow, error) {
	return observeAPIKey(ctx, q, "RotateActiveAPIKey", func() (sqlc.RotateActiveAPIKeyRow, error) { return q.next.RotateActiveAPIKey(ctx, arg) })
}

func (q operationQuerier) TouchActiveAPIKeyLastUsed(ctx context.Context, arg sqlc.TouchActiveAPIKeyLastUsedParams) error {
	_, err := observeAPIKey(ctx, q, "TouchActiveAPIKeyLastUsed", func() (struct{}, error) { return struct{}{}, q.next.TouchActiveAPIKeyLastUsed(ctx, arg) })
	return err
}

// observeAPIKey logs an API key query without its error: the driver error can echo the key prefix.
func observeAPIKey[T any](ctx context.Context, q operationQuerier, name string, call func() (T, error)) (T, error) {
	startedAt := time.Now()
	result, err := call()
	logged := err
	if logged != nil {
		logged = errAPIKeyQueryFailed
	}
	LogOperation(ctx, q.logger, "db.query", name, startedAt, logged)
	return result, err
}
