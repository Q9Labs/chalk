package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// TenantOperator writes a Tenant's default media plane with operator authority. The trigger on
// tenants clears the approval of any default that changes outside a transaction that says it is
// the operator's, so this is the only way to write one that counts.
type TenantOperator struct {
	pool *pgxpool.Pool
}

func NewTenantOperator(pool *pgxpool.Pool) TenantOperator {
	return TenantOperator{pool: pool}
}

func (o TenantOperator) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	return NewTenantRepository(sqlc.New(o.pool)).GetTenant(ctx, id)
}

func (o TenantOperator) SetDefaultMediaPlane(ctx context.Context, id utilities.ID, plane *string) (tenants.Tenant, error) {
	tx, err := o.pool.Begin(ctx)
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("set default media plane: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `select set_config('chalk.operator_write', 'on', true)`); err != nil {
		return tenants.Tenant{}, fmt.Errorf("set default media plane: %w", err)
	}
	tenant, err := tenants.NewService(NewTenantRepository(sqlc.New(tx))).SetDefaultMediaPlane(ctx, id, plane)
	if err != nil {
		return tenants.Tenant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return tenants.Tenant{}, fmt.Errorf("set default media plane: %w", err)
	}
	return tenant, nil
}
