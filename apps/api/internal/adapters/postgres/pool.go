package postgres

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

const (
	defaultMaxConnIdleTime = 30 * time.Minute
	defaultHealthCheck     = time.Minute
	defaultPingTimeout     = 5 * time.Second
	startRetryMin          = time.Second
	startRetryMax          = 15 * time.Second
)

// Open returns a pool once Postgres answers. A database that is away at start (a sleeping or failing-over
// instance) is waited for with a capped backoff until ctx ends, instead of exiting and leaving the supervisor
// to give up after its start limit. A bad configuration still fails at once.
func Open(ctx context.Context, cfg config.DatabaseConfig) (*pgxpool.Pool, error) {
	poolConfig, err := PoolConfig(cfg)
	if err != nil {
		return nil, err
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}

	for delay := startRetryMin; ; delay = min(delay*2, startRetryMax) {
		pingCtx, cancel := context.WithTimeout(ctx, defaultPingTimeout)
		err := pool.Ping(pingCtx)
		cancel()
		if err == nil {
			return pool, nil
		}
		if ctx.Err() != nil {
			pool.Close()
			return nil, fmt.Errorf("ping postgres: %w", ctx.Err())
		}
		// The error text can carry the host, so only its class is logged.
		slog.Warn("postgres unavailable at start; retrying", "event", "postgres.unavailable_at_start", "error_class", fmt.Sprintf("%T", err), "retry_in", delay.String())
		select {
		case <-ctx.Done():
			pool.Close()
			return nil, fmt.Errorf("ping postgres: %w", ctx.Err())
		case <-time.After(delay):
		}
	}
}

func PoolConfig(cfg config.DatabaseConfig) (*pgxpool.Config, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("parse postgres url: %w", err)
	}

	if cfg.MaxConns <= 0 {
		return nil, fmt.Errorf("postgres max conns must be greater than zero")
	}
	if cfg.MinConns < 0 {
		return nil, fmt.Errorf("postgres min conns must be non-negative")
	}
	if cfg.MinConns > cfg.MaxConns {
		return nil, fmt.Errorf("postgres min conns cannot be greater than max conns")
	}

	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MinConns = cfg.MinConns
	poolConfig.MaxConnIdleTime = defaultMaxConnIdleTime
	poolConfig.HealthCheckPeriod = defaultHealthCheck

	return poolConfig, nil
}
