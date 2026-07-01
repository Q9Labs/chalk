package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const tenantID = "11111111-1111-1111-1111-111111111111"

func TestTenantRepositoryCreateTenant(t *testing.T) {
	defaultRegion := "us"
	repository := postgres.NewTenantRepository(&tenantQuerier{})

	tenant, err := repository.CreateTenant(context.Background(), tenants.CreateTenantInput{
		ID:            mustTenantID(t, tenantID),
		Name:          "Acme",
		DefaultRegion: &defaultRegion,
	})
	if err != nil {
		t.Fatalf("create tenant: %v", err)
	}

	if tenant.ID.String() != tenantID {
		t.Fatalf("tenant id = %q, want %q", tenant.ID.String(), tenantID)
	}
	if tenant.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", tenant.Name)
	}
	if tenant.DefaultRegion == nil || *tenant.DefaultRegion != "us" {
		t.Fatalf("default region = %v, want us", tenant.DefaultRegion)
	}
}

func TestTenantRepositoryGetTenant(t *testing.T) {
	website := text("https://acme.test")
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	updatedAt := time.Date(2026, 6, 30, 10, 5, 0, 0, time.UTC)
	repository := postgres.NewTenantRepository(&tenantQuerier{
		tenant: sqlc.Tenant{
			ID:                mustUUID(t, tenantID),
			Name:              "Acme",
			DefaultRegion:     text("us"),
			DefaultMediaPlane: text("cf_rtk"),
			LogoKey:           text("logos/acme.png"),
			Website:           website,
			UpdatedAt:         timestamp(updatedAt),
			CreatedAt:         timestamp(createdAt),
		},
	})

	tenant, err := repository.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if tenant.ID.String() != tenantID {
		t.Fatalf("tenant id = %q, want %q", tenant.ID.String(), tenantID)
	}
	if tenant.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", tenant.Name)
	}
	if tenant.DefaultRegion == nil || *tenant.DefaultRegion != "us" {
		t.Fatalf("tenant default region = %v, want us", tenant.DefaultRegion)
	}
	if tenant.DefaultMediaPlane == nil || *tenant.DefaultMediaPlane != "cf_rtk" {
		t.Fatalf("tenant default media plane = %v, want cf_rtk", tenant.DefaultMediaPlane)
	}
	if tenant.LogoKey == nil || *tenant.LogoKey != "logos/acme.png" {
		t.Fatalf("tenant logo key = %v, want logos/acme.png", tenant.LogoKey)
	}
	if tenant.Website == nil || *tenant.Website != "https://acme.test" {
		t.Fatalf("tenant website = %v, want https://acme.test", tenant.Website)
	}
	if !tenant.CreatedAt.Equal(createdAt) {
		t.Fatalf("tenant created at = %v, want %v", tenant.CreatedAt, createdAt)
	}
	if !tenant.UpdatedAt.Equal(updatedAt) {
		t.Fatalf("tenant updated at = %v, want %v", tenant.UpdatedAt, updatedAt)
	}
}

func TestTenantRepositoryGetTenantKeepsNullableFieldsNil(t *testing.T) {
	repository := postgres.NewTenantRepository(&tenantQuerier{
		tenant: sqlc.Tenant{
			ID:   mustUUID(t, tenantID),
			Name: "Acme",
		},
	})

	tenant, err := repository.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if tenant.DefaultRegion != nil {
		t.Fatalf("tenant default region = %v, want nil", tenant.DefaultRegion)
	}
	if tenant.Website != nil {
		t.Fatalf("tenant website = %v, want nil", tenant.Website)
	}
}

func TestTenantRepositoryGetTenantUsesParsedID(t *testing.T) {
	id := mustTenantID(t, tenantID)
	querier := &tenantQuerier{}
	repository := postgres.NewTenantRepository(querier)

	_, err := repository.GetTenant(context.Background(), id)
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if querier.requestedID.String() != tenantID {
		t.Fatalf("requested id = %q, want %q", querier.requestedID.String(), tenantID)
	}
}

