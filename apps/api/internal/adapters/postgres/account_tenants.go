package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type accountTenantQuerier interface {
	CreateMembership(context.Context, sqlc.CreateMembershipParams) (sqlc.Membership, error)
	CreateTenant(context.Context, sqlc.CreateTenantParams) (sqlc.CreateTenantRow, error)
	GetAccountTenantByOnboarding(context.Context, sqlc.GetAccountTenantByOnboardingParams) (sqlc.GetAccountTenantByOnboardingRow, error)
	GetTenantOnboarding(context.Context, sqlc.GetTenantOnboardingParams) (sqlc.TenantOnboardingRequest, error)
	ListAccountTenants(context.Context, sqlc.ListAccountTenantsParams) ([]sqlc.ListAccountTenantsRow, error)
	ReserveTenantOnboarding(context.Context, sqlc.ReserveTenantOnboardingParams) (sqlc.TenantOnboardingRequest, error)
}

type accountTenantTransactor interface {
	Begin(context.Context) (pgx.Tx, error)
}

type AccountTenantRepository struct {
	queries    accountTenantQuerier
	transactor accountTenantTransactor
	decorate   func(sqlc.Querier) sqlc.Querier
}

func NewAccountTenantRepository(queries accountTenantQuerier, transactor accountTenantTransactor, decorate func(sqlc.Querier) sqlc.Querier) AccountTenantRepository {
	return AccountTenantRepository{queries: queries, transactor: transactor, decorate: decorate}
}

