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
	APIOperationLogs      = "CHALK_API_OPERATION_LOGS"
	APIProfiler           = "CHALK_API_PROFILER"
	APIRequestLogs        = "CHALK_API_REQUEST_LOGS"
	APIRequestSampleRate  = "CHALK_API_REQUEST_SAMPLE_RATE"
	APIService            = "CHALK_API_SERVICE"
	APISlowRequestMS      = "CHALK_API_SLOW_REQUEST_MS"
	APIVersion            = "CHALK_API_VERSION"

	AuthEmailVerificationRequired = "CHALK_AUTH_EMAIL_VERIFICATION_REQUIRED"
	AuthOAuthStateTTLMS           = "CHALK_AUTH_OAUTH_STATE_TTL_MS"
	AuthSessionTTLMS              = "CHALK_AUTH_SESSION_TTL_MS"

	DatabaseURL      = "CHALK_DATABASE_URL"
	DatabaseMaxConns = "CHALK_DATABASE_MAX_CONNS"
	DatabaseMinConns = "CHALK_DATABASE_MIN_CONNS"

	GoogleOAuthClientID     = "CHALK_GOOGLE_OAUTH_CLIENT_ID"
	GoogleOAuthClientSecret = "CHALK_GOOGLE_OAUTH_CLIENT_SECRET"
	GoogleOAuthRedirectURL  = "CHALK_GOOGLE_OAUTH_REDIRECT_URL"

	RedisURL = "CHALK_REDIS_URL"

	R2AccessKeyID      = "CHALK_R2_ACCESS_KEY_ID"
	R2AccountID        = "CHALK_R2_ACCOUNT_ID"
	R2Bucket           = "CHALK_R2_BUCKET"
	R2Endpoint         = "CHALK_R2_ENDPOINT"
	R2SecretAccessKey  = "CHALK_R2_SECRET_ACCESS_KEY"
	R2RequestTimeoutMS = "CHALK_R2_REQUEST_TIMEOUT_MS"

	ResendAPIKey    = "CHALK_RESEND_API_KEY"
	ResendTimeoutMS = "CHALK_RESEND_TIMEOUT_MS"

	DefaultAPIAddress         = ":8080"
	DefaultDatabaseURL        = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns         = int32(10)
	DefaultDBMinConns         = int32(0)
	DefaultEnvironment        = "local"
	DefaultGoogleRedirectURL  = "http://127.0.0.1:8080/v1/auth/google/callback"
	DefaultLogFormat          = "json"
	DefaultLogLevel           = "info"
	DefaultOAuthStateTTLMS    = int64(10 * 60 * 1000)
	DefaultRequestLogs        = "off"
	DefaultRequestSampleRate  = 0.01
	DefaultR2RequestTimeoutMS = int64(10000)
	DefaultRedisURL           = "redis://127.0.0.1:6379/0"
	DefaultResendTimeoutMS    = int64(10000)
	DefaultSessionTTLMS       = int64(30 * 24 * 60 * 60 * 1000)
	DefaultServiceName        = "chalk-api"
	DefaultSlowRequestMS      = int64(250)
	DefaultVersion            = "dev"

	DefaultOAuthStateTTL = time.Duration(DefaultOAuthStateTTLMS) * time.Millisecond
	DefaultR2Timeout     = time.Duration(DefaultR2RequestTimeoutMS) * time.Millisecond
	DefaultResendTimeout = time.Duration(DefaultResendTimeoutMS) * time.Millisecond
	DefaultSessionTTL    = time.Duration(DefaultSessionTTLMS) * time.Millisecond
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

type RedisConfig struct {
	URL string
}

type R2Config struct {
	AccessKeyID     string
	AccountID       string
	Bucket          string
	Endpoint        string
	SecretAccessKey string
	RequestTimeout  time.Duration
}

type AuthConfig struct {
	EmailVerificationRequired bool
	OAuthStateTTL             time.Duration
	SessionTTL                time.Duration
}

type GoogleOAuthConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string
}

type ResendConfig struct {
	APIKey  string
	Timeout time.Duration
}