func TestTenantRepositoryGetTenantMapsNotFound(t *testing.T) {
	repository := postgres.NewTenantRepository(&tenantQuerier{err: pgx.ErrNoRows})

	_, err := repository.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if !errors.Is(err, tenants.ErrTenantNotFound) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrTenantNotFound)
	}
}

func TestTenantRepositoryGetTenantReturnsQueryError(t *testing.T) {
	want := errors.New("query failed")
	repository := postgres.NewTenantRepository(&tenantQuerier{err: want})

	_, err := repository.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func TestTenantRepositoryListTenants(t *testing.T) {
	createdAt := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	nextCreatedAt := time.Date(2026, 6, 30, 9, 0, 0, 0, time.UTC)
	querier := &tenantQuerier{
		tenants: []sqlc.Tenant{
			{
				ID:        mustUUID(t, "11111111-1111-1111-1111-111111111111"),
				Name:      "Acme",
				CreatedAt: timestamp(createdAt),
			},
			{
				ID:        mustUUID(t, "22222222-2222-2222-2222-222222222222"),
				Name:      "Overflow",
				CreatedAt: timestamp(nextCreatedAt),
			},
		},
	}
	repository := postgres.NewTenantRepository(querier)

	list, err := repository.ListTenants(context.Background(), mustPageRequest(t, 1, nil))
	if err != nil {
		t.Fatalf("list tenants: %v", err)
	}

	if querier.listParams.PageSize != 2 {
		t.Fatalf("query page size = %d, want 2", querier.listParams.PageSize)
	}
	if len(list.Tenants) != 1 {
		t.Fatalf("tenant count = %d, want 1", len(list.Tenants))
	}
	if list.Tenants[0].Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", list.Tenants[0].Name)
	}
	if !list.Page.HasMore {
		t.Fatal("has_more = false, want true")
	}
	if list.Page.NextCursor == nil {
		t.Fatal("next cursor was nil")
	}
	if list.Page.NextCursor.ID.String() != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("next cursor id = %q, want first tenant id", list.Page.NextCursor.ID.String())
	}
	if !list.Page.NextCursor.CreatedAt.Equal(createdAt) {
		t.Fatalf("next cursor created at = %v, want %v", list.Page.NextCursor.CreatedAt, createdAt)
	}
}

func TestTenantRepositoryListTenantsUsesCursor(t *testing.T) {
	cursor := pagination.Cursor{
		CreatedAt: time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC),
		ID:        mustTenantID(t, tenantID),
	}
	querier := &tenantQuerier{}
	repository := postgres.NewTenantRepository(querier)

	_, err := repository.ListTenants(context.Background(), mustPageRequest(t, 10, &cursor))
	if err != nil {
		t.Fatalf("list tenants: %v", err)
	}

	if !querier.listParams.CursorSet {
		t.Fatal("cursor_set = false, want true")
	}
	if !querier.listParams.CursorCreatedAt.Valid || !querier.listParams.CursorCreatedAt.Time.Equal(cursor.CreatedAt) {
		t.Fatalf("cursor created at = %#v, want %v", querier.listParams.CursorCreatedAt, cursor.CreatedAt)
	}
	if !querier.listParams.CursorID.Valid || querier.listParams.CursorID.Bytes != cursor.ID.Bytes() {
		t.Fatalf("cursor id = %#v, want %s", querier.listParams.CursorID, cursor.ID.String())
	}
	if querier.listParams.PageSize != 11 {
		t.Fatalf("query page size = %d, want 11", querier.listParams.PageSize)
	}
}

