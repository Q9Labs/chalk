package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/q9labs/chalk/apps/api/internal/accessgrants"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/authorization"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	goredis "github.com/redis/go-redis/v9"
)

type rateLimitTenantRepository struct {
	tenants.TenantRepository
	values map[utilities.ID]tenants.Tenant
	writes int
}

func (r *rateLimitTenantRepository) GetTenant(_ context.Context, id utilities.ID) (tenants.Tenant, error) {
	tenant, ok := r.values[id]
	if !ok {
		return tenants.Tenant{}, tenants.ErrTenantNotFound
	}
	return tenant, nil
}

func (r *rateLimitTenantRepository) UpdateTenant(ctx context.Context, id utilities.ID, _ tenants.UpdateTenantInput) (tenants.Tenant, error) {
	r.writes++
	return r.GetTenant(ctx, id)
}

func serviceRateLimitRouter(t *testing.T, options RateLimitOptions, scopes []authentication.Scope) (http.Handler, *rateLimitTenantRepository, string, []utilities.ID) {
	t.Helper()
	serviceID, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	owner := serviceID.String()
	ids := []utilities.ID{mustTestID(t, "00000000-0000-4000-8000-00000000000a"), mustTestID(t, "00000000-0000-4000-8000-00000000000b")}
	repository := &rateLimitTenantRepository{values: map[utilities.ID]tenants.Tenant{}}
	for _, id := range ids {
		repository.values[id] = tenants.Tenant{ID: id, Name: "Owned", CreatedByServiceID: &owner}
	}
	secret := strings.Repeat("s", 32)
	router := NewRouter(Options{
		ServicePrincipal: authentication.ServiceCredential{ID: owner, Secrets: []string{secret}, Scopes: scopes},
		Tenants:          tenants.NewService(repository), TenantAuthz: authorization.NewTenantPolicy(nil, repository), RateLimit: options,
	})
	return router, repository, secret, ids
}

func rateLimitRequest(router http.Handler, secret, method, tenant, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/v1/tenants/"+tenant, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func testServiceRateLimitBackends(t *testing.T, check func(*testing.T, RateLimitOptions)) {
	t.Helper()
	for _, backend := range []string{"local", "redis"} {
		t.Run(backend, func(t *testing.T) {
			options := DefaultRateLimitOptions()
			options.Now = func() time.Time { return time.Unix(1000, 0) }
			if backend == "redis" {
				rawURL := os.Getenv("CHALK_TEST_REDIS_URL")
				if rawURL == "" {
					t.Skip("CHALK_TEST_REDIS_URL is not set")
				}
				redisOptions, err := goredis.ParseURL(rawURL)
				if err != nil {
					t.Fatal(err)
				}
				client := goredis.NewClient(redisOptions)
				t.Cleanup(func() {
					if err := client.Close(); err != nil {
						t.Error(err)
					}
				})
				options.Limiter = redisadapter.NewRateLimiter(client)
			}
			check(t, options)
		})
	}
}

func TestServiceTenantRateLimitBudgets(t *testing.T) {
	testServiceRateLimitBackends(t, func(t *testing.T, options RateLimitOptions) {
		for _, policy := range []ratelimit.Policy{authenticatedReadRateLimit, authenticatedWriteRateLimit} {
			t.Run(policy.Name, func(t *testing.T) {
				router, repository, secret, ids := serviceRateLimitRouter(t, options, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite})
				method, body := http.MethodGet, ""
				if policy.Name == authenticatedWriteRateLimit.Name {
					method, body = http.MethodPatch, `{"cors_allowed_origins":[]}`
				}
				for _, tenant := range ids {
					for i := 0; i < policy.Limit; i++ {
						if response := rateLimitRequest(router, secret, method, tenant.String(), body); response.Code != http.StatusOK {
							t.Fatalf("tenant %s request %d status = %d: %s", tenant.String(), i+1, response.Code, response.Body.String())
						}
					}
					for _, value := range []string{tenant.String(), strings.ToUpper(tenant.String())} {
						if response := rateLimitRequest(router, secret, method, value, body); response.Code != http.StatusTooManyRequests {
							t.Fatalf("exhausted tenant %s status = %d", value, response.Code)
						}
					}
				}
				if method == http.MethodPatch && repository.writes != 2*policy.Limit {
					t.Fatalf("writes = %d, want %d", repository.writes, 2*policy.Limit)
				}
			})
		}
	})
}