type ObservabilityConfig struct {
	Environment          string
	LogFormat            string
	LogLevel             string
	OperationLogs        bool
	Profiler             bool
	RequestLogs          string
	RequestSampleRate    float64
	Service              string
	SlowRequestThreshold time.Duration
	Version              string
}

type Config struct {
	API           APIConfig
	Auth          AuthConfig
	Database      DatabaseConfig
	GoogleOAuth   GoogleOAuthConfig
	Observability ObservabilityConfig
	R2            R2Config
	Redis         RedisConfig
	Resend        ResendConfig
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

	sessionTTL, err := envMilliseconds(AuthSessionTTLMS, DefaultSessionTTLMS)
	if err != nil {
		return Config{}, err
	}
	if sessionTTL <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", AuthSessionTTLMS)
	}
	oauthStateTTL, err := envMilliseconds(AuthOAuthStateTTLMS, DefaultOAuthStateTTLMS)
	if err != nil {
		return Config{}, err
	}
	if oauthStateTTL <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", AuthOAuthStateTTLMS)
	}

	logFormat, err := envEnum(APILogFormat, DefaultLogFormat, "json", "text")
	if err != nil {
		return Config{}, err
	}
	logLevel, err := envEnum(APILogLevel, DefaultLogLevel, "debug", "info", "warn", "error")
	if err != nil {
		return Config{}, err
	}
	operationLogs := envBool(APIOperationLogs)
	requestLogs, err := envRequestLogs(operationLogs)
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
	resendTimeout, err := envMilliseconds(ResendTimeoutMS, DefaultResendTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if resendTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", ResendTimeoutMS)
	}
	r2RequestTimeout, err := envMilliseconds(R2RequestTimeoutMS, DefaultR2RequestTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if r2RequestTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", R2RequestTimeoutMS)
	}

	return Config{
		API: APIConfig{
			Address:            envOrDefault(APIAddress, DefaultAPIAddress),
			CORSAllowedOrigins: envList(APICORSAllowedOrigins),
		},
		Auth: AuthConfig{
			EmailVerificationRequired: envBool(AuthEmailVerificationRequired),
			OAuthStateTTL:             oauthStateTTL,
			SessionTTL:                sessionTTL,
		},
		Database: DatabaseConfig{
			URL:      envOrDefault(DatabaseURL, DefaultDatabaseURL),
			MaxConns: maxConns,
			MinConns: minConns,
		},
		GoogleOAuth: GoogleOAuthConfig{
			ClientID:     envOrDefault(GoogleOAuthClientID, ""),
			ClientSecret: envOrDefault(GoogleOAuthClientSecret, ""),
			RedirectURL:  envOrDefault(GoogleOAuthRedirectURL, DefaultGoogleRedirectURL),
		},
		Observability: ObservabilityConfig{
			Environment:          envOrDefault(APIEnvironment, DefaultEnvironment),
			LogFormat:            logFormat,
			LogLevel:             logLevel,
			OperationLogs:        operationLogs,
			Profiler:             envBool(APIProfiler),
			RequestLogs:          requestLogs,
			RequestSampleRate:    requestSampleRate,
			Service:              envOrDefault(APIService, DefaultServiceName),
			SlowRequestThreshold: slowRequestThreshold,
			Version:              envOrDefault(APIVersion, DefaultVersion),
		},
		R2: R2Config{
			AccessKeyID:     envOrDefault(R2AccessKeyID, ""),
			AccountID:       envOrDefault(R2AccountID, ""),
			Bucket:          envOrDefault(R2Bucket, ""),
			Endpoint:        envOrDefault(R2Endpoint, ""),
			SecretAccessKey: envOrDefault(R2SecretAccessKey, ""),
			RequestTimeout:  r2RequestTimeout,
		},
		Redis: RedisConfig{
			URL: envOrDefault(RedisURL, DefaultRedisURL),
		},
		Resend: ResendConfig{
			APIKey:  envOrDefault(ResendAPIKey, ""),
			Timeout: resendTimeout,
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

func envRequestLogs(operationLogs bool) (string, error) {
	value, ok := os.LookupEnv(APIRequestLogs)
	if !ok || value == "" {
		if operationLogs {
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
