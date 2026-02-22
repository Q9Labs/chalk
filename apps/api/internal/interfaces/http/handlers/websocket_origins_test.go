package handlers

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildAllowedWSOrigins_IncludesEmanTimeOrigins(t *testing.T) {
	t.Setenv("ENV", "production")
	t.Setenv("ALLOWED_WS_ORIGINS", "")

	origins := buildAllowedWSOrigins()

	assert.Contains(t, origins, "https://app.emantime.com")
	assert.Contains(t, origins, "app.emantime.com")
	assert.Contains(t, origins, "https://dev-app.emantime.com")
	assert.Contains(t, origins, "dev-app.emantime.com")
	assert.Contains(t, origins, "https://portal.emantime.com")
	assert.Contains(t, origins, "portal.emantime.com")
}

func TestBuildAllowedWSOrigins_IncludesEnvConfiguredOrigins(t *testing.T) {
	t.Setenv("ENV", "production")
	t.Setenv("ALLOWED_WS_ORIGINS", "https://foo.example.com, https://bar.example.com")

	origins := buildAllowedWSOrigins()

	assert.Contains(t, origins, "https://foo.example.com")
	assert.Contains(t, origins, "https://bar.example.com")
}
