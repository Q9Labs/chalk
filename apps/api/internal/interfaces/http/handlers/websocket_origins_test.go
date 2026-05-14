package handlers

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildAllowedWSOrigins_IncludesPlatformOrigins(t *testing.T) {
	t.Setenv("ENV", "production")
	t.Setenv("ALLOWED_WS_ORIGINS", "")

	origins := buildAllowedWSOrigins()

	assert.Contains(t, origins, "https://chalkmeet.com")
	assert.Contains(t, origins, "chalkmeet.com")
	assert.Contains(t, origins, "https://chalk-api.q9labs.ai")
	assert.Contains(t, origins, "chalk-api.q9labs.ai")
	assert.Contains(t, origins, "https://chalk-ws.q9labs.ai")
	assert.Contains(t, origins, "chalk-ws.q9labs.ai")
}

func TestBuildAllowedWSOrigins_IncludesEnvConfiguredOrigins(t *testing.T) {
	t.Setenv("ENV", "production")
	t.Setenv("ALLOWED_WS_ORIGINS", "https://foo.example.com, https://bar.example.com")

	origins := buildAllowedWSOrigins()

	assert.Contains(t, origins, "https://foo.example.com")
	assert.Contains(t, origins, "https://bar.example.com")
}

func TestResolveWSOriginPatterns_PrefersTenantVerifiedOrigin(t *testing.T) {
	patterns := resolveWSOriginPatterns(
		"https://tenant.example.com",
		true,
		[]string{"https://fallback.example.com"},
	)

	assert.Equal(t, []string{"https://tenant.example.com", "tenant.example.com"}, patterns)
}

func TestResolveWSOriginPatterns_FallsBackToStaticPatterns(t *testing.T) {
	patterns := resolveWSOriginPatterns(
		"https://tenant.example.com",
		false,
		[]string{"https://fallback.example.com"},
	)

	assert.Equal(t, []string{"https://fallback.example.com"}, patterns)
}
