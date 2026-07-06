package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	APIAddress            = "CHALK_API_ADDR"
	APICORSAllowedOrigins = "CHALK_API_CORS_ALLOWED_ORIGINS"
	APIEnvironment        = "CHALK_API_ENV"
	APITrustedProxyCIDRs  = "CHALK_API_TRUSTED_PROXY_CIDRS"
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

	CloudflareAccountID                = "CHALK_CLOUDFLARE_ACCOUNT_ID"
	CloudflareAPIToken                 = "CHALK_CLOUDFLARE_API_TOKEN"
	CloudflareRealtimeAppID            = "CHALK_CLOUDFLARE_REALTIME_APP_ID"
	CloudflareRealtimeAppSecret        = "CHALK_CLOUDFLARE_REALTIME_APP_SECRET"
	CloudflareRTKAppID                 = "CHALK_CLOUDFLARE_RTK_APP_ID"
	CloudflareRTKPresetFacilitator     = "CHALK_CLOUDFLARE_RTK_PRESET_FACILITATOR"
	CloudflareRTKPresetContributor     = "CHALK_CLOUDFLARE_RTK_PRESET_CONTRIBUTOR"
	CloudflareRealtimeRequestTimeoutMS = "CHALK_CLOUDFLARE_REALTIME_TIMEOUT_MS"

	ComposioAPIKey        = "CHALK_COMPOSIO_API_KEY"
	ComposioBaseURL       = "CHALK_COMPOSIO_BASE_URL"
	ComposioTimeoutMS     = "CHALK_COMPOSIO_TIMEOUT_MS"
	ComposioWebhookSecret = "CHALK_COMPOSIO_WEBHOOK_SECRET"

	R2AccessKeyID      = "CHALK_R2_ACCESS_KEY_ID"
	R2AccountID        = "CHALK_R2_ACCOUNT_ID"
	R2Bucket           = "CHALK_R2_BUCKET"
	R2Endpoint         = "CHALK_R2_ENDPOINT"
	R2SecretAccessKey  = "CHALK_R2_SECRET_ACCESS_KEY"
	R2RequestTimeoutMS = "CHALK_R2_REQUEST_TIMEOUT_MS"

	ResendAPIKey    = "CHALK_RESEND_API_KEY"
	ResendTimeoutMS = "CHALK_RESEND_TIMEOUT_MS"

	DefaultAPIAddress                         = ":8080"
	DefaultDatabaseURL                        = "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"
	DefaultDBMaxConns                         = int32(10)
	DefaultDBMinConns                         = int32(0)
	DefaultEnvironment                        = "local"
	DefaultGoogleRedirectURL                  = "http://127.0.0.1:8080/v1/auth/google/callback"
	DefaultLogFormat                          = "json"
	DefaultLogLevel                           = "info"
	DefaultOAuthStateTTLMS                    = int64(10 * 60 * 1000)
	DefaultCloudflareRealtimeRequestTimeoutMS = int64(10000)
	DefaultComposioBaseURL                    = "https://backend.composio.dev/api/v3.1"
	DefaultComposioTimeoutMS                  = int64(10000)
	DefaultCloudflareRTKPresetContributor     = "contributor"
	DefaultCloudflareRTKPresetFacilitator     = "facilitator"
	DefaultRequestLogs                        = "off"
	DefaultRequestSampleRate                  = 0.01
	DefaultR2RequestTimeoutMS                 = int64(10000)
	DefaultRedisURL                           = "redis://127.0.0.1:6379/0"
	DefaultResendTimeoutMS                    = int64(10000)
	DefaultSessionTTLMS                       = int64(30 * 24 * 60 * 60 * 1000)
	DefaultServiceName                        = "chalk-api"
	DefaultSlowRequestMS                      = int64(250)
	DefaultVersion                            = "dev"

	DefaultOAuthStateTTL             = time.Duration(DefaultOAuthStateTTLMS) * time.Millisecond
	DefaultCloudflareRealtimeTimeout = time.Duration(DefaultCloudflareRealtimeRequestTimeoutMS) * time.Millisecond
	DefaultComposioTimeout           = time.Duration(DefaultComposioTimeoutMS) * time.Millisecond
	DefaultR2Timeout                 = time.Duration(DefaultR2RequestTimeoutMS) * time.Millisecond
	DefaultResendTimeout             = time.Duration(DefaultResendTimeoutMS) * time.Millisecond
	DefaultSessionTTL                = time.Duration(DefaultSessionTTLMS) * time.Millisecond
)

