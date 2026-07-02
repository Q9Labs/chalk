package redis

import (
	"context"
	"fmt"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
	goredis "github.com/redis/go-redis/v9"
)

type OAuthStateStore struct {
	client *goredis.Client
}

func NewOAuthStateStore(client *goredis.Client) OAuthStateStore {
	return OAuthStateStore{client: client}
}

func Open(url string) (*goredis.Client, error) {
	options, err := goredis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}

	return goredis.NewClient(options), nil
}

func (s OAuthStateStore) SaveOAuthState(ctx context.Context, state string, verifier string, ttl time.Duration) error {
	if err := s.client.Set(ctx, key(state), verifier, ttl).Err(); err != nil {
		return fmt.Errorf("save oauth state: %w", err)
	}

	return nil
}

func (s OAuthStateStore) LoadAndDeleteOAuthState(ctx context.Context, state string) (string, error) {
	verifier, err := s.client.GetDel(ctx, key(state)).Result()
	if err == goredis.Nil {
		return "", authentication.ErrOAuthStateNotFound
	}
	if err != nil {
		return "", fmt.Errorf("load oauth state: %w", err)
	}

	return verifier, nil
}

func key(state string) string {
	return "oauth:state:" + state
}