func (r AccountTenantRepository) ListAccountTenants(ctx context.Context, accountID utilities.ID, page pagination.PageRequest) (tenants.AccountTenantList, error) {
	params := sqlc.ListAccountTenantsParams{AccountID: uuid(accountID), PageSize: int32(page.Size() + 1)}
	if cursor := page.Cursor(); cursor != nil {
		params.CursorSet = true
		params.CursorCreatedAt = pgtype.Timestamptz{Time: cursor.CreatedAt, Valid: true}
		params.CursorID = uuid(cursor.ID)
	}
	rows, err := r.queries.ListAccountTenants(ctx, params)
	if err != nil {
		return tenants.AccountTenantList{}, fmt.Errorf("list account tenants: %w", err)
	}

	size := page.Size()
	hasMore := len(rows) > size
	if hasMore {
		rows = rows[:size]
	}
	result := tenants.AccountTenantList{
		Tenants: make([]tenants.AccountTenant, 0, len(rows)),
		Page:    pagination.Page{PageSize: size, HasMore: hasMore},
	}
	for _, row := range rows {
		result.Tenants = append(result.Tenants, mapListAccountTenant(row))
	}
	if hasMore && len(result.Tenants) > 0 {
		last := result.Tenants[len(result.Tenants)-1].Tenant
		result.Page.NextCursor = &pagination.Cursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return result, nil
}

func (r AccountTenantRepository) OnboardTenant(ctx context.Context, input tenants.OnboardTenantRecordInput) (tenants.OnboardTenantResult, error) {
	if r.transactor == nil {
		return tenants.OnboardTenantResult{}, errors.New("tenant onboarding transaction is unavailable")
	}
	tx, err := r.transactor.Begin(ctx)
	if err != nil {
		return tenants.OnboardTenantResult{}, fmt.Errorf("begin tenant onboarding: %w", err)
	}
	defer tx.Rollback(ctx)

	var queries accountTenantQuerier = sqlc.New(tx)
	if r.decorate != nil {
		queries = r.decorate(sqlc.New(tx))
	}
	reservationParams := sqlc.ReserveTenantOnboardingParams{
		AccountID: uuid(input.AccountID), RequestKey: input.RequestKey,
		RequestFingerprint: input.RequestFingerprint[:], TenantID: uuid(input.Tenant.ID), TenantAccessID: uuid(input.AccessID),
	}
	_, reserveErr := queries.ReserveTenantOnboarding(ctx, reservationParams)
	replayed := errors.Is(reserveErr, pgx.ErrNoRows)
	if reserveErr != nil && !replayed {
		return tenants.OnboardTenantResult{}, fmt.Errorf("reserve tenant onboarding: %w", reserveErr)
	}

	if replayed {
		existing, getErr := queries.GetTenantOnboarding(ctx, sqlc.GetTenantOnboardingParams{AccountID: uuid(input.AccountID), RequestKey: input.RequestKey})
		if getErr != nil {
			return tenants.OnboardTenantResult{}, fmt.Errorf("get tenant onboarding replay: %w", getErr)
		}
		if !bytes.Equal(existing.RequestFingerprint, input.RequestFingerprint[:]) {
			return tenants.OnboardTenantResult{}, tenants.ErrIdempotencyConflict
		}
	} else {
		if _, err := queries.CreateTenant(ctx, createAccountTenantParams(input.Tenant)); err != nil {
			return tenants.OnboardTenantResult{}, fmt.Errorf("create onboarded tenant: %w", err)
		}
		if _, err := queries.CreateMembership(ctx, sqlc.CreateMembershipParams{
			ID: uuid(input.AccessID), TenantID: uuid(input.Tenant.ID), UserID: uuid(input.AccountID), Role: string(memberships.RoleOwner),
		}); err != nil {
			return tenants.OnboardTenantResult{}, fmt.Errorf("create owner tenant access: %w", err)
		}
	}

	row, err := queries.GetAccountTenantByOnboarding(ctx, sqlc.GetAccountTenantByOnboardingParams{AccountID: uuid(input.AccountID), RequestKey: input.RequestKey})
	if err != nil {
		return tenants.OnboardTenantResult{}, fmt.Errorf("get onboarded tenant: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return tenants.OnboardTenantResult{}, fmt.Errorf("commit tenant onboarding: %w", err)
	}
	return tenants.OnboardTenantResult{AccountTenant: mapOnboardedAccountTenant(row), Replayed: replayed}, nil
}

func createAccountTenantParams(input tenants.CreateTenantInput) sqlc.CreateTenantParams {
	return sqlc.CreateTenantParams{
		ID: uuid(input.ID), Name: input.Name, DefaultRegion: text(input.DefaultRegion), DefaultMediaPlane: text(input.DefaultMediaPlane),
		MediaPlaneProviderConfig: jsonBytes(input.MediaPlaneProviderConfig), AiProviderConfig: jsonBytes(input.AIProviderConfig),
		StorageProviderConfig: jsonBytes(input.StorageProviderConfig), LogoKey: text(input.LogoKey), Website: text(input.Website),
	}
}

func mapListAccountTenant(row sqlc.ListAccountTenantsRow) tenants.AccountTenant {
	return tenants.AccountTenant{
		Tenant: mapTenant(tenantRecord{
			ID: row.ID, Name: row.Name, DefaultRegion: row.DefaultRegion, DefaultMediaPlane: row.DefaultMediaPlane,
			MediaPlaneProviderConfig: row.MediaPlaneProviderConfig, AiProviderConfig: row.AiProviderConfig,
			StorageProviderConfig: row.StorageProviderConfig, LogoKey: row.LogoKey, Website: row.Website,
			UpdatedAt: row.UpdatedAt, CreatedAt: row.CreatedAt,
		}),
		Access: tenants.TenantAccess{
			ID: utilities.IDFromBytes(row.TenantAccessID.Bytes), TenantID: utilities.IDFromBytes(row.ID.Bytes),
			AccountID: utilities.IDFromBytes(row.AccountID.Bytes), Role: memberships.Role(row.AccessRole),
			UpdatedAt: timestamp(row.AccessUpdatedAt), CreatedAt: timestamp(row.AccessCreatedAt),
		},
	}
}

func mapOnboardedAccountTenant(row sqlc.GetAccountTenantByOnboardingRow) tenants.AccountTenant {
	return tenants.AccountTenant{
		Tenant: mapTenant(tenantRecord{
			ID: row.ID, Name: row.Name, DefaultRegion: row.DefaultRegion, DefaultMediaPlane: row.DefaultMediaPlane,
			MediaPlaneProviderConfig: row.MediaPlaneProviderConfig, AiProviderConfig: row.AiProviderConfig,
			StorageProviderConfig: row.StorageProviderConfig, LogoKey: row.LogoKey, Website: row.Website,
			UpdatedAt: row.UpdatedAt, CreatedAt: row.CreatedAt,
		}),
		Access: tenants.TenantAccess{
			ID: utilities.IDFromBytes(row.TenantAccessID.Bytes), TenantID: utilities.IDFromBytes(row.ID.Bytes),
			AccountID: utilities.IDFromBytes(row.AccountID.Bytes), Role: memberships.Role(row.AccessRole),
			UpdatedAt: timestamp(row.AccessUpdatedAt), CreatedAt: timestamp(row.AccessCreatedAt),
		},
	}
}

var _ tenants.AccountTenantRepository = AccountTenantRepository{}
