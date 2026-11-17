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
	// Cost is how many of the Limit units one charge takes, such as the bytes of
	// one request. Zero means one unit, and a Cost above Limit takes all of it.
	Cost int
}

// Units returns the units one charge takes, between one and Limit.
func (p Policy) Units() int {
	return min(max(p.Cost, 1), max(p.Limit, 1))
}

type Limiter interface {
	Allow(ctx context.Context, key string, policy Policy, now time.Time) Decision
}

type State uint8

const (
	Unavailable State = iota
	Allowed
	Exhausted
)

type Decision struct {
	State      State
	Remaining  int
	RetryAfter time.Duration
}

type LocalLimiter struct {
	mu       sync.Mutex
	buckets  map[string]localBucket
	prunedAt map[string]time.Time
}

type localBucket struct {
	Tokens     float64
	ObservedAt time.Time
}

func NewLocalLimiter() *LocalLimiter {
	return &LocalLimiter{
		buckets:  make(map[string]localBucket),
		prunedAt: make(map[string]time.Time),
	}
}

func (l *LocalLimiter) Allow(ctx context.Context, key string, policy Policy, now time.Time) Decision {
	_ = ctx
	if policy.Limit <= 0 || policy.Window <= 0 {
		return Decision{State: Allowed}
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

	units := float64(policy.Units())
	if bucket.Tokens < units {
		l.buckets[mapKey] = bucket
		return Decision{
			State:      Exhausted,
			Remaining:  0,
			RetryAfter: RetryAfter(bucket.Tokens, policy),
		}
	}

	bucket.Tokens -= units
	l.buckets[mapKey] = bucket

	return Decision{
		State:     Allowed,
		Remaining: int(math.Floor(bucket.Tokens)),
	}
}

func (l *LocalLimiter) pruneColdBuckets(policy Policy, now time.Time) {
	if prunedAt := l.prunedAt[policy.Name]; !prunedAt.IsZero() && now.Sub(prunedAt) < policy.Window {
		return
	}

	prefix := policy.Name + ":"
	for key, bucket := range l.buckets {
		if strings.HasPrefix(key, prefix) && now.Sub(bucket.ObservedAt) >= policy.Window {
			delete(l.buckets, key)
		}
	}

	l.prunedAt[policy.Name] = now
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
	missingTokens := float64(policy.Units()) - tokens
	if missingTokens <= 0 {
		return 0
	}

	seconds := missingTokens * policy.Window.Seconds() / float64(policy.Limit)
	return time.Duration(math.Ceil(seconds)) * time.Second
}
