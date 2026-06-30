package tenants_test

import (
	"context"
	"errors"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

func TestServiceGetTenant(t *testing.T) {
	id := mustTenantID(t, "11111111-1111-1111-1111-111111111111")
	store := &tenantStore{
		tenant: tenants.Tenant{
			ID:   id,
			Name: "Acme",
		},
	}
	service := tenants.NewService(store)

	tenant, err := service.GetTenant(context.Background(), id)
	if err != nil {
		t.Fatalf("get tenant: %v", err)
	}

	if tenant.ID.String() != id.String() {
		t.Fatalf("tenant id = %q, want %q", tenant.ID.String(), id.String())
	}
	if store.requestedID.String() != id.String() {
		t.Fatalf("requested id = %q, want %q", store.requestedID.String(), id.String())
	}
}

func TestServiceGetTenantRejectsZeroID(t *testing.T) {
	store := &tenantStore{}
	service := tenants.NewService(store)

	_, err := service.GetTenant(context.Background(), tenants.TenantID{})
	if !errors.Is(err, tenants.ErrInvalidTenantID) {
		t.Fatalf("error = %v, want %v", err, tenants.ErrInvalidTenantID)
	}
	if store.called {
		t.Fatal("store was called")
	}
}

func TestServiceGetTenantReturnsStoreError(t *testing.T) {
	want := errors.New("store failed")
	service := tenants.NewService(&tenantStore{err: want})

	_, err := service.GetTenant(context.Background(), mustTenantID(t, "11111111-1111-1111-1111-111111111111"))
	if !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
}

type tenantStore struct {
	called      bool
	requestedID tenants.TenantID
	tenant      tenants.Tenant
	err         error
}

func (s *tenantStore) GetTenant(ctx context.Context, id tenants.TenantID) (tenants.Tenant, error) {
	s.called = true
	s.requestedID = id

	if s.err != nil {
		return tenants.Tenant{}, s.err
	}

	return s.tenant, nil
}

func mustTenantID(t *testing.T, value string) tenants.TenantID {
	t.Helper()

	id, err := tenants.ParseTenantID(value)
	if err != nil {
		t.Fatalf("parse tenant id: %v", err)
	}

	return id
}
