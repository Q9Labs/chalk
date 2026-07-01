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

func (q operationQuerier) CreateUser(ctx context.Context, arg db.CreateUserParams) (db.User, error) {
	startedAt := time.Now()
	user, err := q.next.CreateUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateMembership(ctx context.Context, arg db.CreateMembershipParams) (db.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.CreateMembership(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateMembership", startedAt, err)
	return membership, err
}

func (q operationQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.GetTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) GetUser(ctx context.Context, id pgtype.UUID) (db.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUser(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetUser", startedAt, err)
	return user, err
}

func (q operationQuerier) ListTenantMemberships(ctx context.Context, arg db.ListTenantMembershipsParams) ([]db.Membership, error) {
	startedAt := time.Now()
	memberships, err := q.next.ListTenantMemberships(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantMemberships", startedAt, err)
	return memberships, err
}

func (q operationQuerier) ListTenants(ctx context.Context, arg db.ListTenantsParams) ([]db.Tenant, error) {
	startedAt := time.Now()
	tenants, err := q.next.ListTenants(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenants", startedAt, err)
	return tenants, err
}

func (q operationQuerier) ListUsers(ctx context.Context, arg db.ListUsersParams) ([]db.User, error) {
	startedAt := time.Now()
	users, err := q.next.ListUsers(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListUsers", startedAt, err)
	return users, err
}

func (q operationQuerier) UpdateTenant(ctx context.Context, id db.UpdateTenantParams) (db.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.UpdateTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) UpdateTenantMembership(ctx context.Context, arg db.UpdateTenantMembershipParams) (db.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.UpdateTenantMembership(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantMembership", startedAt, err)
	return membership, err
}

var _ db.Querier = operationQuerier{}
