package redis

import (
	"context"
	"sync"
	"testing"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

type nonceClient struct {
	mu   sync.Mutex
	seen map[string]bool
}

func (c *nonceClient) SetNX(_ context.Context, key string, _ interface{}, _ time.Duration) *goredis.BoolCmd {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen[key] {
		return goredis.NewBoolResult(false, nil)
	}
	c.seen[key] = true
	return goredis.NewBoolResult(true, nil)
}

func TestWorkloadNonceStoreConsumesOnce(t *testing.T) {
	store := newWorkloadNonceStore(&nonceClient{seen: make(map[string]bool)})

	consumed, err := store.Consume(context.Background(), "nonce-1234567890", time.Minute)
	if err != nil || !consumed {
		t.Fatalf("first Consume() = %v, %v; want true, nil", consumed, err)
	}
	consumed, err = store.Consume(context.Background(), "nonce-1234567890", time.Minute)
	if err != nil || consumed {
		t.Fatalf("second Consume() = %v, %v; want false, nil", consumed, err)
	}
}
