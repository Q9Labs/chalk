package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
)

type tracedQuerier struct {
	next   db.Querier
	logger *slog.Logger
}

func TraceQueries(next db.Querier, logger *slog.Logger) db.Querier {
	if next == nil || logger == nil {
		return next
	}

	return tracedQuerier{
		next:   next,
		logger: logger,
	}
}

func (q tracedQuerier) CreateTenant(ctx context.Context, arg db.CreateTenantParams) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.CreateTenant(ctx, arg)
	LogSpan(ctx, q.logger, "db.query", "CreateTenant", startedAt, err)
	return tenant, err
}

func (q tracedQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.GetTenant(ctx, id)
	LogSpan(ctx, q.logger, "db.query", "GetTenant", startedAt, err)
	return tenant, err
}

func (q tracedQuerier) ListTenants(ctx context.Context, arg db.ListTenantsParams) ([]db.Tenant, error) {
	startedAt := time.Now()
	tenants, err := q.next.ListTenants(ctx, arg)
	LogSpan(ctx, q.logger, "db.query", "ListTenants", startedAt, err)
	return tenants, err
}

func (q tracedQuerier) UpdateTenant(ctx context.Context, id db.UpdateTenantParams) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.UpdateTenant(ctx, id)
	LogSpan(ctx, q.logger, "db.query", "UpdateTenant", startedAt, err)
	return tenant, err
}

var _ db.Querier = tracedQuerier{}
