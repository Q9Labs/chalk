package redis

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type RateLimit struct {
	MaxRequests int
	Window      time.Duration
}

var DefaultWSLimits = map[string]RateLimit{
	"chat.send":     {MaxRequests: 10, Window: 10 * time.Second},
	"reaction.send": {MaxRequests: 5, Window: 5 * time.Second},
	"hand.raise":    {MaxRequests: 2, Window: 10 * time.Second},
}

type WSRateLimiter struct {
	client *Client
	limits map[string]RateLimit
}

func NewWSRateLimiter(client *Client) *WSRateLimiter {
	return &WSRateLimiter{
		client: client,
		limits: DefaultWSLimits,
	}
}

func NewWSRateLimiterWithLimits(client *Client, limits map[string]RateLimit) *WSRateLimiter {
	return &WSRateLimiter{
		client: client,
		limits: limits,
	}
}

func (r *WSRateLimiter) Allow(ctx context.Context, participantID uuid.UUID, action string) bool {
	limit, ok := r.limits[action]
	if !ok {
		return true
	}

	key := fmt.Sprintf("ratelimit:%s:%s", participantID.String(), action)
	return r.tokenBucketAllow(ctx, key, limit.MaxRequests, limit.Window)
}

func (r *WSRateLimiter) tokenBucketAllow(ctx context.Context, key string, maxTokens int, window time.Duration) bool {
	now := time.Now().UnixMilli()
	windowMs := window.Milliseconds()

	script := `
		local key = KEYS[1]
		local max_tokens = tonumber(ARGV[1])
		local window_ms = tonumber(ARGV[2])
		local now = tonumber(ARGV[3])
		
		local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
		local tokens = tonumber(bucket[1])
		local last_refill = tonumber(bucket[2])
		
		if tokens == nil then
			tokens = max_tokens
			last_refill = now
		end
		
		local elapsed = now - last_refill
		local refill_rate = max_tokens / window_ms
		local new_tokens = tokens + (elapsed * refill_rate)
		
		if new_tokens > max_tokens then
			new_tokens = max_tokens
		end
		
		if new_tokens >= 1 then
			new_tokens = new_tokens - 1
			redis.call('HSET', key, 'tokens', new_tokens, 'last_refill', now)
			redis.call('PEXPIRE', key, window_ms * 2)
			return 1
		end
		
		redis.call('HSET', key, 'tokens', new_tokens, 'last_refill', now)
		redis.call('PEXPIRE', key, window_ms * 2)
		return 0
	`

	result, err := r.client.GetClient().Eval(ctx, script, []string{key}, maxTokens, windowMs, now).Int()
	if err != nil {
		return true
	}

	return result == 1
}

func (r *WSRateLimiter) GetLimit(action string) (RateLimit, bool) {
	limit, ok := r.limits[action]
	return limit, ok
}

func (r *WSRateLimiter) SetLimit(action string, limit RateLimit) {
	r.limits[action] = limit
}

func (r *WSRateLimiter) Reset(ctx context.Context, participantID uuid.UUID, action string) error {
	key := fmt.Sprintf("ratelimit:%s:%s", participantID.String(), action)
	return r.client.Del(ctx, key)
}

func (r *WSRateLimiter) ResetAll(ctx context.Context, participantID uuid.UUID) error {
	for action := range r.limits {
		key := fmt.Sprintf("ratelimit:%s:%s", participantID.String(), action)
		if err := r.client.Del(ctx, key); err != nil {
			return err
		}
	}
	return nil
}
