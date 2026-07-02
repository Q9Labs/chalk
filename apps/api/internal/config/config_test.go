package config_test

import (
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.API.Address != config.DefaultAPIAddress {
		t.Fatalf("api address = %q, want %q", cfg.API.Address, config.DefaultAPIAddress)
	}
	if len(cfg.API.CORSAllowedOrigins) != 0 {
		t.Fatalf("cors allowed origins = %#v, want empty", cfg.API.CORSAllowedOrigins)
	}
	if cfg.Auth.EmailVerificationRequired {
		t.Fatal("email verification required = true, want false")
	}
	if cfg.Auth.OAuthStateTTL != config.DefaultOAuthStateTTL {
		t.Fatalf("oauth state ttl = %s, want %s", cfg.Auth.OAuthStateTTL, config.DefaultOAuthStateTTL)
	}
	if cfg.Auth.SessionTTL != config.DefaultSessionTTL {
		t.Fatalf("session ttl = %s, want %s", cfg.Auth.SessionTTL, config.DefaultSessionTTL)
	}
	if cfg.Database.URL != config.DefaultDatabaseURL {
		t.Fatalf("database url = %q, want %q", cfg.Database.URL, config.DefaultDatabaseURL)
	}
	if cfg.Database.MaxConns != config.DefaultDBMaxConns {
		t.Fatalf("database max conns = %d, want %d", cfg.Database.MaxConns, config.DefaultDBMaxConns)
	}
	if cfg.Database.MinConns != config.DefaultDBMinConns {
		t.Fatalf("database min conns = %d, want %d", cfg.Database.MinConns, config.DefaultDBMinConns)
	}
	if cfg.GoogleOAuth.ClientID != "" {
		t.Fatalf("google oauth client id = %q, want empty", cfg.GoogleOAuth.ClientID)
	}
	if cfg.GoogleOAuth.ClientSecret != "" {
		t.Fatalf("google oauth client secret = %q, want empty", cfg.GoogleOAuth.ClientSecret)
	}
	if cfg.GoogleOAuth.RedirectURL != config.DefaultGoogleRedirectURL {
		t.Fatalf("google oauth redirect url = %q, want %q", cfg.GoogleOAuth.RedirectURL, config.DefaultGoogleRedirectURL)
	}
	if cfg.Redis.URL != config.DefaultRedisURL {
		t.Fatalf("redis url = %q, want %q", cfg.Redis.URL, config.DefaultRedisURL)
	}
	if cfg.R2.AccessKeyID != "" {
		t.Fatalf("r2 access key id = %q, want empty", cfg.R2.AccessKeyID)
	}
	if cfg.R2.AccountID != "" {
		t.Fatalf("r2 account id = %q, want empty", cfg.R2.AccountID)
	}
	if cfg.R2.Bucket != "" {
		t.Fatalf("r2 bucket = %q, want empty", cfg.R2.Bucket)
	}
	if cfg.R2.Endpoint != "" {
		t.Fatalf("r2 endpoint = %q, want empty", cfg.R2.Endpoint)
	}
	if cfg.R2.SecretAccessKey != "" {
		t.Fatalf("r2 secret access key = %q, want empty", cfg.R2.SecretAccessKey)
	}
	if cfg.R2.RequestTimeout != config.DefaultR2Timeout {
		t.Fatalf("r2 request timeout = %s, want %s", cfg.R2.RequestTimeout, config.DefaultR2Timeout)
	}
	if cfg.Resend.APIKey != "" {
		t.Fatalf("resend api key = %q, want empty", cfg.Resend.APIKey)
	}
	if cfg.Resend.Timeout != config.DefaultResendTimeout {
		t.Fatalf("resend timeout = %s, want %s", cfg.Resend.Timeout, config.DefaultResendTimeout)
	}
	if cfg.Observability.Profiler {
		t.Fatal("profiler = true, want false")
	}
	if cfg.Observability.OperationLogs {
		t.Fatal("operation logs = true, want false")
	}
	if cfg.Observability.Service != config.DefaultServiceName {
		t.Fatalf("service = %q, want %q", cfg.Observability.Service, config.DefaultServiceName)
	}
	if cfg.Observability.Environment != config.DefaultEnvironment {
		t.Fatalf("environment = %q, want %q", cfg.Observability.Environment, config.DefaultEnvironment)
	}
	if cfg.Observability.Version != config.DefaultVersion {
		t.Fatalf("version = %q, want %q", cfg.Observability.Version, config.DefaultVersion)
	}
	if cfg.Observability.LogFormat != config.DefaultLogFormat {
		t.Fatalf("log format = %q, want %q", cfg.Observability.LogFormat, config.DefaultLogFormat)
	}
	if cfg.Observability.LogLevel != config.DefaultLogLevel {
		t.Fatalf("log level = %q, want %q", cfg.Observability.LogLevel, config.DefaultLogLevel)
	}
	if cfg.Observability.RequestLogs != config.DefaultRequestLogs {
		t.Fatalf("request logs = %q, want %q", cfg.Observability.RequestLogs, config.DefaultRequestLogs)
	}
	if cfg.Observability.RequestSampleRate != config.DefaultRequestSampleRate {
		t.Fatalf("request sample rate = %f, want %f", cfg.Observability.RequestSampleRate, config.DefaultRequestSampleRate)
	}
	if cfg.Observability.SlowRequestThreshold != time.Duration(config.DefaultSlowRequestMS)*time.Millisecond {
		t.Fatalf("slow request threshold = %s, want %dms", cfg.Observability.SlowRequestThreshold, config.DefaultSlowRequestMS)
	}
}

