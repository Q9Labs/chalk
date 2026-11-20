package config

import (
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	DatabaseURL                        = "CHALK_DATABASE_URL"
	DatabaseMaxConns                   = "CHALK_DATABASE_MAX_CONNS"
	DatabaseMinConns                   = "CHALK_DATABASE_MIN_CONNS"
	DeadlineSchedulerIntervalMS        = "CHALK_DEADLINE_SCHEDULER_INTERVAL_MS"
	DeadlineSchedulerBatch             = "CHALK_DEADLINE_SCHEDULER_BATCH"
	RedisURL                           = "CHALK_REDIS_URL"
	DefaultDatabaseURL                 = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns                  = int32(10)
	DefaultDBMinConns                  = int32(0)
	DefaultDeadlineSchedulerIntervalMS = int64(1000)
	DefaultDeadlineSchedulerBatch      = int32(50)
	DefaultRedisURL                    = "redis://127.0.0.1:6379/0"
)

type DatabaseConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type RedisConfig struct {
	URL string
}

type DeadlineSchedulerConfig struct {
	Interval time.Duration
	Batch    int32
}

func loadDatabaseSettings() (DatabaseConfig, DeadlineSchedulerConfig, error) {
	maxConns, err := envInt32(DatabaseMaxConns, DefaultDBMaxConns)
	if err != nil {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, err
	}

	minConns, err := envInt32(DatabaseMinConns, DefaultDBMinConns)
	if err != nil {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, err
	}

	if maxConns <= 0 {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, fmt.Errorf("%s must be greater than zero", DatabaseMaxConns)
	}
	if minConns < 0 {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, fmt.Errorf("%s must be non-negative", DatabaseMinConns)
	}
	if minConns > maxConns {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, fmt.Errorf("%s cannot be greater than %s", DatabaseMinConns, DatabaseMaxConns)
	}
	deadlineSchedulerInterval, err := envMilliseconds(DeadlineSchedulerIntervalMS, DefaultDeadlineSchedulerIntervalMS)
	if err != nil {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, err
	}
	deadlineSchedulerBatch, err := envInt32(DeadlineSchedulerBatch, DefaultDeadlineSchedulerBatch)
	if err != nil {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, err
	}
	if deadlineSchedulerInterval <= 0 || deadlineSchedulerBatch <= 0 {
		return DatabaseConfig{}, DeadlineSchedulerConfig{}, fmt.Errorf("deadline scheduler interval and batch must be greater than zero")
	}
	return DatabaseConfig{MaxConns: maxConns, MinConns: minConns}, DeadlineSchedulerConfig{Interval: deadlineSchedulerInterval, Batch: deadlineSchedulerBatch}, nil
}

func validateDatabaseURL(environment string, databaseURL string) error {
	if environment == DefaultEnvironment {
		return nil
	}
	if strings.TrimSpace(databaseURL) == "" || databaseURL == DefaultDatabaseURL {
		return fmt.Errorf("%s must be set outside local environments", DatabaseURL)
	}

	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return fmt.Errorf("%s must be a valid URL: %w", DatabaseURL, err)
	}

	switch strings.ToLower(parsed.Query().Get("sslmode")) {
	case "require", "verify-ca", "verify-full":
		return nil
	default:
		return fmt.Errorf("%s must set sslmode=require, verify-ca, or verify-full outside local environments", DatabaseURL)
	}
}
