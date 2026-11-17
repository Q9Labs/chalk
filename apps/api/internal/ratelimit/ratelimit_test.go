package ratelimit

import (
	"context"
	"testing"
	"time"
)

func TestACostTakesThatManyUnitsAndRefillsInProportion(t *testing.T) {
	limiter := NewLocalLimiter()
	policy := Policy{Name: "bytes", Limit: 1000, Window: 10 * time.Minute, Cost: 400}
	now := time.Unix(1000, 0)

	for range 2 {
		if decision := limiter.Allow(context.Background(), "key", policy, now); decision.State != Allowed {
			t.Fatalf("decision = %+v, want allowed while 400 units are left", decision)
		}
	}
	decision := limiter.Allow(context.Background(), "key", policy, now)
	if decision.State != Exhausted {
		t.Fatalf("decision = %+v, want exhausted with 200 units left", decision)
	}
	// 200 units are missing, and the bucket refills 1000 units in 10 minutes.
	if want := 2 * time.Minute; decision.RetryAfter != want {
		t.Fatalf("retry after = %s, want %s", decision.RetryAfter, want)
	}
	if decision := limiter.Allow(context.Background(), "key", policy, now.Add(2*time.Minute)); decision.State != Allowed {
		t.Fatalf("decision = %+v, want allowed after the wait", decision)
	}
}

func TestACostAboveTheLimitTakesAllOfIt(t *testing.T) {
	policy := Policy{Limit: 100, Window: time.Minute, Cost: 5000}
	if policy.Units() != 100 {
		t.Fatalf("units = %d, want the limit", policy.Units())
	}
	if (Policy{Limit: 100, Window: time.Minute}).Units() != 1 {
		t.Fatal("a policy without a cost must take one unit")
	}
}
