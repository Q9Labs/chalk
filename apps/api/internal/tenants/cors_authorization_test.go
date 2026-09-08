package tenants

import (
	"context"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestAllowsOriginReadsTheSharedTenantPolicyAfterAnotherServiceRevokesAnOrigin(t *testing.T) {
	tenantID := corsAuthorizationTestID(t)
	repository := &corsAuthorizationRepository{origins: []string{"https://old.example"}}
	firstInstance := NewService(repository)
	secondInstance := NewService(repository)

	allowed, err := firstInstance.AllowsOrigin(context.Background(), tenantID, "https://old.example")
	if err != nil || !allowed {
		t.Fatalf("initial AllowsOrigin = %t, %v, want true, nil", allowed, err)
	}
	_, err = secondInstance.UpdateTenant(context.Background(), tenantID, UpdateTenantInput{
		CORSAllowedOrigins: OptionalCORSOrigins{Set: true, Value: []string{"https://new.example"}},
	})
	if err != nil {
		t.Fatalf("UpdateTenant returned an error: %v", err)
	}
	allowed, err = firstInstance.AllowsOrigin(context.Background(), tenantID, "https://old.example")
	if err != nil || allowed {
		t.Fatalf("revoked AllowsOrigin = %t, %v, want false, nil", allowed, err)
	}
	allowed, err = firstInstance.AllowsOrigin(context.Background(), tenantID, "https://new.example")
	if err != nil || !allowed {
		t.Fatalf("replacement AllowsOrigin = %t, %v, want true, nil", allowed, err)
	}
}

func TestAllowsOriginFailsClosedForMissingTenant(t *testing.T) {
	service := NewService(&corsAuthorizationRepository{lookupErr: ErrTenantNotFound})
	allowed, err := service.AllowsOrigin(context.Background(), corsAuthorizationTestID(t), "https://app.example")
	if err != nil || allowed {
		t.Fatalf("AllowsOrigin = %t, %v, want false, nil", allowed, err)
	}
}

type corsAuthorizationRepository struct {
	origins   []string
	lookupErr error
}

func (r *corsAuthorizationRepository) CreateTenant(context.Context, CreateTenantInput) (Tenant, error) {
	return Tenant{}, nil
}

func (r *corsAuthorizationRepository) GetTenant(context.Context, utilities.ID) (Tenant, error) {
	return Tenant{}, nil
}

func (r *corsAuthorizationRepository) ListTenants(context.Context, pagination.PageRequest) (TenantList, error) {
	return TenantList{}, nil
}

func (r *corsAuthorizationRepository) UpdateTenant(_ context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error) {
	if input.CORSAllowedOrigins.Set {
		r.origins = append([]string(nil), input.CORSAllowedOrigins.Value...)
	}
	return Tenant{ID: id, CORSAllowedOrigins: append([]string(nil), r.origins...)}, nil
}

func (r *corsAuthorizationRepository) GetTenantCORSAllowedOrigins(context.Context, utilities.ID) ([]string, error) {
	if r.lookupErr != nil {
		return nil, r.lookupErr
	}
	return append([]string(nil), r.origins...), nil
}

func corsAuthorizationTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	return id
}
