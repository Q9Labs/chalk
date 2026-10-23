package redis

import (
	"context"
	"errors"
	"math"
	"net"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/ratelimit"
	goredis "github.com/redis/go-redis/v9"
)

type rateLimitReply struct {
	value any
	err   error
}

func (r rateLimitReply) Eval(ctx context.Context, _ string, _ []string, _ ...any) *goredis.Cmd {
	cmd := goredis.NewCmd(ctx)
	cmd.SetVal(r.value)
	cmd.SetErr(r.err)
	return cmd
}

func TestRateLimiterStates(t *testing.T) {
	policy := ratelimit.Policy{Name: "test", Limit: 3, Window: time.Hour}
	for _, tc := range []struct {
		name  string
		reply rateLimitReply
		want  ratelimit.State
	}{
		{"allowed", rateLimitReply{value: []any{int64(1), int64(2), int64(0)}}, ratelimit.Allowed},
		{"exhausted", rateLimitReply{value: []any{int64(0), int64(0), int64(1200000)}}, ratelimit.Exhausted},
		{"eval_failure", rateLimitReply{err: errors.New("Redis EVAL failed")}, ratelimit.Unavailable},
		{"malformed", rateLimitReply{value: "not an array"}, ratelimit.Unavailable},
		{"invalid_flag", rateLimitReply{value: []any{int64(2), int64(0), int64(0)}}, ratelimit.Unavailable},
		{"negative_remaining", rateLimitReply{value: []any{int64(1), int64(-1), int64(0)}}, ratelimit.Unavailable},
		{"retry_overflow", rateLimitReply{value: []any{int64(0), int64(0), int64(math.MaxInt64)}}, ratelimit.Unavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := NewRateLimiterWithClient(tc.reply).Allow(context.Background(), "test", policy, time.Now())
			if got.State != tc.want {
				t.Fatalf("state=%v want=%v", got.State, tc.want)
			}
		})
	}
	// Exercise the real go-redis EVAL path with an unavailable transport, without
	// needing a local Redis daemon or allowing retries to stall this light test.
	client := goredis.NewClient(&goredis.Options{
		Addr: "unused:6379", MaxRetries: -1,
		Dialer: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("simulated Redis transport outage")
		},
	})
	t.Cleanup(func() { _ = client.Close() })
	if got := NewRateLimiter(client).Allow(context.Background(), "test", policy, time.Now()); got.State != ratelimit.Unavailable {
		t.Fatalf("disconnected Redis state=%v", got.State)
	}
}
