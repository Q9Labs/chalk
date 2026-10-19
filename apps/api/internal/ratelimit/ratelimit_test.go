package ratelimit

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestLocalLimiterPrunesEachPolicy(t *testing.T) {
	limiter := NewLocalLimiter()
	now := time.Unix(1000, 0)
	ceiling := Policy{Name: "read.service_ceiling", Limit: 6000, Window: time.Minute}
	tenant := Policy{Name: "read", Limit: 300, Window: time.Minute}
	for i := 0; i < 4; i++ {
		limiter.Allow(context.Background(), "service", ceiling, now)
		limiter.Allow(context.Background(), fmt.Sprintf("tenant:%d", i), tenant, now)
		now = now.Add(time.Minute)
	}
	if len(limiter.buckets) != 2 {
		t.Fatalf("retained buckets = %d, want only the active ceiling and tenant", len(limiter.buckets))
	}
}
