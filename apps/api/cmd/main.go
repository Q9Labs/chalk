package main

import (
	"context"
	"fmt"
	"os"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	redisadapter "github.com/q9labs/chalk/apps/api/internal/adapters/redis"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "api: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	obs, stopTelemetry, err := startObservability(cfg)
	if err != nil {
		return err
	}
	defer stopTelemetry()

	pool, err := postgres.Open(context.Background(), cfg.Database)
	if err != nil {
		return fmt.Errorf("open postgres: %w", err)
	}
	defer pool.Close()
	obs.logger.Info("postgres connected", "event", "postgres.connected")

	w := &wiring{cfg: cfg, obs: obs, pool: pool}
	if cfg.Transcription.WorkloadAuthSecret != "" || cfg.Observability.Environment != config.DefaultEnvironment {
		w.redis, err = redisadapter.Open(cfg.Redis.URL)
		if err != nil {
			return fmt.Errorf("open redis: %w", err)
		}
		defer w.redis.Close()
		obs.logger.Info("redis connected", "event", "redis.connected")
	}
	if err := w.build(); err != nil {
		return err
	}
	return w.serve()
}
