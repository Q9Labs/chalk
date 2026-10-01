package httpapi

import (
	"context"
	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	"testing"
	"time"
)

func TestEpisodeHistoryReadsDoNotExhaustMutationBudget(t *testing.T) {
	endpoint := listEpisodesEndpoint(nil, nil)
	if endpoint.contract.RateLimit.Name != "v1.authenticated.read" {
		t.Fatalf("history policy = %s", endpoint.contract.RateLimit.Name)
	}
	limiter := ratelimit.NewLocalLimiter()
	now := time.Now()
	for i := 0; i < 180; i++ {
		if !limiter.Allow(context.Background(), "account", endpoint.contract.RateLimit, now).Allowed {
			t.Fatalf("normal 30-Space history view throttled at request %d", i)
		}
	}
	if !limiter.Allow(context.Background(), "account", authenticatedWriteRateLimit, now).Allowed {
		t.Fatal("reads consumed write budget")
	}
}