func TestLoadAPICORSAllowedOrigins(t *testing.T) {
	t.Setenv(config.APICORSAllowedOrigins, "https://app.chalk.test, http://localhost:3000 ,,")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	want := []string{"https://app.chalk.test", "http://localhost:3000"}
	if len(cfg.API.CORSAllowedOrigins) != len(want) {
		t.Fatalf("cors allowed origins = %#v, want %#v", cfg.API.CORSAllowedOrigins, want)
	}
	for i := range want {
		if cfg.API.CORSAllowedOrigins[i] != want[i] {
			t.Fatalf("cors allowed origins = %#v, want %#v", cfg.API.CORSAllowedOrigins, want)
		}
	}
}

func TestLoadAPIAddress(t *testing.T) {
	t.Setenv(config.APIAddress, "127.0.0.1:9000")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.API.Address != "127.0.0.1:9000" {
		t.Fatalf("api address = %q, want 127.0.0.1:9000", cfg.API.Address)
	}
}

func TestLoadDatabaseURL(t *testing.T) {
	t.Setenv(config.DatabaseURL, "postgres://example")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Database.URL != "postgres://example" {
		t.Fatalf("database url = %q, want postgres://example", cfg.Database.URL)
	}
}

func TestLoadDatabasePoolSettings(t *testing.T) {
	t.Setenv(config.DatabaseMaxConns, "25")
	t.Setenv(config.DatabaseMinConns, "5")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Database.MaxConns != 25 {
		t.Fatalf("database max conns = %d, want 25", cfg.Database.MaxConns)
	}
	if cfg.Database.MinConns != 5 {
		t.Fatalf("database min conns = %d, want 5", cfg.Database.MinConns)
	}
}

func TestLoadAuth(t *testing.T) {
	t.Setenv(config.AuthEmailVerificationRequired, "true")
	t.Setenv(config.AuthOAuthStateTTLMS, "120000")
	t.Setenv(config.AuthSessionTTLMS, "3600000")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if !cfg.Auth.EmailVerificationRequired {
		t.Fatal("email verification required = false, want true")
	}
	if cfg.Auth.OAuthStateTTL != 2*time.Minute {
		t.Fatalf("oauth state ttl = %s, want 2m", cfg.Auth.OAuthStateTTL)
	}
	if cfg.Auth.SessionTTL != time.Hour {
		t.Fatalf("session ttl = %s, want 1h", cfg.Auth.SessionTTL)
	}
}

