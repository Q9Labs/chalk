package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds all application configuration
type Config struct {
	Server     ServerConfig
	Database   DatabaseConfig
	Redis      RedisConfig
	Cloudflare CloudflareConfig
	JWT        JWTConfig
}

// ServerConfig holds server configuration
type ServerConfig struct {
	Port string
	Env  string
}

// DatabaseConfig holds database configuration
type DatabaseConfig struct {
	URL string
}

// RedisConfig holds Redis configuration
type RedisConfig struct {
	URL string
}

// CloudflareConfig holds Cloudflare RealtimeKit configuration
type CloudflareConfig struct {
	AccountID string
	AppID     string
	APIToken  string
}

// JWTConfig holds JWT configuration
type JWTConfig struct {
	SigningKey    string
	ExpiryMinutes int
}

// Load loads configuration from environment variables
func Load() (*Config, error) {
	cfg := &Config{
		Server: ServerConfig{
			Port: getEnv("PORT", "8080"),
			Env:  getEnv("ENV", "development"),
		},
		Database: DatabaseConfig{
			URL: getEnv("DATABASE_URL", "postgres://localhost:5432/chalk?sslmode=disable"),
		},
		Redis: RedisConfig{
			URL: getEnv("REDIS_URL", "redis://localhost:6379"),
		},
		Cloudflare: CloudflareConfig{
			AccountID: getEnv("CLOUDFLARE_ACCOUNT_ID", ""),
			AppID:     getEnv("CLOUDFLARE_APP_ID", ""),
			APIToken:  getEnv("CLOUDFLARE_API_TOKEN", ""),
		},
		JWT: JWTConfig{
			SigningKey:    getEnv("JWT_SIGNING_KEY", "development-secret-key"),
			ExpiryMinutes: getEnvInt("JWT_EXPIRY_MINUTES", 60),
		},
	}

	// Validate required fields
	if err := cfg.validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

// validate checks that required configuration is present
func (c *Config) validate() error {
	if c.Cloudflare.AccountID == "" {
		return fmt.Errorf("CLOUDFLARE_ACCOUNT_ID is required")
	}
	if c.Cloudflare.AppID == "" {
		return fmt.Errorf("CLOUDFLARE_APP_ID is required")
	}
	if c.Cloudflare.APIToken == "" {
		return fmt.Errorf("CLOUDFLARE_API_TOKEN is required")
	}
	return nil
}

// IsDevelopment returns true if running in development mode
func (c *Config) IsDevelopment() bool {
	return c.Server.Env == "development"
}

// IsProduction returns true if running in production mode
func (c *Config) IsProduction() bool {
	return c.Server.Env == "production"
}

// getEnv gets an environment variable or returns a default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt gets an environment variable as int or returns a default value
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}
