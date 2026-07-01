package httpapi

import "net/http"

type CORSOptions struct {
	AllowedOrigins []string
}

func allowCORS(options CORSOptions) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(options.AllowedOrigins))
	allowAnyOrigin := false
	for _, origin := range options.AllowedOrigins {
		if origin == "*" {
			allowAnyOrigin = true
			continue
		}
		allowed[origin] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			allowedOrigin, ok := allowedCORSOrigin(origin, allowed, allowAnyOrigin)
			if ok {
				headers := w.Header()
				headers.Set("Access-Control-Allow-Origin", allowedOrigin)
				headers.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
				headers.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				headers.Set("Access-Control-Max-Age", "600")
				headers.Add("Vary", "Origin")
			}

			if r.Method == http.MethodOptions {
				if !ok {
					writeError(w, http.StatusForbidden, "cors_origin_forbidden", "CORS origin is not allowed")
					return
				}

				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func allowedCORSOrigin(origin string, allowed map[string]struct{}, allowAnyOrigin bool) (string, bool) {
	if origin == "" {
		return "", false
	}

	if allowAnyOrigin {
		return "*", true
	}

	if _, ok := allowed[origin]; ok {
		return origin, true
	}

	return "", false
}
