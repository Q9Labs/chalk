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
	if cfg.Database.URL != config.DefaultDatabaseURL {
		t.Fatalf("database url = %q, want %q", cfg.Database.URL, config.DefaultDatabaseURL)
	}
	if cfg.Database.MaxConns != config.DefaultDBMaxConns {
		t.Fatalf("database max conns = %d, want %d", cfg.Database.MaxConns, config.DefaultDBMaxConns)
	}
	if cfg.Database.MinConns != config.DefaultDBMinConns {
		t.Fatalf("database min conns = %d, want %d", cfg.Database.MinConns, config.DefaultDBMinConns)
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
