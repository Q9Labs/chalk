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
			credential, ok := bearerToken(r.Header.Get("Authorization"))
			if !ok || !apikeys.LooksLikeRawKey(credential) {
				writeUnauthenticated(w)
				return
			}
			principal, failure, ok := authenticateAPIKey(r, apiKeys, clientIPs, credential)
			if !ok {
				writeAPIError(w, failure)
				return
			}
			next.ServeHTTP(w, r.WithContext(authentication.ContextWithPrincipal(r.Context(), principal)))
		})
	}
}

// authenticateAPIKey checks a raw API key and returns the API error to send when it fails.
func authenticateAPIKey(r *http.Request, apiKeys APIKeyAuthenticator, clientIPs ClientIPOptions, credential string) (authentication.Principal, APIError, bool) {
	if apiKeys == nil {
		return authentication.Principal{}, apiErrorServiceUnavailable, false
	}
	address, _ := netip.ParseAddr(clientIP(r, clientIPs))
	principal, err := apiKeys.Authenticate(r.Context(), apikeys.AuthenticateInput{RawKey: credential, IPAddress: address})
	switch {
	case errors.Is(err, apikeys.ErrUnauthenticated):
		return authentication.Principal{}, apiErrorUnauthenticated, false
	case err != nil:
		return authentication.Principal{}, apiErrorServiceUnavailable, false
	}
	return principal, APIError{}, true
}

func writeUnauthenticated(w http.ResponseWriter) {
	writeAPIError(w, apiErrorUnauthenticated)
}

func writeServiceUnavailable(w http.ResponseWriter) {
	writeAPIError(w, apiErrorServiceUnavailable)
}

// serviceCredentialMatches compares the bearer token against every secret without stopping at the first match.
func serviceCredentialMatches(credential authentication.ServiceCredential, r *http.Request) bool {
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok || credential.ID == "" {
		return false
	}
	matched := 0
	for _, secret := range credential.Secrets {
		matched |= subtle.ConstantTimeCompare([]byte(token), []byte(secret))
	}
	return matched == 1
}

func acceptServiceCredential(credential authentication.ServiceCredential) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if serviceCredentialMatches(credential, r) {
				principal := authentication.Principal{Kind: authentication.PrincipalService, ServiceID: credential.ID, Scopes: credential.Scopes}
				r = r.WithContext(authentication.ContextWithPrincipal(r.Context(), principal))
			}
			next.ServeHTTP(w, r)
		})
	}
}
