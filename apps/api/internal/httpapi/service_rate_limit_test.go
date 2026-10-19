package httpapi

import (
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
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	goredis "github.com/redis/go-redis/v9"
)

func TestServiceTenantRateLimitBudgets(t *testing.T) {
	for _, backend := range []string{"local", "redis"} {
		t.Run(backend, func(t *testing.T) {
			for _, policy := range []ratelimit.Policy{authenticatedReadRateLimit, authenticatedWriteRateLimit} {
				t.Run(policy.Name, func(t *testing.T) {
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
					serviceID, err := utilities.NewID()
					if err != nil {
						t.Fatal(err)
					}
					principal := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: serviceID.String()}
					router := chi.NewRouter()
					handler := rateLimit(options, policy)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
					router.Method(http.MethodGet, "/tenants/{tenant_id}/spaces", handler)
					requestStatus := func(tenant string) int {
						request := httptest.NewRequest(http.MethodGet, "/tenants/"+tenant+"/spaces", nil)
						request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), principal))
						response := httptest.NewRecorder()
						router.ServeHTTP(response, request)
						return response.Code
					}
					for _, tenant := range []string{"00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"} {
						for i := 0; i < policy.Limit; i++ {
							if status := requestStatus(tenant); status != http.StatusNoContent {
								t.Fatalf("tenant %s request %d status = %d", tenant, i+1, status)
							}
						}
						if status := requestStatus(tenant); status != http.StatusTooManyRequests {
							t.Fatalf("exhausted tenant %s status = %d", tenant, status)
						}
						if status := requestStatus(strings.ToUpper(tenant)); status != http.StatusTooManyRequests {
							t.Fatalf("uppercase tenant %s bypassed budget: %d", tenant, status)
						}
					}
				})
			}
		})
	}
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
		{name: "service tenant", principal: authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard"}, tenant: id.String(), want: "principal:service:dashboard:tenant:" + id.String()},
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
