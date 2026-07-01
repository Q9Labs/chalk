package postgres_test

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/config"
)

func TestPoolConfig(t *testing.T) {
	poolConfig, err := postgres.PoolConfig(config.DatabaseConfig{
		URL:      "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable",
		MaxConns: 12,
		MinConns: 2,
	})
	if err != nil {
		t.Fatalf("pool config: %v", err)
	}

	if poolConfig.ConnConfig.Host != "127.0.0.1" {
		t.Fatalf("host = %q, want 127.0.0.1", poolConfig.ConnConfig.Host)
	}
	if poolConfig.ConnConfig.Database != "chalk" {
		t.Fatalf("database = %q, want chalk", poolConfig.ConnConfig.Database)
	}
	if poolConfig.MaxConns != 12 {
		t.Fatalf("max conns = %d, want 12", poolConfig.MaxConns)
	}
	if poolConfig.MinConns != 2 {
		t.Fatalf("min conns = %d, want 2", poolConfig.MinConns)
	}
}

func TestPoolConfigRejectsInvalidURL(t *testing.T) {
	_, err := postgres.PoolConfig(config.DatabaseConfig{
		URL:      "://bad-url",
		MaxConns: 10,
		MinConns: 0,
	})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestPoolConfigRejectsInvalidPoolSettings(t *testing.T) {
	tests := []struct {
		name string
		cfg  config.DatabaseConfig
	}{
		{
			name: "zero max conns",
			cfg: config.DatabaseConfig{
				URL:      config.DefaultDatabaseURL,
				MaxConns: 0,
				MinConns: 0,
			},
		},
		{
			name: "negative min conns",
			cfg: config.DatabaseConfig{
				URL:      config.DefaultDatabaseURL,
				MaxConns: 10,
				MinConns: -1,
			},
		},
		{
			name: "min greater than max",
			cfg: config.DatabaseConfig{
				URL:      config.DefaultDatabaseURL,
				MaxConns: 2,
				MinConns: 3,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := postgres.PoolConfig(tt.cfg)
			if err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
