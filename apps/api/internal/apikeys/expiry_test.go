package apikeys_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

func TestAPIKeyExpiryPolicyThroughPublicAPI(t *testing.T) {
	for _, action := range []string{"create", "rotate"} {
		for _, expiry := range []struct {
			name  string
			ttl   time.Duration
			valid bool
		}{
			{name: "30 days", ttl: 30 * 24 * time.Hour, valid: true},
			{name: "90 days", ttl: 90 * 24 * time.Hour, valid: true},
			{name: "1 year", ttl: apikeys.MaxTTL, valid: true},
			{name: "just over limit", ttl: apikeys.MaxTTL + time.Nanosecond},
			{name: "end of final day", ttl: apikeys.MaxTTL + time.Hour},
			{name: "expired", ttl: -time.Second},
		} {
			t.Run(action+"/"+expiry.name, func(t *testing.T) {
				repository := newRepository()
				service := newService(repository, nil)
				caller, err := service.Create(context.Background(), apikeys.CreateInput{
					TenantID: tenantID, Name: "Issuer", ExpiresAt: testNow.Add(time.Hour),
					Scopes: []authentication.Scope{authentication.ScopeSpacesRead, authentication.ScopeAPIKeysWrite},
				})
				if err != nil {
					t.Fatal(err)
				}
				router := httpapi.NewRouter(httpapi.Options{APIKeys: service, APIKeyAuthentication: service, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
				path := "/v1/tenants/" + tenantID.String() + "/api-keys"
				want := http.StatusCreated
				if action == "rotate" {
					key := createKey(t, service, testNow.Add(time.Hour))
					path += "/" + key.Key.ID.String() + "/rotate"
					want = http.StatusOK
				}
				if !expiry.valid {
					want = http.StatusBadRequest
				}
				body := `{"expires_at":"` + testNow.Add(expiry.ttl).Format(time.RFC3339Nano) + `"}`
				if action == "create" {
					body = `{"name":"Test","scopes":["spaces:read"],"expires_at":"` + testNow.Add(expiry.ttl).Format(time.RFC3339Nano) + `"}`
				}
				request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				request.Header.Set("Authorization", "Bearer "+caller.RawKey)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Idempotency-Key", "expiry-policy-regression")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if response.Code != want {
					t.Fatalf("status=%d want=%d body=%s", response.Code, want, response.Body.String())
				}
				if !expiry.valid {
					var failure struct {
						Error struct {
							Code    string `json:"code"`
							Message string `json:"message"`
						} `json:"error"`
					}
					if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
						t.Fatal(err)
					}
					if failure.Error.Code != "api_key.invalid_expiry" || failure.Error.Message != "API key expiry must be in the future and no more than 365 days from now." {
						t.Fatalf("expiry rejection must explain the policy: %s", response.Body.String())
					}
				}
			})
		}
	}
}
