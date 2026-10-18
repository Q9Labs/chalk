package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
)

type serviceHTTPResult struct {
	status int
	body   []byte
	err    error
}

func serviceHTTPRequest(client *http.Client, method, target, bearer, body string) serviceHTTPResult {
	request, err := http.NewRequest(method, target, strings.NewReader(body))
	if err != nil {
		return serviceHTTPResult{err: err}
	}
	request.Header.Set("Authorization", "Bearer "+bearer)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "service-principal-integration-"+fmt.Sprint(time.Now().UnixNano()))
	response, err := client.Do(request)
	if err != nil {
		return serviceHTTPResult{err: err}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	return serviceHTTPResult{status: response.StatusCode, body: data, err: err}
}

func TestServicePrincipalHTTPIsolationAndAtomicTenantCreation(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	queries := sqlc.New(pool)
	repository := NewTenantRepository(queries)
	service := tenants.NewService(repository)
	keyService := apikeys.NewService(NewAPIKeyRepository(queries, pool), apikeys.Config{})
	suffix := accountTenantIntegrationID(t).String()
	firstID, secondID := "service-first-"+suffix, "service-second-"+suffix
	oldSecret, newSecret := strings.Repeat("o", 32), strings.Repeat("n", 32)
	scopes := []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite, authentication.ScopeAPIKeysRead, authentication.ScopeAPIKeysWrite, authentication.ScopeAPIKeysDelete}
	server := func(id string, secrets []string, allowed []authentication.Scope) *httptest.Server {
		instance := httptest.NewServer(httpapi.NewRouter(httpapi.Options{
			LocalSystemToken: "local-test-system",
			ServicePrincipal: authentication.ServiceCredential{ID: id, Secrets: secrets, Scopes: allowed},
			Tenants:          service, APIKeys: keyService, APIKeyAuthentication: keyService,
			TenantAuthz: authorization.NewTenantPolicy(nil, repository), RateLimit: httpapi.DefaultRateLimitOptions(),
		}))
		t.Cleanup(instance.Close)
		return instance
	}
	first := server(firstID, []string{oldSecret, newSecret}, scopes)
	second := server(secondID, []string{oldSecret}, scopes)
	disabled := server("", nil, nil)
	var systemID string
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// No shared fixtures are touched; these service IDs belong only to this run.
		for _, query := range []string{
			`delete from api_key_mutation_requests where tenant_id in (select id from tenants where created_by_service_id = any($1::text[]) or id::text = $2)`,
			`delete from api_keys where tenant_id in (select id from tenants where created_by_service_id = any($1::text[]) or id::text = $2)`,
			`delete from tenant_service_ownership_audit where service_id = any($1::text[])`,
			`delete from tenants where created_by_service_id = any($1::text[]) or id::text = $2`,
		} {
			// The audit query has only one argument.
			var err error
			if strings.Contains(query, "$2") {
				_, err = pool.Exec(cleanupCtx, query, []string{firstID, secondID}, systemID)
			} else {
				_, err = pool.Exec(cleanupCtx, query, []string{firstID, secondID})
			}
			if err != nil {
				t.Errorf("cleanup service fixtures: %v", err)
			}
		}
	})
	expect := func(instance *httptest.Server, method, path, secret, body string, status int) []byte {
		t.Helper()
		result := serviceHTTPRequest(instance.Client(), method, instance.URL+path, secret, body)
		if result.err != nil || result.status != status {
			t.Fatalf("%s %s: status=%d error=%v body=%s; want %d", method, path, result.status, result.err, result.body, status)
		}
		return result.body
	}
	tenantID := func(data []byte) string {
		t.Helper()
		var tenant struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(data, &tenant); err != nil || tenant.ID == "" {
			t.Fatalf("invalid Tenant: %s (%v)", data, err)
		}
		return tenant.ID
	}
	externalID := "workos:test:" + suffix
	body := fmt.Sprintf(`{"name":"Original","external_id":%q}`, externalID)
	original := expect(first, "POST", "/v1/tenants", oldSecret, body, http.StatusCreated)
	id := tenantID(original)
	repeated := expect(first, "POST", "/v1/tenants", oldSecret, fmt.Sprintf(`{"name":"Must not replace","external_id":%q}`, externalID), http.StatusCreated)
	if !bytes.Equal(original, repeated) {
		t.Fatalf("repeat changed Tenant: %s / %s", original, repeated)
	}
	policyBody := `{"transcription_ceiling":"on_demand","transcription_default_mode":"on_demand","provider_policy_version":"service-policy"}`
	updated := expect(first, "PATCH", "/v1/tenants/"+id, newSecret, policyBody, http.StatusOK)
	repeated = expect(first, "POST", "/v1/tenants", newSecret, body, http.StatusCreated)
	if !bytes.Equal(updated, repeated) {
		t.Fatalf("repeat replaced policy: %s / %s", updated, repeated)
	}
	otherID := tenantID(expect(second, "POST", "/v1/tenants", oldSecret, body, http.StatusCreated))
	if otherID == id {
		t.Fatal("two service IDs share a Tenant")
	}
	systemID = tenantID(expect(first, "POST", "/v1/tenants", "local-test-system", `{"name":"System-created TH-style Tenant"}`, http.StatusCreated))
	for _, foreign := range []string{otherID, systemID} {
		expect(first, "GET", "/v1/tenants/"+foreign, oldSecret, "", http.StatusForbidden)
		expect(first, "PATCH", "/v1/tenants/"+foreign, oldSecret, `{"name":"Forbidden"}`, http.StatusForbidden)
		expect(first, "GET", "/v1/tenants/"+foreign+"/api-keys", oldSecret, "", http.StatusForbidden)
	}
	listed := expect(first, "GET", "/v1/tenants", oldSecret, "", http.StatusOK)
	if !bytes.Contains(listed, []byte(id)) || bytes.Contains(listed, []byte(otherID)) || bytes.Contains(listed, []byte(systemID)) {
		t.Fatalf("list leaks or misses Tenant: %s", listed)
	}
	for _, instance := range []*httptest.Server{first, second} {
		found := expect(instance, "GET", "/v1/tenants/by-external-id?external_id="+url.QueryEscape(externalID), oldSecret, "", http.StatusOK)
		want := id
		if instance == second {
			want = otherID
		}
		if tenantID(found) != want {
			t.Fatalf("external lookup crossed service boundary")
		}
	}
	expect(second, "GET", "/v1/tenants/by-external-id?external_id=missing-"+suffix, oldSecret, "", http.StatusNotFound)
	expect(first, "POST", "/v1/tenants", oldSecret, `{"name":"Spoof","created_by_service_id":"another-service"}`, http.StatusBadRequest)
	rotated := server(firstID, []string{newSecret}, scopes)
	expect(rotated, "GET", "/v1/tenants/"+id, newSecret, "", http.StatusOK)
	expect(rotated, "GET", "/v1/tenants/"+id, oldSecret, "", http.StatusUnauthorized)
	expect(disabled, "POST", "/v1/tenants", oldSecret, body, http.StatusUnauthorized)
	expect(disabled, "POST", "/v1/tenants", "local-test-system", `{"name":"System external ID is invalid","external_id":"orphan"}`, http.StatusBadRequest)
	limited := server(firstID, []string{oldSecret}, []authentication.Scope{authentication.ScopeTenantsRead})
	expect(limited, "POST", "/v1/tenants", oldSecret, body, http.StatusForbidden)
	expect(limited, "PATCH", "/v1/tenants/"+id, oldSecret, `{"name":"Forbidden"}`, http.StatusForbidden)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	keyBody := fmt.Sprintf(`{"name":"Narrow key","scopes":["tenants:read"],"expires_at":%q}`, expires)
	key := expect(first, "POST", "/v1/tenants/"+id+"/api-keys", oldSecret, keyBody, http.StatusCreated)
	var createdKey struct {
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(key, &createdKey); err != nil || createdKey.Secret == "" {
		t.Fatalf("invalid key: %s", key)
	}
	expect(disabled, "GET", "/v1/tenants/"+id, createdKey.Secret, "", http.StatusOK)
	expect(disabled, "GET", "/v1/tenants/"+otherID, createdKey.Secret, "", http.StatusForbidden)
	keyBody = fmt.Sprintf(`{"name":"Too broad","scopes":["spaces:write"],"expires_at":%q}`, expires)
	expect(first, "POST", "/v1/tenants/"+id+"/api-keys", oldSecret, keyBody, http.StatusForbidden)
	broad := expect(first, "POST", "/v1/tenants/"+id+"/api-keys", "local-test-system", keyBody, http.StatusCreated)
	var broadKey struct {
		APIKey struct {
			ID string `json:"id"`
		} `json:"api_key"`
	}
	if err := json.Unmarshal(broad, &broadKey); err != nil || broadKey.APIKey.ID == "" {
		t.Fatalf("invalid broad key: %s", broad)
	}
	expect(first, "POST", "/v1/tenants/"+id+"/api-keys/"+broadKey.APIKey.ID+"/rotate", oldSecret, `{}`, http.StatusForbidden)

	raceExternal := "concurrent-" + suffix
	raceBody := fmt.Sprintf(`{"name":"Concurrent","external_id":%q}`, raceExternal)
	start := make(chan struct{})
	results := make(chan serviceHTTPResult, 2)
	for range 2 {
		go func() {
			<-start
			results <- serviceHTTPRequest(first.Client(), "POST", first.URL+"/v1/tenants", newSecret, raceBody)
		}()
	}
	close(start)
	one, two := <-results, <-results
	if one.err != nil || two.err != nil || one.status != http.StatusCreated || two.status != http.StatusCreated {
		t.Fatalf("concurrent creation: %+v / %+v", one, two)
	}
	if tenantID(one.body) != tenantID(two.body) {
		t.Fatalf("concurrent calls created different Tenants")
	}
	expect(second, "GET", "/v1/tenants/by-external-id?external_id="+url.QueryEscape(raceExternal), oldSecret, "", http.StatusNotFound)
	var tenantCount, policyCount int
	err := pool.QueryRow(ctx, `select count(*),count(p.tenant_id) from tenants t join tenant_artifact_policies p on p.tenant_id=t.id where t.created_by_service_id=$1 and t.external_id=$2`, firstID, raceExternal).Scan(&tenantCount, &policyCount)
	if err != nil || tenantCount != 1 || policyCount != 1 {
		t.Fatalf("atomic Tenant/policy counts %d/%d, %v", tenantCount, policyCount, err)
	}
}
