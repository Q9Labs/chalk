package redis

import (
	"context"
	"errors"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

type WorkloadNonceStore struct {
	client workloadNonceClient
}

type workloadNonceClient interface {
	SetNX(context.Context, string, interface{}, time.Duration) *goredis.BoolCmd
}

func NewWorkloadNonceStore(client *goredis.Client) WorkloadNonceStore {
	return WorkloadNonceStore{client: client}
}

func newWorkloadNonceStore(client workloadNonceClient) WorkloadNonceStore {
	return WorkloadNonceStore{client: client}
}

// Consume atomically records a nonce. The true result means this caller owns
// the nonce; false means another request already consumed it.
func (s WorkloadNonceStore) Consume(ctx context.Context, nonce string, ttl time.Duration) (bool, error) {
	if s.client == nil || nonce == "" || ttl <= 0 {
		return false, errors.New("workload nonce store unavailable")
	}
	return s.client.SetNX(ctx, "workload_nonce:transcription:"+nonce, "1", ttl).Result()
}
