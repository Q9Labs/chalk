package postgres

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/mcpauth"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/webhooks"
)

func TestServicePrincipalTenantIsolation(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	q := sqlc.New(pool)
	tenantRepository := NewTenantRepository(q, pool)
	protector, err := webhooks.NewAESGCMProtector(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	serviceA, serviceB := "service-a-"+accountTenantIntegrationID(t).String(), "service-b-"+accountTenantIntegrationID(t).String()
	const secretA, rotatedA, secretB = "test-service-a-secret", "test-service-a-rotated", "test-service-b-secret"
	scopes := []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite, authentication.ScopeAPIKeysWrite, authentication.ScopeWebhooksWrite}
	options := httpapi.Options{
		Tenants:            tenants.NewService(tenantRepository),
		TenantAuthz:        authorization.NewTenantPolicy(nil, tenantRepository),
		APIKeys:            apikeys.NewService(NewAPIKeyRepository(q, pool), apikeys.Config{}),
		Webhooks:           webhooks.NewService(NewWebhookRepository(pool, protector), protector),
		OAuth:              mcpauth.NewService(NewMCPOAuthRepository(pool), mcpauth.Config{}),
		DashboardServiceID: serviceA,
		ServicePrincipals: []authentication.ServiceCredential{
			{ID: serviceA, Secrets: []string{secretA, rotatedA}, Scopes: scopes},
			{ID: serviceB, Secrets: []string{secretB}, Scopes: scopes},
		},
	}
	options.RateLimit.DisableAuthenticated = true
	router := httpapi.NewRouter(options)
	t.Cleanup(func() {
		ctx := context.Background()
		for _, table := range []string{"api_key_mutation_requests", "api_keys", "tenant_artifact_policies"} {
			if _, err := pool.Exec(ctx, `delete from `+table+` where tenant_id in (select id from tenants where created_by_service_id in ($1,$2))`, serviceA, serviceB); err != nil {
				t.Error(err)
			}
		}
		if _, err := pool.Exec(ctx, `delete from tenants where created_by_service_id in ($1,$2)`, serviceA, serviceB); err != nil {
			t.Error(err)
		}
	})

	do := func(t *testing.T, method, path, token, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "service-isolation-0001")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("%s %s: status=%d, want %d", method, path, response.Code, status)
		}
		return response
	}
	type tenant struct {
		ID string `json:"id"`
	}
	decodeTenant := func(t *testing.T, response *httptest.ResponseRecorder) tenant {
		t.Helper()
		var result tenant
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.ID == "" {
			t.Fatalf("invalid Tenant response: %s (error %v)", response.Body, err)
		}
		return result
	}
	const collection = "/v1/tenants"
	const externalLookup = collection + "/by-external-id?external_id=shared"
	const createBody = `{"name":"Service Tenant","external_id":"shared"}`
	a := decodeTenant(t, do(t, http.MethodPost, collection, secretA, createBody, http.StatusCreated))
	aPath := collection + "/" + a.ID
	t.Run("lookup cannot find another service Tenant", func(t *testing.T) {
		do(t, http.MethodGet, externalLookup, secretB, "", http.StatusNotFound)
	})
	b := decodeTenant(t, do(t, http.MethodPost, collection, secretB, createBody, http.StatusCreated))
	t.Run("services can reuse the same external ID", func(t *testing.T) {
		if found := decodeTenant(t, do(t, http.MethodGet, externalLookup, secretB, "", http.StatusOK)); b.ID == a.ID || found != b {
			t.Fatalf("Tenants for the same external ID: service A=%+v service B=%+v lookup=%+v", a, b, found)
		}
		if replay := decodeTenant(t, do(t, http.MethodPost, collection, rotatedA, createBody, http.StatusCreated)); replay != a {
			t.Fatalf("rotated secret did not resolve to the original Tenant: %+v, want %+v", replay, a)
		}
	})
	t.Run("list excludes another service Tenant", func(t *testing.T) {
		response := do(t, http.MethodGet, collection, secretB, "", http.StatusOK)
		var list struct {
			Tenants []tenant `json:"tenants"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil || !slices.Equal(list.Tenants, []tenant{b}) {
			t.Fatalf("service B's Tenant list=%+v, want only %+v (error %v)", list.Tenants, b, err)
		}
	})
	expires := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	for _, test := range []struct {
		name, method, path, body string
	}{
		{"read", http.MethodGet, aPath, ""},
		{"update", http.MethodPatch, aPath, `{"cors_allowed_origins":["https://example.test"]}`},
		{"mint API key", http.MethodPost, aPath + "/api-keys", `{"name":"Service key","scopes":["tenants:read"],"expires_at":"` + expires + `"}`},
		{"configure webhook", http.MethodPost, aPath + "/webhook-endpoints", `{"name":"Service webhook","url":"https://example.test/events","enabled":true,"api_version":1,"event_types":["participant.joined"]}`},
		{"inspect MCP consent", http.MethodPost, "/v1/mcp-oauth/requests/inspect", `{"request":"pending-request"}`},
		{"approve MCP consent", http.MethodPost, "/v1/mcp-oauth/requests/approve", `{"request":"pending-request","tenant_id":"` + b.ID + `","scope":"spaces:read"}`},
		{"deny MCP consent", http.MethodPost, "/v1/mcp-oauth/requests/deny", `{"request":"pending-request"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			do(t, test.method, test.path, secretB, test.body, http.StatusForbidden)
		})
	}
	t.Run("unknown secret", func(t *testing.T) {
		do(t, http.MethodGet, aPath, "test-service-unknown-secret", "", http.StatusUnauthorized)
	})
}
