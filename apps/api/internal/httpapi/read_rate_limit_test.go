package httpapi

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
)

func TestGETRoutesNeverUseWriteBudget(t *testing.T) {
	for _, route := range PreviewRouteContracts() {
		if route.Method == http.MethodGet && route.RateLimit.Name == authenticatedWriteRateLimit.Name {
			t.Errorf("GET %s (%s) consumes the authenticated write budget", route.Path, route.OperationID)
		}
	}
}

func TestAdmissionPollingPreservesWriteCapacity(t *testing.T) {
	policy := listPublicAdmissionRequestsEndpoint(nil, nil).contract.RateLimit
	if policy != authenticatedReadRateLimit {
		t.Fatalf("admission list policy = %+v, want authenticated read", policy)
	}
	limiter := ratelimit.NewLocalLimiter()
	ctx, now := context.Background(), time.Now()
	// Two reads per three-second status tick across five pages for a full minute.
	for i := 0; i < 200; i++ {
		if limiter.Allow(ctx, "tenant", policy, now).State != ratelimit.Allowed {
			t.Fatalf("read capacity exhausted at poll %d", i)
		}
	}
	for i := 0; i < authenticatedWriteRateLimit.Limit; i++ {
		if limiter.Allow(ctx, "tenant", authenticatedWriteRateLimit, now).State != ratelimit.Allowed {
			t.Fatalf("polling consumed write capacity: write %d rejected", i)
		}
	}
	if limiter.Allow(ctx, "tenant", authenticatedWriteRateLimit, now).State == ratelimit.Allowed {
		t.Fatal("write limit is not enforced")
	}
}
