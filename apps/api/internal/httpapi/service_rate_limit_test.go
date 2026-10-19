package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
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
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	goredis "github.com/redis/go-redis/v9"
)

type rateLimitTenantRepository struct {
	tenants.TenantRepository
	values  map[utilities.ID]tenants.Tenant
	writes  int
	reads   int
	readErr error
}

func (r *rateLimitTenantRepository) GetTenant(_ context.Context, id utilities.ID) (tenants.Tenant, error) {
	r.reads++
	if r.readErr != nil {
		return tenants.Tenant{}, r.readErr
	}
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

func TestServiceCeilingStopsOwnershipLookups(t *testing.T) {
	testServiceRateLimitBackends(t, func(t *testing.T, options RateLimitOptions) {
		for _, policy := range []ratelimit.Policy{authenticatedReadRateLimit, authenticatedWriteRateLimit} {
			t.Run(policy.Name, func(t *testing.T) {
				options.ServiceReadCeiling = 4
				options.ServiceWriteCeiling = 4
				router, repository, secret, _ := serviceRateLimitRouter(t, options, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite})
				method, body := http.MethodGet, ""
				if policy.Name == authenticatedWriteRateLimit.Name {
					method, body = http.MethodPatch, `{"cors_allowed_origins":[]}`
				}
				for i := 0; i < 7; i++ {
					id := mustTestID(t, fmt.Sprintf("00000000-0000-4000-8000-%012x", i+100))
					if i%2 == 0 {
						otherOwner := "another-service"
						repository.values[id] = tenants.Tenant{ID: id, Name: "Foreign", CreatedByServiceID: &otherOwner}
					}
					want := http.StatusForbidden
					if i >= 4 {
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
				if repository.reads != 4 {
					t.Fatalf("ownership lookups = %d, want %d", repository.reads, 4)
				}
				if repository.writes != 0 {
					t.Fatal("rejected requests reached UpdateTenant")
				}
			})
		}
	})
}

func TestServiceOwnershipErrorPreservesFailure(t *testing.T) {
	testServiceRateLimitBackends(t, func(t *testing.T, options RateLimitOptions) {
		options.ServiceReadCeiling = 2
		router, repository, secret, ids := serviceRateLimitRouter(t, options, []authentication.Scope{authentication.ScopeTenantsRead})
		repository.readErr = errors.New("ownership repository unavailable")
		var logs bytes.Buffer
		router = observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)))(router)
		for i := 0; i < 4; i++ {
			logs.Reset()
			response := rateLimitRequest(router, secret, http.MethodGet, ids[i%len(ids)].String(), "")
			want := http.StatusInternalServerError
			if i >= 2 {
				want = http.StatusTooManyRequests
			}
			if response.Code != want {
				t.Fatalf("request %d status = %d, want %d: %s", i+1, response.Code, want, response.Body.String())
			}
			logged := strings.Contains(logs.String(), `"event":"http.failure"`) && strings.Contains(logs.String(), repository.readErr.Error())
			if logged != (i < 2) {
				t.Fatalf("request %d failure logging = %t: %s", i+1, logged, logs.String())
			}
		}
		if repository.reads != 2 {
			t.Fatalf("ownership lookups = %d, want 2", repository.reads)
		}
	})
}

func TestServiceCeilingDisabledWithAuthenticatedLimits(t *testing.T) {
	testServiceRateLimitBackends(t, func(t *testing.T, options RateLimitOptions) {
		options.DisableAuthenticated = true
		options.ServiceReadCeiling = 1
		options.ServiceWriteCeiling = 1
		router, _, secret, ids := serviceRateLimitRouter(t, options, []authentication.Scope{authentication.ScopeTenantsRead, authentication.ScopeTenantsWrite})
		for _, method := range []string{http.MethodGet, http.MethodPatch} {
			for i := 0; i < authenticatedReadRateLimit.Limit+1; i++ {
				response := rateLimitRequest(router, secret, method, ids[0].String(), `{"cors_allowed_origins":[]}`)
				if response.Code != http.StatusOK {
					t.Fatalf("%s request %d status = %d", method, i+1, response.Code)
				}
			}
		}
	})
}

type recordingRateLimiter struct {
	keys     []string
	policies []ratelimit.Policy
}

func (l *recordingRateLimiter) Allow(_ context.Context, key string, policy ratelimit.Policy, _ time.Time) ratelimit.Decision {
	l.keys = append(l.keys, key)
	l.policies = append(l.policies, policy)
	return ratelimit.Decision{Allowed: true}
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
		policy       ratelimit.Policy
	}{
		{name: "service tenant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: id.String(), want: "principal:service:dashboard"},
		{name: "service write", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: id.String(), want: "principal:service:dashboard", policy: authenticatedWriteRateLimit},
		{name: "service other policy", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: id.String(), want: "principal:service:dashboard", policy: webhookReadRateLimit},
		{name: "service global", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, want: "principal:service:dashboard"},
		{name: "service invalid tenant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: "invalid", want: "principal:service:dashboard"},
		{name: "user", principal: authentication.Principal{Kind: authentication.PrincipalUser, UserID: id}, tenant: id.String(), want: "principal:user:" + id.String()},
		{name: "api key", principal: authentication.Principal{Kind: authentication.PrincipalAPIKey, APIKeyID: id, TenantID: id}, tenant: id.String(), want: "principal:api_key:" + id.String()},
		{name: "system", principal: authentication.Principal{Kind: authentication.PrincipalSystem}, tenant: id.String(), want: "principal:system"},
		{name: "participant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, participant: true, tenant: id.String(), want: "participant:" + id.String() + ":" + id.String()},
		{name: "ip", tenant: id.String(), want: "ip:192.0.2.1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			limiter := &recordingRateLimiter{}
			options := DefaultRateLimitOptions()
			options.Limiter = limiter
			policy := test.policy
			if policy.Name == "" {
				policy = authenticatedReadRateLimit
			}
			router := chi.NewRouter()
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := rateLimitKey(r, ClientIPOptions{}); got != test.want {
					t.Errorf("base key = %q, want %q", got, test.want)
				}
			})
			router.Method(http.MethodGet, "/tenants/{tenant_id}", rateLimit(options, policy)(handler))
			router.Method(http.MethodGet, "/tenants", rateLimit(options, policy)(handler))
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
			if test.principal.Kind == authentication.PrincipalSystem {
				if len(limiter.keys) != 0 {
					t.Fatal("system principal was limited")
				}
				return
			}
			wantKey := test.want
			wantCalls := 1
			if test.principal.Kind == authentication.PrincipalService && !test.participant && test.tenant == id.String() && (policy.Name == authenticatedReadRateLimit.Name || policy.Name == authenticatedWriteRateLimit.Name) {
				wantKey += ":tenant:" + id.String()
				wantCalls = 2
				wantCeiling := serviceReadCeiling
				if policy.Name == authenticatedWriteRateLimit.Name {
					wantCeiling = serviceWriteCeiling
				}
				if len(limiter.keys) != wantCalls {
					t.Fatalf("keys = %v, want %d calls", limiter.keys, wantCalls)
				}
				if limiter.keys[0] != test.want || limiter.policies[0].Name != policy.Name+".service_ceiling" || limiter.policies[0].Limit != wantCeiling {
					t.Fatalf("wrong service ceiling: %v %v", limiter.keys, limiter.policies)
				}
			}
			if len(limiter.keys) != wantCalls || limiter.keys[len(limiter.keys)-1] != wantKey {
				t.Fatalf("keys = %v, want %d calls ending with %s", limiter.keys, wantCalls, wantKey)
			}

		})
	}
}
