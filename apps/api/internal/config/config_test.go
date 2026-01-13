package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestLoad_WithAllEnvVarsSet tests Load with all environment variables properly set
func TestLoad_WithAllEnvVarsSet(t *testing.T) {
	// Save original env vars
	originalPort := os.Getenv("PORT")
	originalEnv := os.Getenv("ENV")
	originalDBURL := os.Getenv("DATABASE_URL")
	originalRedisURL := os.Getenv("REDIS_URL")
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")
	originalJWTKey := os.Getenv("JWT_SIGNING_KEY")
	originalJWTExpiry := os.Getenv("JWT_EXPIRY_MINUTES")

	defer func() {
		// Restore original env vars
		if originalPort != "" {
			os.Setenv("PORT", originalPort)
		} else {
			os.Unsetenv("PORT")
		}
		if originalEnv != "" {
			os.Setenv("ENV", originalEnv)
		} else {
			os.Unsetenv("ENV")
		}
		if originalDBURL != "" {
			os.Setenv("DATABASE_URL", originalDBURL)
		} else {
			os.Unsetenv("DATABASE_URL")
		}
		if originalRedisURL != "" {
			os.Setenv("REDIS_URL", originalRedisURL)
		} else {
			os.Unsetenv("REDIS_URL")
		}
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
		if originalJWTKey != "" {
			os.Setenv("JWT_SIGNING_KEY", originalJWTKey)
		} else {
			os.Unsetenv("JWT_SIGNING_KEY")
		}
		if originalJWTExpiry != "" {
			os.Setenv("JWT_EXPIRY_MINUTES", originalJWTExpiry)
		} else {
			os.Unsetenv("JWT_EXPIRY_MINUTES")
		}
	}()

	os.Setenv("PORT", "3000")
	os.Setenv("ENV", "production")
	os.Setenv("DATABASE_URL", "postgres://prod:5432/db")
	os.Setenv("REDIS_URL", "redis://prod:6379")
	os.Setenv("CLOUDFLARE_ACCOUNT_ID", "test-account-id")
	os.Setenv("CLOUDFLARE_APP_ID", "test-app-id")
	os.Setenv("CLOUDFLARE_API_TOKEN", "test-api-token")
	os.Setenv("JWT_SIGNING_KEY", "custom-key")
	os.Setenv("JWT_EXPIRY_MINUTES", "120")

	cfg, err := Load()

	require.NoError(t, err)
	assert.NotNil(t, cfg)
	assert.Equal(t, "3000", cfg.Server.Port)
	assert.Equal(t, "production", cfg.Server.Env)
	assert.Equal(t, "postgres://prod:5432/db", cfg.Database.URL)
	assert.Equal(t, "redis://prod:6379", cfg.Redis.URL)
	assert.Equal(t, "test-account-id", cfg.Cloudflare.AccountID)
	assert.Equal(t, "test-app-id", cfg.Cloudflare.AppID)
	assert.Equal(t, "test-api-token", cfg.Cloudflare.APIToken)
	assert.Equal(t, "custom-key", cfg.JWT.SigningKey)
	assert.Equal(t, 120, cfg.JWT.ExpiryMinutes)
}

// TestLoad_WithMissingCloudflareAccountID tests that Load returns error when CLOUDFLARE_ACCOUNT_ID is missing
func TestLoad_WithMissingCloudflareAccountID(t *testing.T) {
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")

	defer func() {
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
	}()

	os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
	os.Setenv("CLOUDFLARE_APP_ID", "test-app-id")
	os.Setenv("CLOUDFLARE_API_TOKEN", "test-api-token")

	cfg, err := Load()

	assert.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "CLOUDFLARE_ACCOUNT_ID is required")
}

// TestLoad_WithMissingCloudflareAppID tests that Load returns error when CLOUDFLARE_APP_ID is missing
func TestLoad_WithMissingCloudflareAppID(t *testing.T) {
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")

	defer func() {
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
	}()

	os.Setenv("CLOUDFLARE_ACCOUNT_ID", "test-account-id")
	os.Unsetenv("CLOUDFLARE_APP_ID")
	os.Setenv("CLOUDFLARE_API_TOKEN", "test-api-token")

	cfg, err := Load()

	assert.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "CLOUDFLARE_APP_ID is required")
}

