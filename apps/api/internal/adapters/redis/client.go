package redis

import (
	"fmt"

	goredis "github.com/redis/go-redis/v9"
)

func Open(url string) (*goredis.Client, error) {
	options, err := goredis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	return goredis.NewClient(options), nil
}
