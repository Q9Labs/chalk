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
)

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

func requireTenantAuthentication(apiKeys APIKeyAuthenticator, clientIPs ClientIPOptions) func(http.Handler) http.Handler {
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

			writeUnauthenticated(w)
		})
	}
}

func writeUnauthenticated(w http.ResponseWriter) {
	writeAPIError(w, apiErrorUnauthenticated)
}

func writeServiceUnavailable(w http.ResponseWriter) {
	writeAPIError(w, apiErrorServiceUnavailable)
}

func acceptServiceCredential(credential authentication.ServiceCredential) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, ok := bearerToken(r.Header.Get("Authorization"))
			matched := 0
			if ok && credential.ID != "" {
				for _, secret := range credential.Secrets {
					matched |= subtle.ConstantTimeCompare([]byte(token), []byte(secret))
				}
			}
			if matched == 1 {
				principal := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: credential.ID, Scopes: credential.Scopes}
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), principal))
			}
			next.ServeHTTP(w, r)
		})
	}
}
