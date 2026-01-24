package handlers

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestValidateOrigin_ValidOrigins(t *testing.T) {
	validOrigins := []string{
		"https://example.com",
		"https://app.example.com",
		"http://localhost",
		"http://localhost:3000",
		"http://127.0.0.1:8080",
		"https://my-app.vercel.app",
	}

	for _, origin := range validOrigins {
		t.Run(origin, func(t *testing.T) {
			err := validateOrigin(origin)
			assert.NoError(t, err, "origin should be valid: %s", origin)
		})
	}
}

func TestValidateOrigin_InvalidOrigins(t *testing.T) {
	testCases := []struct {
		name   string
		origin string
	}{
		{"wildcard", "https://*.example.com"},
		{"no scheme", "example.com"},
		{"ftp scheme", "ftp://example.com"},
		{"with path", "https://example.com/path"},
		{"no host", "https://"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateOrigin(tc.origin)
			assert.Error(t, err, "origin should be invalid: %s", tc.origin)
		})
	}
}

func TestValidateAllowedOrigins_MaxLimit(t *testing.T) {
	// Create 21 valid origins (exceeds max of 20)
	origins := make([]string, 21)
	for i := 0; i < 21; i++ {
		origins[i] = "https://example" + string(rune('a'+i)) + ".com"
	}

	err := validateAllowedOrigins(origins)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "maximum 20")
}

func TestValidateAllowedOrigins_WithinLimit(t *testing.T) {
	origins := []string{
		"https://example1.com",
		"https://example2.com",
		"http://localhost:3000",
	}

	err := validateAllowedOrigins(origins)
	assert.NoError(t, err)
}

func TestValidateAllowedOrigins_Empty(t *testing.T) {
	err := validateAllowedOrigins([]string{})
	assert.NoError(t, err)
}

func TestUpdateTenantConfigRequest_AllowedOrigins(t *testing.T) {
	// Test JSON parsing of allowed_origins field
	jsonBody := `{
		"allowed_origins": ["https://app.example.com", "https://admin.example.com"]
	}`

	var req UpdateTenantConfigRequest
	err := json.Unmarshal([]byte(jsonBody), &req)
	assert.NoError(t, err)
	assert.NotNil(t, req.AllowedOrigins)
	assert.Len(t, *req.AllowedOrigins, 2)
	assert.Contains(t, *req.AllowedOrigins, "https://app.example.com")
	assert.Contains(t, *req.AllowedOrigins, "https://admin.example.com")
}

func TestTenantConfig_AllowedOrigins(t *testing.T) {
	// Test TenantConfig struct with allowed_origins
	config := TenantConfig{
		AllowedOrigins: []string{"https://app.example.com"},
	}

	data, err := json.Marshal(config)
	assert.NoError(t, err)
	assert.Contains(t, string(data), "allowed_origins")

	var parsed TenantConfig
	err = json.Unmarshal(data, &parsed)
	assert.NoError(t, err)
	assert.Len(t, parsed.AllowedOrigins, 1)
}

func TestIsLocalhostOrigin(t *testing.T) {
	localhostOrigins := []string{
		"http://localhost",
		"http://localhost:3000",
		"http://127.0.0.1",
		"http://127.0.0.1:8080",
		"https://localhost:443",
	}

	for _, origin := range localhostOrigins {
		t.Run(origin, func(t *testing.T) {
			assert.True(t, isLocalhostOrigin(origin), "should be localhost: %s", origin)
		})
	}

	nonLocalhostOrigins := []string{
		"https://example.com",
		"http://192.168.1.1",
		"http://localhos", // typo
	}

	for _, origin := range nonLocalhostOrigins {
		t.Run(origin, func(t *testing.T) {
			assert.False(t, isLocalhostOrigin(origin), "should not be localhost: %s", origin)
		})
	}
}
