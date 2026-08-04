package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/memberships"
	"github.com/q9labs/chalk/apps/api/internal/pagination"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type accountTenantService struct {
	list    func(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error)
	onboard func(context.Context, tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error)
}

func (s accountTenantService) ListAccountTenants(ctx context.Context, accountID utilities.ID, page pagination.PageRequest) (tenants.AccountTenantList, error) {
	return s.list(ctx, accountID, page)
}

func (s accountTenantService) OnboardTenant(ctx context.Context, input tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error) {
	return s.onboard(ctx, input)
}

func TestListMyTenantsUsesAuthenticatedAccountScope(t *testing.T) {
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	tenantID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	accessID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	res := authenticatedRequestWithOptions(t, http.MethodGet, "/v1/me/tenants?page_size=10", httpapi.Options{
		AccountTenants: accountTenantService{list: func(_ context.Context, accountID utilities.ID, page pagination.PageRequest) (tenants.AccountTenantList, error) {
			if accountID != authUser(t).ID {
				t.Fatalf("account id = %s", accountID.String())
			}
			if page.Size() != 10 {
				t.Fatalf("page size = %d", page.Size())
			}
			return tenants.AccountTenantList{Tenants: []tenants.AccountTenant{{
				Tenant: tenants.Tenant{ID: tenantID, Name: "Acme studio", UpdatedAt: now, CreatedAt: now},
				Access: tenants.TenantAccess{ID: accessID, TenantID: tenantID, AccountID: accountID, Role: memberships.RoleOwner, UpdatedAt: now, CreatedAt: now},
			}}, Page: pagination.Page{PageSize: 10}}, nil
		}},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var body struct {
		Tenants []struct {
			Tenant struct {
				Name string `json:"name"`
			} `json:"tenant"`
			Access struct {
				Role string `json:"role"`
			} `json:"access"`
		} `json:"tenants"`
	}
	decodeJSON(t, res, &body)
	if len(body.Tenants) != 1 || body.Tenants[0].Tenant.Name != "Acme studio" || body.Tenants[0].Access.Role != "owner" {
		t.Fatalf("response = %#v", body)
	}
}

func TestOnboardTenantDerivesAccountScopeFromPrincipal(t *testing.T) {
	now := time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)
	tenantID := mustTenantID(t, "33333333-3333-4333-8333-333333333333")
	accessID := mustTenantID(t, "44444444-4444-4444-8444-444444444444")
	request := bearerRequestWithBody(http.MethodPost, "/v1/me/tenants", authenticatedFixtureToken(), `{"name":"Acme studio"}`)
	request.Header.Set("Idempotency-Key", "tenant-onboard-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{
		AccountTenants: accountTenantService{onboard: func(_ context.Context, input tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error) {
			if input.AccountID != authUser(t).ID || input.RequestKey != "tenant-onboard-0001" || input.Name != "Acme studio" {
				t.Fatalf("input = %#v", input)
			}
			return tenants.OnboardTenantResult{Replayed: true, AccountTenant: tenants.AccountTenant{
				Tenant: tenants.Tenant{ID: tenantID, Name: input.Name, UpdatedAt: now, CreatedAt: now},
				Access: tenants.TenantAccess{ID: accessID, TenantID: tenantID, AccountID: input.AccountID, Role: memberships.RoleOwner, UpdatedAt: now, CreatedAt: now},
			}}, nil
		}},
	}))
	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	var raw map[string]any
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if raw["replayed"] != true {
		t.Fatalf("response = %#v", raw)
	}
}

func TestOnboardTenantRejectsAccountIDInBody(t *testing.T) {
	request := bearerRequestWithBody(http.MethodPost, "/v1/me/tenants", authenticatedFixtureToken(), `{"name":"Acme studio","account_id":"99999999-9999-4999-8999-999999999999"}`)
	request.Header.Set("Idempotency-Key", "tenant-onboard-0001")
	res := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{AccountTenants: accountTenantService{onboard: func(context.Context, tenants.OnboardTenantInput) (tenants.OnboardTenantResult, error) {
		t.Fatal("service called with browser-supplied Account ID")
		return tenants.OnboardTenantResult{}, nil
	}}}))
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusBadRequest)
	}
}

func TestMyTenantsRejectsTenantAPIKey(t *testing.T) {
	request := bearerRequest(http.MethodGet, "/v1/me/tenants", "chalk_sk_test_credential")
	res := requestWithOptionsAndRequest(t, request, httpapi.Options{AccountTenants: accountTenantService{list: func(context.Context, utilities.ID, pagination.PageRequest) (tenants.AccountTenantList, error) {
		t.Fatal("service called with Tenant API key")
		return tenants.AccountTenantList{}, nil
	}}})
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}