func TestLoadGoogleOAuth(t *testing.T) {
	t.Setenv(config.GoogleOAuthClientID, "client-id.apps.googleusercontent.com")
	t.Setenv(config.GoogleOAuthClientSecret, "client-secret")
	t.Setenv(config.GoogleOAuthRedirectURL, "https://api.chalk.test/v1/auth/google/callback")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.GoogleOAuth.ClientID != "client-id.apps.googleusercontent.com" {
		t.Fatalf("google oauth client id = %q, want configured client id", cfg.GoogleOAuth.ClientID)
	}
	if cfg.GoogleOAuth.ClientSecret != "client-secret" {
		t.Fatalf("google oauth client secret = %q, want configured secret", cfg.GoogleOAuth.ClientSecret)
	}
	if cfg.GoogleOAuth.RedirectURL != "https://api.chalk.test/v1/auth/google/callback" {
		t.Fatalf("google oauth redirect url = %q, want configured redirect url", cfg.GoogleOAuth.RedirectURL)
	}
}

func TestLoadRedisURL(t *testing.T) {
	t.Setenv(config.RedisURL, "redis://redis.internal:6379/2")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Redis.URL != "redis://redis.internal:6379/2" {
		t.Fatalf("redis url = %q, want redis://redis.internal:6379/2", cfg.Redis.URL)
	}
}

func TestLoadR2(t *testing.T) {
	t.Setenv(config.R2AccessKeyID, "access-key")
	t.Setenv(config.R2AccountID, "account-id")
	t.Setenv(config.R2Bucket, "chalk-media")
	t.Setenv(config.R2Endpoint, "https://storage.chalk.test")
	t.Setenv(config.R2SecretAccessKey, "secret-key")
	t.Setenv(config.R2RequestTimeoutMS, "2500")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.R2.AccessKeyID != "access-key" {
		t.Fatalf("r2 access key id = %q, want access-key", cfg.R2.AccessKeyID)
	}
	if cfg.R2.AccountID != "account-id" {
		t.Fatalf("r2 account id = %q, want account-id", cfg.R2.AccountID)
	}
	if cfg.R2.Bucket != "chalk-media" {
		t.Fatalf("r2 bucket = %q, want chalk-media", cfg.R2.Bucket)
	}
	if cfg.R2.Endpoint != "https://storage.chalk.test" {
		t.Fatalf("r2 endpoint = %q, want configured endpoint", cfg.R2.Endpoint)
	}
	if cfg.R2.SecretAccessKey != "secret-key" {
		t.Fatalf("r2 secret access key = %q, want secret-key", cfg.R2.SecretAccessKey)
	}
	if cfg.R2.RequestTimeout != 2500*time.Millisecond {
		t.Fatalf("r2 request timeout = %s, want 2500ms", cfg.R2.RequestTimeout)
	}
}

func TestLoadResend(t *testing.T) {
	t.Setenv(config.ResendAPIKey, "re_123")
	t.Setenv(config.ResendTimeoutMS, "2500")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Resend.APIKey != "re_123" {
		t.Fatalf("resend api key = %q, want re_123", cfg.Resend.APIKey)
	}
	if cfg.Resend.Timeout != 2500*time.Millisecond {
		t.Fatalf("resend timeout = %s, want 2500ms", cfg.Resend.Timeout)
	}
}