// TestLoad_WithMissingCloudflareAPIToken tests that Load returns error when CLOUDFLARE_API_TOKEN is missing
func TestLoad_WithMissingCloudflareAPIToken(t *testing.T) {
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")

	defer func() {
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
	}()

	os.Setenv("CLOUDFLARE_ACCOUNT_ID", "test-account-id")
	os.Setenv("CLOUDFLARE_APP_ID", "test-app-id")
	os.Unsetenv("CLOUDFLARE_API_TOKEN")

	cfg, err := Load()

	assert.Error(t, err)
	assert.Nil(t, cfg)
	assert.Contains(t, err.Error(), "CLOUDFLARE_API_TOKEN is required")
}

// TestLoad_WithDefaultValues tests Load uses correct default values when env vars are not set
func TestLoad_WithDefaultValues(t *testing.T) {
	originalPort := os.Getenv("PORT")
	originalEnv := os.Getenv("ENV")
	originalDBURL := os.Getenv("DATABASE_URL")
	originalRedisURL := os.Getenv("REDIS_URL")
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")
	originalJWTKey := os.Getenv("JWT_SIGNING_KEY")
	originalJWTExpiry := os.Getenv("JWT_EXPIRY_MINUTES")

	defer func() {
		if originalPort != "" {
			os.Setenv("PORT", originalPort)
		} else {
			os.Unsetenv("PORT")
		}
		if originalEnv != "" {
			os.Setenv("ENV", originalEnv)
		} else {
			os.Unsetenv("ENV")
		}
		if originalDBURL != "" {
			os.Setenv("DATABASE_URL", originalDBURL)
		} else {
			os.Unsetenv("DATABASE_URL")
		}
		if originalRedisURL != "" {
			os.Setenv("REDIS_URL", originalRedisURL)
		} else {
			os.Unsetenv("REDIS_URL")
		}
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
		if originalJWTKey != "" {
			os.Setenv("JWT_SIGNING_KEY", originalJWTKey)
		} else {
			os.Unsetenv("JWT_SIGNING_KEY")
		}
		if originalJWTExpiry != "" {
			os.Setenv("JWT_EXPIRY_MINUTES", originalJWTExpiry)
		} else {
			os.Unsetenv("JWT_EXPIRY_MINUTES")
		}
	}()

	os.Unsetenv("PORT")
	os.Unsetenv("ENV")
	os.Unsetenv("DATABASE_URL")
	os.Unsetenv("REDIS_URL")
	os.Setenv("CLOUDFLARE_ACCOUNT_ID", "test-account-id")
	os.Setenv("CLOUDFLARE_APP_ID", "test-app-id")
	os.Setenv("CLOUDFLARE_API_TOKEN", "test-api-token")
	os.Unsetenv("JWT_SIGNING_KEY")
	os.Unsetenv("JWT_EXPIRY_MINUTES")

	cfg, err := Load()

	require.NoError(t, err)
	assert.NotNil(t, cfg)
	assert.Equal(t, "8081", cfg.Server.Port)
	assert.Equal(t, "development", cfg.Server.Env)
	assert.Equal(t, "postgres://postgres@localhost:5432/chalk?sslmode=disable", cfg.Database.URL)
	assert.Equal(t, "redis://localhost:6379", cfg.Redis.URL)
	assert.Equal(t, "development-secret-key", cfg.JWT.SigningKey)
	assert.Equal(t, 60, cfg.JWT.ExpiryMinutes)
}

// TestIsDevelopment_WithDevelopmentEnv tests IsDevelopment returns true when ENV is "development"
func TestIsDevelopment_WithDevelopmentEnv(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{
			Env: "development",
		},
	}

	assert.True(t, cfg.IsDevelopment())
}

// TestIsDevelopment_WithProductionEnv tests IsDevelopment returns false when ENV is "production"
func TestIsDevelopment_WithProductionEnv(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{
			Env: "production",
		},
	}

	assert.False(t, cfg.IsDevelopment())
}

// TestIsProduction_WithProductionEnv tests IsProduction returns true when ENV is "production"
func TestIsProduction_WithProductionEnv(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{
			Env: "production",
		},
	}

	assert.True(t, cfg.IsProduction())
}

// TestIsProduction_WithDevelopmentEnv tests IsProduction returns false when ENV is "development"
func TestIsProduction_WithDevelopmentEnv(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{
			Env: "development",
		},
	}

	assert.False(t, cfg.IsProduction())
}

