package postgres

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

type serviceIsolationHarness struct {
	t        *testing.T
	server   *httptest.Server
	serviceA string
	serviceB string
	secretA  string
	secretB  string
}

func newServiceIsolationHarness(t *testing.T) *serviceIsolationHarness {
	t.Helper()
	pool := accountTenantIntegrationPool(t)
	queries := sqlc.New(pool)
	tenantRepository := NewTenantRepository(queries)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	webhookRepository := NewWebhookRepository(pool, protector)
	suffix := serviceIsolationID(t).String()
	h := &serviceIsolationHarness{
		t:        t,
		serviceA: "service-a-" + suffix,
		serviceB: "service-b-" + suffix,
		secretA:  "service-a-secret-0123456789abcdef",
		secretB:  "service-b-secret-0123456789abcdef",
	}
	scopes := []authentication.Scope{
		authentication.ScopeTenantsRead,
		authentication.ScopeTenantsWrite,
		authentication.ScopeSpacesRead,
		authentication.ScopeAPIKeysRead,
		authentication.ScopeAPIKeysWrite,
		authentication.ScopeAPIKeysDelete,
		authentication.ScopeWebhooksRead,
		authentication.ScopeWebhooksWrite,
		authentication.ScopeWebhooksDelete,
	}
	options := httpapi.Options{
		ServicePrincipals: []authentication.ServiceCredential{
			{ID: h.serviceA, Secrets: []string{h.secretA}, Scopes: scopes, Dashboard: true},
			{ID: h.serviceB, Secrets: []string{h.secretB}, Scopes: scopes},
		},
		TenantAuthz: authorization.NewTenantPolicy(NewMembershipRepository(queries, pool), tenantRepository),
		Tenants:     tenants.NewService(tenantRepository),
		APIKeys:     apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{}),
		Webhooks:    webhooks.NewService(webhookRepository, protector),
	}
	options.RateLimit.DisableAuthenticated = true
	h.server = httptest.NewServer(httpapi.NewRouter(options))
	t.Cleanup(h.server.Close)
	return h
}

func serviceIsolationID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func (h *serviceIsolationHarness) do(method, path, secret, body string, headers map[string]string) (int, string) {
	h.t.Helper()
	request, err := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	if secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := h.server.Client().Do(request)
	if err != nil {
		h.t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	return response.StatusCode, string(raw)
}

func (h *serviceIsolationHarness) createTenant(secret, name, externalID string) (int, string) {
	h.t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name, "external_id": externalID})
	return h.do(http.MethodPost, "/v1/tenants", secret, string(body), nil)
}

func tenantIDFromBody(t *testing.T, body string) string {
	t.Helper()
	var response struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &response); err != nil || response.ID == "" {
		t.Fatalf("tenant response missing id: %s", body)
	}
	return response.ID
}

func tenantListHas(t *testing.T, body, id string) bool {
	t.Helper()
	var response struct {
		Tenants []struct {
			ID string `json:"id"`
		} `json:"tenants"`
	}
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatalf("tenant list response: %s", body)
	}
	for _, tenant := range response.Tenants {
		if tenant.ID == id {
			return true
		}
	}
	return false
}

func cleanupServiceIsolationTenant(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	for _, statement := range []string{
		`delete from api_key_mutation_requests where tenant_id=$1::uuid`,
		`delete from api_keys where tenant_id=$1::uuid`,
		`delete from tenants where id=$1::uuid`,
	} {
		if _, err := pool.Exec(context.Background(), statement, id); err != nil {
			t.Errorf("cleanup tenant %s: %v", id, err)
		}
	}
}

