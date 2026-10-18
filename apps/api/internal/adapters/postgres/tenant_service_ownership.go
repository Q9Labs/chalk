package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type ServiceTenantAdopter interface {
	AdoptServiceTenant(context.Context, sqlc.AdoptServiceTenantParams) (int64, error)
}

// AdoptServiceTenant records the operator's assertion and ownership atomically.
func AdoptServiceTenant(ctx context.Context, queries ServiceTenantAdopter, input tenants.AdoptServiceInput) (int64, error) {
	if err := input.Validate(); err != nil {
		return 0, err
	}
	auditID, err := queries.AdoptServiceTenant(ctx, sqlc.AdoptServiceTenantParams{
		TenantID: uuid(input.TenantID), ServiceID: input.ServiceID, ExternalID: text(input.ExternalID), Actor: input.Actor, Reason: input.Reason,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, tenants.ErrServiceOwnershipConflict
	}
	if err != nil {
		return 0, fmt.Errorf("adopt service Tenant: %w", err)
	}
	return auditID, nil
}
