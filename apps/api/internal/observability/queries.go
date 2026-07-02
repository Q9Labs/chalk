package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
)

type operationQuerier struct {
	next   sqlc.Querier
	logger *slog.Logger
}

func OperationQueries(next sqlc.Querier, logger *slog.Logger) sqlc.Querier {
	if next == nil || logger == nil {
		return next
	}

	return operationQuerier{
		next:   next,
		logger: logger,
	}
}

func (q operationQuerier) CreateTenant(ctx context.Context, arg sqlc.CreateTenantParams) (sqlc.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.CreateTenant(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) CreateGoogleUser(ctx context.Context, arg sqlc.CreateGoogleUserParams) (sqlc.CreateGoogleUserRow, error) {
	startedAt := time.Now()
	user, err := q.next.CreateGoogleUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateGoogleUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateLoginSession(ctx context.Context, arg sqlc.CreateLoginSessionParams) (sqlc.LoginSession, error) {
	startedAt := time.Now()
	session, err := q.next.CreateLoginSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateLoginSession", startedAt, err)
	return session, err
}

func (q operationQuerier) CreatePasswordUser(ctx context.Context, arg sqlc.CreatePasswordUserParams) (sqlc.CreatePasswordUserRow, error) {
	startedAt := time.Now()
	user, err := q.next.CreatePasswordUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreatePasswordUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateUser(ctx context.Context, arg sqlc.CreateUserParams) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.CreateUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateUser", startedAt, err)
	return user, err
}

func (q operationQuerier) CreateMembership(ctx context.Context, arg sqlc.CreateMembershipParams) (sqlc.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.CreateMembership(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "CreateMembership", startedAt, err)
	return membership, err
}

func (q operationQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (sqlc.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.GetTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) GetUser(ctx context.Context, id pgtype.UUID) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUser(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "GetUser", startedAt, err)
	return user, err
}

func (q operationQuerier) GetLoginSessionByTokenHash(ctx context.Context, tokenHash string) (sqlc.GetLoginSessionByTokenHashRow, error) {
	startedAt := time.Now()
	session, err := q.next.GetLoginSessionByTokenHash(ctx, tokenHash)
	LogOperation(ctx, q.logger, "db.query", "GetLoginSessionByTokenHash", startedAt, err)
	return session, err
}

func (q operationQuerier) GetPasswordIdentityByEmail(ctx context.Context, email string) (sqlc.GetPasswordIdentityByEmailRow, error) {
	startedAt := time.Now()
	identity, err := q.next.GetPasswordIdentityByEmail(ctx, email)
	LogOperation(ctx, q.logger, "db.query", "GetPasswordIdentityByEmail", startedAt, err)
	return identity, err
}

func (q operationQuerier) GetTenantMembershipForUser(ctx context.Context, arg sqlc.GetTenantMembershipForUserParams) (sqlc.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.GetTenantMembershipForUser(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetTenantMembershipForUser", startedAt, err)
	return membership, err
}

func (q operationQuerier) GetUserByAuthIdentity(ctx context.Context, arg sqlc.GetUserByAuthIdentityParams) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUserByAuthIdentity(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "GetUserByAuthIdentity", startedAt, err)
	return user, err
}

func (q operationQuerier) GetUserByEmail(ctx context.Context, email string) (sqlc.User, error) {
	startedAt := time.Now()
	user, err := q.next.GetUserByEmail(ctx, email)
	LogOperation(ctx, q.logger, "db.query", "GetUserByEmail", startedAt, err)
	return user, err
}

func (q operationQuerier) ListTenantMemberships(ctx context.Context, arg sqlc.ListTenantMembershipsParams) ([]sqlc.Membership, error) {
	startedAt := time.Now()
	memberships, err := q.next.ListTenantMemberships(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenantMemberships", startedAt, err)
	return memberships, err
}

func (q operationQuerier) ListTenants(ctx context.Context, arg sqlc.ListTenantsParams) ([]sqlc.Tenant, error) {
	startedAt := time.Now()
	tenants, err := q.next.ListTenants(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListTenants", startedAt, err)
	return tenants, err
}

func (q operationQuerier) ListUsers(ctx context.Context, arg sqlc.ListUsersParams) ([]sqlc.User, error) {
	startedAt := time.Now()
	users, err := q.next.ListUsers(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "ListUsers", startedAt, err)
	return users, err
}

func (q operationQuerier) UpdateTenant(ctx context.Context, id sqlc.UpdateTenantParams) (sqlc.Tenant, error) {
	startedAt := time.Now()
	tenant, err := q.next.UpdateTenant(ctx, id)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenant", startedAt, err)
	return tenant, err
}

func (q operationQuerier) RevokeLoginSession(ctx context.Context, arg sqlc.RevokeLoginSessionParams) (sqlc.LoginSession, error) {
	startedAt := time.Now()
	session, err := q.next.RevokeLoginSession(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "RevokeLoginSession", startedAt, err)
	return session, err
}

func (q operationQuerier) UpdateTenantMembership(ctx context.Context, arg sqlc.UpdateTenantMembershipParams) (sqlc.Membership, error) {
	startedAt := time.Now()
	membership, err := q.next.UpdateTenantMembership(ctx, arg)
	LogOperation(ctx, q.logger, "db.query", "UpdateTenantMembership", startedAt, err)
	return membership, err
}

var _ sqlc.Querier = operationQuerier{}
