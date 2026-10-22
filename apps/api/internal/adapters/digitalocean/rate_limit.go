package digitalocean

import (
	"net/http"
	"strconv"
	"time"
)

type RateLimitSnapshot struct {
	Requests   uint64
	Remaining  *uint64
	Limit      *uint64
	ResetAt    time.Time
	ObservedAt time.Time
}

func (a *RecorderFleet) RateLimitSnapshot() RateLimitSnapshot {
	a.rateLimitMu.Lock()
	defer a.rateLimitMu.Unlock()
	return a.rateLimit
}

func (a *RecorderFleet) observeResponse(header http.Header, now time.Time) {
	a.rateLimitMu.Lock()
	defer a.rateLimitMu.Unlock()
	a.rateLimit.Remaining = rateLimitNumber(header.Get("RateLimit-Remaining"))
	a.rateLimit.Limit = rateLimitNumber(header.Get("RateLimit-Limit"))
	a.rateLimit.ResetAt = rateLimitReset(header.Get("RateLimit-Reset"))
	a.rateLimit.ObservedAt = now
}

func rateLimitNumber(value string) *uint64 {
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func rateLimitReset(value string) time.Time {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

// DigitalOcean sends Retry-After only on burst 429s, and those can also report
// zero remaining, so a valid Retry-After wins. RateLimit-Reset is the fallback
// for an exhausted allowance without one.
func retryDeadline(header http.Header, now time.Time) time.Time {
	deadline, ok := retryAfter(header.Get("Retry-After"), now)
	if !ok {
		if remaining := rateLimitNumber(header.Get("RateLimit-Remaining")); remaining != nil && *remaining == 0 {
			deadline = rateLimitReset(header.Get("RateLimit-Reset"))
		}
	}
	if !deadline.After(now) {
		return time.Time{}
	}
	return deadline
}

func retryAfter(value string, now time.Time) (time.Time, bool) {
	if seconds, err := strconv.ParseUint(value, 10, 63); err == nil && seconds <= uint64((1<<63-1)/int64(time.Second)) {
		return now.Add(time.Duration(seconds) * time.Second), true
	}
	if retry, err := http.ParseTime(value); err == nil {
		return retry, true
	}
	return time.Time{}, false
}
