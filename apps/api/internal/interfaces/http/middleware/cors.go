package middleware

import (
	"encoding/json"
	"net"
	"net/url"
	"regexp"
	"strings"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/gin-gonic/gin"
)

// localhostPattern matches http://localhost or http://localhost:PORT (numeric port only)
var localhostPattern = regexp.MustCompile(`^http://(localhost|127\.0\.0\.1)(:\d+)?$`)

func isDevelopmentOrigin(origin string) bool {
	if localhostPattern.MatchString(origin) {
		return true
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}

	host := parsed.Hostname()
	if host == "" {
		return false
	}

	if strings.EqualFold(host, "localhost") {
		return true
	}

	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}

	if ip.IsLoopback() {
		return true
	}

	// Allow RFC1918 LAN hosts for local device/simulator development against
	// a machine-local API, but only outside production.
	return ip.IsPrivate()
}

// PlatformOrigins are the static origins always allowed by the platform
var PlatformOrigins = map[string]bool{
	"https://chalk.q9labs.ai":     true,
	"https://chalkmeet.com":       true,
	"https://chalk-api.q9labs.ai": true,
	"https://chalk-ws.q9labs.ai":  true,
	"https://chalk-5bc.pages.dev": true,
}

// CORS returns a middleware that handles Cross-Origin Resource Sharing
func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Allow localhost plus private LAN origins for development.
		isLocalhost := isDevelopmentOrigin(origin)
		isAllowed := PlatformOrigins[origin] || isLocalhost

		if isAllowed {
			c.Header("Access-Control-Allow-Origin", origin)
			// API-MED-06: Only set credentials header when origin is allowed
			c.Header("Access-Control-Allow-Credentials", "true")
			// Add Vary header for proper caching behavior
			c.Header("Vary", "Origin")
		}

		c.Header("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, X-API-Key, X-Admin-Secret, X-Chalk-Local-Client-ID, x-chalk-source, accept, origin, Cache-Control, X-Requested-With")
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

	// Localhost and private LAN origins are allowed for local development.
	if isDevelopmentOrigin(origin) {
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
