package config

import (
	"fmt"
	"net/url"
	"strings"
)

type DatabaseConfig struct {
	URL      string
	MaxConns int32
	MinConns int32
}

type RedisConfig struct {
	URL string
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
