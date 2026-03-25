package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Server      ServerConfig
	Database    DatabaseConfig
	Redis       RedisConfig
	Cloudflare  CloudflareConfig
	API         APIConfig
	Auth        AuthConfig
	JWT         JWTConfig
	Storage     StorageConfig
	GitHub      GitHubConfig
	Axiom       AxiomConfig
	CORSOrigins CORSOriginsConfig
	PostMeeting PostMeetingConfig
	Admin       AdminConfig
}

type AdminConfig struct {
	Secret     string
	AllowedIPs []string
	Enabled    bool
}

type ServerConfig struct {
	Port string
	Env  string
}

type DatabaseConfig struct {
	URL      string
	Host     string
	Port     string
	Name     string
	User     string
	Password string
	SSLMode  string
	MaxConns int
	MinConns int
}

type RedisConfig struct {
	URL      string
	Host     string
	Port     string
	Password string
	TLS      bool
}

type CloudflareConfig struct {
	AccountID     string
	AppID         string
	APIToken      string
	WebhookSecret string
	Mock          bool
}

type APIConfig struct {
	PublicURL string // API_PUBLIC_URL - public URL for webhook registration
}

type AuthConfig struct {
	// Google auth (internal tenants)
	GoogleClientID     string
	GoogleClientSecret string
	InternalAppURL     string
	InternalAppURLs    string

	// Cookie settings (cross-subdomain in prod).
	CookieDomain string

	// HMAC signing key for join/share tokens.
	LinkSigningKey string

	SessionTTLDays int // default 30
}

type JWTConfig struct {
	SigningKey    string
	ExpiryMinutes int
}

