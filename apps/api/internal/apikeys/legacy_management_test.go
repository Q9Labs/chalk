package apikeys_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/httpapi"
)

func TestLegacyKeyCanManageOnlyEffectiveScopeSubset(t *testing.T) {
	for _, action := range []string{"rotate", "revoke"} {
		for _, target := range []struct {
			name   string
			extra  authentication.Scope
			status int
		}{
			{name: "retired scopes", status: http.StatusOK},
			{name: "missing surviving scope", extra: authentication.ScopeSpacesWrite, status: http.StatusForbidden},
			{name: "unknown scope", extra: "future:unknown", status: http.StatusForbidden},
		} {
			t.Run(action+"/"+target.name, func(t *testing.T) {
				repository := newRepository()
				service := newService(repository, nil)
				caller, err := service.Create(context.Background(), apikeys.CreateInput{
					TenantID: tenantID, Name: "Legacy caller", ExpiresAt: testNow.Add(time.Hour),
					Scopes: []authentication.Scope{authentication.ScopeSpacesRead, authentication.ScopeAPIKeysWrite, authentication.ScopeAPIKeysDelete},
				})
				if err != nil {
					t.Fatal(err)
				}
				key := createKey(t, service, testNow.Add(time.Hour))
				for _, id := range []string{caller.Key.ID.String(), key.Key.ID.String()} {
					record := repository.records[id]
					record.Scopes = append(slices.Clone(record.Scopes), "integrations:read", "users:write", "audit_logs:read")
					if id == key.Key.ID.String() && target.extra != "" {
						record.Scopes = append(record.Scopes, target.extra)
					}
					repository.records[id] = record
				}
				router := httpapi.NewRouter(httpapi.Options{APIKeys: service, APIKeyAuthentication: service, TenantAuthz: authorization.NewTenantPolicy(nil, nil)})
				method, path := http.MethodPost, "/v1/tenants/"+tenantID.String()+"/api-keys/"+key.Key.ID.String()+"/rotate"
				want := target.status
				if action == "revoke" {
					method, path = http.MethodDelete, strings.TrimSuffix(path, "/rotate")
					if want == http.StatusOK {
						want = http.StatusNoContent
					}
				}
				request := httptest.NewRequest(method, path, strings.NewReader(`{}`))
				request.Header.Set("Authorization", "Bearer "+caller.RawKey)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Idempotency-Key", "legacy-target-rotation")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if response.Code != want {
					t.Fatalf("status=%d want=%d body=%s", response.Code, want, response.Body.String())
				}
				record := repository.records[key.Key.ID.String()]
				if target.status == http.StatusOK {
					if action == "rotate" && record.Prefix == key.Key.Prefix {
						t.Fatal("target credential was not rotated")
					}
					if action == "revoke" && record.RevokedAt == nil {
						t.Fatal("target was not revoked")
					}
				} else if record.Prefix != key.Key.Prefix || record.RevokedAt != nil {
					t.Fatal("forbidden target was mutated")
				}
			})
		}
	}
}

func TestCreateRejectsRetiredAndUnknownScopes(t *testing.T) {
	service := newService(newRepository(), nil)
	for _, scope := range []authentication.Scope{"integrations:read", "users:read", "audit_logs:read", "future:unknown"} {
		_, err := service.Create(context.Background(), apikeys.CreateInput{TenantID: tenantID, Name: "Invalid", Scopes: []authentication.Scope{authentication.ScopeSpacesRead, scope}, ExpiresAt: testNow.Add(time.Hour)})
		if err != apikeys.ErrInvalidScopes {
			t.Fatalf("create %q: %v", scope, err)
		}
	}
}
