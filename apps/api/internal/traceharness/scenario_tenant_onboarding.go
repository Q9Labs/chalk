package traceharness

import (
	"context"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type tracedAccountTenantService struct {
	recorder *Recorder
	now      func() time.Time
	conflict bool
}

func (s tracedAccountTenantService) ListAccountTenants(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error) {
	return tenants.AccountTenantList{}, nil
}

func (s tracedAccountTenantService) OnboardTenant(_ context.Context, input tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error) {
	span := s.recorder.Start("service", "tenants.AccountService.OnboardTenant", "validate Account scope, normalize Tenant, and fingerprint the idempotent request", map[string]any{
		"account_id": input.AccountID.String(), "request_key": input.RequestKey,
		"tenant": map[string]any{"name": input.Name, "default_region": input.DefaultRegion},
	})
	if s.conflict {
		s.recorder.Add("database", "SELECT tenant_onboarding_requests", "load the existing request fingerprint without exposing the response body", map[string]any{"request_key": input.RequestKey})
		span.End("reject a key previously used for a different normalized Tenant request", nil, tenants.ErrIdempotencyConflict)
		return tenants.OnboardTenantResult{}, tenants.ErrIdempotencyConflict
	}

	tenantID := mustID("33333333-3333-4333-8333-333333333333")
	accessID := mustID("44444444-4444-4444-8444-444444444444")
	createdAt := s.now()
	s.recorder.Add("database", "BEGIN", "start atomic Tenant onboarding transaction", nil)
	s.recorder.Add("database", "INSERT tenant_onboarding_requests", "reserve the Account-scoped idempotency key and request fingerprint", map[string]any{"request_key": input.RequestKey})
	s.recorder.Add("database", "INSERT tenants", "create the customer isolation boundary", map[string]any{"tenant_id": tenantID.String(), "name": "Trace studio", "default_region": "us"})
	s.recorder.Add("database", "INSERT memberships", "create legacy persistence for owner-level Tenant access", map[string]any{"tenant_id": tenantID.String(), "account_id": input.AccountID.String(), "role": "owner"})
	s.recorder.Add("database", "COMMIT", "commit Tenant and owner access together", nil)
	result := tenants.OnboardTenantResult{AccountTenant: tenants.AccountTenant{
		Tenant: tenants.Tenant{ID: tenantID, Name: "Trace studio", DefaultRegion: stringPointer("us"), CreatedAt: createdAt, UpdatedAt: createdAt},
		Access: tenants.TenantAccess{ID: accessID, TenantID: tenantID, AccountID: input.AccountID, Role: memberships.RoleOwner, CreatedAt: createdAt, UpdatedAt: createdAt},
	}}
	span.End("return the created Tenant and owner-level Tenant access", map[string]any{"tenant_id": tenantID.String(), "access_role": "owner", "replayed": false}, nil)
	return result, nil
}

func stringPointer(value string) *string {
	return &value
}