func TestLoadObservability(t *testing.T) {
	t.Setenv(config.APIEnvironment, "staging")
	t.Setenv(config.APILogFormat, "text")
	t.Setenv(config.APILogLevel, "debug")
	t.Setenv(config.APIProfiler, "true")
	t.Setenv(config.APIOperationLogs, "1")
	t.Setenv(config.APIRequestLogs, "sampled")
	t.Setenv(config.APIRequestSampleRate, "0.25")
	t.Setenv(config.APIService, "chalk-api-test")
	t.Setenv(config.APISlowRequestMS, "75")
	t.Setenv(config.APIVersion, "2026.07.01")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if !cfg.Observability.Profiler {
		t.Fatal("profiler = false, want true")
	}
	if !cfg.Observability.OperationLogs {
		t.Fatal("operation logs = false, want true")
	}
	if cfg.Observability.Service != "chalk-api-test" {
		t.Fatalf("service = %q, want chalk-api-test", cfg.Observability.Service)
	}
	if cfg.Observability.Environment != "staging" {
		t.Fatalf("environment = %q, want staging", cfg.Observability.Environment)
	}
	if cfg.Observability.Version != "2026.07.01" {
		t.Fatalf("version = %q, want 2026.07.01", cfg.Observability.Version)
	}
	if cfg.Observability.LogFormat != "text" {
		t.Fatalf("log format = %q, want text", cfg.Observability.LogFormat)
	}
	if cfg.Observability.LogLevel != "debug" {
		t.Fatalf("log level = %q, want debug", cfg.Observability.LogLevel)
	}
	if cfg.Observability.RequestLogs != "sampled" {
		t.Fatalf("request logs = %q, want sampled", cfg.Observability.RequestLogs)
	}
	if cfg.Observability.RequestSampleRate != 0.25 {
		t.Fatalf("request sample rate = %f, want 0.25", cfg.Observability.RequestSampleRate)
	}
	if cfg.Observability.SlowRequestThreshold != 75*time.Millisecond {
		t.Fatalf("slow request threshold = %s, want 75ms", cfg.Observability.SlowRequestThreshold)
	}
}

func TestLoadOperationLogsDefaultToAllRequestLogs(t *testing.T) {
	t.Setenv(config.APIOperationLogs, "1")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.Observability.RequestLogs != "all" {
		t.Fatalf("request logs = %q, want all", cfg.Observability.RequestLogs)
	}
}

func TestLoadRejectsInvalidDatabasePoolSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad max conns",
			env: map[string]string{
				config.DatabaseMaxConns: "many",
			},
		},
		{
			name: "zero max conns",
			env: map[string]string{
				config.DatabaseMaxConns: "0",
			},
		},
		{
			name: "negative min conns",
			env: map[string]string{
				config.DatabaseMinConns: "-1",
			},
		},
		{
			name: "min greater than max",
			env: map[string]string{
				config.DatabaseMaxConns: "2",
				config.DatabaseMinConns: "3",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidAuthSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad session ttl",
			env: map[string]string{
				config.AuthSessionTTLMS: "soon",
			},
		},
		{
			name: "zero session ttl",
			env: map[string]string{
				config.AuthSessionTTLMS: "0",
			},
		},
		{
			name: "bad oauth state ttl",
			env: map[string]string{
				config.AuthOAuthStateTTLMS: "soon",
			},
		},
		{
			name: "zero oauth state ttl",
			env: map[string]string{
				config.AuthOAuthStateTTLMS: "0",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidObservabilitySettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad log format",
			env: map[string]string{
				config.APILogFormat: "xml",
			},
		},
		{
			name: "bad log level",
			env: map[string]string{
				config.APILogLevel: "verbose",
			},
		},
		{
			name: "bad request logs",
			env: map[string]string{
				config.APIRequestLogs: "everything",
			},
		},
		{
			name: "bad sample rate",
			env: map[string]string{
				config.APIRequestSampleRate: "many",
			},
		},
		{
			name: "sample rate too high",
			env: map[string]string{
				config.APIRequestSampleRate: "1.5",
			},
		},
		{
			name: "bad slow request threshold",
			env: map[string]string{
				config.APISlowRequestMS: "soon",
			},
		},
		{
			name: "negative slow request threshold",
			env: map[string]string{
				config.APISlowRequestMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidResendSettings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad timeout",
			env: map[string]string{
				config.ResendTimeoutMS: "soon",
			},
		},
		{
			name: "zero timeout",
			env: map[string]string{
				config.ResendTimeoutMS: "0",
			},
		},
		{
			name: "negative timeout",
			env: map[string]string{
				config.ResendTimeoutMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestLoadRejectsInvalidR2Settings(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "bad timeout",
			env: map[string]string{
				config.R2RequestTimeoutMS: "soon",
			},
		},
		{
			name: "zero timeout",
			env: map[string]string{
				config.R2RequestTimeoutMS: "0",
			},
		},
		{
			name: "negative timeout",
			env: map[string]string{
				config.R2RequestTimeoutMS: "-1",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for key, value := range tt.env {
				t.Setenv(key, value)
			}

			_, err := config.Load()
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
