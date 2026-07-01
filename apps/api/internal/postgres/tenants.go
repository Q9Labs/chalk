package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TenantRepository struct {
	queries db.Querier
}

func NewTenantRepository(queries db.Querier) TenantRepository {
	return TenantRepository{queries: queries}
}

func (s TenantRepository) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	tenant, err := s.queries.CreateTenant(ctx, db.CreateTenantParams{
		ID:                pgtype.UUID{Bytes: input.ID.Bytes(), Valid: true},
		Name:              input.Name,
		DefaultRegion:     text(input.DefaultRegion),
		DefaultMediaPlane: text(input.DefaultMediaPlane),
		LogoKey:           text(input.LogoKey),
		Website:           text(input.Website),
	})
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("create tenant: %w", err)
	}

	return mapTenant(tenant), nil
}

func (s TenantRepository) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	tenant, err := s.queries.GetTenant(ctx, pgtype.UUID{Bytes: id.Bytes(), Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("get tenant: %w", err)
	}

	return mapTenant(tenant), nil
}

func (s TenantRepository) ListTenants(ctx context.Context, page pagination.PageRequest) (tenants.TenantList, error) {
	rows, err := s.queries.ListTenants(ctx, listTenantsParams(page))
	if err != nil {
		return tenants.TenantList{}, fmt.Errorf("list tenants: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}

	response := tenants.TenantList{
		Tenants: make([]tenants.Tenant, 0, len(rows)),
		Page: pagination.Page{
			PageSize: size,
			HasMore:  hasMore,
		},
	}
	for _, row := range rows {
		response.Tenants = append(response.Tenants, mapTenant(row))
	}

	if hasMore && len(response.Tenants) > 0 {
		lastTenant := response.Tenants[len(response.Tenants)-1]
		response.Page.NextCursor = &pagination.Cursor{
			CreatedAt: lastTenant.CreatedAt,
			ID:        lastTenant.ID,
		}
	}

	return response, nil
}

func (s TenantRepository) UpdateTenant(ctx context.Context, id utilities.ID, input tenants.UpdateTenantInput) (tenants.Tenant, error) {
	tenant, err := s.queries.UpdateTenant(ctx, db.UpdateTenantParams{
		ID:                   pgtype.UUID{Bytes: id.Bytes(), Valid: true},
		NameSet:              input.Name.Set,
		Name:                 requiredText(input.Name),
		DefaultRegionSet:     input.DefaultRegion.Set,
		DefaultRegion:        text(input.DefaultRegion.Value),
		DefaultMediaPlaneSet: input.DefaultMediaPlane.Set,
		DefaultMediaPlane:    text(input.DefaultMediaPlane.Value),
		LogoKeySet:           input.LogoKey.Set,
		LogoKey:              text(input.LogoKey.Value),
		WebsiteSet:           input.Website.Set,
		Website:              text(input.Website.Value),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("update tenant: %w", err)
	}

	return mapTenant(tenant), nil
}

func listTenantsParams(page pagination.PageRequest) db.ListTenantsParams {
	cursor := page.Cursor()
	params := db.ListTenantsParams{
		PageSize: int32(page.Size() + 1),
	}
	if cursor == nil {
		return params
	}

	params.CursorSet = true
	params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
	params.CursorID = pgtype.UUID{Bytes: cursor.ID.Bytes(), Valid: true}
	return params
}

func mapTenant(tenant db.Tenant) tenants.Tenant {
	return tenants.Tenant{
		ID:                utilities.IDFromBytes(tenant.ID.Bytes),
		Name:              tenant.Name,
		DefaultRegion:     nullableText(tenant.DefaultRegion),
		DefaultMediaPlane: nullableText(tenant.DefaultMediaPlane),
		LogoKey:           nullableText(tenant.LogoKey),
		Website:           nullableText(tenant.Website),
		UpdatedAt:         timestamp(tenant.UpdatedAt),
		CreatedAt:         timestamp(tenant.CreatedAt),
	}
}

var _ tenants.TenantRepository = TenantRepository{}
