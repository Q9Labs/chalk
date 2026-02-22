package handlers

import (
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
		"https://collabdash-dev.vercel.app",
		"collabdash-dev.vercel.app",
		"https://app.collabdash.io",
		"app.collabdash.io",
		// TuitionHighway origins
		"https://dev.dwd4jsk5p7j52.amplifyapp.com",
		"dev.dwd4jsk5p7j52.amplifyapp.com",
		"https://dev.d17jmjn2v13h91.amplifyapp.com",
		"dev.d17jmjn2v13h91.amplifyapp.com",
		"https://portal-dev.tuitionhighway.com",
		"portal-dev.tuitionhighway.com",
		"https://portal.tuitionhighway.com",
		"portal.tuitionhighway.com",
		"https://backend.tuitionhighway.com",
		"backend.tuitionhighway.com",
		"https://backend-dev.tuitionhighway.com",
		"backend-dev.tuitionhighway.com",
		// Eman Time origins
		"https://app.emantime.com",
		"app.emantime.com",
		"https://dev-app.emantime.com",
		"dev-app.emantime.com",
		"https://portal.emantime.com",
		"portal.emantime.com",
		// Allow localhost for development/testing even in production
		"http://localhost:*",
		"localhost:*",
		"http://127.0.0.1:*",
		"127.0.0.1:*",
	)

	return origins
}
