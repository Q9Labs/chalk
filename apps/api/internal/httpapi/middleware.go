package httpapi

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/authentication"
)

type sessionUserContextKey struct{}

func acceptLocalSystemToken(rawToken string) func(http.Handler) http.Handler {
	token := strings.TrimSpace(rawToken)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token == "" {
				next.ServeHTTP(w, r)
				return
			}

			requestToken, ok := bearerToken(r.Header.Get("Authorization"))
			if ok && subtle.ConstantTimeCompare([]byte(requestToken), []byte(token)) == 1 {
				principal := authentication.Principal{Kind: authentication.PrincipalSystem}
				ctx := authentication.ContextWithPrincipal(r.Context(), principal)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func requireAuthentication(service AuthenticationService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.IsAuthenticated() {
				next.ServeHTTP(w, r)
				return
			}

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
	writeAPIError(w, apiErrorUnauthenticated)
}

func writeServiceUnavailable(w http.ResponseWriter) {
	writeAPIError(w, apiErrorServiceUnavailable)
}
