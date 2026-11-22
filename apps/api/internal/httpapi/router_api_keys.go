package httpapi

import (
	"net/http"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/apikeys"
	"github.com/q9labs/chalk/apps/api/internal/authentication"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// A tenant API key reaches only routes scoped to its Tenant; these guards refuse it everywhere else.

func rejectTenantAPIKeyCredential(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hasTenantAPIKeyCredential(r) {
			writeUnauthenticated(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func rejectTenantAPIKeyOnUnscopedRoute(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if tenantScopedAPIPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if hasTenantAPIKeyCredential(r) {
			writeUnauthenticated(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func hasTenantAPIKeyCredential(r *http.Request) bool {
	if principal, ok := authentication.PrincipalFromContext(r.Context()); ok && principal.Kind == authentication.PrincipalAPIKey {
		return true
	}
	credential, ok := bearerToken(r.Header.Get("Authorization"))
	return ok && apikeys.LooksLikeRawKey(credential)
}

func tenantScopedAPIPath(path string) bool {
	remainder, ok := strings.CutPrefix(path, "/v1/tenants/")
	if !ok {
		return false
	}
	tenantID, _, _ := strings.Cut(remainder, "/")
	_, err := utilities.ParseID(tenantID)
	return err == nil
}
