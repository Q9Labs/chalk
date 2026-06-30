package config_test

import (
	"testing"

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
	if cfg.Database.URL != config.DefaultDatabaseURL {
		t.Fatalf("database url = %q, want %q", cfg.Database.URL, config.DefaultDatabaseURL)
	}
	if cfg.Database.MaxConns != config.DefaultDBMaxConns {
		t.Fatalf("database max conns = %d, want %d", cfg.Database.MaxConns, config.DefaultDBMaxConns)
	}
	if cfg.Database.MinConns != config.DefaultDBMinConns {
		t.Fatalf("database min conns = %d, want %d", cfg.Database.MinConns, config.DefaultDBMinConns)
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
