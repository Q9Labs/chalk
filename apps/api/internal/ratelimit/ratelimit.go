package ratelimit

import (
	"context"
	"math"
	"strings"
	"sync"
	"time"
)

type Policy struct {
	Name   string
	Limit  int
	Window time.Duration
}

type Limiter interface {
	Allow(ctx context.Context, key string, policy Policy, now time.Time) Decision
}

type Decision struct {
	Allowed    bool
	Remaining  int
	RetryAfter time.Duration
}

type LocalLimiter struct {
	mu       sync.Mutex
	buckets  map[string]localBucket
	prunedAt time.Time
}

type localBucket struct {
	Tokens     float64
	ObservedAt time.Time
}

func NewLocalLimiter() *LocalLimiter {
	return &LocalLimiter{
		buckets: make(map[string]localBucket),
	}
}

func (l *LocalLimiter) Allow(ctx context.Context, key string, policy Policy, now time.Time) Decision {
	_ = ctx
	if policy.Limit <= 0 || policy.Window <= 0 {
		return Decision{Allowed: true}
	}

	mapKey := policy.Name + ":" + key
	l.mu.Lock()
	defer l.mu.Unlock()

	l.pruneColdBuckets(policy, now)

	bucket, ok := l.buckets[mapKey]
	if !ok {
		bucket = localBucket{
			Tokens:     float64(policy.Limit),
			ObservedAt: now,
		}
	}

	bucket.Tokens = refillBucket(bucket, policy, now)
	bucket.ObservedAt = now

	if bucket.Tokens < 1 {
		l.buckets[mapKey] = bucket
		return Decision{
			Allowed:    false,
			Remaining:  0,
			RetryAfter: RetryAfter(bucket.Tokens, policy),
		}
	}

	bucket.Tokens--
	l.buckets[mapKey] = bucket

	return Decision{
		Allowed:   true,
		Remaining: int(math.Floor(bucket.Tokens)),
	}
}

func (l *LocalLimiter) pruneColdBuckets(policy Policy, now time.Time) {
	if !l.prunedAt.IsZero() && now.Sub(l.prunedAt) < policy.Window {
		return
	}

	prefix := policy.Name + ":"
	for key, bucket := range l.buckets {
		if strings.HasPrefix(key, prefix) && now.Sub(bucket.ObservedAt) >= policy.Window {
			delete(l.buckets, key)
		}
	}

	l.prunedAt = now
}

func refillBucket(bucket localBucket, policy Policy, now time.Time) float64 {
	elapsed := now.Sub(bucket.ObservedAt)
	if elapsed <= 0 {
		return bucket.Tokens
	}

	refill := elapsed.Seconds() * float64(policy.Limit) / policy.Window.Seconds()
	return math.Min(float64(policy.Limit), bucket.Tokens+refill)
}

func RetryAfter(tokens float64, policy Policy) time.Duration {
	missingTokens := 1 - tokens
	if missingTokens <= 0 {
		return 0
	}

	seconds := missingTokens * policy.Window.Seconds() / float64(policy.Limit)
	return time.Duration(math.Ceil(seconds)) * time.Second
}