// TestGetEnv_WithSetEnvVar tests getEnv returns environment variable value when set
func TestGetEnv_WithSetEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENV")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENV", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENV")
		}
	}()

	os.Setenv("TEST_VAR_GETENV", "custom-value")

	result := getEnv("TEST_VAR_GETENV", "default-value")

	assert.Equal(t, "custom-value", result)
}

// TestGetEnv_WithUnsetEnvVar tests getEnv returns default value when env var is not set
func TestGetEnv_WithUnsetEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENV_UNSET")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENV_UNSET", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENV_UNSET")
		}
	}()

	os.Unsetenv("TEST_VAR_GETENV_UNSET")

	result := getEnv("TEST_VAR_GETENV_UNSET", "default-value")

	assert.Equal(t, "default-value", result)
}

// TestGetEnv_WithEmptyEnvVar tests getEnv returns default value when env var is empty string
func TestGetEnv_WithEmptyEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENV_EMPTY")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENV_EMPTY", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENV_EMPTY")
		}
	}()

	os.Setenv("TEST_VAR_GETENV_EMPTY", "")

	result := getEnv("TEST_VAR_GETENV_EMPTY", "default-value")

	assert.Equal(t, "default-value", result)
}

// TestGetEnvInt_WithValidIntEnvVar tests getEnvInt returns int value when env var is valid integer
func TestGetEnvInt_WithValidIntEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENVINT")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENVINT", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENVINT")
		}
	}()

	os.Setenv("TEST_VAR_GETENVINT", "42")

	result := getEnvInt("TEST_VAR_GETENVINT", 99)

	assert.Equal(t, 42, result)
}

// TestGetEnvInt_WithInvalidIntEnvVar tests getEnvInt returns default when env var is not a valid integer
func TestGetEnvInt_WithInvalidIntEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENVINT_INVALID")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENVINT_INVALID", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENVINT_INVALID")
		}
	}()

	os.Setenv("TEST_VAR_GETENVINT_INVALID", "not-a-number")

	result := getEnvInt("TEST_VAR_GETENVINT_INVALID", 99)

	assert.Equal(t, 99, result)
}

// TestGetEnvInt_WithUnsetEnvVar tests getEnvInt returns default value when env var is not set
func TestGetEnvInt_WithUnsetEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENVINT_UNSET")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENVINT_UNSET", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENVINT_UNSET")
		}
	}()

	os.Unsetenv("TEST_VAR_GETENVINT_UNSET")

	result := getEnvInt("TEST_VAR_GETENVINT_UNSET", 99)

	assert.Equal(t, 99, result)
}

// TestGetEnvInt_WithEmptyEnvVar tests getEnvInt returns default value when env var is empty string
func TestGetEnvInt_WithEmptyEnvVar(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENVINT_EMPTY")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENVINT_EMPTY", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENVINT_EMPTY")
		}
	}()

	os.Setenv("TEST_VAR_GETENVINT_EMPTY", "")

	result := getEnvInt("TEST_VAR_GETENVINT_EMPTY", 99)

	assert.Equal(t, 99, result)
}

// TestGetEnvInt_WithNegativeInt tests getEnvInt correctly parses negative integers
func TestGetEnvInt_WithNegativeInt(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENVINT_NEGATIVE")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENVINT_NEGATIVE", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENVINT_NEGATIVE")
		}
	}()

	os.Setenv("TEST_VAR_GETENVINT_NEGATIVE", "-50")

	result := getEnvInt("TEST_VAR_GETENVINT_NEGATIVE", 99)

	assert.Equal(t, -50, result)
}

// TestGetEnvInt_WithZero tests getEnvInt correctly parses zero
func TestGetEnvInt_WithZero(t *testing.T) {
	original := os.Getenv("TEST_VAR_GETENVINT_ZERO")
	defer func() {
		if original != "" {
			os.Setenv("TEST_VAR_GETENVINT_ZERO", original)
		} else {
			os.Unsetenv("TEST_VAR_GETENVINT_ZERO")
		}
	}()

	os.Setenv("TEST_VAR_GETENVINT_ZERO", "0")

	result := getEnvInt("TEST_VAR_GETENVINT_ZERO", 99)

	assert.Equal(t, 0, result)
}

