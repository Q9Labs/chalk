package middleware

import (
	"encoding/json"
	"regexp"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
)

// localhostPattern matches http://localhost or http://localhost:PORT (numeric port only)
var localhostPattern = regexp.MustCompile(`^http://(localhost|127\.0\.0\.1)(:\d+)?$`)

// PlatformOrigins are the static origins always allowed by the platform
var PlatformOrigins = map[string]bool{
	"https://chalk.q9labs.ai":                   true,
	"https://chalk-5bc.pages.dev":               true,
	"https://collabdash-dev.vercel.app":         true,
	"https://app.collabdash.io":                 true,
	"https://dev.dwd4jsk5p7j52.amplifyapp.com":  true,
	"https://dev.d17jmjn2v13h91.amplifyapp.com": true,
	"https://portal-dev.tuitionhighway.com":     true,
	"https://portal.tuitionhighway.com":         true,
	"https://backend.tuitionhighway.com":        true,
	"https://backend-dev.tuitionhighway.com":    true,
	"https://app.emantime.com":                  true,
	"https://dev-app.emantime.com":              true,
}

// CORS returns a middleware that handles Cross-Origin Resource Sharing
func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Allow any localhost or 127.0.0.1 origin for development
		isLocalhost := localhostPattern.MatchString(origin)
		isAllowed := PlatformOrigins[origin] || isLocalhost

		if isAllowed {
			c.Header("Access-Control-Allow-Origin", origin)
			// API-MED-06: Only set credentials header when origin is allowed
			c.Header("Access-Control-Allow-Credentials", "true")
			// Add Vary header for proper caching behavior
			c.Header("Vary", "Origin")
		}

		c.Header("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, X-API-Key, X-Admin-Secret, accept, origin, Cache-Control, X-Requested-With")
		c.Header("Access-Control-Allow-Methods", "POST, OPTIONS, GET, HEAD, PUT, PATCH, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}

// TenantConfig represents the tenant_config JSONB structure for origin checking
type tenantConfigForCORS struct {
	AllowedOrigins []string `json:"allowed_origins,omitempty"`
}

// IsOriginAllowedForTenant checks if an origin is allowed for a specific tenant
// Returns true if the origin is:
// - A platform origin (always allowed)
// - A localhost origin (for development)
// - Listed in the tenant's allowed_origins config
func IsOriginAllowedForTenant(origin string, tenant *db.Tenant) bool {
	// Platform origins are always allowed
	if PlatformOrigins[origin] {
		return true
	}

	// Localhost is always allowed for development
	if localhostPattern.MatchString(origin) {
		return true
	}

	// Check tenant-specific origins
	if tenant != nil && tenant.TenantConfig != nil {
		var config tenantConfigForCORS
		if err := json.Unmarshal(tenant.TenantConfig, &config); err == nil {
			for _, allowed := range config.AllowedOrigins {
				if allowed == origin {
					return true
				}
			}
		}
	}

	return false
}
