package middleware

import (
	"regexp"

	"github.com/gin-gonic/gin"
)

// localhostPattern matches http://localhost or http://localhost:PORT (numeric port only)
var localhostPattern = regexp.MustCompile(`^http://(localhost|127\.0\.0\.1)(:\d+)?$`)

// CORS returns a middleware that handles Cross-Origin Resource Sharing
func CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Production domains
		allowedOrigins := map[string]bool{
			"https://chalk.q9labs.ai":           true,
			"https://chalk-5bc.pages.dev":       true,
			"https://collabdash-dev.vercel.app": true,
		}

		// Allow any localhost or 127.0.0.1 origin for development
		isLocalhost := localhostPattern.MatchString(origin)
		isAllowed := allowedOrigins[origin] || isLocalhost

		if isAllowed {
			c.Header("Access-Control-Allow-Origin", origin)
			// API-MED-06: Only set credentials header when origin is allowed
			c.Header("Access-Control-Allow-Credentials", "true")
			// Add Vary header for proper caching behavior
			c.Header("Vary", "Origin")
		}

		c.Header("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, X-API-Key, accept, origin, Cache-Control, X-Requested-With")
		c.Header("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, PATCH, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}
