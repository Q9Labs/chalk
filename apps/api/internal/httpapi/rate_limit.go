package httpapi

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	defaultAuthRateLimit       = 10
	defaultAuthRateLimitWindow = time.Minute
)

type AuthRateLimitConfig struct {
	Limit  int
	Window time.Duration
	Now    func() time.Time
}

type requestRateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	now     func() time.Time
	buckets map[string]rateLimitBucket
}

type rateLimitBucket struct {
	count   int
	resetAt time.Time
}

func newRequestRateLimiter(config AuthRateLimitConfig) *requestRateLimiter {
	limit := config.Limit
	if limit <= 0 {
		limit = defaultAuthRateLimit
	}
	window := config.Window
	if window <= 0 {
		window = defaultAuthRateLimitWindow
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}

	return &requestRateLimiter{
		limit:   limit,
		window:  window,
		now:     now,
		buckets: make(map[string]rateLimitBucket),
	}
}

func (l *requestRateLimiter) Allow(key string) (time.Duration, bool) {
	if l == nil {
		return 0, true
	}

	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	bucket := l.buckets[key]
	if bucket.resetAt.IsZero() || !now.Before(bucket.resetAt) {
		l.buckets[key] = rateLimitBucket{
			count:   1,
			resetAt: now.Add(l.window),
		}
		l.prune(now)
		return 0, true
	}
	if bucket.count >= l.limit {
		return bucket.resetAt.Sub(now), false
	}

	bucket.count++
	l.buckets[key] = bucket
	return 0, true
}

func (l *requestRateLimiter) prune(now time.Time) {
	for key, bucket := range l.buckets {
		if !now.Before(bucket.resetAt) {
			delete(l.buckets, key)
		}
	}
}

func rateLimitRequests(limiter *requestRateLimiter, route string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			wait, ok := limiter.Allow(route + ":" + identifyRequestClient(r))
			if !ok {
				if wait > 0 {
					seconds := int64(math.Ceil(wait.Seconds()))
					w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
				}
				writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func identifyRequestClient(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	if r.RemoteAddr != "" {
		return r.RemoteAddr
	}
	return "unknown"
}
