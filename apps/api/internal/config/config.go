package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

const (
	APIAddress   = "CHALK_API_ADDR"
	APIPprof     = "CHALK_API_PPROF"
	APITraceLogs = "CHALK_API_TRACE_LOGS"

	DatabaseURL      = "CHALK_DATABASE_URL"
	DatabaseMaxConns = "CHALK_DATABASE_MAX_CONNS"
	DatabaseMinConns = "CHALK_DATABASE_MIN_CONNS"

	DefaultAPIAddress  = ":8080"
	DefaultDatabaseURL = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns  = int32(10)
	DefaultDBMinConns  = int32(0)
)

type APIConfig struct {
	Address string
}

type DatabaseConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type ObservabilityConfig struct {
	Pprof     bool
	TraceLogs bool
}

type Config struct {
	API           APIConfig
	Database      DatabaseConfig
	Observability ObservabilityConfig
}

func Load() (Config, error) {
	maxConns, err := envInt32(DatabaseMaxConns, DefaultDBMaxConns)
	if err != nil {
		return Config{}, err
	}

	minConns, err := envInt32(DatabaseMinConns, DefaultDBMinConns)
	if err != nil {
		return Config{}, err
	}

	if maxConns <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", DatabaseMaxConns)
	}
	if minConns < 0 {
		return Config{}, fmt.Errorf("%s must be non-negative", DatabaseMinConns)
	}
	if minConns > maxConns {
		return Config{}, fmt.Errorf("%s cannot be greater than %s", DatabaseMinConns, DatabaseMaxConns)
	}

	return Config{
		API: APIConfig{
			Address: envOrDefault(APIAddress, DefaultAPIAddress),
		},
		Database: DatabaseConfig{
			URL:      envOrDefault(DatabaseURL, DefaultDatabaseURL),
			MaxConns: maxConns,
			MinConns: minConns,
		},
		Observability: ObservabilityConfig{
			Pprof:     envBool(APIPprof),
			TraceLogs: envBool(APITraceLogs),
		},
	}, nil
}

func envOrDefault(name string, fallback string) string {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback
	}

	return value
}

func envInt32(name string, fallback int32) (int32, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}

	return int32(parsed), nil
}

func envBool(name string) bool {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return false
	}

	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
