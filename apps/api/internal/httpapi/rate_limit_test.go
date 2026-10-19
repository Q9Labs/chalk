package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/config"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

func TestLocalRateLimitsSwitch(t *testing.T) {
	for _, value := range []string{"", "on", "off"} {
		t.Run("value="+value, func(t *testing.T) {
			t.Setenv(config.APIEnvironment, "local")
			t.Setenv(config.APIRateLimits, value)
			cfg, err := config.Load()
			if err != nil {
				t.Fatal(err)
			}
			for _, policy := range []ratelimit.Policy{authenticatedReadRateLimit, authenticatedWriteRateLimit, corsPolicyLookupRateLimit, webhookReadRateLimit} {
				t.Run(policy.Name, func(t *testing.T) {
					options := DefaultRateLimitOptions()
					options.DisableAuthenticated = cfg.API.DisableAuthenticatedRateLimits
					options.Now = func() time.Time { return time.Unix(1000, 0) }
					handler := rateLimit(options, policy)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
					for i := 0; i <= policy.Limit; i++ {
						request := httptest.NewRequest(http.MethodGet, "/", nil)
						request = request.WithContext(authentication.ContextWithPrincipal(request.Context(), authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "dashboard-runtime-proof"}))
						response := httptest.NewRecorder()
						handler.ServeHTTP(response, request)
						want := http.StatusNoContent
						disabled := value == "off" && (policy.Name == ratelimit.PolicyNameAuthenticatedRead || policy.Name == ratelimit.PolicyNameAuthenticatedWrite)
						if i == policy.Limit && !disabled {
							want = http.StatusTooManyRequests
						}
						if response.Code != want {
							t.Fatalf("request %d status = %d, want %d", i+1, response.Code, want)
						}
					}
				})
			}
		})
	}
}
