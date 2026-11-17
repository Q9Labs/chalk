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
	tx, err := beginPlaneWrite(ctx, o.pool)
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

// namingTheWriter runs write on queries, or, when the write sets the default plane and the
// repository has a pool, in a transaction that tells the plane audit who is writing.
func (s TenantRepository) namingTheWriter(ctx context.Context, setsPlane bool, write func(tenantQuerier) error) error {
	if !setsPlane || s.pool == nil {
		return write(s.queries)
	}
	tx, err := beginPlaneWrite(ctx, s.pool)
	if err != nil {
		return fmt.Errorf("begin tenant write: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := write(sqlc.New(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant write: %w", err)
	}
	return nil
}
