package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	APIAddress            = "CHALK_API_ADDR"
	APICORSAllowedOrigins = "CHALK_API_CORS_ALLOWED_ORIGINS"
	APIEnvironment        = "CHALK_API_ENV"
	APILogFormat          = "CHALK_API_LOG_FORMAT"
	APILogLevel           = "CHALK_API_LOG_LEVEL"
	APIPprof              = "CHALK_API_PPROF"
	APIRequestLogs        = "CHALK_API_REQUEST_LOGS"
	APIRequestSampleRate  = "CHALK_API_REQUEST_SAMPLE_RATE"
	APIService            = "CHALK_API_SERVICE"
	APISlowRequestMS      = "CHALK_API_SLOW_REQUEST_MS"
	APITraceLogs          = "CHALK_API_TRACE_LOGS"
	APIVersion            = "CHALK_API_VERSION"

	DatabaseURL      = "CHALK_DATABASE_URL"
	DatabaseMaxConns = "CHALK_DATABASE_MAX_CONNS"
	DatabaseMinConns = "CHALK_DATABASE_MIN_CONNS"

	DefaultAPIAddress        = ":8080"
	DefaultDatabaseURL       = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns        = int32(10)
	DefaultDBMinConns        = int32(0)
	DefaultEnvironment       = "local"
	DefaultLogFormat         = "json"
	DefaultLogLevel          = "info"
	DefaultRequestLogs       = "off"
	DefaultRequestSampleRate = 0.01
	DefaultServiceName       = "chalk-api"
	DefaultSlowRequestMS     = int64(250)
	DefaultVersion           = "dev"
)

type APIConfig struct {
	Address            string
	CORSAllowedOrigins []string
}

type DatabaseConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type ObservabilityConfig struct {
	Environment          string
	LogFormat            string
	LogLevel             string
	Pprof                bool
	RequestLogs          string
	RequestSampleRate    float64
	Service              string
	SlowRequestThreshold time.Duration
	TraceLogs            bool
	Version              string
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

	logFormat, err := envEnum(APILogFormat, DefaultLogFormat, "json", "text")
	if err != nil {
		return Config{}, err
	}
	logLevel, err := envEnum(APILogLevel, DefaultLogLevel, "debug", "info", "warn", "error")
	if err != nil {
		return Config{}, err
	}
	traceLogs := envBool(APITraceLogs)
	requestLogs, err := envRequestLogs(traceLogs)
	if err != nil {
		return Config{}, err
	}
	requestSampleRate, err := envFloat64(APIRequestSampleRate, DefaultRequestSampleRate)
	if err != nil {
		return Config{}, err
	}
	if requestSampleRate < 0 || requestSampleRate > 1 {
		return Config{}, fmt.Errorf("%s must be between 0 and 1", APIRequestSampleRate)
	}
	slowRequestThreshold, err := envMilliseconds(APISlowRequestMS, DefaultSlowRequestMS)
	if err != nil {
		return Config{}, err
	}
	if slowRequestThreshold < 0 {
		return Config{}, fmt.Errorf("%s must be non-negative", APISlowRequestMS)
	}

	return Config{
		API: APIConfig{
			Address:            envOrDefault(APIAddress, DefaultAPIAddress),
			CORSAllowedOrigins: envList(APICORSAllowedOrigins),
		},
		Database: DatabaseConfig{
			URL:      envOrDefault(DatabaseURL, DefaultDatabaseURL),
			MaxConns: maxConns,
			MinConns: minConns,
		},
		Observability: ObservabilityConfig{
			Environment:          envOrDefault(APIEnvironment, DefaultEnvironment),
			LogFormat:            logFormat,
			LogLevel:             logLevel,
			Pprof:                envBool(APIPprof),
			RequestLogs:          requestLogs,
			RequestSampleRate:    requestSampleRate,
			Service:              envOrDefault(APIService, DefaultServiceName),
			SlowRequestThreshold: slowRequestThreshold,
			TraceLogs:            traceLogs,
			Version:              envOrDefault(APIVersion, DefaultVersion),
		},
	}, nil
}

func envList(name string) []string {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return nil
	}

	parts := strings.Split(value, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			values = append(values, part)
		}
	}

	return values
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

func envFloat64(name string, fallback float64) (float64, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number: %w", name, err)
	}

	return parsed, nil
}

func envMilliseconds(name string, fallback int64) (time.Duration, error) {
	value, ok := os.LookupEnv(name)
	if !ok || value == "" {
		return time.Duration(fallback) * time.Millisecond, nil
	}

	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer number of milliseconds: %w", name, err)
	}

	return time.Duration(parsed) * time.Millisecond, nil
}

func envEnum(name string, fallback string, allowed ...string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(envOrDefault(name, fallback)))
	for _, option := range allowed {
		if value == option {
			return value, nil
		}
	}

	return "", fmt.Errorf("%s must be one of: %s", name, strings.Join(allowed, ", "))
}

func envRequestLogs(traceLogs bool) (string, error) {
	value, ok := os.LookupEnv(APIRequestLogs)
	if !ok || value == "" {
		if traceLogs {
			return "all", nil
		}
		return DefaultRequestLogs, nil
	}

	return envEnum(APIRequestLogs, DefaultRequestLogs, "off", "errors", "slow", "sampled", "all")
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
