package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"github.com/q9labs/chalk/apps/api/internal/tenants"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const corsTestTenantID = "11111111-1111-4111-8111-111111111111"

type corsTestContextKey struct{}

func TestObservableCORSOrigin(t *testing.T) {
	for _, test := range []struct {
		name   string
		origin string
		want   string
	}{
		{name: "https host", origin: "https://school.example", want: "https://school.example"},
		{name: "http port", origin: "http://school.example:3000", want: "http://school.example"},
		{name: "uppercase", origin: "HTTPS://SCHOOL.EXAMPLE", want: "https://school.example"},
		{name: "ignores path and query", origin: "https://school.example/path?token=private#fragment", want: "https://school.example"},
		{name: "null", origin: "null", want: "null"},
		{name: "ipv4", origin: "http://10.0.0.5:3000", want: "http://[ip]"},
		{name: "ipv6", origin: "http://[::1]:8080", want: "http://[ip]"},
		{name: "file", origin: "file://x", want: "invalid"},
		{name: "garbage", origin: "not an origin", want: "invalid"},
		{name: "userinfo", origin: "https://user:pw@host", want: "invalid"},
		{name: "oversized host", origin: "https://" + strings.Repeat("a", 254), want: "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := observableCORSOrigin(test.origin); got != test.want {
				t.Fatalf("observableCORSOrigin(%q) = %q, want %q", test.origin, got, test.want)
			}
		})
	}
}

func TestCORSUsesDeploymentPolicyForUnscopedRoute(t *testing.T) {
	response := executeCORSRequest(t, CORSOptions{AllowedOrigins: []string{"https://dashboard.example"}}, http.MethodOptions, "/v1/regions", "https://dashboard.example")
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "https://dashboard.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestCORSForbiddenOriginObservability(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	spans := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(spans))
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
	})

	tracer := provider.Tracer("cors-test")
	middleware := []func(http.Handler) http.Handler{
		func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx, span := tracer.Start(r.Context(), "journey.phase.http")
				defer span.End()
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		},
	}
	path := "/v1/tenants/" + corsTestTenantID + "/spaces/22222222-2222-4222-8222-222222222222/episodes/33333333-3333-4333-8333-333333333333/participants/44444444-4444-4444-8444-444444444444/media/sfu/tracks"
	router := NewRouter(Options{Middleware: middleware, RateLimit: DefaultRateLimitOptions()})
	request := httptest.NewRequest(http.MethodOptions, path, nil)
	request.Header.Set("Origin", "https://school.example")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
	if !strings.Contains(response.Body.String(), `"cors.origin_forbidden"`) {
		t.Fatalf("forbidden response body = %s", response.Body.String())
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("log lines = %d, want 1: %s", len(lines), logs.String())
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &entry); err != nil {
		t.Fatalf("decode warning log: %v", err)
	}
	for key, want := range map[string]string{
		"level":       "WARN",
		"msg":         "CORS origin rejected",
		"event":       "cors.origin_forbidden",
		"cors_origin": "https://school.example",
		"cors_policy": "tenant",
		"http_method": http.MethodOptions,
	} {
		if got := entry[key]; got != want {
			t.Errorf("log %s = %v, want %q", key, got, want)
		}
	}
	if strings.Contains(lines[0], corsTestTenantID) || strings.Contains(lines[0], "/media/sfu/tracks") {
		t.Fatalf("warning log contains request path data: %s", lines[0])
	}

	foundJourney := false
	for _, span := range spans.Ended() {
		if span.Name() != "journey.phase.http" {
			continue
		}
		foundJourney = true
		attributes := make(map[string]string)
		for _, field := range span.Attributes() {
			attributes[string(field.Key)] = field.Value.AsString()
		}
		for key, want := range map[string]string{
			"cors.outcome": "forbidden",
			"cors.policy":  "tenant",
			"cors.origin":  "https://school.example",
		} {
			if got := attributes[key]; got != want {
				t.Errorf("journey span %s = %q, want %q", key, got, want)
			}
		}
	}
	if !foundJourney {
		t.Fatal("journey.phase.http span was not recorded")
	}

	logs.Reset()
	allowedRouter := NewRouter(Options{
		CORS:       CORSOptions{AllowedOrigins: []string{"https://school.example"}},
		Middleware: middleware,
		RateLimit:  DefaultRateLimitOptions(),
	})
	allowedRequest := httptest.NewRequest(http.MethodOptions, "/v1/regions", nil)
	allowedRequest.Header.Set("Origin", "https://school.example")
	allowedRequest.Header.Set("Access-Control-Request-Method", http.MethodGet)
	allowedResponse := httptest.NewRecorder()
	allowedRouter.ServeHTTP(allowedResponse, allowedRequest)
	if allowedResponse.Code != http.StatusNoContent {
		t.Fatalf("allowed status = %d, want %d", allowedResponse.Code, http.StatusNoContent)
	}
	if logs.Len() != 0 {
		t.Fatalf("allowed-origin request logged: %s", logs.String())
	}
}

func TestCORSLogsForbiddenNonPreflightOriginAndContinues(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/tenants/"+corsTestTenantID+"/media", nil)
	request.Header.Set("Origin", "https://school.example")
	response := httptest.NewRecorder()
	allowCORS(CORSOptions{}, DefaultRateLimitOptions())(next).ServeHTTP(response, request)

	if !nextCalled || response.Code != http.StatusNoContent {
		t.Fatalf("next called = %t, status = %d", nextCalled, response.Code)
	}
	if !strings.Contains(logs.String(), `"event":"cors.origin_forbidden"`) {
		t.Fatalf("forbidden non-preflight origin was not logged: %s", logs.String())
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
	limiter := &corsTestLimiter{decision: ratelimit.Decision{State: ratelimit.Exhausted, RetryAfter: time.Second}}
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