func TestTenantRepositoryListTenantsReturnsQueryError(t *testing.T) {
	want := errors.New("query failed")
	repository := postgres.NewTenantRepository(&tenantQuerier{err: want})

	_, err := repository.ListTenants(context.Background(), mustPageRequest(t, 10, nil))
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

func TestTenantRepositoryUpdateTenant(t *testing.T) {
	name := "Acme Labs"
	defaultRegion := "sg"
	querier := &tenantQuerier{}
	repository := postgres.NewTenantRepository(querier)

	tenant, err := repository.UpdateTenant(context.Background(), mustTenantID(t, tenantID), tenants.UpdateTenantInput{
		Name: utilities.OptionalString{
			Set:   true,
			Value: &name,
		},
		DefaultRegion: utilities.OptionalString{
			Set:   true,
			Value: &defaultRegion,
		},
		Website: utilities.OptionalString{Set: true},
	})
	if err != nil {
		t.Fatalf("update tenant: %v", err)
	}

	if tenant.ID.String() != tenantID {
		t.Fatalf("tenant id = %q, want %q", tenant.ID.String(), tenantID)
	}
	if !querier.updateParams.NameSet || querier.updateParams.Name != "Acme Labs" {
		t.Fatalf("name params = %#v, want set Acme Labs", querier.updateParams)
	}
	if !querier.updateParams.DefaultRegionSet || !querier.updateParams.DefaultRegion.Valid || querier.updateParams.DefaultRegion.String != "sg" {
		t.Fatalf("default region params = %#v, want sg", querier.updateParams.DefaultRegion)
	}
	if !querier.updateParams.WebsiteSet || querier.updateParams.Website.Valid {
		t.Fatalf("website params = %#v, want set null", querier.updateParams.Website)
	}
}

func TestTenantRepositoryUpdateTenantMapsNotFound(t *testing.T) {
	repository := postgres.NewTenantRepository(&tenantQuerier{err: pgx.ErrNoRows})

	_, err := repository.UpdateTenant(context.Background(), mustTenantID(t, tenantID), tenants.UpdateTenantInput{})
	if !errors.Is(err, tenants.ErrTenantNotFound) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrTenantNotFound)
	}
}

type tenantQuerier struct {
	called       bool
	requestedID  pgtype.UUID
	createParams sqlc.CreateTenantParams
	listParams   sqlc.ListTenantsParams
	updateParams sqlc.UpdateTenantParams
	tenant       sqlc.Tenant
	tenants      []sqlc.Tenant
	err          error
}

func (q *tenantQuerier) CreateTenant(ctx context.Context, arg sqlc.CreateTenantParams) (sqlc.Tenant, error) {
	q.called = true
	q.createParams = arg

	if q.err != nil {
		return sqlc.Tenant{}, q.err
	}

	return sqlc.Tenant{
		ID:                arg.ID,
		Name:              arg.Name,
		DefaultRegion:     arg.DefaultRegion,
		DefaultMediaPlane: arg.DefaultMediaPlane,
		LogoKey:           arg.LogoKey,
		Website:           arg.Website,
	}, nil
}

func (q *tenantQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (sqlc.Tenant, error) {
	q.called = true
	q.requestedID = id

	if q.err != nil {
		return sqlc.Tenant{}, q.err
	}

	return q.tenant, nil
}

func (q *tenantQuerier) ListTenants(ctx context.Context, arg sqlc.ListTenantsParams) ([]sqlc.Tenant, error) {
	q.called = true
	q.listParams = arg

	if q.err != nil {
		return nil, q.err
	}

	return q.tenants, nil
}

func (q *tenantQuerier) UpdateTenant(ctx context.Context, arg sqlc.UpdateTenantParams) (sqlc.Tenant, error) {
	q.called = true
	q.updateParams = arg

	if q.err != nil {
		return sqlc.Tenant{}, q.err
	}

	return sqlc.Tenant{
		ID:                arg.ID,
		Name:              arg.Name,
		DefaultRegion:     arg.DefaultRegion,
		DefaultMediaPlane: arg.DefaultMediaPlane,
		LogoKey:           arg.LogoKey,
		Website:           arg.Website,
	}, nil
}

func mustUUID(t *testing.T, value string) pgtype.UUID {
	t.Helper()

	var uuid pgtype.UUID
	if err := uuid.Scan(value); err != nil {
		t.Fatalf("scan uuid: %v", err)
	}

	return uuid
}

func text(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: true}
}

func timestamp(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value, Valid: true}
}

func mustTenantID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}

func mustPageRequest(t *testing.T, size int, cursor *pagination.Cursor) pagination.PageRequest {
	t.Helper()

	page, err := pagination.NewPageRequest(size, cursor)
	if err != nil {
		t.Fatalf("new page request: %v", err)
	}

	return page
}