type StorageConfig struct {
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

type GitHubConfig struct {
	Token    string
	Owner    string
	Repo     string
	CacheTTL int // (minutes)
}

type AxiomConfig struct {
	Token   string // AXIOM_TOKEN (required for Axiom, falls back to stdout if empty)
	Dataset string // AXIOM_DATASET (default: chalk-api | chalk-api-prod)
}

type CORSOriginsConfig struct {
	Bucket string // CORS_ORIGINS_BUCKET
	Key    string // CORS_ORIGINS_KEY (default: cors/allowed-origins.json)
}

type PostMeetingConfig struct {
	TranscriptionDefaultProvider string // POST_MEETING_TRANSCRIPTION_DEFAULT_PROVIDER (default: whisper)
	GroqAPIKey                   string // POST_MEETING_GROQ_API_KEY
	WhisperEnabled               bool   // POST_MEETING_WHISPER_ENABLED (default: true)
	WhisperRedisQueue            string // POST_MEETING_WHISPER_REDIS_QUEUE (default: transcription:jobs)

	AIDefaultProvider      string // POST_MEETING_AI_DEFAULT_PROVIDER (default: openrouter)
	OpenRouterAPIKey       string // POST_MEETING_OPENROUTER_API_KEY
	OpenRouterDefaultModel string // POST_MEETING_OPENROUTER_DEFAULT_MODEL (default: z-ai/glm-4.7-flash)
}

func Load() (*Config, error) {
	env := getEnv("ENV", "development")
	dbURL := getEnv("DATABASE_URL", "postgres://postgres:hello123@localhost:5432/chalk?sslmode=disable")
	dbHost := getEnv("DATABASE_HOST", "localhost")
	dbPort := getEnv("DATABASE_PORT", "5432")
	dbName := getEnv("DATABASE_NAME", "chalk")
	dbUser := getEnv("DATABASE_USER", "postgres")
	dbPassword := getEnv("DATABASE_PASSWORD", "hello123")
	dbSSLMode := getEnv("DATABASE_SSLMODE", "disable")

	if dbURL == "" && dbPassword != "" {
		dbURL = fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s",
			dbUser, dbPassword, dbHost, dbPort, dbName, dbSSLMode)
	} else if dbURL == "" {
		dbURL = fmt.Sprintf("postgres://%s@%s:%s/%s?sslmode=%s",
			dbUser, dbHost, dbPort, dbName, dbSSLMode)
	}

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

	axiomDatasetDefault := "chalk-api"
	if env == "production" {
		axiomDatasetDefault = "chalk-api-prod"
	}

	cfg := &Config{
		Server: ServerConfig{
			Port: getEnv("PORT", "8080"),
			Env:  env,
		},
		Database: DatabaseConfig{
			URL:      dbURL,
			Host:     dbHost,
			Port:     dbPort,
			Name:     dbName,
			User:     dbUser,
			Password: dbPassword,
			SSLMode:  dbSSLMode,
			MaxConns: getEnvInt("DATABASE_MAX_CONNS", 25),
			MinConns: getEnvInt("DATABASE_MIN_CONNS", 5),
		},
		Redis: RedisConfig{
			URL:      redisURL,
			Host:     redisHost,
			Port:     redisPort,
			Password: redisPassword,
			TLS:      redisTLS,
		},
		Cloudflare: CloudflareConfig{
			AccountID:     getEnv("CLOUDFLARE_ACCOUNT_ID", ""),
			AppID:         getEnv("CLOUDFLARE_APP_ID", ""),
			APIToken:      getEnv("CLOUDFLARE_API_TOKEN", ""),
			WebhookSecret: getEnv("CLOUDFLARE_WEBHOOK_SECRET", ""),
			Mock:          getEnvBool("CLOUDFLARE_MOCK", false),
		},
		API: APIConfig{
			PublicURL: getEnv("API_PUBLIC_URL", ""),
		},
		Auth: AuthConfig{
			GoogleClientID:     getEnv("AUTH_GOOGLE_CLIENT_ID", ""),
			GoogleClientSecret: getEnv("AUTH_GOOGLE_CLIENT_SECRET", ""),
			InternalAppURL:     getEnv("INTERNAL_APP_URL", "http://localhost:3070"),
			InternalAppURLs:    getEnv("INTERNAL_APP_URLS", ""),
			CookieDomain:       getEnv("AUTH_COOKIE_DOMAIN", ""),
			LinkSigningKey:     getEnv("AUTH_LINK_SIGNING_KEY", getEnv("JWT_SIGNING_KEY", "development-secret-key")),
			SessionTTLDays:     getEnvInt("AUTH_SESSION_TTL_DAYS", 30),
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
		GitHub: GitHubConfig{
			Token:    getEnv("GITHUB_TOKEN", ""),
			Owner:    getEnv("GITHUB_OWNER", "Q9Labs"),
			Repo:     getEnv("GITHUB_REPO", "chalk"),
			CacheTTL: getEnvInt("WHATS_NEW_CACHE_TTL", 15),
		},
		Axiom: AxiomConfig{
			Token:   getEnv("AXIOM_TOKEN", ""),
			Dataset: getEnv("AXIOM_DATASET", axiomDatasetDefault),
		},
		CORSOrigins: CORSOriginsConfig{
			Bucket: getEnv("CORS_ORIGINS_BUCKET", ""),
			Key:    getEnv("CORS_ORIGINS_KEY", "cors/allowed-origins.json"),
		},
		PostMeeting: PostMeetingConfig{
			TranscriptionDefaultProvider: getEnv("POST_MEETING_TRANSCRIPTION_DEFAULT_PROVIDER", "whisper"),
			GroqAPIKey:                   getEnv("POST_MEETING_GROQ_API_KEY", ""),
			WhisperEnabled:               getEnvBool("POST_MEETING_WHISPER_ENABLED", true),
			WhisperRedisQueue:            getEnv("POST_MEETING_WHISPER_REDIS_QUEUE", "transcription:jobs"),
			AIDefaultProvider:            getEnv("POST_MEETING_AI_DEFAULT_PROVIDER", "openrouter"),
			OpenRouterAPIKey:             getEnv("POST_MEETING_OPENROUTER_API_KEY", ""),
			OpenRouterDefaultModel:       getEnv("POST_MEETING_OPENROUTER_DEFAULT_MODEL", "z-ai/glm-4.7-flash"),
		},
	}

	cfg.Admin = AdminConfig{
		Secret:     getEnv("ADMIN_SECRET", "admin-dev-secret-change-in-production"),
		AllowedIPs: parseCommaSeparated(getEnv("ADMIN_ALLOWED_IPS", "127.0.0.1,::1")),
		Enabled:    getEnvBool("ADMIN_ENABLED", env == "development"),
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

func (c *Config) validate() error {
	devSecrets := []string{"", "development-secret-key", "chalk-dev-secret-change-in-production"}
	isDevSecret := false
	for _, s := range devSecrets {
		if c.JWT.SigningKey == s {
			isDevSecret = true
			break
		}
	}
	if isDevSecret && c.IsProduction() {
		return fmt.Errorf("JWT_SIGNING_KEY must be set to a secure value in production (not empty or default)")
	}

	if c.Admin.Enabled && c.IsProduction() && c.Admin.Secret == "admin-dev-secret-change-in-production" {
		return fmt.Errorf("ADMIN_SECRET must be set to a secure value in production")
	}

	if !c.Cloudflare.Mock && c.Cloudflare.AccountID == "" {
		return fmt.Errorf("CLOUDFLARE_ACCOUNT_ID is required")
	}
	if !c.Cloudflare.Mock && c.Cloudflare.AppID == "" {
		return fmt.Errorf("CLOUDFLARE_APP_ID is required")
	}
	if !c.Cloudflare.Mock && c.Cloudflare.APIToken == "" {
		return fmt.Errorf("CLOUDFLARE_API_TOKEN is required")
	}
	if c.Database.MaxConns < 1 {
		return fmt.Errorf("DATABASE_MAX_CONNS must be >= 1")
	}
	if c.Database.MinConns < 0 {
		return fmt.Errorf("DATABASE_MIN_CONNS must be >= 0")
	}
	if c.Database.MinConns > c.Database.MaxConns {
		return fmt.Errorf("DATABASE_MIN_CONNS must be <= DATABASE_MAX_CONNS")
	}

	return nil
}

func (c *Config) IsDevelopment() bool {
	return c.Server.Env == "development"
}

func (c *Config) IsProduction() bool {
	return c.Server.Env == "production"
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}

func parseCommaSeparated(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if b, err := strconv.ParseBool(value); err == nil {
			return b
		}
	}
	return defaultValue
}
