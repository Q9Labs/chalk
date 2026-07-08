package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type TenantRepository struct {
	queries tenantQuerier
}

type tenantQuerier interface {
	CreateTenant(ctx context.Context, arg sqlc.CreateTenantParams) (sqlc.CreateTenantRow, error)
	GetTenant(ctx context.Context, id pgtype.UUID) (sqlc.GetTenantRow, error)
	ListTenants(ctx context.Context, arg sqlc.ListTenantsParams) ([]sqlc.ListTenantsRow, error)
	UpdateTenant(ctx context.Context, arg sqlc.UpdateTenantParams) (sqlc.UpdateTenantRow, error)
}

func NewTenantRepository(queries tenantQuerier) TenantRepository {
	return TenantRepository{queries: queries}
}

func (s TenantRepository) CreateTenant(ctx context.Context, input tenants.CreateTenantInput) (tenants.Tenant, error) {
	tenant, err := s.queries.CreateTenant(ctx, sqlc.CreateTenantParams{
		ID:                       pgtype.UUID{Bytes: input.ID.Bytes(), Valid: true},
		Name:                     input.Name,
		DefaultRegion:            text(input.DefaultRegion),
		DefaultMediaPlane:        text(input.DefaultMediaPlane),
		MediaPlaneProviderConfig: jsonBytes(input.MediaPlaneProviderConfig),
		AiProviderConfig:         jsonBytes(input.AIProviderConfig),
		StorageProviderConfig:    jsonBytes(input.StorageProviderConfig),
		LogoKey:                  text(input.LogoKey),
		Website:                  text(input.Website),
	})
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("create tenant: %w", err)
	}

	return mapTenant(createTenantRecord(tenant)), nil
}

