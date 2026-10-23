package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/observability"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestRateLimitOutageRecordsBoundedEvidence(t *testing.T) {
	for _, policy := range []ratelimit.Policy{corsPolicyLookupRateLimit, authenticatedReadRateLimit, authenticatedWriteRateLimit, webhookReadRateLimit,
		{Name: "private-unknown-policy", Limit: 1, Window: time.Minute},
	} {
		for _, malformed := range []bool{false, true} {
			t.Run(policy.Name+map[bool]string{false: "/eval_error", true: "/malformed"}[malformed], func(t *testing.T) {
				ctx := context.Background()
				reader := metric.NewManualReader()
				provider := metric.NewMeterProvider(metric.WithReader(reader))
				previous := otel.GetMeterProvider()
				otel.SetMeterProvider(provider)
				t.Cleanup(func() {
					otel.SetMeterProvider(previous)
					_ = provider.Shutdown(ctx)
				})
				wantPolicy := policy.Name
				if policy.Name == "private-unknown-policy" {
					wantPolicy = "unknown"
				}
				// Service-principal requests also exercise the separate global ceiling.
				if policy.Name == authenticatedReadRateLimit.Name || policy.Name == authenticatedWriteRateLimit.Name {
					wantPolicy += ".service_ceiling"
				}
				failurePolicy := wantPolicy
				if wantPolicy == "unknown" {
					failurePolicy = policy.Name
				}
				options := DefaultRateLimitOptions()
				options.Limiter = redisadapter.NewRateLimiterWithClient(failingReportRedis{policy: failurePolicy, malformed: malformed})
				var logs bytes.Buffer
				router := chi.NewRouter()
				router.Use(observability.RequestMiddleware(slog.New(slog.NewJSONHandler(&logs, nil)), observability.RequestLogConfig{Mode: observability.RequestLogOff}))
				router.With(rateLimit(options, policy)).Get("/tenants/{tenant_id}/spaces", func(http.ResponseWriter, *http.Request) {
					t.Error("unavailable limiter reached the endpoint")
				})
				r := httptest.NewRequest(http.MethodGet, "/tenants/00000000-0000-4000-8000-00000000000a/spaces", nil)
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), authentication.Principal{Kind: authentication.PrincipalService, ServiceID: "private-service-identity"}))
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				if w.Code != http.StatusServiceUnavailable {
					t.Fatalf("status = %d, want 503", w.Code)
				}
				for _, header := range []string{ratelimit.HeaderLimit, ratelimit.HeaderRemaining, ratelimit.HeaderRetryAfter} {
					if w.Header().Get(header) != "" {
						t.Errorf("unavailable limiter returned %s", header)
					}
				}
				var entry struct{ Event, Cause, Policy string }
				if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
					t.Errorf("missing structured outage log: %v", err)
				}
				if entry.Event != "rate_limit.unavailable" || entry.Cause != "limiter_unavailable" || entry.Policy != wantPolicy {
					t.Errorf("outage log = %+v, want bounded policy %q and limiter_unavailable", entry, wantPolicy)
				}
				var metrics metricdata.ResourceMetrics
				if err := reader.Collect(ctx, &metrics); err != nil {
					t.Fatal(err)
				}
				points := 0
				for _, scope := range metrics.ScopeMetrics {
					for _, m := range scope.Metrics {
						if m.Name != "chalk.api.rate_limit.unavailable" {
							continue
						}
						for _, point := range m.Data.(metricdata.Sum[int64]).DataPoints {
							points++
							attrs := map[string]string{}
							for _, attr := range point.Attributes.ToSlice() {
								attrs[string(attr.Key)] = attr.Value.AsString()
							}
							if point.Value != 1 || len(attrs) != 2 || attrs["policy"] != wantPolicy || attrs["cause"] != "limiter_unavailable" {
								t.Errorf("unbounded or incorrect outage metric: %+v", point)
							}
						}
					}
				}
				if points != 1 {
					t.Errorf("outage metric points = %d, want 1", points)
				}
				evidence, err := json.Marshal(metrics)
				if err != nil {
					t.Fatal(err)
				}
				for _, private := range []string{"private-service-identity", "private source error", "private-unknown-policy", "principal:", "00000000-0000-4000-8000-00000000000a"} {
					if strings.Contains(logs.String()+string(evidence), private) {
						t.Errorf("outage evidence contains private limiter input %q", private)
					}
				}
			})
		}
	}
}