func TestServicePrincipalsIsolateOwnedTenants(t *testing.T) {
	h := newServiceIsolationHarness(t)
	pool := accountTenantIntegrationPool(t)
	externalID := "tenant-" + serviceIsolationID(t).String()
	createdTenants := make([]string, 0, 2)
	t.Cleanup(func() {
		for _, id := range createdTenants {
			cleanupServiceIsolationTenant(t, pool, id)
		}
	})

	status, body := h.createTenant(h.secretA, "Service A Tenant", externalID)
	if status != http.StatusCreated {
		t.Fatalf("create service A Tenant: %d %s", status, body)
	}
	tenantA := tenantIDFromBody(t, body)
	createdTenants = append(createdTenants, tenantA)

	status, repeatedBody := h.createTenant(h.secretA, "Service A Tenant", externalID)
	if status != http.StatusCreated || tenantIDFromBody(t, repeatedBody) != tenantA {
		t.Fatalf("repeated service A create: %d %s, want Tenant %s", status, repeatedBody, tenantA)
	}

	foreignLookup := "/v1/tenants/by-external-id?external_id=" + url.QueryEscape(externalID)
	status, body = h.do(http.MethodGet, foreignLookup, h.secretB, "", nil)
	if status != http.StatusNotFound {
		t.Fatalf("service B lookup of service A external_id: %d %s, want 404", status, body)
	}

	status, body = h.createTenant(h.secretB, "Service B Tenant", externalID)
	if status != http.StatusCreated {
		t.Fatalf("create service B Tenant with the same external_id: %d %s", status, body)
	}
	tenantB := tenantIDFromBody(t, body)
	if tenantB == tenantA {
		t.Fatal("services received the same Tenant for independently owned external_ids")
	}
	createdTenants = append(createdTenants, tenantB)

	status, body = h.do(http.MethodGet, foreignLookup, h.secretB, "", nil)
	if status != http.StatusOK || tenantIDFromBody(t, body) != tenantB {
		t.Fatalf("service B lookup after create: %d %s, want its own Tenant %s", status, body, tenantB)
	}

	status, body = h.do(http.MethodGet, "/v1/tenants/"+tenantA, h.secretB, "", nil)
	if status != http.StatusForbidden {
		t.Fatalf("service B read of service A Tenant: %d %s, want 403", status, body)
	}

	status, body = h.do(http.MethodGet, "/v1/tenants", h.secretA, "", nil)
	if status != http.StatusOK || !tenantListHas(t, body, tenantA) || tenantListHas(t, body, tenantB) {
		t.Fatalf("service A list: %d %s", status, body)
	}
	status, body = h.do(http.MethodGet, "/v1/tenants", h.secretB, "", nil)
	if status != http.StatusOK || !tenantListHas(t, body, tenantB) || tenantListHas(t, body, tenantA) {
		t.Fatalf("service B list: %d %s", status, body)
	}

	status, body = h.do(http.MethodPatch, "/v1/tenants/"+tenantA, h.secretB, `{"cors_allowed_origins":["https://service-b.example.test"]}`, nil)
	if status != http.StatusForbidden {
		t.Fatalf("service B update of service A Tenant: %d %s, want 403", status, body)
	}
	status, body = h.do(http.MethodPatch, "/v1/tenants/"+tenantA, h.secretA, `{"cors_allowed_origins":["https://service-a.example.test"]}`, nil)
	if status != http.StatusOK {
		t.Fatalf("service A update of its own Tenant: %d %s", status, body)
	}

	expires := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	keyBody := `{"name":"tenant automation","scopes":["spaces:read"],"expires_at":"` + expires + `"}`
	keyHeaders := map[string]string{"Idempotency-Key": "create-key-" + serviceIsolationID(t).String()}
	status, body = h.do(http.MethodPost, "/v1/tenants/"+tenantA+"/api-keys", h.secretB, keyBody, keyHeaders)
	if status != http.StatusForbidden {
		t.Fatalf("service B API-key mint for service A Tenant: %d %s, want 403", status, body)
	}
	keyHeaders = map[string]string{"Idempotency-Key": "create-key-" + serviceIsolationID(t).String()}
	status, body = h.do(http.MethodPost, "/v1/tenants/"+tenantA+"/api-keys", h.secretA, keyBody, keyHeaders)
	if status != http.StatusCreated {
		t.Fatalf("service A API-key mint for its own Tenant: %d %s", status, body)
	}

	webhookBody := `{"name":"tenant automation","url":"https://example.com/hook","enabled":true,"api_version":1,"event_types":["space.created"]}`
	webhookHeaders := map[string]string{"Idempotency-Key": "create-hook-" + serviceIsolationID(t).String()}
	status, body = h.do(http.MethodPost, "/v1/tenants/"+tenantA+"/webhook-endpoints", h.secretB, webhookBody, webhookHeaders)
	if status != http.StatusForbidden {
		t.Fatalf("service B webhook configuration for service A Tenant: %d %s, want 403", status, body)
	}
	webhookHeaders = map[string]string{"Idempotency-Key": "create-hook-" + serviceIsolationID(t).String()}
	status, body = h.do(http.MethodPost, "/v1/tenants/"+tenantA+"/webhook-endpoints", h.secretA, webhookBody, webhookHeaders)
	if status != http.StatusCreated {
		t.Fatalf("service A webhook configuration for its own Tenant: %d %s", status, body)
	}

	status, body = h.do(http.MethodGet, "/v1/tenants", "unknown-service-secret-0123456789", "", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("unknown service secret: %d %s, want 401", status, body)
	}
}