func (s TenantRepository) GetTenant(ctx context.Context, id utilities.ID) (tenants.Tenant, error) {
	tenant, err := s.queries.GetTenant(ctx, pgtype.UUID{Bytes: id.Bytes(), Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("get tenant: %w", err)
	}

	return mapTenant(getTenantRecord(tenant)), nil
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
		response.Tenants = append(response.Tenants, mapTenant(listTenantRecord(row)))
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
	tenant, err := s.queries.UpdateTenant(ctx, sqlc.UpdateTenantParams{
		ID:                          pgtype.UUID{Bytes: id.Bytes(), Valid: true},
		NameSet:                     input.Name.Set,
		Name:                        requiredText(input.Name),
		DefaultRegionSet:            input.DefaultRegion.Set,
		DefaultRegion:               text(input.DefaultRegion.Value),
		DefaultMediaPlaneSet:        input.DefaultMediaPlane.Set,
		DefaultMediaPlane:           text(input.DefaultMediaPlane.Value),
		MediaPlaneProviderConfigSet: input.MediaPlaneProviderConfig.Set,
		MediaPlaneProviderConfig:    jsonBytes(input.MediaPlaneProviderConfig.Value),
		AiProviderConfigSet:         input.AIProviderConfig.Set,
		AiProviderConfig:            jsonBytes(input.AIProviderConfig.Value),
		StorageProviderConfigSet:    input.StorageProviderConfig.Set,
		StorageProviderConfig:       jsonBytes(input.StorageProviderConfig.Value),
		LogoKeySet:                  input.LogoKey.Set,
		LogoKey:                     text(input.LogoKey.Value),
		WebsiteSet:                  input.Website.Set,
		Website:                     text(input.Website.Value),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	if err != nil {
		return tenants.Tenant{}, fmt.Errorf("update tenant: %w", err)
	}

	return mapTenant(updateTenantRecord(tenant)), nil
}

func listTenantsParams(page pagination.PageRequest) sqlc.ListTenantsParams {
	cursor := page.Cursor()
	params := sqlc.ListTenantsParams{
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

func mapTenant(tenant tenantRecord) tenants.Tenant {
	return tenants.Tenant{
		ID:                       utilities.IDFromBytes(tenant.ID.Bytes),
		Name:                     tenant.Name,
		DefaultRegion:            nullableText(tenant.DefaultRegion),
		DefaultMediaPlane:        nullableText(tenant.DefaultMediaPlane),
		MediaPlaneProviderConfig: jsonRaw(tenant.MediaPlaneProviderConfig),
		AIProviderConfig:         jsonRaw(tenant.AiProviderConfig),
		StorageProviderConfig:    jsonRaw(tenant.StorageProviderConfig),
		LogoKey:                  nullableText(tenant.LogoKey),
		Website:                  nullableText(tenant.Website),
		UpdatedAt:                timestamp(tenant.UpdatedAt),
		CreatedAt:                timestamp(tenant.CreatedAt),
	}
}

type tenantRecord struct {
	ID                       pgtype.UUID
	Name                     string
	DefaultRegion            pgtype.Text
	DefaultMediaPlane        pgtype.Text
	MediaPlaneProviderConfig []byte
	AiProviderConfig         []byte
	StorageProviderConfig    []byte
	LogoKey                  pgtype.Text
	Website                  pgtype.Text
	UpdatedAt                pgtype.Timestamptz
	CreatedAt                pgtype.Timestamptz
}

func createTenantRecord(row sqlc.CreateTenantRow) tenantRecord {
	return tenantRecord{
		ID:                       row.ID,
		Name:                     row.Name,
		DefaultRegion:            row.DefaultRegion,
		DefaultMediaPlane:        row.DefaultMediaPlane,
		MediaPlaneProviderConfig: row.MediaPlaneProviderConfig,
		AiProviderConfig:         row.AiProviderConfig,
		StorageProviderConfig:    row.StorageProviderConfig,
		LogoKey:                  row.LogoKey,
		Website:                  row.Website,
		UpdatedAt:                row.UpdatedAt,
		CreatedAt:                row.CreatedAt,
	}
}

func getTenantRecord(row sqlc.GetTenantRow) tenantRecord {
	return tenantRecord{
		ID:                       row.ID,
		Name:                     row.Name,
		DefaultRegion:            row.DefaultRegion,
		DefaultMediaPlane:        row.DefaultMediaPlane,
		MediaPlaneProviderConfig: row.MediaPlaneProviderConfig,
		AiProviderConfig:         row.AiProviderConfig,
		StorageProviderConfig:    row.StorageProviderConfig,
		LogoKey:                  row.LogoKey,
		Website:                  row.Website,
		UpdatedAt:                row.UpdatedAt,
		CreatedAt:                row.CreatedAt,
	}
}

func listTenantRecord(row sqlc.ListTenantsRow) tenantRecord {
	return tenantRecord{
		ID:                       row.ID,
		Name:                     row.Name,
		DefaultRegion:            row.DefaultRegion,
		DefaultMediaPlane:        row.DefaultMediaPlane,
		MediaPlaneProviderConfig: row.MediaPlaneProviderConfig,
		AiProviderConfig:         row.AiProviderConfig,
		StorageProviderConfig:    row.StorageProviderConfig,
		LogoKey:                  row.LogoKey,
		Website:                  row.Website,
		UpdatedAt:                row.UpdatedAt,
		CreatedAt:                row.CreatedAt,
	}
}

func updateTenantRecord(row sqlc.UpdateTenantRow) tenantRecord {
	return tenantRecord{
		ID:                       row.ID,
		Name:                     row.Name,
		DefaultRegion:            row.DefaultRegion,
		DefaultMediaPlane:        row.DefaultMediaPlane,
		MediaPlaneProviderConfig: row.MediaPlaneProviderConfig,
		AiProviderConfig:         row.AiProviderConfig,
		StorageProviderConfig:    row.StorageProviderConfig,
		LogoKey:                  row.LogoKey,
		Website:                  row.Website,
		UpdatedAt:                row.UpdatedAt,
		CreatedAt:                row.CreatedAt,
	}
}

var _ tenants.TenantRepository = TenantRepository{}
