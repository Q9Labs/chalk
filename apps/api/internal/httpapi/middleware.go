package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

type sessionUserContextKey struct{}

func requireAuthentication(service AuthenticationService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if service == nil {
				writeServiceUnavailable(w)
				return
			}

			token, ok := sessionTokenFromRequest(r)
			if !ok {
				writeUnauthenticated(w)
				return
			}

			sessionUser, err := service.AuthenticateSession(r.Context(), token)
			if err != nil {
				writeAuthenticationServiceError(w, err)
				return
			}

			principal := service.PrincipalForSession(sessionUser.Session)
			ctx := authentication.ContextWithPrincipal(r.Context(), principal)
			ctx = context.WithValue(ctx, sessionUserContextKey{}, sessionUser)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func sessionUserFromContext(ctx context.Context) (authentication.SessionUser, bool) {
	sessionUser, ok := ctx.Value(sessionUserContextKey{}).(authentication.SessionUser)
	return sessionUser, ok
}

func sessionTokenFromRequest(r *http.Request) (string, bool) {
	if token, ok := bearerToken(r.Header.Get("Authorization")); ok {
		return token, true
	}

	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return "", false
	}

	token := strings.TrimSpace(cookie.Value)
	return token, token != ""
}

func bearerToken(header string) (string, bool) {
	scheme, token, ok := strings.Cut(strings.TrimSpace(header), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}

	token = strings.TrimSpace(token)
	return token, token != ""
}

func writeUnauthenticated(w http.ResponseWriter) {
	writeError(w, http.StatusUnauthorized, "unauthenticated", "Authentication required")
}

func writeServiceUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusServiceUnavailable, "service_unavailable", "Service is not ready")
}
