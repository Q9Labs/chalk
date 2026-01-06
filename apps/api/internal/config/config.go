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
	Storage    StorageConfig
}

// ServerConfig holds server configuration
type ServerConfig struct {
	Port string
	Env  string
}

// DatabaseConfig holds database configuration
type DatabaseConfig struct {
	URL      string
	Host     string
	Port     string
	Name     string
	User     string
	Password string
	SSLMode  string
}

// RedisConfig holds Redis configuration
type RedisConfig struct {
	URL      string
	Host     string
	Port     string
	Password string
	TLS      bool
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

// StorageConfig holds storage configuration for R2 and S3
type StorageConfig struct {
	// R2 (Cloudflare)
	R2AccountID       string
	R2AccessKeyID     string
	R2SecretAccessKey string
	R2BucketName      string
	R2PublicURL       string

	// S3 Glacier (AWS)
	S3Region          string
	S3AccessKeyID     string
	S3SecretAccessKey string
	S3BucketName      string
}

// Load loads configuration from environment variables
func Load() (*Config, error) {
	// Database config - prefer URL, fallback to parts
	dbURL := getEnv("DATABASE_URL", "")
	dbHost := getEnv("DATABASE_HOST", "localhost")
	dbPort := getEnv("DATABASE_PORT", "5432")
	dbName := getEnv("DATABASE_NAME", "chalk")
	dbUser := getEnv("DATABASE_USER", "postgres")
	dbPassword := getEnv("DATABASE_PASSWORD", "")
	dbSSLMode := getEnv("DATABASE_SSLMODE", "disable")

	if dbURL == "" && dbPassword != "" {
		dbURL = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s",
			dbUser, dbPassword, dbHost, dbPort, dbName, dbSSLMode)
	} else if dbURL == "" {
		dbURL = fmt.Sprintf("postgres://%s@%s:%s/%s?sslmode=%s",
			dbUser, dbHost, dbPort, dbName, dbSSLMode)
	}

	// Redis config - prefer URL, fallback to parts
	redisURL := getEnv("REDIS_URL", "")
	redisHost := getEnv("REDIS_HOST", "localhost")
	redisPort := getEnv("REDIS_PORT", "6379")
	redisPassword := getEnv("REDIS_PASSWORD", "")
	redisTLS := getEnvBool("REDIS_TLS", false)

	if redisURL == "" {
		scheme := "redis"
		if redisTLS {
			scheme = "rediss"
		}
		if redisPassword != "" {
			redisURL = fmt.Sprintf("%s://:%s@%s:%s", scheme, redisPassword, redisHost, redisPort)
		} else {
			redisURL = fmt.Sprintf("%s://%s:%s", scheme, redisHost, redisPort)
		}
	}

	cfg := &Config{
		Server: ServerConfig{
			Port: getEnv("PORT", "8081"),
			Env:  getEnv("ENV", "development"),
		},
		Database: DatabaseConfig{
			URL:      dbURL,
			Host:     dbHost,
			Port:     dbPort,
			Name:     dbName,
			User:     dbUser,
			Password: dbPassword,
			SSLMode:  dbSSLMode,
		},
		Redis: RedisConfig{
			URL:      redisURL,
			Host:     redisHost,
			Port:     redisPort,
			Password: redisPassword,
			TLS:      redisTLS,
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
		Storage: StorageConfig{
			R2AccountID:       getEnv("R2_ACCOUNT_ID", ""),
			R2AccessKeyID:     getEnv("R2_ACCESS_KEY_ID", ""),
			R2SecretAccessKey: getEnv("R2_SECRET_ACCESS_KEY", ""),
			R2BucketName:      getEnv("R2_BUCKET_NAME", "chalk-recordings"),
			R2PublicURL:       getEnv("R2_PUBLIC_URL", ""),
			S3Region:          getEnv("S3_REGION", "us-east-1"),
			S3AccessKeyID:     getEnv("S3_ACCESS_KEY_ID", ""),
			S3SecretAccessKey: getEnv("S3_SECRET_ACCESS_KEY", ""),
			S3BucketName:      getEnv("S3_BUCKET_NAME", "chalk-recordings-archive"),
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
	// Cloudflare config is optional - API can run in limited mode without real-time features
	// Only validate if any Cloudflare config is provided (indicates intent to use)
	hasCloudflareConfig := c.Cloudflare.AccountID != "" || c.Cloudflare.AppID != "" || c.Cloudflare.APIToken != ""
	if hasCloudflareConfig {
		if c.Cloudflare.AccountID == "" {
			return fmt.Errorf("CLOUDFLARE_ACCOUNT_ID is required when Cloudflare is configured")
		}
		if c.Cloudflare.AppID == "" {
			return fmt.Errorf("CLOUDFLARE_APP_ID is required when Cloudflare is configured")
		}
		if c.Cloudflare.APIToken == "" {
			return fmt.Errorf("CLOUDFLARE_API_TOKEN is required when Cloudflare is configured")
		}
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

// getEnvBool gets an environment variable as bool or returns a default value
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if b, err := strconv.ParseBool(value); err == nil {
			return b
		}
	}
	return defaultValue
}
