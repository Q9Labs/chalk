package redis

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	goredis "github.com/redis/go-redis/v9"
)

type rateLimitClient struct {
	err    error
	keys   []string
	args   []any
	result any
	script string
}

func (c *rateLimitClient) Eval(ctx context.Context, script string, keys []string, args ...any) *goredis.Cmd {
	c.script = script
	c.keys = keys
	c.args = args

	cmd := goredis.NewCmd(ctx)
	if c.err != nil {
		cmd.SetErr(c.err)
		return cmd
	}
	cmd.SetVal(c.result)
	return cmd
}

func TestRateLimiterAllowsFromRedisDecision(t *testing.T) {
	client := &rateLimitClient{
		result: []any{int64(1), int64(4), int64(0)},
	}
	limiter := NewRateLimiterWithClient(client)

	decision := limiter.Allow(context.Background(), "ip:203.0.113.10", ratelimit.Policy{
		Name:   "auth.register",
		Limit:  5,
		Window: time.Minute,
	}, time.UnixMilli(1000))

	if !decision.Allowed {
		t.Fatal("allowed = false, want true")
	}
	if decision.Remaining != 4 {
		t.Fatalf("remaining = %d, want 4", decision.Remaining)
	}
	if len(client.keys) != 1 || client.keys[0] != "rate_limit:auth.register:ip:203.0.113.10" {
		t.Fatalf("keys = %#v, want rate limit key", client.keys)
	}
	if len(client.args) != 3 || client.args[0] != 5 || client.args[1] != int64(time.Minute.Milliseconds()) || client.args[2] != int64(1000) {
		t.Fatalf("args = %#v, want limit/window/now", client.args)
	}
	if client.script == "" {
		t.Fatal("script was empty")
	}
}

func TestRateLimiterRejectsFromRedisDecision(t *testing.T) {
	client := &rateLimitClient{
		result: []any{int64(0), int64(0), int64(2000)},
	}
	limiter := NewRateLimiterWithClient(client)

	decision := limiter.Allow(context.Background(), "ip:203.0.113.10", ratelimit.Policy{
		Name:   "auth.register",
		Limit:  5,
		Window: time.Minute,
	}, time.UnixMilli(1000))

	if decision.Allowed {
		t.Fatal("allowed = true, want false")
	}
	if decision.RetryAfter != 2*time.Second {
		t.Fatalf("retry after = %s, want 2s", decision.RetryAfter)
	}
}

func TestRateLimiterFailsClosed(t *testing.T) {
	limiter := NewRateLimiterWithClient(&rateLimitClient{
		err: errors.New("redis unavailable"),
	})

	decision := limiter.Allow(context.Background(), "ip:203.0.113.10", ratelimit.Policy{
		Name:   "auth.register",
		Limit:  5,
		Window: time.Minute,
	}, time.UnixMilli(1000))

	if decision.Allowed {
		t.Fatal("allowed = true, want false")
	}
	if decision.RetryAfter != time.Second {
		t.Fatalf("retry after = %s, want 1s", decision.RetryAfter)
	}
}
