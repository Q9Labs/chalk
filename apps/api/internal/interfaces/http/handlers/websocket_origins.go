package handlers

import (
	"net/url"
	"os"
	"strings"
)

func buildAllowedWSOrigins() []string {
	// Parse allowed origins from environment
	originsEnv := os.Getenv("ALLOWED_WS_ORIGINS")
	var origins []string
	if originsEnv != "" {
		origins = strings.Split(originsEnv, ",")
		for i := range origins {
			origins[i] = strings.TrimSpace(origins[i])
		}
	}

	// Add default development origins
	if os.Getenv("ENV") != "production" {
		origins = append(origins,
			"http://localhost:*",
			"http://127.0.0.1:*",
			"localhost:*", // Some browsers send origin without scheme
			"127.0.0.1:*",
		)
	}

	// Production/staging origins (always allowed)
	// Include patterns with and without scheme for compatibility
	origins = append(origins,
		"https://chalk.q9labs.ai",
		"chalk.q9labs.ai", // Some requests may not include scheme
		"https://chalkmeet.com",
		"chalkmeet.com",
		"https://chalk-api.q9labs.ai",
		"chalk-api.q9labs.ai",
		"https://chalk-ws.q9labs.ai",
		"chalk-ws.q9labs.ai",
		// Allow localhost for development/testing even in production
		"http://localhost:*",
		"localhost:*",
		"http://127.0.0.1:*",
		"127.0.0.1:*",
	)

	return origins
}

func resolveWSOriginPatterns(requestOrigin string, tenantOriginAllowed bool, fallbackOrigins []string) []string {
	if requestOrigin != "" && tenantOriginAllowed {
		// Tighten origin checking to the verified request origin while
		// keeping host-only compatibility for ALB/API Gateway forwarded headers.
		patterns := []string{requestOrigin}
		if parsed, err := url.Parse(requestOrigin); err == nil && parsed.Host != "" {
			patterns = append(patterns, parsed.Host)
		}
		return patterns
	}
	if len(fallbackOrigins) > 0 {
		return fallbackOrigins
	}
	return nil
}
