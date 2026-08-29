package tenants

import (
	"context"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestOriginPolicyCachesTenantAllowlist(t *testing.T) {
	tenantID := originPolicyTestID(t)
	repository := &originPolicyRepository{origins: []string{"https://app.example"}}
	policy := NewOriginPolicy(repository)

	for range 2 {
		allowed, err := policy.Allows(context.Background(), tenantID, "https://app.example")
		if err != nil || !allowed {
			t.Fatalf("Allows = %t, %v, want true, nil", allowed, err)
		}
	}
	if repository.lookups != 1 {
		t.Fatalf("repository lookups = %d, want 1", repository.lookups)
	}
}

func TestOriginPolicyExpiresAndRefreshesTenantAllowlist(t *testing.T) {
	tenantID := originPolicyTestID(t)
	repository := &originPolicyRepository{origins: []string{"https://old.example"}}
	policy := NewOriginPolicy(repository)
	now := time.Date(2026, 8, 29, 16, 0, 0, 0, time.UTC)
	policy.now = func() time.Time { return now }

	allowed, err := policy.Allows(context.Background(), tenantID, "https://old.example")
	if err != nil || !allowed {
		t.Fatalf("initial Allows = %t, %v, want true, nil", allowed, err)
	}
	repository.origins = []string{"https://new.example"}
	now = now.Add(originPolicyCacheTTL)
	allowed, err = policy.Allows(context.Background(), tenantID, "https://new.example")
	if err != nil || !allowed {
		t.Fatalf("refreshed Allows = %t, %v, want true, nil", allowed, err)
	}
	if repository.lookups != 2 {
		t.Fatalf("repository lookups = %d, want 2", repository.lookups)
	}
}

func TestServiceUpdateRefreshesOriginPolicy(t *testing.T) {
	tenantID := originPolicyTestID(t)
	repository := &originPolicyRepository{origins: []string{"https://old.example"}}
	service := NewService(repository)
	if allowed, err := service.AllowsOrigin(context.Background(), tenantID, "https://old.example"); err != nil || !allowed {
		t.Fatalf("initial AllowsOrigin = %t, %v, want true, nil", allowed, err)
	}

	_, err := service.UpdateTenant(context.Background(), tenantID, UpdateTenantInput{
		CORSAllowedOrigins: OptionalCORSOrigins{Set: true, Value: []string{"https://new.example"}},
	})
	if err != nil {
		t.Fatalf("UpdateTenant returned an error: %v", err)
	}
	if allowed, err := service.AllowsOrigin(context.Background(), tenantID, "https://new.example"); err != nil || !allowed {
		t.Fatalf("updated AllowsOrigin = %t, %v, want true, nil", allowed, err)
	}
	if allowed, err := service.AllowsOrigin(context.Background(), tenantID, "https://old.example"); err != nil || allowed {
		t.Fatalf("old AllowsOrigin = %t, %v, want false, nil", allowed, err)
	}
}

func TestServiceCachesMissingTenantPolicy(t *testing.T) {
	tenantID := originPolicyTestID(t)
	repository := &originPolicyRepository{lookupErr: ErrTenantNotFound}
	service := NewService(repository)

	for range 2 {
		allowed, err := service.AllowsOrigin(context.Background(), tenantID, "https://app.example")
		if err != nil || allowed {
			t.Fatalf("AllowsOrigin = %t, %v, want false, nil", allowed, err)
		}
	}
	if repository.lookups != 1 {
		t.Fatalf("repository lookups = %d, want 1", repository.lookups)
	}
}

type originPolicyRepository struct {
	origins   []string
	lookups   int
	lookupErr error
}

func (r *originPolicyRepository) CreateTenant(context.Context, CreateTenantInput) (Tenant, error) {
	return Tenant{}, nil
}

func (r *originPolicyRepository) GetTenant(context.Context, utilities.ID) (Tenant, error) {
	return Tenant{}, nil
}

func (r *originPolicyRepository) ListTenants(context.Context, pagination.PageRequest) (TenantList, error) {
	return TenantList{}, nil
}

func (r *originPolicyRepository) UpdateTenant(_ context.Context, id utilities.ID, input UpdateTenantInput) (Tenant, error) {
	if input.CORSAllowedOrigins.Set {
		r.origins = append([]string(nil), input.CORSAllowedOrigins.Value...)
	}
	return Tenant{ID: id, CORSAllowedOrigins: append([]string(nil), r.origins...)}, nil
}

func (r *originPolicyRepository) GetTenantCORSAllowedOrigins(context.Context, utilities.ID) ([]string, error) {
	r.lookups++
	if r.lookupErr != nil {
		return nil, r.lookupErr
	}
	return append([]string(nil), r.origins...), nil
}

func originPolicyTestID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.ParseID("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	return id
}
