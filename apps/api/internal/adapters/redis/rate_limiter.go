package redis

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	goredis "github.com/redis/go-redis/v9"
)

const rateLimitScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local ttl_ms = window_ms * 2

local bucket = redis.call("HMGET", key, "tokens", "observed_ms")
local tokens = tonumber(bucket[1])
local observed_ms = tonumber(bucket[2])

if tokens == nil or observed_ms == nil then
  tokens = limit
  observed_ms = now_ms
end

local elapsed_ms = now_ms - observed_ms
if elapsed_ms > 0 then
  tokens = math.min(limit, tokens + (elapsed_ms * limit / window_ms))
end

local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  retry_ms = math.ceil((1 - tokens) * window_ms / limit)
end

redis.call("HSET", key, "tokens", tokens, "observed_ms", now_ms)
redis.call("PEXPIRE", key, ttl_ms)

return {allowed, math.floor(tokens), retry_ms}
`

type rateLimitScriptClient interface {
	Eval(ctx context.Context, script string, keys []string, args ...any) *goredis.Cmd
}

type RateLimiter struct {
	client rateLimitScriptClient
}

func NewRateLimiter(client *goredis.Client) RateLimiter {
	return RateLimiter{client: client}
}

func NewRateLimiterWithClient(client rateLimitScriptClient) RateLimiter {
	return RateLimiter{client: client}
}

func (l RateLimiter) Allow(ctx context.Context, key string, policy ratelimit.Policy, now time.Time) ratelimit.Decision {
	if l.client == nil || policy.Limit <= 0 || policy.Window <= 0 {
		return ratelimit.Decision{Allowed: true}
	}

	result, err := l.client.Eval(ctx, rateLimitScript, []string{rateLimitKey(policy.Name, key)},
		policy.Limit,
		policy.Window.Milliseconds(),
		now.UnixMilli(),
	).Result()
	if err != nil {
		return ratelimit.Decision{Allowed: false, RetryAfter: time.Second}
	}

	decision, err := parseRateLimitDecision(result)
	if err != nil {
		return ratelimit.Decision{Allowed: false, RetryAfter: time.Second}
	}

	return decision
}

func rateLimitKey(policyName string, key string) string {
	return "rate_limit:" + policyName + ":" + key
}

func parseRateLimitDecision(result any) (ratelimit.Decision, error) {
	values, ok := result.([]any)
	if !ok || len(values) != 3 {
		return ratelimit.Decision{}, fmt.Errorf("unexpected rate limit result: %T", result)
	}

	allowed, err := int64Value(values[0])
	if err != nil {
		return ratelimit.Decision{}, err
	}
	remaining, err := int64Value(values[1])
	if err != nil {
		return ratelimit.Decision{}, err
	}
	retryMS, err := int64Value(values[2])
	if err != nil {
		return ratelimit.Decision{}, err
	}

	return ratelimit.Decision{
		Allowed:    allowed == 1,
		Remaining:  int(remaining),
		RetryAfter: time.Duration(retryMS) * time.Millisecond,
	}, nil
}

func int64Value(value any) (int64, error) {
	switch v := value.(type) {
	case int64:
		return v, nil
	case int:
		return int64(v), nil
	case string:
		parsed, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parse redis integer %q: %w", v, err)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("unexpected redis integer type: %T", value)
	}
}
