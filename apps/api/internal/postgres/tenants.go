package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type TenantStore struct {
	queries db.Querier
}

func NewTenantStore(queries db.Querier) TenantStore {
	return TenantStore{queries: queries}
}

func (s TenantStore) GetTenant(ctx context.Context, id tenants.TenantID) (tenants.Tenant, error) {
	tenant, err := s.queries.GetTenant(ctx, pgtype.UUID{Bytes: id.Bytes(), Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("get tenant: %w", err)
	}

	return mapTenant(tenant), nil
}

func mapTenant(tenant db.Tenant) tenants.Tenant {
	return tenants.Tenant{
		ID:                tenants.TenantIDFromBytes(tenant.ID.Bytes),
		Name:              tenant.Name,
		DefaultRegion:     textValue(tenant.DefaultRegion),
		DefaultMediaPlane: textValue(tenant.DefaultMediaPlane),
		LogoKey:           textValue(tenant.LogoKey),
		Website:           textValue(tenant.Website),
	}
}

func textValue(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}

	return &value.String
}

var _ tenants.Store = TenantStore{}