func TestServiceUnownedTenantBurstSharesBudget(t *testing.T) {
	testServiceRateLimitBackends(t, func(t *testing.T, options RateLimitOptions) {
		for _, policy := range []ratelimit.Policy{authenticatedReadRateLimit, authenticatedWriteRateLimit} {
			t.Run(policy.Name, func(t *testing.T) {
				router, repository, secret, owned := serviceRateLimitRouter(t, options, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite})
				method, body := http.MethodGet, ""
				if policy.Name == authenticatedWriteRateLimit.Name {
					method, body = http.MethodPatch, `{"cors_allowed_origins":[]}`
				}
				for i := 0; i < policy.Limit+3; i++ {
					id := mustTestID(t, fmt.Sprintf("00000000-0000-4000-8000-%012x", i+100))
					if i%2 == 0 {
						otherOwner := "another-service"
						repository.values[id] = tenants.Tenant{ID: id, Name: "Foreign", CreatedByServiceID: &otherOwner}
					}
					want := http.StatusForbidden
					if i >= policy.Limit {
						want = http.StatusTooManyRequests
					}
					response := rateLimitRequest(router, secret, method, id.String(), body)
					if response.Code != want {
						t.Fatalf("unowned tenant request %d status = %d, want %d: %s", i+1, response.Code, want, response.Body.String())
					}
					if want == http.StatusTooManyRequests && response.Header().Get(ratelimit.HeaderRetryAfter) == "" {
						t.Fatal("429 is missing Retry-After")
					}
				}
				if repository.writes != 0 {
					t.Fatal("rejected requests reached UpdateTenant")
				}
				if response := rateLimitRequest(router, secret, method, owned[0].String(), body); response.Code != http.StatusOK {
					t.Fatalf("owned tenant was blocked by rejection budget: %d", response.Code)
				}
			})
		}
	})
}

func TestServiceUnverifiedRequestsShareBudget(t *testing.T) {
	testServiceRateLimitBackends(t, func(t *testing.T, options RateLimitOptions) {
		for _, failure := range []struct {
			name, body string
			scopes     []authentication.Scope
			status     int
		}{
			{"missing scope", `{"cors_allowed_origins":[]}`, []authentication.Scope{authentication.ScopeTenantsRead}, http.StatusForbidden},
			{"decode failure", `{`, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite}, http.StatusBadRequest},
		} {
			t.Run(failure.name, func(t *testing.T) {
				router, repository, secret, ids := serviceRateLimitRouter(t, options, failure.scopes)
				for i := 0; i < authenticatedWriteRateLimit.Limit+3; i++ {
					want := failure.status
					if i >= authenticatedWriteRateLimit.Limit {
						want = http.StatusTooManyRequests
					}
					response := rateLimitRequest(router, secret, http.MethodPatch, ids[i%len(ids)].String(), failure.body)
					if response.Code != want {
						t.Fatalf("request %d status = %d, want %d: %s", i+1, response.Code, want, response.Body.String())
					}
				}
				if repository.writes != 0 {
					t.Fatal("unverified request reached UpdateTenant")
				}
			})
		}
	})
}

func TestRateLimitKeys(t *testing.T) {
	id, err := utilities.ParseID("00000000-0000-4000-8000-00000000000a")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name         string
		principal    authentication.Principal
		participant  bool
		tenant, want string
	}{
		{name: "unverified service tenant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: id.String(), want: "principal:service:dashboard"},
		{name: "service global", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, want: "principal:service:dashboard"},
		{name: "service invalid tenant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: "invalid", want: "principal:service:dashboard"},
		{name: "user", principal: authentication.Principal{Kind: authentication.PrincipalUser, UserID: id}, tenant: id.String(), want: "principal:user:" + id.String()},
		{name: "api key", principal: authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: id, TenantID: id}, tenant: id.String(), want: "principal:api_key:" + id.String()},
		{name: "system", principal: authentication.Principal{Kind: authentication.PrincipalSystem}, tenant: id.String(), want: "principal:system"},
		{name: "participant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, participant: true, tenant: id.String(), want: "participant:" + id.String() + ":" + id.String()},
		{name: "ip", tenant: id.String(), want: "ip:192.0.2.1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Get("/tenants/{tenant_id}", func(w http.ResponseWriter, r *http.Request) {
				if got := rateLimitKey(r, ClientIPOptions{}); got != test.want {
					t.Errorf("key = %q, want %q", got, test.want)
				}
			})
			router.Get("/tenants", func(w http.ResponseWriter, r *http.Request) {
				if got := rateLimitKey(r, ClientIPOptions{}); got != test.want {
					t.Errorf("key = %q, want %q", got, test.want)
				}
			})
			path := "/tenants?tenant_id=" + id.String()
			if test.tenant != "" {
				path = "/tenants/" + test.tenant
			}
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.RemoteAddr = "192.0.2.1:1234"
			if test.principal.Kind != "" {
				request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), test.principal))
			}
			if test.participant {
				request = request.WithContext(accessgrants.WithSubject(request.Context(), accessgrants.Subject{TenantID: id, ParticipantID: id}))
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("route status = %d", response.Code)
			}
		})
	}
}
