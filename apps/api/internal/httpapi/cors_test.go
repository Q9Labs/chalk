package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

const corsTestTenantID = "11111111-1111-4111-8111-111111111111"

type corsTestContextKey struct{}

func TestCORSUsesDeploymentPolicyForUnscopedRoute(t *testing.T) {
	response := executeCORSRequest(t, CORSOptions{AllowedOrigins: []string{"https://dashboard.example"}}, http.MethodOptions, "/v1/regions", "https://dashboard.example")
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "https://dashboard.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestCORSUsesTenantPolicyInAdditionToExactDeploymentOrigins(t *testing.T) {
	authorizer := &corsTestTenantAuthorizer{allowed: map[string]map[string]bool{
		corsTestTenantID: {"http://localhost:3070": true},
	}}
	options := CORSOptions{AllowedOrigins: []string{"https://dashboard.example"}, TenantOrigins: authorizer}

	allowed := executeCORSRequest(t, options, http.MethodOptions, "/v1/tenants/"+corsTestTenantID+"/spaces", "http://localhost:3070")
	if allowed.Code != http.StatusNoContent {
		t.Fatalf("allowed status = %d, want %d", allowed.Code, http.StatusNoContent)
	}
	if got := allowed.Header().Get("Access-Control-Max-Age"); got != "60" {
		t.Fatalf("Tenant Access-Control-Max-Age = %q, want 60", got)
	}
	firstParty := executeCORSRequest(t, options, http.MethodOptions, "/v1/tenants/"+corsTestTenantID+"/spaces", "https://dashboard.example")
	if firstParty.Code != http.StatusNoContent {
		t.Fatalf("first-party deployment origin status = %d, want %d", firstParty.Code, http.StatusNoContent)
	}
	wrongPort := executeCORSRequest(t, options, http.MethodOptions, "/v1/tenants/"+corsTestTenantID+"/spaces", "http://localhost:3071")
	if wrongPort.Code != http.StatusForbidden {
		t.Fatalf("wrong localhost port status = %d, want %d", wrongPort.Code, http.StatusForbidden)
	}
}

func TestCORSDoesNotApplyDeploymentWildcardToTenantRoute(t *testing.T) {
	response := executeCORSRequest(t, CORSOptions{AllowedOrigins: []string{"*"}, TenantOrigins: &corsTestTenantAuthorizer{}}, http.MethodOptions, "/v1/tenants/"+corsTestTenantID+"/spaces", "https://customer.example")
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestCORSDoesNotSharePolicyAcrossTenants(t *testing.T) {
	secondTenantID := "22222222-2222-4222-8222-222222222222"
	authorizer := &corsTestTenantAuthorizer{allowed: map[string]map[string]bool{
		corsTestTenantID: {"https://first.example": true},
		secondTenantID:   {"https://second.example": true},
	}}
	response := executeCORSRequest(t, CORSOptions{TenantOrigins: authorizer}, http.MethodOptions, "/v1/tenants/"+secondTenantID+"/spaces", "https://first.example")
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestCORSPolicyLookupFailureFailsClosed(t *testing.T) {
	authorizer := &corsTestTenantAuthorizer{err: errors.New("database unavailable")}
	response := executeCORSRequest(t, CORSOptions{TenantOrigins: authorizer}, http.MethodGet, "/v1/tenants/"+corsTestTenantID+"/spaces", "https://app.example")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestCORSPolicyLookupReceivesOuterMiddlewareContext(t *testing.T) {
	authorizer := &corsTestTenantAuthorizer{}
	middleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), corsTestContextKey{}, true)))
		})
	}
	router := NewRouter(Options{
		CORS:       CORSOptions{TenantOrigins: authorizer},
		Middleware: []func(http.Handler) http.Handler{middleware},
		RateLimit:  DefaultRateLimitOptions(),
	})
	request := httptest.NewRequest(http.MethodOptions, "/v1/tenants/"+corsTestTenantID+"/spaces", nil)
	request.Header.Set("Origin", "https://app.example")
	request.Header.Set("Access-Control-Request-Method", http.MethodGet)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if !authorizer.receivedMiddlewareContext {
		t.Fatal("Tenant authorizer did not receive outer middleware context")
	}
}

func TestCORSPolicyLookupIsRateLimitedBeforeTenantAuthorizer(t *testing.T) {
	authorizer := &corsTestTenantAuthorizer{}
	limiter := &corsTestLimiter{decision: ratelimit.Decision{Allowed: false, RetryAfter: time.Second}}
	response := executeCORSRequestWithRateLimits(t, CORSOptions{TenantOrigins: authorizer}, RateLimitOptions{Limiter: limiter}, http.MethodOptions, "/v1/tenants/"+corsTestTenantID+"/spaces", "https://app.example")
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusTooManyRequests)
	}
	if authorizer.calls != 0 {
		t.Fatalf("Tenant authorizer calls = %d, want 0", authorizer.calls)
	}
	if limiter.calls != 1 {
		t.Fatalf("rate limiter calls = %d, want 1", limiter.calls)
	}
}

func TestCORSRejectsInvalidTenantPath(t *testing.T) {
	response := executeCORSRequest(t, CORSOptions{TenantOrigins: &corsTestTenantAuthorizer{}}, http.MethodOptions, "/v1/tenants/not-an-id/spaces", "https://app.example")
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestTenantResponseKeepsEmptyCORSAllowlistAsArray(t *testing.T) {
	response := newTenantResponse(tenants.Tenant{})
	if response.CORSAllowedOrigins == nil {
		t.Fatal("CORSAllowedOrigins is nil, want an empty JSON array")
	}
}

func executeCORSRequest(t *testing.T, options CORSOptions, method string, path string, origin string) *httptest.ResponseRecorder {
	return executeCORSRequestWithRateLimits(t, options, DefaultRateLimitOptions(), method, path, origin)
}

func executeCORSRequestWithRateLimits(t *testing.T, options CORSOptions, rateLimits RateLimitOptions, method string, path string, origin string) *httptest.ResponseRecorder {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	request := httptest.NewRequest(method, path, nil)
	request.Header.Set("Origin", origin)
	request.Header.Set("Access-Control-Request-Method", http.MethodGet)
	response := httptest.NewRecorder()
	allowCORS(options, rateLimits)(next).ServeHTTP(response, request)
	return response
}

type corsTestTenantAuthorizer struct {
	allowed                   map[string]map[string]bool
	err                       error
	calls                     int
	receivedMiddlewareContext bool
}

func (a *corsTestTenantAuthorizer) AllowsOrigin(ctx context.Context, tenantID utilities.ID, origin string) (bool, error) {
	a.calls++
	a.receivedMiddlewareContext, _ = ctx.Value(corsTestContextKey{}).(bool)
	if a.err != nil {
		return false, a.err
	}
	return a.allowed[tenantID.String()][origin], nil
}

type corsTestLimiter struct {
	decision ratelimit.Decision
	calls    int
}

func (l *corsTestLimiter) Allow(context.Context, string, ratelimit.Policy, time.Time) ratelimit.Decision {
	l.calls++
	return l.decision
}