type APIConfig struct {
	Address            string
	CORSAllowedOrigins []string
	TrustedProxyCIDRs  []string
}

type DatabaseConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type RedisConfig struct {
	URL string
}

type CloudflareRealtimeConfig struct {
	AccountID            string
	APIToken             string
	RealtimeAppID        string
	RealtimeAppSecret    string
	RTKAppID             string
	RTKPresetFacilitator string
	RTKPresetContributor string
	RequestTimeout       time.Duration
}

type ComposioConfig struct {
	APIKey         string
	BaseURL        string
	RequestTimeout time.Duration
	WebhookSecret  string
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
	API                APIConfig
	Auth               AuthConfig
	CloudflareRealtime CloudflareRealtimeConfig
	Composio           ComposioConfig
	Database           DatabaseConfig
	GoogleOAuth        GoogleOAuthConfig
	Observability      ObservabilityConfig
	R2                 R2Config
	Redis              RedisConfig
	Resend             ResendConfig
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
	environment := envOrDefault(APIEnvironment, DefaultEnvironment)
	databaseURL := envOrDefault(DatabaseURL, DefaultDatabaseURL)
	if err := validateDatabaseURL(environment, databaseURL); err != nil {
		return Config{}, err
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
	cloudflareRealtimeRequestTimeout, err := envMilliseconds(CloudflareRealtimeRequestTimeoutMS, DefaultCloudflareRealtimeRequestTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if cloudflareRealtimeRequestTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", CloudflareRealtimeRequestTimeoutMS)
	}
	composioTimeout, err := envMilliseconds(ComposioTimeoutMS, DefaultComposioTimeoutMS)
	if err != nil {
		return Config{}, err
	}
	if composioTimeout <= 0 {
		return Config{}, fmt.Errorf("%s must be greater than zero", ComposioTimeoutMS)
	}
	composioAPIKey := envOrDefault(ComposioAPIKey, "")
	if environment != DefaultEnvironment && strings.TrimSpace(composioAPIKey) == "" {
		return Config{}, fmt.Errorf("%s must be set outside local environments", ComposioAPIKey)
	}

	return Config{
		API: APIConfig{
			Address:            envOrDefault(APIAddress, DefaultAPIAddress),
			CORSAllowedOrigins: envList(APICORSAllowedOrigins),
			TrustedProxyCIDRs:  envList(APITrustedProxyCIDRs),
		},
		Auth: AuthConfig{
			EmailVerificationRequired: envBool(AuthEmailVerificationRequired),
			OAuthStateTTL:             oauthStateTTL,
			SessionTTL:                sessionTTL,
		},
		CloudflareRealtime: CloudflareRealtimeConfig{
			AccountID:            envOrDefault(CloudflareAccountID, ""),
			APIToken:             envOrDefault(CloudflareAPIToken, ""),
			RealtimeAppID:        envOrDefault(CloudflareRealtimeAppID, ""),
			RealtimeAppSecret:    envOrDefault(CloudflareRealtimeAppSecret, ""),
			RTKAppID:             envOrDefault(CloudflareRTKAppID, ""),
			RTKPresetFacilitator: envOrDefault(CloudflareRTKPresetFacilitator, DefaultCloudflareRTKPresetFacilitator),
			RTKPresetContributor: envOrDefault(CloudflareRTKPresetContributor, DefaultCloudflareRTKPresetContributor),
			RequestTimeout:       cloudflareRealtimeRequestTimeout,
		},
		Composio: ComposioConfig{
			APIKey:         composioAPIKey,
			BaseURL:        envOrDefault(ComposioBaseURL, DefaultComposioBaseURL),
			RequestTimeout: composioTimeout,
			WebhookSecret:  envOrDefault(ComposioWebhookSecret, ""),
		},
		Database: DatabaseConfig{
			URL:      databaseURL,
			MaxConns: maxConns,
			MinConns: minConns,
		},
		GoogleOAuth: GoogleOAuthConfig{
			ClientID:     envOrDefault(GoogleOAuthClientID, ""),
			ClientSecret: envOrDefault(GoogleOAuthClientSecret, ""),
			RedirectURL:  envOrDefault(GoogleOAuthRedirectURL, DefaultGoogleRedirectURL),
		},
		Observability: ObservabilityConfig{
			Environment:          environment,
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
