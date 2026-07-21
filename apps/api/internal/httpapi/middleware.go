package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/netip"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
)

type sessionUserContextKey struct{}

type APIKeyAuthenticator interface {
	Authenticate(context.Context, apikeys.AuthenticateInput) (authentication.Principal, error)
}

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

// requireTenantAuthentication accepts either a tenant API key or the existing
// user Session credential. A value in the API-key namespace is never handed to
// Session authentication, even when malformed or unknown.
func requireTenantAuthentication(service AuthenticationService, apiKeys APIKeyAuthenticator, clientIPs ClientIPOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.IsAuthenticated() {
				next.ServeHTTP(w, r)
				return
			}

			if credential, ok := bearerToken(r.Header.Get("Authorization")); ok && strings.HasPrefix(credential, "chalk_sk_") {
				if apiKeys == nil {
					writeServiceUnavailable(w)
					return
				}
				address, _ := netip.ParseAddr(clientIP(r, clientIPs))
				principal, err := apiKeys.Authenticate(r.Context(), apikeys.AuthenticateInput{RawKey: credential, IPAddress: address})
				if err != nil {
					if errors.Is(err, apikeys.ErrUnauthenticated) {
						writeUnauthenticated(w)
					} else {
						writeServiceUnavailable(w)
					}
					return
				}
				ctx := authentication.ContextWithPrincipal(r.Context(), principal)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			requireAuthentication(service)(next).ServeHTTP(w, r)
		})
	}
}

// requireTelemetryIntakeCredential accepts a verified Chalk meeting or API
// session credential for the isolated append-only telemetry intake route.
func requireTelemetryIntakeCredential(service AuthenticationService, verifier MeetingCredentialVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.IsAuthenticated() {
				next.ServeHTTP(w, r)
				return
			}

			if token, ok := bearerToken(r.Header.Get("Authorization")); ok && verifier != nil {
				err := verifier.Verify(r.Context(), token)
				switch {
				case err == nil:
					next.ServeHTTP(w, r)
					return
				case errors.Is(err, mediaplane.ErrCredentialNotApplicable):
				case errors.Is(err, mediaplane.ErrInvalidCredential):
					writeUnauthenticated(w)
					return
				default:
					writeServiceUnavailable(w)
					return
				}
			}

			requireAuthentication(service)(next).ServeHTTP(w, r)
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