// TestLoad_WithCustomPort tests Load correctly loads custom port
func TestLoad_WithCustomPort(t *testing.T) {
	originalPort := os.Getenv("PORT")
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")

	defer func() {
		if originalPort != "" {
			os.Setenv("PORT", originalPort)
		} else {
			os.Unsetenv("PORT")
		}
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
	}()

	os.Setenv("PORT", "9000")
	os.Setenv("CLOUDFLARE_ACCOUNT_ID", "test-account-id")
	os.Setenv("CLOUDFLARE_APP_ID", "test-app-id")
	os.Setenv("CLOUDFLARE_API_TOKEN", "test-api-token")

	cfg, err := Load()

	require.NoError(t, err)
	assert.Equal(t, "9000", cfg.Server.Port)
}

// TestLoad_WithProductionEnv tests Load correctly loads production environment
func TestLoad_WithProductionEnv(t *testing.T) {
	originalEnv := os.Getenv("ENV")
	originalCFAccountID := os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	originalCFAppID := os.Getenv("CLOUDFLARE_APP_ID")
	originalCFAPIToken := os.Getenv("CLOUDFLARE_API_TOKEN")

	defer func() {
		if originalEnv != "" {
			os.Setenv("ENV", originalEnv)
		} else {
			os.Unsetenv("ENV")
		}
		if originalCFAccountID != "" {
			os.Setenv("CLOUDFLARE_ACCOUNT_ID", originalCFAccountID)
		} else {
			os.Unsetenv("CLOUDFLARE_ACCOUNT_ID")
		}
		if originalCFAppID != "" {
			os.Setenv("CLOUDFLARE_APP_ID", originalCFAppID)
		} else {
			os.Unsetenv("CLOUDFLARE_APP_ID")
		}
		if originalCFAPIToken != "" {
			os.Setenv("CLOUDFLARE_API_TOKEN", originalCFAPIToken)
		} else {
			os.Unsetenv("CLOUDFLARE_API_TOKEN")
		}
	}()

	os.Setenv("ENV", "production")
	os.Setenv("JWT_SIGNING_KEY", "test-production-jwt-signing-key-secure")
	os.Setenv("CLOUDFLARE_ACCOUNT_ID", "test-account-id")
	os.Setenv("CLOUDFLARE_APP_ID", "test-app-id")
	os.Setenv("CLOUDFLARE_API_TOKEN", "test-api-token")

	cfg, err := Load()

	require.NoError(t, err)
	assert.True(t, cfg.IsProduction())
	assert.False(t, cfg.IsDevelopment())
}

// TestValidateConfig_AllFieldsPresent tests validate passes when all required fields are present
func TestValidateConfig_AllFieldsPresent(t *testing.T) {
	cfg := &Config{
		Cloudflare: CloudflareConfig{
			AccountID: "account-123",
			AppID:     "app-456",
			APIToken:  "token-789",
		},
	}

	err := cfg.validate()

	assert.NoError(t, err)
}

// TestValidateConfig_EmptyCloudflareAccountID tests validate fails when CloudflareAccountID is empty
func TestValidateConfig_EmptyCloudflareAccountID(t *testing.T) {
	cfg := &Config{
		Cloudflare: CloudflareConfig{
			AccountID: "",
			AppID:     "app-456",
			APIToken:  "token-789",
		},
	}

	err := cfg.validate()

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "CLOUDFLARE_ACCOUNT_ID is required")
}

// TestValidateConfig_EmptyCloudflareAppID tests validate fails when CloudflareAppID is empty
func TestValidateConfig_EmptyCloudflareAppID(t *testing.T) {
	cfg := &Config{
		Cloudflare: CloudflareConfig{
			AccountID: "account-123",
			AppID:     "",
			APIToken:  "token-789",
		},
	}

	err := cfg.validate()

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "CLOUDFLARE_APP_ID is required")
}

// TestValidateConfig_EmptyCloudflareAPIToken tests validate fails when CloudflareAPIToken is empty
func TestValidateConfig_EmptyCloudflareAPIToken(t *testing.T) {
	cfg := &Config{
		Cloudflare: CloudflareConfig{
			AccountID: "account-123",
			AppID:     "app-456",
			APIToken:  "",
		},
	}

	err := cfg.validate()

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "CLOUDFLARE_API_TOKEN is required")
}
