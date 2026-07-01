package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
)

type operationQuerier struct {
	next   db.Querier
	logger *slog.Logger
}

func OperationQueries(next db.Querier, logger *slog.Logger) db.Querier {
	if next == nil || logger == nil {
		return next
	}

	return operationQuerier{
		next:   next,
		logger: logger,
	}
}

func (q operationQuerier) CreateTenant(ctx context.Context, arg db.CreateTenantParams) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.CreateTenant(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.GetTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) ListTenants(ctx context.Context, arg db.ListTenantsParams) ([]db.Tenant, error) {
	startedAt := time.Now()
	tenants, err := q.next.ListTenants(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenants", startedAt, err)
	return tenants, err
}

func (q operationQuerier) UpdateTenant(ctx context.Context, id db.UpdateTenantParams) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.UpdateTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenant", startedAt, err)
	return tenant, err
}

var _ db.Querier = operationQuerier{}
