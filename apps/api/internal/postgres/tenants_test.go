package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/postgres"
	"github.com/q9labs/chalk/apps/api/internal/postgres/db"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

const tenantID = "11111111-1111-1111-1111-111111111111"

func TestTenantStoreGetTenant(t *testing.T) {
	website := text("https://acme.test")
	store := postgres.NewTenantStore(&tenantQuerier{
		tenant: db.Tenant{
			ID:                mustUUID(t, tenantID),
			Name:              "Acme",
			DefaultRegion:     text("iad"),
			DefaultMediaPlane: text("cf_rtk"),
			LogoKey:           text("logos/acme.png"),
			Website:           website,
		},
	})

	tenant, err := store.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if tenant.ID.String() != tenantID {
		t.Fatalf("tenant id = %q, want %q", tenant.ID.String(), tenantID)
	}
	if tenant.Name != "Acme" {
		t.Fatalf("tenant name = %q, want Acme", tenant.Name)
	}
	if tenant.DefaultRegion == nil || *tenant.DefaultRegion != "iad" {
		t.Fatalf("tenant default region = %v, want iad", tenant.DefaultRegion)
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
}

func TestTenantStoreGetTenantKeepsNullableFieldsNil(t *testing.T) {
	store := postgres.NewTenantStore(&tenantQuerier{
		tenant: db.Tenant{
			ID:   mustUUID(t, tenantID),
			Name: "Acme",
		},
	})

	tenant, err := store.GetTenant(context.Background(), mustTenantID(t, tenantID))
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

func TestTenantStoreGetTenantUsesParsedID(t *testing.T) {
	id := mustTenantID(t, tenantID)
	querier := &tenantQuerier{}
	store := postgres.NewTenantStore(querier)

	_, err := store.GetTenant(context.Background(), id)
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if querier.requestedID.String() != tenantID {
		t.Fatalf("requested id = %q, want %q", querier.requestedID.String(), tenantID)
	}
}

func TestTenantStoreGetTenantMapsNotFound(t *testing.T) {
	store := postgres.NewTenantStore(&tenantQuerier{err: pgx.ErrNoRows})

	_, err := store.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if !errors.Is(err, tenants.ErrTenantNotFound) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrTenantNotFound)
	}
}

func TestTenantStoreGetTenantReturnsQueryError(t *testing.T) {
	want := errors.New("query failed")
	store := postgres.NewTenantStore(&tenantQuerier{err: want})

	_, err := store.GetTenant(context.Background(), mustTenantID(t, tenantID))
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

type tenantQuerier struct {
	called      bool
	requestedID pgtype.UUID
	tenant      db.Tenant
	err         error
}

func (q *tenantQuerier) GetTenant(ctx context.Context, id pgtype.UUID) (db.Tenant, error) {
	q.called = true
	q.requestedID = id

	if q.err != nil {
		return db.Tenant{}, q.err
	}

	return q.tenant, nil
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

func mustTenantID(t *testing.T, value string) tenants.TenantID {
	t.Helper()

	id, err := tenants.ParseTenantID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}
